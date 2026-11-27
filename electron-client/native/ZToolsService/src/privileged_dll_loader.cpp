#include "ztools_service/privileged_dll_loader.hpp"

#include <Windows.h>

#include <cwchar>
#include <mutex>
#include <set>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ztools::service {
namespace {

PrivilegedDllLoadResult LoadFailure(
    const std::string& code,
    const std::string& message) {
  PrivilegedDllLoadResult result;
  result.code = code;
  result.message = message;
  return result;
}

bool SamePath(const std::wstring& left, const std::wstring& right) noexcept {
  return left.size() == right.size() &&
         CompareStringOrdinal(
             left.data(),
             static_cast<int>(left.size()),
             right.data(),
             static_cast<int>(right.size()),
             TRUE) == CSTR_EQUAL;
}

bool ReadModulePath(const HMODULE module, std::wstring* const path) {
  std::vector<wchar_t> buffer(512);
  while (buffer.size() <= 32768) {
    SetLastError(ERROR_SUCCESS);
    const DWORD length = GetModuleFileNameW(
        module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0) {
      return false;
    }
    if (length < buffer.size() - 1 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      path->assign(buffer.data(), length);
      return true;
    }
    buffer.resize(buffer.size() * 2);
  }
  return false;
}

std::wstring FileName(const std::wstring& path) {
  const std::size_t separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? path : path.substr(separator + 1);
}

void CloseHandles(std::vector<HANDLE>& handles) noexcept {
  for (HANDLE h : handles) {
    if (h != INVALID_HANDLE_VALUE && h != nullptr) {
      CloseHandle(h);
    }
  }
  handles.clear();
}

}  // namespace

// 会话持有已加载模块与全部受保护快照文件句柄（§3.6），避免单次 validation 析构后提前释放锁
struct PrivilegedDllSession {
  HMODULE module = nullptr;
  std::wstring path;
  std::wstring snapshot_dir;
  std::vector<HANDLE> locked_handles;
  using Destroy = void(__cdecl*)();
  Destroy destroy = nullptr;
  bool initialized = false;
  ~PrivilegedDllSession() {
    if (initialized && destroy) {
      try { destroy(); } catch (...) {}
    }
    if (module) FreeLibrary(module);
    CloseHandles(locked_handles);
  }
};

struct PrivilegedDllSessionRegistry {
  std::mutex mutex;
  std::unordered_map<std::string, std::shared_ptr<PrivilegedDllSession>> entries;
};

struct PrivilegedDllSessionLease {
  std::shared_ptr<PrivilegedDllSessionRegistry> registry;
  std::shared_ptr<PrivilegedDllSession> value;
  std::string key;
  ~PrivilegedDllSessionLease() {
    if (!registry) return;
    std::lock_guard lock(registry->mutex);
    value.reset();
    const auto found = registry->entries.find(key);
    if (found != registry->entries.end() && found->second.use_count() == 1) {
      registry->entries.erase(found);
    }
  }
};

PrivilegedDllLoader::PrivilegedDllLoader(
    const PrivilegedDllResolver* const resolver)
    : resolver_(resolver), sessions_(std::make_shared<PrivilegedDllSessionRegistry>()) {
  // 默认搜索路径保持仅 SYSTEM32；受保护快照目录内依赖通过 LoadLibraryExW 显式放行
  if (SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) == FALSE) {
    last_error_ = GetLastError();
    return;
  }
  system_only_ready_ = true;
}

bool PrivilegedDllLoader::system_only_ready() const noexcept {
  return system_only_ready_;
}

DWORD PrivilegedDllLoader::last_error() const noexcept {
  return last_error_;
}

