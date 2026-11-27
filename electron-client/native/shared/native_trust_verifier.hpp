#pragma once

#include "dll_paths.hpp"
#include "native_semver.hpp"
#include "native_trust_crypto.hpp"
#include "native_trust_json.hpp"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ztools::native_trust {

inline constexpr std::array<std::uint8_t, 23> kNativeTrustDomainPrefix = {
  'z', 't', 'o', 'o', 'l', 's', '-', 'n', 'a', 't', 'i', 'v', 'e', '-', 't', 'r', 'u', 's', 't', '-', 'v', '1', '\0'
};
inline constexpr std::uint64_t kMaxTrustManifestBytes = 256ULL * 1024ULL;
inline constexpr std::uint64_t kMaxTrustSignatureBytes = 256ULL;
inline constexpr std::uint64_t kMaxNativeBinaryBytes = 512ULL * 1024ULL * 1024ULL;
inline constexpr std::size_t kMaxTrustFiles = 128;
inline constexpr std::size_t kMaxFunctionsPerMain = 256;
inline constexpr std::size_t kMaxCommonLibsPerManifest = 32;
inline constexpr wchar_t kManifestFileName[] = L"native-trust.json";
inline constexpr wchar_t kSignatureFileName[] = L"native-trust.sig";

enum class TrustMode {
  Normal,
  Privileged,
};

enum class TrustFileRole {
  Main,
  Dependency,
  Helper,
};

enum class TrustFileArch {
  X86,
  X64,
};

struct TrustPublicKey {
  std::string key_id;
  std::array<std::uint8_t, kP256PublicKeyBytes> pub_xy{};
  bool allow_native = false;
  bool allow_privileged = false;
};

struct TrustRevocations {
  std::set<std::string> revoked_key_ids;
  std::set<std::array<std::uint8_t, kSha256Bytes>> revoked_manifest_sha256;
  std::set<std::array<std::uint8_t, kSha256Bytes>> revoked_file_sha256;
  // key 为小写 pluginId
  std::map<std::string, std::string> min_plugin_versions;
};

struct LegacyFrozenEntry {
  std::string plugin_id;
  std::string dll_id;
  std::array<std::uint8_t, kSha256Bytes> sha256{};
  std::set<std::string> functions;
};

struct TrustBundle {
  std::vector<TrustPublicKey> public_keys;
  TrustRevocations revocations;
  std::vector<LegacyFrozenEntry> legacy_frozen;
};

struct TestTrustOverrides {
  std::optional<std::array<std::uint8_t, kP256PublicKeyBytes>> ephemeral_normal_pub;
  std::optional<std::array<std::uint8_t, kP256PublicKeyBytes>> ephemeral_privileged_pub;
  bool disable_legacy = false;
};

struct ParsedTrustFileEntry {
  TrustFileRole role = TrustFileRole::Helper;
  std::string dll_id;
  std::string relative_path;
  TrustFileArch arch = TrustFileArch::X86;
  std::uint64_t size = 0;
  std::array<std::uint8_t, kSha256Bytes> sha256{};
  std::set<std::string> functions;
};

struct ParsedTrustManifest {
  std::string key_id;
  std::string plugin_id;
  std::string plugin_version;
  SemVer parsed_version;
  bool require_admin = false;
  std::string issued_at;
  std::vector<ParsedTrustFileEntry> files;
  // 可选：仅普通权限官方签名插件可声明的签名 CommonLibs 工具池逻辑 ID（requireAdmin=true 严禁出现）
  std::vector<std::string> common_libs;
};

struct VerifiedFileHandle {
  TrustFileRole role = TrustFileRole::Helper;
  TrustFileArch arch = TrustFileArch::X86;
  std::string relative_path;
  std::wstring full_path;
  std::uint64_t size = 0;
  std::array<std::uint8_t, kSha256Bytes> sha256{};
  dll_paths::UniqueHandle handle;
};

struct VerifyResult {
  bool success = false;
  std::string code;
  std::string message;
  bool from_legacy = false;
  // 为 true 时调用方需按 allowed_functions 校验函数白名单；旧版无签名兼容模式为 false
  bool restrict_functions = true;
  std::string plugin_id;
  std::string plugin_version;
  std::string manifest_sha256_hex;
  std::vector<std::uint8_t> raw_manifest_bytes;
  std::wstring main_path;
  std::set<std::string> allowed_functions;
  std::vector<VerifiedFileHandle> files;
};

struct PayloadVerifyResult {
  bool success = false;
  std::string code;
  std::string message;
  std::array<std::uint8_t, kSha256Bytes> manifest_sha256{};
  ParsedTrustManifest manifest;
};

