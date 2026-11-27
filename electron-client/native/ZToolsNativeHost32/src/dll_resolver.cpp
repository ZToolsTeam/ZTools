#include "dll_resolver.hpp"
#include "native_trust_bundle.generated.hpp"
#include "../../shared/dll_paths.hpp"

#include <Windows.h>

#include <cstring>
#include <utility>
#include <vector>

// 显式保活内嵌信任表摘要标记，防止 MSVC Release /OPT:REF 将未引用常量裁切
#pragma comment(linker, "/INCLUDE:_ztools_native_trust_bundle_marker")
extern "C" const char ztools_native_trust_bundle_marker[] =
  ZTOOLS_NATIVE_TRUST_BUNDLE_MARKER_LITERAL;

namespace ztools::native_host {
namespace {

bool ReadEnvironmentAndClear(const wchar_t* name, std::wstring& output) {
  const DWORD required = GetEnvironmentVariableW(name, nullptr, 0);
  if (required == 0 || required > 32767) {
    SetEnvironmentVariableW(name, nullptr);
    return false;
  }
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required));
  const DWORD length = GetEnvironmentVariableW(name, buffer.data(), required);
  SetEnvironmentVariableW(name, nullptr);
  if (length == 0 || length >= required) {
    SecureZeroMemory(buffer.data(), buffer.size() * sizeof(wchar_t));
    return false;
  }
  output.assign(buffer.data(), length);
  SecureZeroMemory(buffer.data(), buffer.size() * sizeof(wchar_t));
  return true;
}

void CloseAllHandles(std::vector<HANDLE>& handles) noexcept {
  for (HANDLE h : handles) {
    if (h != INVALID_HANDLE_VALUE && h != nullptr) {
      CloseHandle(h);
    }
  }
  handles.clear();
}

}  // namespace

void ReadDllPathConfig(DllPathConfig& config) {
  config = DllPathConfig{};
  // 清理历史遗留变量，防止被子进程误读
  SetEnvironmentVariableW(L"ZTOOLS_NATIVE_MANIFEST_SHA256", nullptr);
  SetEnvironmentVariableW(L"ZTOOLS_NATIVE_RESOURCES_MANIFEST_SHA256", nullptr);

  std::wstring raw_plugin_root;
  if (ReadEnvironmentAndClear(L"ZTOOLS_NATIVE_PLUGIN_ROOT", raw_plugin_root)) {
    std::wstring normalized;
    if (dll_paths::NormalizeLocalRoot(raw_plugin_root, normalized)) {
      config.plugin_root = std::move(normalized);
      config.has_plugin_root = true;
    }
  }

  std::wstring raw_resources_root;
  if (ReadEnvironmentAndClear(L"ZTOOLS_NATIVE_RESOURCES_ROOT", raw_resources_root)) {
    std::wstring normalized;
    if (dll_paths::NormalizeLocalRoot(raw_resources_root, normalized)) {
      config.resources_root = std::move(normalized);
      config.has_resources_root = true;
    }
  }

#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  std::wstring test_pub;
  if (ReadEnvironmentAndClear(L"ZTOOLS_NATIVE_TEST_PUBKEY_HEX", test_pub)) {
    std::array<std::uint8_t, native_trust::kP256PublicKeyBytes> pub_xy{};
    if (dll_paths::ParseHex(test_pub, pub_xy)) {
      config.test_overrides.ephemeral_normal_pub = pub_xy;
    }
    SecureZeroMemory(test_pub.data(), test_pub.size() * sizeof(wchar_t));
  }

  std::wstring test_priv_pub;
  if (ReadEnvironmentAndClear(L"ZTOOLS_NATIVE_TEST_PRIV_PUBKEY_HEX", test_priv_pub)) {
    std::array<std::uint8_t, native_trust::kP256PublicKeyBytes> pub_xy{};
    if (dll_paths::ParseHex(test_priv_pub, pub_xy)) {
      config.test_overrides.ephemeral_privileged_pub = pub_xy;
    }
    SecureZeroMemory(test_priv_pub.data(), test_priv_pub.size() * sizeof(wchar_t));
  }

  std::wstring disable_legacy;
  if (ReadEnvironmentAndClear(L"ZTOOLS_NATIVE_TEST_DISABLE_LEGACY", disable_legacy)) {
    config.test_overrides.disable_legacy = (disable_legacy == L"1");
    SecureZeroMemory(disable_legacy.data(), disable_legacy.size() * sizeof(wchar_t));
  }
#endif
}

DllResolver::DllResolver(DllPathConfig config)
    : config_(std::move(config)),
      bundle_(native_trust::BuildEmbeddedTrustBundle()) {}

DllCheckResult DllResolver::Check(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& function_name) const {
  auto result = Resolve(plugin_id, dll_id, function_name);
  return {result.success, std::move(result.code), std::move(result.message)};
}

DllResolveResult DllResolver::Resolve(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::optional<std::string>& function_name) const {
  const bool is_common = dll_paths::LowerAscii(plugin_id) == "commonplugins";
  const bool has_root = is_common ? config_.has_resources_root : config_.has_plugin_root;
  const std::wstring& root = is_common ? config_.resources_root : config_.plugin_root;
  if (!has_root) {
    DllResolveResult out;
    out.code = "MANIFEST_UNTRUSTED";
    out.message = "trusted native plugin root is not configured";
    return out;
  }

  native_trust::VerifyResult verified =
    native_trust::VerifyNativePluginTrust<native_trust::TrustMode::Normal>(
      root, plugin_id, dll_id, function_name, bundle_, config_.test_overrides);
  DllResolveResult out;
  if (!verified.success) {
    out.code = std::move(verified.code);
    out.message = std::move(verified.message);
    return out;
  }
  out.success = true;
  out.path = std::move(verified.main_path);
  out.restrict_functions = verified.restrict_functions;
  out.allowed_functions = std::move(verified.allowed_functions);
  out.locked_handles.reserve(verified.files.size());
  for (auto& file : verified.files) {
    HANDLE raw = file.handle.Release();
    if (raw != INVALID_HANDLE_VALUE && raw != nullptr) {
      out.locked_handles.push_back(raw);
    }
  }
  return out;
}

DllResolveResult::~DllResolveResult() {
  CloseAllHandles(locked_handles);
}

DllResolveResult::DllResolveResult(DllResolveResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      path(std::move(other.path)),
      restrict_functions(other.restrict_functions),
      allowed_functions(std::move(other.allowed_functions)),
      locked_handles(std::move(other.locked_handles)) {
  other.locked_handles.clear();
}

DllResolveResult& DllResolveResult::operator=(DllResolveResult&& other) noexcept {
  if (this == &other) return *this;
  CloseAllHandles(locked_handles);
  success = other.success;
  code = std::move(other.code);
  message = std::move(other.message);
  path = std::move(other.path);
  restrict_functions = other.restrict_functions;
  allowed_functions = std::move(other.allowed_functions);
  locked_handles = std::move(other.locked_handles);
  other.locked_handles.clear();
  return *this;
}

}  // namespace ztools::native_host
