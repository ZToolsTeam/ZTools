#include "ztools_service/privileged_dll_resolver.hpp"
#include "native_trust_bundle.generated.hpp"
#include "../../shared/dll_paths.hpp"

#include <utility>

// 显式保活内嵌信任表摘要标记，防止 MSVC Release /OPT:REF 裁切
#pragma comment(linker, "/INCLUDE:_ztools_service_native_trust_bundle_marker")
extern "C" const char ztools_service_native_trust_bundle_marker[] =
  ZTOOLS_NATIVE_TRUST_BUNDLE_MARKER_LITERAL;

namespace ztools::service {
namespace {

void CloseAllHandles(std::vector<HANDLE>& handles) noexcept {
  for (HANDLE h : handles) {
    if (h != INVALID_HANDLE_VALUE && h != nullptr) CloseHandle(h);
  }
  handles.clear();
}

}  // namespace

bool ReadInstalledPrivilegedDllPathConfig(
  const std::wstring& data_root,
  PrivilegedDllPathConfig* config,
  DWORD* error) noexcept {
  if (!config || !error) return false;
  try {
    config->data_root = data_root;
    *error = ERROR_SUCCESS;
    return true;
  } catch (...) {
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
}

PrivilegedDllResolver::PrivilegedDllResolver(PrivilegedDllPathConfig config)
    : config_(std::move(config)),
      bundle_(native_trust::BuildEmbeddedTrustBundle()),
      snapshot_manager_(
        config_.snapshot_root_override,
        !config_.data_root.empty() || !config_.snapshot_root_override.empty()),
      state_store_(config_.trust_state_file_override) {
  std::wstring normalized_data_root;
  data_root_valid_ = !config_.data_root.empty() &&
    dll_paths::NormalizeLocalRoot(config_.data_root, normalized_data_root);
  if (data_root_valid_) {
    config_.data_root = std::move(normalized_data_root);
  }
  const auto effective_keys =
    native_trust::detail::CollectEffectiveKeys(bundle_, config_.test_overrides);
  has_privileged_key_ =
    native_trust::detail::HasUsableKeyForMode(effective_keys, native_trust::TrustMode::Privileged);
#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  allow_legacy_ = !config_.test_overrides.disable_legacy;
#else
  allow_legacy_ = true;
#endif
  if (snapshot_manager_.root_ready()) {
    snapshot_manager_.GarbageCollectAllOnStartup();
  }
}

PrivilegedDllResolver::~PrivilegedDllResolver() = default;

bool PrivilegedDllResolver::trusted() const noexcept {
  return data_root_valid_ && (has_privileged_key_ || allow_legacy_) && snapshot_manager_.root_ready();
}

const std::wstring& PrivilegedDllResolver::snapshot_root() const noexcept {
  return snapshot_manager_.snapshot_root();
}

PrivilegedDllCheckResult PrivilegedDllResolver::Check(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& function_name) const {
  auto result = Resolve(plugin_id, dll_id, function_name);
  return {result.success, std::move(result.code), std::move(result.message)};
}

PrivilegedDllResolveResult PrivilegedDllResolver::Resolve(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::optional<std::string>& function_name) const {
  PrivilegedDllResolveResult out;
  if (!data_root_valid_) {
    out.code = "DLL_PATH_INVALID";
    out.message = "service data root is not configured or invalid";
    return out;
  }
  if (!has_privileged_key_ && !allow_legacy_) {
    out.code = "MANIFEST_UNTRUSTED";
    out.message = "no trusted privileged signing key is available";
    return out;
  }
  if (!snapshot_manager_.EnsureRootReady()) {
    out.code = "DLL_PATH_INVALID";
    out.message = "trusted snapshot root directory failed security verification";
    return out;
  }

  const std::wstring plugins_root = config_.data_root + L"\\Plugins";
  auto query_hw = [this](const std::string& pid) {
    return state_store_.ReadHighWater(pid);
  };

  // 第 1 步：在用户目录执行完整验签、防回滚与全 PE 哈希校验（源文件句柄在 verified 内保持锁定）
  native_trust::VerifyResult verified =
    native_trust::VerifyNativePluginTrust<native_trust::TrustMode::Privileged>(
      plugins_root, plugin_id, dll_id, function_name, bundle_, config_.test_overrides, query_hw);
  if (!verified.success) {
    out.code = std::move(verified.code);
    out.message = std::move(verified.message);
    return out;
  }

  // 第 2 步：在互斥锁保护下从已锁定源句柄物化（或校验复用）SYSTEM 独占执行快照
  SnapshotMaterializeResult materialized = snapshot_manager_.PrepareSnapshot(verified);
  if (!materialized.success) {
    out.code = std::move(materialized.code);
    out.message = std::move(materialized.message);
    return out;
  }

  // verified 离开作用域释放源目录句柄，仅返回快照内全部锁定句柄
  out.success = true;
  out.plugin_id = std::move(verified.plugin_id);
  out.plugin_version = std::move(verified.plugin_version);
  out.snapshot_dir = std::move(materialized.snapshot_dir);
  out.path = std::move(materialized.main_snapshot_path);
  out.allowed_functions = std::move(verified.allowed_functions);
  out.locked_handles = std::move(materialized.locked_handles);
  materialized.locked_handles.clear();
  return out;
}

void PrivilegedDllResolver::CommitSuccessfulLoad(
  const std::string& plugin_id,
  const std::string& plugin_version,
  const std::wstring& current_snapshot_dir,
  const std::set<std::wstring>& active_snapshot_dirs) const {
  if (!plugin_id.empty() && !plugin_version.empty()) {
    state_store_.UpdateHighWater(plugin_id, plugin_version);
  }
  snapshot_manager_.GarbageCollect(plugin_id, current_snapshot_dir, active_snapshot_dirs);
}

PrivilegedDllResolveResult::~PrivilegedDllResolveResult() {
  CloseAllHandles(locked_handles);
}

PrivilegedDllResolveResult::PrivilegedDllResolveResult(
  PrivilegedDllResolveResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      plugin_id(std::move(other.plugin_id)),
      plugin_version(std::move(other.plugin_version)),
      snapshot_dir(std::move(other.snapshot_dir)),
      path(std::move(other.path)),
      allowed_functions(std::move(other.allowed_functions)),
      locked_handles(std::move(other.locked_handles)) {
  other.locked_handles.clear();
}

PrivilegedDllResolveResult& PrivilegedDllResolveResult::operator=(
  PrivilegedDllResolveResult&& other) noexcept {
  if (this != &other) {
    CloseAllHandles(locked_handles);
    success = other.success;
    code = std::move(other.code);
    message = std::move(other.message);
    plugin_id = std::move(other.plugin_id);
    plugin_version = std::move(other.plugin_version);
    snapshot_dir = std::move(other.snapshot_dir);
    path = std::move(other.path);
    allowed_functions = std::move(other.allowed_functions);
    locked_handles = std::move(other.locked_handles);
    other.locked_handles.clear();
  }
  return *this;
}

}  // namespace ztools::service