namespace detail {

inline bool IsSafeKeyId(std::string_view value) noexcept {
  if (value.empty() || value.size() > 64) return false;
  for (std::size_t i = 0; i < value.size(); ++i) {
    const unsigned char ch = static_cast<unsigned char>(value[i]);
    const bool alpha = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    const bool digit = ch >= '0' && ch <= '9';
    const bool punct = ch == '.' || ch == '_' || ch == '-';
    if (!(alpha || digit || punct) || (i == 0 && !(alpha || digit))) return false;
  }
  return true;
}

// 校验签名 CommonLibs 逻辑工具 ID（与 TS/MJS 规则及 CommonLibsManager TOOL_ID_SEGMENT_REGEX 严格一致）
inline bool IsSafeCommonLibId(std::string_view value) noexcept {
  if (value.empty() || value.size() > 128 || value.back() == '.') return false;
  for (std::size_t i = 0; i < value.size(); ++i) {
    const unsigned char ch = static_cast<unsigned char>(value[i]);
    const bool lower = ch >= 'a' && ch <= 'z';
    const bool digit = ch >= '0' && ch <= '9';
    const bool punct = ch == '.' || ch == '_' || ch == '-';
    if (!(lower || digit || punct) || (i == 0 && !(lower || digit))) return false;
  }
  return dll_paths::IsSafeIdentifier(value);
}

inline bool ParseStrictLowerHex(std::string_view value, std::span<std::uint8_t> output) noexcept {
  if (value.size() != output.size() * 2) return false;
  auto nibble = [](char ch, std::uint8_t& out) noexcept {
    if (ch >= '0' && ch <= '9') {
      out = static_cast<std::uint8_t>(ch - '0');
      return true;
    }
    if (ch >= 'a' && ch <= 'f') {
      out = static_cast<std::uint8_t>(ch - 'a' + 10);
      return true;
    }
    return false;
  };
  for (std::size_t i = 0; i < output.size(); ++i) {
    std::uint8_t hi = 0;
    std::uint8_t lo = 0;
    if (!nibble(value[i * 2], hi) || !nibble(value[i * 2 + 1], lo)) return false;
    output[i] = static_cast<std::uint8_t>((hi << 4U) | lo);
  }
  return true;
}

struct ParsedSignature {
  std::string key_id;
  std::array<std::uint8_t, kP256SignatureBytes> signature{};
};

inline bool ParseSignatureLine(std::string_view raw, ParsedSignature& out) {
  if (raw.empty() || raw.size() > kMaxTrustSignatureBytes) return false;
  if (!raw.empty() && raw.back() == '\n') raw.remove_suffix(1);
  if (!raw.empty() && raw.back() == '\r') raw.remove_suffix(1);
  if (raw.find('\r') != std::string_view::npos || raw.find('\n') != std::string_view::npos) {
    return false;
  }
  const std::size_t c1 = raw.find(':');
  if (c1 == std::string_view::npos || raw.substr(0, c1) != "v1") return false;
  const std::size_t c2 = raw.find(':', c1 + 1);
  if (c2 == std::string_view::npos || raw.find(':', c2 + 1) != std::string_view::npos) return false;
  const std::string_view key_id = raw.substr(c1 + 1, c2 - c1 - 1);
  const std::string_view sig_hex = raw.substr(c2 + 1);
  if (!IsSafeKeyId(key_id) || !ParseStrictLowerHex(sig_hex, out.signature)) return false;
  out.key_id = std::string(key_id);
  return true;
}

inline bool ValidateAndExtractManifest(
  const JsonValue& root,
  std::string_view expected_key_id,
  ParsedTrustManifest& out) {
  if (root.type != JsonType::Object) return false;
  const JsonValue* v_common_libs = root.Find("commonLibs");
  const std::size_t expected_keys = v_common_libs ? 8U : 7U;
  if (root.object_value.size() != expected_keys) return false;
  const JsonValue* v_schema = root.Find("schemaVersion");
  const JsonValue* v_key_id = root.Find("keyId");
  const JsonValue* v_plugin_id = root.Find("pluginId");
  const JsonValue* v_plugin_ver = root.Find("pluginVersion");
  const JsonValue* v_req_admin = root.Find("requireAdmin");
  const JsonValue* v_issued_at = root.Find("issuedAt");
  const JsonValue* v_files = root.Find("files");
  if (!v_schema || !v_key_id || !v_plugin_id || !v_plugin_ver ||
      !v_req_admin || !v_issued_at || !v_files) {
    return false;
  }
  if (v_schema->type != JsonType::Uint64 || v_schema->uint_value != 1ULL) return false;
  if (v_key_id->type != JsonType::String || !IsSafeKeyId(v_key_id->string_value) ||
      v_key_id->string_value != expected_key_id) {
    return false;
  }
  if (v_plugin_id->type != JsonType::String || !dll_paths::IsSafeIdentifier(v_plugin_id->string_value)) {
    return false;
  }
  if (v_plugin_ver->type != JsonType::String ||
      !ParseSemVer(v_plugin_ver->string_value, out.parsed_version)) {
    return false;
  }
  if (v_req_admin->type != JsonType::Bool) return false;
  if (v_issued_at->type != JsonType::String || v_issued_at->string_value.empty() ||
      v_issued_at->string_value.size() > 64) {
    return false;
  }
  if (v_files->type != JsonType::Array || v_files->array_value.empty() ||
      v_files->array_value.size() > kMaxTrustFiles) {
    return false;
  }

  out.common_libs.clear();
  if (v_common_libs != nullptr) {
    // 护栏 2：特权插件（SYSTEM）严禁声明用户目录 CommonLibs 依赖
    if (v_req_admin->bool_value) return false;
    if (v_common_libs->type != JsonType::Array ||
        v_common_libs->array_value.size() > kMaxCommonLibsPerManifest) {
      return false;
    }
    std::set<std::string> seen_common_libs;
    out.common_libs.reserve(v_common_libs->array_value.size());
    for (const JsonValue& lib : v_common_libs->array_value) {
      if (lib.type != JsonType::String || !IsSafeCommonLibId(lib.string_value)) {
        return false;
      }
      if (!seen_common_libs.insert(lib.string_value).second) return false;
      out.common_libs.push_back(lib.string_value);
    }
  }

  out.key_id = v_key_id->string_value;
  out.plugin_id = v_plugin_id->string_value;
  out.plugin_version = v_plugin_ver->string_value;
  out.require_admin = v_req_admin->bool_value;
  out.issued_at = v_issued_at->string_value;
  out.files.clear();
  out.files.reserve(v_files->array_value.size());

  std::set<std::string> seen_paths;
  std::set<std::string> seen_dll_ids;
  std::size_t main_count = 0;

  for (const JsonValue& item : v_files->array_value) {
    if (item.type != JsonType::Object) return false;
    const JsonValue* v_role = item.Find("role");
    const JsonValue* v_path = item.Find("path");
    const JsonValue* v_arch = item.Find("arch");
    const JsonValue* v_size = item.Find("size");
    const JsonValue* v_sha = item.Find("sha256");
    if (!v_role || v_role->type != JsonType::String ||
        !v_path || v_path->type != JsonType::String ||
        !v_arch || v_arch->type != JsonType::String ||
        !v_size || v_size->type != JsonType::Uint64 || v_size->uint_value == 0 ||
        v_size->uint_value > kMaxNativeBinaryBytes ||
        !v_sha || v_sha->type != JsonType::String) {
      return false;
    }

    ParsedTrustFileEntry entry;
    entry.relative_path = v_path->string_value;
    entry.size = v_size->uint_value;
    if (!ParseStrictLowerHex(v_sha->string_value, entry.sha256)) return false;

    const std::string lower_path = dll_paths::LowerAscii(entry.relative_path);
    if (!seen_paths.insert(lower_path).second) return false;

    if (v_role->string_value == "main") {
      if (item.object_value.size() != 7) return false;
      const JsonValue* v_dll_id = item.Find("dllId");
      const JsonValue* v_functions = item.Find("functions");
      if (!v_dll_id || v_dll_id->type != JsonType::String ||
          !dll_paths::IsSafeIdentifier(v_dll_id->string_value) ||
          !v_functions || v_functions->type != JsonType::Array ||
          v_functions->array_value.empty() ||
          v_functions->array_value.size() > kMaxFunctionsPerMain) {
        return false;
      }
      if (v_arch->string_value != "x86") return false;
      entry.role = TrustFileRole::Main;
      entry.arch = TrustFileArch::X86;
      entry.dll_id = v_dll_id->string_value;
      if (!seen_dll_ids.insert(dll_paths::LowerAscii(entry.dll_id)).second) return false;
      for (const JsonValue& fn : v_functions->array_value) {
        if (fn.type != JsonType::String || !dll_paths::IsSafeIdentifier(fn.string_value, true)) {
          return false;
        }
        if (!entry.functions.insert(fn.string_value).second) return false;
      }
      ++main_count;
    } else if (v_role->string_value == "dependency") {
      if (item.object_value.size() != 5) return false;
      if (v_arch->string_value != "x86") return false;
      entry.role = TrustFileRole::Dependency;
      entry.arch = TrustFileArch::X86;
    } else if (v_role->string_value == "helper") {
      if (item.object_value.size() != 5) return false;
      if (v_arch->string_value == "x86") entry.arch = TrustFileArch::X86;
      else if (v_arch->string_value == "x64") entry.arch = TrustFileArch::X64;
      else return false;
      entry.role = TrustFileRole::Helper;
    } else {
      return false;
    }

    out.files.push_back(std::move(entry));
  }
  return main_count > 0;
}

inline std::vector<TrustPublicKey> CollectEffectiveKeys(
  const TrustBundle& bundle,
  const TestTrustOverrides& overrides) {
  std::vector<TrustPublicKey> keys = bundle.public_keys;
#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  if (overrides.ephemeral_normal_pub.has_value()) {
    TrustPublicKey test_key;
    test_key.key_id = "test-ephemeral";
    test_key.pub_xy = *overrides.ephemeral_normal_pub;
    test_key.allow_native = true;
    test_key.allow_privileged = false;
    keys.push_back(std::move(test_key));
  }
  if (overrides.ephemeral_privileged_pub.has_value()) {
    TrustPublicKey test_key;
    test_key.key_id = "test-ephemeral-priv";
    test_key.pub_xy = *overrides.ephemeral_privileged_pub;
    test_key.allow_native = false;
    test_key.allow_privileged = true;
    keys.push_back(std::move(test_key));
  }
#else
  (void)overrides;
#endif
  return keys;
}

