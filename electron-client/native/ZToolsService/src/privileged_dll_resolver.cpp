#include "ztools_service/privileged_dll_resolver.hpp"
#include "../../shared/dll_paths.hpp"

#include "ztools_service/service_auth.hpp"

#include <algorithm>

namespace ztools::service {
bool ReadInstalledPrivilegedDllPathConfig(const std::wstring& data_root,
    PrivilegedDllPathConfig* config, DWORD* error) noexcept {
  if (!config || !error) return false;
  try {
    config->data_root = data_root;
    return ReadInstalledPrivilegedManifestTrustConfig(
        data_root, &config->manifest_trust, error);
  } catch (...) {
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
}
PrivilegedDllResolver::PrivilegedDllResolver(PrivilegedDllPathConfig config)
    : config_(std::move(config)) {}
PrivilegedDllResolver::~PrivilegedDllResolver() {
  SecureEraseServiceBytes(config_.manifest_trust.manifest_sha256);
}
bool PrivilegedDllResolver::trusted() const noexcept {
  return config_.manifest_trust.trusted;
}
PrivilegedDllCheckResult PrivilegedDllResolver::Check(const std::string& plugin_id,
    const std::string& dll_id, const std::string& function_name) const {
  auto result = Resolve(plugin_id, dll_id, function_name);
  return {result.success, std::move(result.code), std::move(result.message)};
}
PrivilegedDllResolveResult PrivilegedDllResolver::Resolve(const std::string& plugin_id,
    const std::string& dll_id, const std::optional<std::string>& function_name) const {
  PrivilegedManifestResolver trusted_manifest(config_.manifest_trust);
  PrivilegedManifestResolveResult trusted = trusted_manifest.Resolve(
      plugin_id, dll_id, function_name);
  if (!trusted.success) {
    PrivilegedDllResolveResult result;
    result.code = std::move(trusted.code);
    result.message = std::move(trusted.message);
    return result;
  }

  PrivilegedDllResolveResult resolved = dll_paths::Resolve<PrivilegedDllResolveResult>(
      config_.data_root.empty() ? std::wstring{} : config_.data_root + L"\\Plugins",
      plugin_id, dll_id, function_name);
  if (!resolved.success) return resolved;
  if (trusted.path.size() != resolved.path.size() || CompareStringOrdinal(
          trusted.path.data(), static_cast<int>(trusted.path.size()),
          resolved.path.data(), static_cast<int>(resolved.path.size()), TRUE) != CSTR_EQUAL) {
    PrivilegedDllResolveResult result;
    result.code = "DLL_PATH_INVALID";
    result.message = "dll path does not match the trusted manifest";
    return result;
  }
  return resolved;
}
PrivilegedDllResolveResult::~PrivilegedDllResolveResult() {
  if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
    CloseHandle(validation_handle);
  }
}

PrivilegedDllResolveResult::PrivilegedDllResolveResult(
    PrivilegedDllResolveResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      path(std::move(other.path)),
      validation_handle(other.validation_handle) {
  other.validation_handle = INVALID_HANDLE_VALUE;
}

PrivilegedDllResolveResult&
PrivilegedDllResolveResult::operator=(
    PrivilegedDllResolveResult&& other) noexcept {
  if (this != &other) {
    if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
      CloseHandle(validation_handle);
    }
    success = other.success;
    code = std::move(other.code);
    message = std::move(other.message);
    path = std::move(other.path);
    validation_handle = other.validation_handle;
    other.validation_handle = INVALID_HANDLE_VALUE;
  }
  return *this;
}

}  // namespace ztools::service
