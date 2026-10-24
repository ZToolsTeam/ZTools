#include "dll_resolver.hpp"
#include "../../shared/dll_paths.hpp"

#include <algorithm>
#include <cwctype>

namespace ztools::native_host {
void ReadDllPathConfig(DllPathConfig& config) {
  ReadManifestTrustConfig(config.plugin_trust);
  ReadManifestTrustConfig(
      config.resources_trust,
      L"ZTOOLS_NATIVE_RESOURCES_ROOT",
      L"ZTOOLS_NATIVE_RESOURCES_MANIFEST_SHA256");
}
DllResolver::DllResolver(DllPathConfig config) : config_(std::move(config)) {}
DllCheckResult DllResolver::Check(const std::string& plugin_id,
    const std::string& dll_id, const std::string& function_name) const {
  auto result = Resolve(plugin_id, dll_id, function_name);
  return {result.success, std::move(result.code), std::move(result.message)};
}
DllResolveResult DllResolver::Resolve(const std::string& plugin_id,
    const std::string& dll_id, const std::optional<std::string>& function_name) const {
  const bool is_common = dll_paths::LowerAscii(plugin_id) == "commonplugins";
  const ManifestTrustConfig& trust = is_common
      ? config_.resources_trust
      : config_.plugin_trust;
  ManifestResolver trusted_manifest(trust);
  ManifestResolveResult trusted = trusted_manifest.Resolve(
      plugin_id, dll_id, function_name);
  if (!trusted.success) {
    DllResolveResult result;
    result.code = std::move(trusted.code);
    result.message = std::move(trusted.message);
    return result;
  }

  // The manifest verifies the installed digest and function allowlist. Run the
  // shared path/handle checks as a second gate, then require both resolvers to
  // have selected the same file before handing its validated handle to LoadLibrary.
  DllResolveResult resolved = dll_paths::Resolve<DllResolveResult>(
      trust.plugin_root, plugin_id, dll_id, function_name);
  if (!resolved.success) return resolved;
  std::wstring trusted_path = std::move(trusted.path);
  std::wstring resolved_path = resolved.path;
  std::transform(trusted_path.begin(), trusted_path.end(), trusted_path.begin(),
      [](wchar_t value) { return static_cast<wchar_t>(std::towlower(value)); });
  std::transform(resolved_path.begin(), resolved_path.end(), resolved_path.begin(),
      [](wchar_t value) { return static_cast<wchar_t>(std::towlower(value)); });
  if (trusted_path != resolved_path) {
    DllResolveResult result;
    result.code = "DLL_PATH_INVALID";
    result.message = "dll path does not match the trusted manifest";
    return result;
  }
  return resolved;
}
DllResolveResult::~DllResolveResult() {
  if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
    CloseHandle(validation_handle);
  }
}

DllResolveResult::DllResolveResult(DllResolveResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      path(std::move(other.path)),
      validation_handle(other.validation_handle) {
  other.validation_handle = INVALID_HANDLE_VALUE;
}

DllResolveResult& DllResolveResult::operator=(DllResolveResult&& other) noexcept {
  if (this == &other) return *this;
  if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
    CloseHandle(validation_handle);
  }
  success = other.success;
  code = std::move(other.code);
  message = std::move(other.message);
  path = std::move(other.path);
  validation_handle = other.validation_handle;
  other.validation_handle = INVALID_HANDLE_VALUE;
  return *this;
}

}  // namespace ztools::native_host