inline bool HasUsableKeyForMode(const std::vector<TrustPublicKey>& keys, TrustMode mode) noexcept {
  for (const auto& key : keys) {
    if (mode == TrustMode::Normal && key.allow_native) return true;
    if (mode == TrustMode::Privileged && key.allow_privileged) return true;
  }
  return false;
}

// 检查从 root 到 target 父目录沿途是否存在重解析点（含断裂联接点）或非目录节点
inline bool HasUnsafeAncestorDirectory(const std::wstring& root, const std::wstring& target) noexcept {
  if (!dll_paths::IsWithinRoot(root, target)) return true;
  std::wstring current = root;
  std::size_t offset = root.size() + 1;
  while (offset <= target.size()) {
    const std::size_t separator = target.find(L'\\', offset);
    if (separator == std::wstring::npos) {
      return false;
    }
    current += L"\\" + target.substr(offset, separator - offset);
    const DWORD attrs = GetFileAttributesW(current.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) {
      // 父目录尚不存在，后续目标文件按缺失处理
      return false;
    }
    if ((attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return true;
    }
    offset = separator + 1;
  }
  return false;
}

struct LegacyPathProbeResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;
  ~LegacyPathProbeResult() {
    if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
      CloseHandle(validation_handle);
    }
  }
  LegacyPathProbeResult() = default;
  LegacyPathProbeResult(const LegacyPathProbeResult&) = delete;
  LegacyPathProbeResult& operator=(const LegacyPathProbeResult&) = delete;
  LegacyPathProbeResult(LegacyPathProbeResult&& other) noexcept
      : success(other.success),
        code(std::move(other.code)),
        message(std::move(other.message)),
        path(std::move(other.path)),
        validation_handle(other.validation_handle) {
    other.validation_handle = INVALID_HANDLE_VALUE;
  }
  LegacyPathProbeResult& operator=(LegacyPathProbeResult&& other) noexcept {
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
};

}  // namespace detail

