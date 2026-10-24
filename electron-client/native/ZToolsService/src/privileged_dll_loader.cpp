#include "ztools_service/privileged_dll_loader.hpp"

#include <Windows.h>

#include <cwchar>
#include <mutex>
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

}  // namespace

// The registry owns one reference; every active call/task owns a lease.
// Release and reacquisition are serialized, including Destroy/FreeLibrary.
struct PrivilegedDllSession {
  HMODULE module = nullptr;
  std::wstring path;
  using Destroy = void(__cdecl*)();
  Destroy destroy = nullptr;
  bool initialized = false;
  ~PrivilegedDllSession() {
    if (initialized && destroy) {
      try { destroy(); } catch (...) {}
    }
    if (module) FreeLibrary(module);
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
        "System32-only dependency policy is unavailable");
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
  // Allocate the lease before taking the lock so exception cleanup cannot
  // reacquire the registry mutex while it is already held.
  auto lease = std::make_shared<PrivilegedDllSessionLease>();
  lease->registry = sessions_;
  lease->key = key;
  std::lock_guard lock(sessions_->mutex);
  const auto found = sessions_->entries.find(key);
  if (found != sessions_->entries.end()) {
    if (!SamePath(found->second->path, validation.path)) {
      return LoadFailure("DLL_PATH_CHANGED", "session path differs from validated path");
    }
    lease->value = found->second;
  } else {
    const std::wstring file_name = FileName(validation.path);
    if (file_name.empty() || GetModuleHandleW(file_name.c_str()) != nullptr) {
      return LoadFailure(
          "DLL_NAME_COLLISION", "a module with the same file name is already loaded");
    }
    auto session = std::make_shared<PrivilegedDllSession>();
    session->module = LoadLibraryExW(
        validation.path.c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (session->module == nullptr) {
      return LoadFailure("DLL_LOAD_FAILED",
          "dll or a non-System32 dependency could not be loaded");
    }
    std::wstring loaded_path;
    if (!ReadModulePath(session->module, &loaded_path) ||
        !SamePath(validation.path, loaded_path)) {
      return LoadFailure("DLL_PATH_CHANGED", "loaded module path differs from the validated path");
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
    sessions_->entries.emplace(key, session);
    lease->value = std::move(session);
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