PrivilegedDllLoadResult PrivilegedDllLoader::Load(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name) const {
  if (!system_only_ready_ || resolver_ == nullptr) {
    return LoadFailure(
        "DEPENDENCY_POLICY_UNAVAILABLE",
        "Trusted snapshot and System32 dependency policy is unavailable");
  }
  PrivilegedDllResolveResult validation =
      resolver_->Resolve(plugin_id, dll_id, function_name);
  if (!validation.success) {
    PrivilegedDllLoadResult result;
    result.code = std::move(validation.code);
    result.message = std::move(validation.message);
    return result;
  }
  std::string key = plugin_id + "/" + dll_id;
  for (char& character : key) {
    if (character >= 'A' && character <= 'Z') character += 'a' - 'A';
  }
  auto lease = std::make_shared<PrivilegedDllSessionLease>();
  lease->registry = sessions_;
  lease->key = key;

  bool newly_loaded = false;
  std::string commit_plugin_id;
  std::string commit_plugin_version;
  std::wstring commit_snapshot_dir;
  std::set<std::wstring> active_snapshot_dirs;

  {
    std::lock_guard lock(sessions_->mutex);
    const auto found = sessions_->entries.find(key);
    if (found != sessions_->entries.end()) {
      if (!SamePath(found->second->path, validation.path)) {
        return LoadFailure("DLL_PATH_CHANGED", "session path differs from validated snapshot path");
      }
      lease->value = found->second;
    } else {
      const std::wstring file_name = FileName(validation.path);
      if (file_name.empty() || GetModuleHandleW(file_name.c_str()) != nullptr) {
        return LoadFailure(
            "DLL_NAME_COLLISION", "a module with the same file name is already loaded");
      }
      auto session = std::make_shared<PrivilegedDllSession>();
      // 快照目录受 SYSTEM 独占保护，允许解析同快照目录内已签名的 dependency DLL 与 System32
      session->module = LoadLibraryExW(
          validation.path.c_str(),
          nullptr,
          LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
      if (session->module == nullptr) {
        return LoadFailure("DLL_LOAD_FAILED",
            "dll or a trusted snapshot/System32 dependency could not be loaded");
      }
      std::wstring loaded_path;
      if (!ReadModulePath(session->module, &loaded_path) ||
          !SamePath(validation.path, loaded_path)) {
        return LoadFailure("DLL_PATH_CHANGED", "loaded module path differs from the validated snapshot path");
      }
      const auto init = reinterpret_cast<int(__cdecl*)()>(
          GetProcAddress(session->module, "DllPlugin_Init"));
      session->destroy = reinterpret_cast<PrivilegedDllSession::Destroy>(
          GetProcAddress(session->module, "DllPlugin_Destroy"));
      const auto info = reinterpret_cast<const void*(__cdecl*)()>(
          GetProcAddress(session->module, "DllPlugin_GetInfo"));
      if (!init || !session->destroy || !info ||
          !GetProcAddress(session->module, "DllPlugin_Call")) {
        return LoadFailure("DLL_EXPORTS_INVALID", "required DLL exports are missing");
      }
      if (init() != 0) return LoadFailure("DLL_INIT_FAILED", "DLL initialization failed");
      session->initialized = true;
      if (!info()) return LoadFailure("DLL_INFO_INVALID", "DLL information is invalid");
      session->path = validation.path;
      session->snapshot_dir = validation.snapshot_dir;
      // 将全部快照文件句柄绑定至持久会话，直至会话卸载释放
      session->locked_handles = std::move(validation.locked_handles);
      validation.locked_handles.clear();

      sessions_->entries.emplace(key, session);
      lease->value = std::move(session);
      newly_loaded = true;
      commit_plugin_id = validation.plugin_id;
      commit_plugin_version = validation.plugin_version;
      commit_snapshot_dir = validation.snapshot_dir;
      for (const auto& entry : sessions_->entries) {
        if (entry.second && !entry.second->snapshot_dir.empty()) {
          active_snapshot_dirs.insert(entry.second->snapshot_dir);
        }
      }
    }
  }

  if (newly_loaded) {
    resolver_->CommitSuccessfulLoad(
        commit_plugin_id,
        commit_plugin_version,
        commit_snapshot_dir,
        active_snapshot_dirs);
  }

  PrivilegedDllLoadResult result;
  result.success = true;
  result.module = lease->value->module;
  result.session = std::move(lease);
  result.validation = std::move(validation);
  return result;
}

PrivilegedDllLoadResult::~PrivilegedDllLoadResult() {
  session.reset();
}

PrivilegedDllLoadResult::PrivilegedDllLoadResult(
    PrivilegedDllLoadResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      module(other.module),
      validation(std::move(other.validation)),
      session(std::move(other.session)) {
  other.module = nullptr;
}

PrivilegedDllLoadResult& PrivilegedDllLoadResult::operator=(
    PrivilegedDllLoadResult&& other) noexcept {
  if (this != &other) {
    session.reset();
    success = other.success;
    code = std::move(other.code);
    message = std::move(other.message);
    module = other.module;
    validation = std::move(other.validation);
    session = std::move(other.session);
    other.module = nullptr;
  }
  return *this;
}

}  // namespace ztools::service