// 纯内存载荷验签与解析（先验签后解析），供状态机与 C++ 跨语言黄金向量单测共用
inline PayloadVerifyResult VerifySignedPayload(
  std::span<const std::uint8_t> raw_manifest_bytes,
  std::string_view raw_sig_text,
  TrustMode mode,
  const std::vector<TrustPublicKey>& keys,
  const TrustRevocations& revocations) {
  auto fail = [](const char* code, const char* message) {
    PayloadVerifyResult r;
    r.code = code;
    r.message = message;
    return r;
  };
  if (raw_manifest_bytes.empty() || raw_manifest_bytes.size() > kMaxTrustManifestBytes ||
      raw_sig_text.empty() || raw_sig_text.size() > kMaxTrustSignatureBytes) {
    return fail("MANIFEST_UNAVAILABLE", "native trust manifest or signature size is invalid");
  }

  detail::ParsedSignature parsed_sig;
  if (!detail::ParseSignatureLine(raw_sig_text, parsed_sig)) {
    return fail("MANIFEST_INVALID", "native trust signature format is invalid");
  }

  // 先按 keyId 查公钥并校验 usage 与吊销状态
  const TrustPublicKey* matched_key = nullptr;
  for (const auto& key : keys) {
    if (key.key_id == parsed_sig.key_id) {
      matched_key = &key;
      break;
    }
  }
  if (matched_key == nullptr) {
    return fail("MANIFEST_UNTRUSTED", "native trust signing key is unknown");
  }
  const bool usage_ok = mode == TrustMode::Privileged
    ? matched_key->allow_privileged
    : matched_key->allow_native;
  if (!usage_ok) {
    return fail("MANIFEST_UNTRUSTED", "native trust signing key usage does not match mode");
  }
  if (revocations.revoked_key_ids.contains(parsed_sig.key_id)) {
    return fail("MANIFEST_REVOKED", "native trust signing key has been revoked");
  }

  // 先对原始字节验签，通过后再解析 JSON
  if (!VerifyEcdsaP256Sha256(
        matched_key->pub_xy,
        std::span<const std::uint8_t>(kNativeTrustDomainPrefix.data(), kNativeTrustDomainPrefix.size()),
        raw_manifest_bytes,
        parsed_sig.signature)) {
    return fail("MANIFEST_UNTRUSTED", "native trust ECDSA signature verification failed");
  }

  PayloadVerifyResult out;
  if (!Sha256Bytes(raw_manifest_bytes, out.manifest_sha256)) {
    return fail("MANIFEST_UNTRUSTED", "failed to hash native trust manifest");
  }
  if (revocations.revoked_manifest_sha256.contains(out.manifest_sha256)) {
    return fail("MANIFEST_REVOKED", "native trust manifest digest has been revoked");
  }

  const std::string_view json_view(
    reinterpret_cast<const char*>(raw_manifest_bytes.data()), raw_manifest_bytes.size());
  JsonValue parsed_json;
  if (!ParseStrictJson(json_view, parsed_json) ||
      !detail::ValidateAndExtractManifest(parsed_json, parsed_sig.key_id, out.manifest)) {
    return fail("MANIFEST_INVALID", "native trust manifest schema or syntax is invalid");
  }

  out.success = true;
  return out;
}

// 统一校验状态机（§3.5，Normal 与 Privileged 两宿主共用）
template<TrustMode Mode>
VerifyResult VerifyNativePluginTrust(
  const std::wstring& configured_root,
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::optional<std::string>& function_name,
  const TrustBundle& bundle,
  const TestTrustOverrides& overrides = {},
  const std::function<std::optional<std::string>(const std::string&)>& query_high_water = {}) {
  auto fail = [](const char* code, const char* message) {
    VerifyResult r;
    r.code = code;
    r.message = message;
    return r;
  };

  // S1: 标识符校验
  if (!dll_paths::IsSafeIdentifier(plugin_id) || !dll_paths::IsSafeIdentifier(dll_id) ||
      (function_name && !dll_paths::IsSafeIdentifier(*function_name, true))) {
    return fail("INVALID_REQUEST", "plugin, dll, or function identifier is invalid");
  }

  // S2: 根目录规范化
  std::wstring root;
  std::wstring wide_plugin_id;
  if (!dll_paths::NormalizeLocalRoot(configured_root, root) ||
      !dll_paths::Utf8ToWide(plugin_id, wide_plugin_id)) {
    return fail("DLL_PATH_INVALID", "plugin root directory is invalid");
  }

  // S3: 信任就绪检查（无签名旧版插件默认走兼容放行；测试构建下可通过 disable_legacy 关闭旧版兼容）
  const std::vector<TrustPublicKey> effective_keys = detail::CollectEffectiveKeys(bundle, overrides);
  const bool has_key = detail::HasUsableKeyForMode(effective_keys, Mode);
#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  const bool allow_legacy = !overrides.disable_legacy;
#else
  const bool allow_legacy = true;
#endif
  if (!has_key && !allow_legacy) {
    return fail("MANIFEST_UNTRUSTED", "native trust root has no usable keys for current mode");
  }

  // S4: 探测 <root>\<plugin_id>\native-trust.json 与 .sig
  const std::wstring plugin_dir = root + L"\\" + wide_plugin_id;
  const DWORD root_attr = GetFileAttributesW(root.c_str());
  if (root_attr == INVALID_FILE_ATTRIBUTES ||
      (root_attr & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (root_attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return fail("DLL_PATH_INVALID", "plugin root directory is missing or unsafe");
  }
  const DWORD plugin_dir_attr = GetFileAttributesW(plugin_dir.c_str());
  if (plugin_dir_attr == INVALID_FILE_ATTRIBUTES) {
    return fail("DLL_UNAVAILABLE", "plugin directory is unavailable");
  }
  if ((plugin_dir_attr & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (plugin_dir_attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return fail("DLL_PATH_INVALID", "plugin directory is not an ordinary directory");
  }

  const std::wstring manifest_path = plugin_dir + L"\\" + kManifestFileName;
  const std::wstring sig_path = plugin_dir + L"\\" + kSignatureFileName;
  const DWORD manifest_attr = GetFileAttributesW(manifest_path.c_str());
  const DWORD sig_attr = GetFileAttributesW(sig_path.c_str());
  const bool has_manifest_file = manifest_attr != INVALID_FILE_ATTRIBUTES;
  const bool has_sig_file = sig_attr != INVALID_FILE_ATTRIBUTES;

  if (has_manifest_file || has_sig_file) {
    // 分支 A：任一签名文件存在即严格验签，严禁降级至冻结表
    if (!has_manifest_file || !has_sig_file ||
        !dll_paths::IsOrdinaryTreePath(root, manifest_path) ||
        !dll_paths::IsOrdinaryTreePath(root, sig_path)) {
      return fail("MANIFEST_UNAVAILABLE", "native trust manifest or signature is missing or unsafe");
    }

    // 各只读一次，句柄在本作用域结束即释放，绝不进入长期会话句柄集
    std::vector<std::uint8_t> raw_manifest;
    std::vector<std::uint8_t> raw_sig;
    {
      dll_paths::UniqueHandle manifest_handle;
      dll_paths::UniqueHandle sig_handle;
      if (!dll_paths::ReadFileBytes(manifest_path, kMaxTrustManifestBytes, raw_manifest, manifest_handle) ||
          !dll_paths::ReadFileBytes(sig_path, kMaxTrustSignatureBytes, raw_sig, sig_handle) ||
          !dll_paths::FinalHandleIsWithinRoot(manifest_handle.Get(), plugin_dir) ||
          !dll_paths::FinalHandleIsWithinRoot(sig_handle.Get(), plugin_dir)) {
        return fail("MANIFEST_UNAVAILABLE", "native trust manifest or signature cannot be read");
      }
    }

    const std::string_view sig_text(
      reinterpret_cast<const char*>(raw_sig.data()), raw_sig.size());
    PayloadVerifyResult payload = VerifySignedPayload(
      raw_manifest, sig_text, Mode, effective_keys, bundle.revocations);
    if (!payload.success) {
      return fail(payload.code.c_str(), payload.message.c_str());
    }

    // A.8 pluginId 必须匹配请求（忽略大小写）
    const std::string lower_req_plugin = dll_paths::LowerAscii(plugin_id);
    if (dll_paths::LowerAscii(payload.manifest.plugin_id) != lower_req_plugin) {
      return fail("MANIFEST_INVALID", "native trust manifest pluginId does not match request");
    }

    // A.9 requireAdmin 与模式严格一致
    if (payload.manifest.require_admin != (Mode == TrustMode::Privileged)) {
      return fail("DLL_NOT_ALLOWED", "native trust manifest privilege mode mismatch");
    }

    // A.10 最低版本与特权单调高水位防回滚
    const auto min_it = bundle.revocations.min_plugin_versions.find(lower_req_plugin);
    if (min_it != bundle.revocations.min_plugin_versions.end()) {
      SemVer min_ver;
      if (!ParseSemVer(min_it->second, min_ver) ||
          CompareSemVer(payload.manifest.parsed_version, min_ver) < 0) {
        return fail("MANIFEST_ROLLBACK", "plugin version is below minimum required version");
      }
    }
    if constexpr (Mode == TrustMode::Privileged) {
      if (query_high_water) {
        const std::optional<std::string> hw = query_high_water(lower_req_plugin);
        if (hw.has_value()) {
          SemVer hw_ver;
          if (!ParseSemVer(*hw, hw_ver) ||
              CompareSemVer(payload.manifest.parsed_version, hw_ver) < 0) {
            return fail("MANIFEST_ROLLBACK", "privileged plugin version is below high-water mark");
          }
        }
      }
    }

    // A.11 按 dllId 查找 role==main 并校验函数白名单
    const std::string lower_req_dll = dll_paths::LowerAscii(dll_id);
    const ParsedTrustFileEntry* matched_main = nullptr;
    for (const auto& entry : payload.manifest.files) {
      if (entry.role == TrustFileRole::Main &&
          dll_paths::LowerAscii(entry.dll_id) == lower_req_dll) {
        matched_main = &entry;
        break;
      }
    }
    if (matched_main == nullptr) {
      return fail("DLL_NOT_ALLOWED", "requested dllId is not declared as main in manifest");
    }
    if (function_name.has_value() && !matched_main->functions.contains(*function_name)) {
      return fail("FUNCTION_NOT_ALLOWED", "requested function is not in signed manifest allowlist");
    }

    // A.12 全文件校验并锁定全部 PE 文件句柄
    VerifyResult result;
    result.plugin_id = payload.manifest.plugin_id;
    result.plugin_version = payload.manifest.plugin_version;
    result.manifest_sha256_hex = BytesToLowerHex(payload.manifest_sha256);
    result.raw_manifest_bytes = std::move(raw_manifest);
    result.allowed_functions = matched_main->functions;
    result.files.reserve(payload.manifest.files.size());

    for (const auto& entry : payload.manifest.files) {
      std::wstring target;
      const bool require_lib = (Mode == TrustMode::Privileged);
      const bool require_dll_ext = (entry.role != TrustFileRole::Helper);
      if (!dll_paths::ValidateRelativePath(
            root, plugin_id, entry.relative_path, require_lib, require_dll_ext, target)) {
        return fail("DLL_PATH_INVALID", "declared file path is invalid");
      }
      // 先检查父目录链是否存在重解析点（含断裂联接点），避免误归类为 DLL_UNAVAILABLE
      if (detail::HasUnsafeAncestorDirectory(root, target)) {
        return fail("DLL_PATH_INVALID", "declared native binary ancestor directory contains reparse point or is invalid");
      }
      const DWORD file_attr = GetFileAttributesW(target.c_str());
      if (file_attr == INVALID_FILE_ATTRIBUTES) {
        return fail("DLL_UNAVAILABLE", "declared native binary file is missing");
      }
      if (!dll_paths::IsOrdinaryTreePath(root, target)) {
        return fail("DLL_PATH_INVALID", "declared native binary path contains reparse point or escapes root");
      }
      dll_paths::UniqueHandle handle;
      std::uint64_t actual_size = 0;
      if (!dll_paths::OpenOrdinaryFile(target, kMaxNativeBinaryBytes, handle, actual_size)) {
        return fail("DLL_UNAVAILABLE", "declared native binary file cannot be opened");
      }
      if (!dll_paths::FinalHandleIsWithinRoot(handle.Get(), plugin_dir)) {
        return fail("DLL_PATH_INVALID", "declared native binary handle escaped plugin directory");
      }

      if (entry.role == TrustFileRole::Main || entry.role == TrustFileRole::Dependency) {
        if (!dll_paths::IsX86Pe(handle.Get(), actual_size)) {
          return fail("DLL_ARCH_INVALID", "main or dependency binary is not a valid x86 DLL");
        }
      } else {
        std::uint16_t machine = 0;
        bool is_dll = false;
        if (!dll_paths::PeMachineOf(handle.Get(), actual_size, machine, is_dll)) {
          return fail("DLL_ARCH_INVALID", "helper binary is not a valid PE image");
        }
        const bool arch_match = (entry.arch == TrustFileArch::X86 && machine == IMAGE_FILE_MACHINE_I386) ||
          (entry.arch == TrustFileArch::X64 && machine == IMAGE_FILE_MACHINE_AMD64);
        if (!arch_match) {
          return fail("DLL_ARCH_INVALID", "helper binary architecture does not match manifest");
        }
      }

      std::array<std::uint8_t, kSha256Bytes> actual_sha{};
      if (actual_size != entry.size || !Sha256File(handle.Get(), actual_sha) ||
          !ConstantTimeEqualBytes(actual_sha, entry.sha256)) {
        SecureEraseBytes(actual_sha);
        return fail("DLL_INTEGRITY", "native binary file size or sha256 mismatch");
      }
      if (bundle.revocations.revoked_file_sha256.contains(actual_sha)) {
        SecureEraseBytes(actual_sha);
        return fail("MANIFEST_REVOKED", "native binary file sha256 has been revoked");
      }
      SecureEraseBytes(actual_sha);

      if (&entry == matched_main) {
        result.main_path = target;
      }
      VerifiedFileHandle locked;
      locked.role = entry.role;
      locked.arch = entry.arch;
      locked.relative_path = entry.relative_path;
      locked.full_path = std::move(target);
      locked.size = actual_size;
      locked.sha256 = entry.sha256;
      locked.handle = std::move(handle);
      result.files.push_back(std::move(locked));
    }

    // A.13 Normal 模式补充递归唯一性双闸校验
    if constexpr (Mode == TrustMode::Normal) {
      detail::LegacyPathProbeResult probe =
        dll_paths::Resolve<detail::LegacyPathProbeResult>(root, plugin_id, dll_id, function_name);
      if (!probe.success) {
        return fail(probe.code.c_str(), probe.message.c_str());
      }
      if (!dll_paths::SamePathOrdinal(probe.path, result.main_path)) {
        return fail("DLL_PATH_INVALID", "dll path does not match signed manifest main entry");
      }
    }

    result.success = true;
    return result;
  }

  // 分支 B：无签名文件 → 旧版本原生插件兼容放行（不走新验签逻辑，但保留路径安全、PE 合法性与吊销黑名单校验）
  if (!allow_legacy) {
    return fail("DLL_NOT_ALLOWED", "unsigned native dll is not allowed");
  }
  if constexpr (Mode == TrustMode::Privileged) {
    const std::string main_rel = "lib/" + dll_id + ".dll";
    std::wstring main_target;
    if (!dll_paths::ValidateRelativePath(root, plugin_id, main_rel, true, true, main_target)) {
      return fail("DLL_PATH_INVALID", "legacy privileged dll path is invalid");
    }
    if (detail::HasUnsafeAncestorDirectory(root, main_target)) {
      return fail("DLL_PATH_INVALID", "legacy privileged dll ancestor directory contains reparse point or is invalid");
    }
    const DWORD main_attr = GetFileAttributesW(main_target.c_str());
    if (main_attr == INVALID_FILE_ATTRIBUTES) {
      return fail("DLL_UNAVAILABLE", "legacy privileged dll file is missing");
    }
    if (!dll_paths::IsOrdinaryTreePath(root, main_target)) {
      return fail("DLL_PATH_INVALID", "legacy privileged dll path contains reparse point or escapes root");
    }
    dll_paths::UniqueHandle main_handle;
    std::uint64_t main_size = 0;
    if (!dll_paths::OpenOrdinaryFile(main_target, kMaxNativeBinaryBytes, main_handle, main_size)) {
      return fail("DLL_UNAVAILABLE", "legacy privileged dll file cannot be opened");
    }
    if (!dll_paths::FinalHandleIsWithinRoot(main_handle.Get(), plugin_dir)) {
      return fail("DLL_PATH_INVALID", "legacy privileged dll handle escaped plugin directory");
    }
    if (!dll_paths::IsX86Pe(main_handle.Get(), main_size)) {
      return fail("DLL_ARCH_INVALID", "legacy privileged main binary is not a valid x86 DLL");
    }
    std::array<std::uint8_t, kSha256Bytes> main_sha{};
    if (!Sha256File(main_handle.Get(), main_sha)) {
      SecureEraseBytes(main_sha);
      return fail("DLL_UNAVAILABLE", "failed to hash legacy privileged dll");
    }
    if (bundle.revocations.revoked_file_sha256.contains(main_sha)) {
      SecureEraseBytes(main_sha);
      return fail("MANIFEST_REVOKED", "legacy privileged dll sha256 has been revoked");
    }

    VerifyResult result;
    result.from_legacy = true;
    result.restrict_functions = false;
    result.plugin_id = plugin_id;
    result.main_path = main_target;

    VerifiedFileHandle main_file;
    main_file.role = TrustFileRole::Main;
    main_file.arch = TrustFileArch::X86;
    main_file.relative_path = main_rel;
    main_file.full_path = main_target;
    main_file.size = main_size;
    main_file.sha256 = main_sha;
    main_file.handle = std::move(main_handle);
    result.files.push_back(std::move(main_file));

    // 同步纳入 lib/ 同级普通伴生 PE（如 ContextMenuScanner.exe），确保快照目录执行时依赖完整
    const std::wstring lib_dir = plugin_dir + L"\\lib";
    WIN32_FIND_DATAW fd{};
    HANDLE find = FindFirstFileW((lib_dir + L"\\*").c_str(), &fd);
    if (find != INVALID_HANDLE_VALUE) {
      do {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
            (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
          continue;
        }
        std::string entry_name;
        if (!dll_paths::WideToUtf8(std::wstring(fd.cFileName), entry_name) || entry_name.empty()) {
          continue;
        }
        const std::string lower_name = dll_paths::LowerAscii(entry_name);
        const bool is_dll_ext = lower_name.size() > 4 && lower_name.ends_with(".dll");
        const bool is_exe_ext = lower_name.size() > 4 && lower_name.ends_with(".exe");
        if (!is_dll_ext && !is_exe_ext) continue;
        const std::string rel = "lib/" + entry_name;
        if (dll_paths::LowerAscii(rel) == dll_paths::LowerAscii(main_rel)) continue;

        std::wstring companion_target;
        if (!dll_paths::ValidateRelativePath(root, plugin_id, rel, true, false, companion_target) ||
            !dll_paths::IsOrdinaryTreePath(root, companion_target)) {
          continue;
        }
        dll_paths::UniqueHandle comp_handle;
        std::uint64_t comp_size = 0;
        if (!dll_paths::OpenOrdinaryFile(companion_target, kMaxNativeBinaryBytes, comp_handle, comp_size) ||
            !dll_paths::FinalHandleIsWithinRoot(comp_handle.Get(), plugin_dir)) {
          continue;
        }
        std::uint16_t machine = 0;
        bool is_pe_dll = false;
        if (!dll_paths::PeMachineOf(comp_handle.Get(), comp_size, machine, is_pe_dll) ||
            (machine != IMAGE_FILE_MACHINE_I386 && machine != IMAGE_FILE_MACHINE_AMD64)) {
          continue;
        }
        std::array<std::uint8_t, kSha256Bytes> comp_sha{};
        if (!Sha256File(comp_handle.Get(), comp_sha)) {
          SecureEraseBytes(comp_sha);
          continue;
        }
        if (bundle.revocations.revoked_file_sha256.contains(comp_sha)) {
          SecureEraseBytes(comp_sha);
          FindClose(find);
          SecureEraseBytes(main_sha);
          return fail("MANIFEST_REVOKED", "legacy privileged companion binary sha256 has been revoked");
        }
        VerifiedFileHandle comp_file;
        comp_file.role = is_dll_ext ? TrustFileRole::Dependency : TrustFileRole::Helper;
        comp_file.arch = (machine == IMAGE_FILE_MACHINE_AMD64) ? TrustFileArch::X64 : TrustFileArch::X86;
        comp_file.relative_path = rel;
        comp_file.full_path = std::move(companion_target);
        comp_file.size = comp_size;
        comp_file.sha256 = comp_sha;
        comp_file.handle = std::move(comp_handle);
        result.files.push_back(std::move(comp_file));
        SecureEraseBytes(comp_sha);
      } while (FindNextFileW(find, &fd) != FALSE);
      FindClose(find);
    }

    // 基于纳入快照的全部文件相对路径与摘要生成确定性快照键
    std::vector<std::string> digest_parts;
    digest_parts.reserve(result.files.size());
    for (const auto& f : result.files) {
      digest_parts.push_back(dll_paths::LowerAscii(f.relative_path) + ":" + BytesToLowerHex(f.sha256));
    }
    std::sort(digest_parts.begin(), digest_parts.end());
    std::string combined;
    for (const auto& part : digest_parts) {
      combined += part;
      combined.push_back('\n');
    }
    std::array<std::uint8_t, kSha256Bytes> snap_key{};
    const std::span<const std::uint8_t> combined_bytes(
      reinterpret_cast<const std::uint8_t*>(combined.data()), combined.size());
    if (Sha256Bytes(combined_bytes, snap_key)) {
      result.manifest_sha256_hex = BytesToLowerHex(snap_key);
      SecureEraseBytes(snap_key);
    } else {
      result.manifest_sha256_hex = BytesToLowerHex(main_sha);
    }
    SecureEraseBytes(main_sha);
    result.success = true;
    return result;
  } else {
    detail::LegacyPathProbeResult probe =
      dll_paths::Resolve<detail::LegacyPathProbeResult>(root, plugin_id, dll_id, function_name);
    if (!probe.success) {
      return fail(probe.code.c_str(), probe.message.c_str());
    }
    std::array<std::uint8_t, kSha256Bytes> actual_sha{};
    if (!Sha256File(probe.validation_handle, actual_sha)) {
      SecureEraseBytes(actual_sha);
      return fail("DLL_UNAVAILABLE", "failed to hash legacy dll");
    }
    if (bundle.revocations.revoked_file_sha256.contains(actual_sha)) {
      SecureEraseBytes(actual_sha);
      return fail("MANIFEST_REVOKED", "legacy dll sha256 has been revoked");
    }

    VerifyResult result;
    result.success = true;
    result.from_legacy = true;
    result.restrict_functions = false;
    result.plugin_id = plugin_id;
    result.main_path = probe.path;
    VerifiedFileHandle main_file;
    main_file.role = TrustFileRole::Main;
    main_file.arch = TrustFileArch::X86;
    main_file.full_path = std::move(probe.path);
    main_file.sha256 = actual_sha;
    main_file.handle = dll_paths::UniqueHandle(probe.validation_handle);
    probe.validation_handle = INVALID_HANDLE_VALUE;
    result.files.push_back(std::move(main_file));
    SecureEraseBytes(actual_sha);
    return result;
  }
}

}  // namespace ztools::native_trust
