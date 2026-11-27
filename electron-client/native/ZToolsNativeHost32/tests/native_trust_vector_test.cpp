#include "../../shared/native_trust_verifier.hpp"

#include <Windows.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

bool ReadAllText(const std::wstring& path, std::string& out) {
  std::ifstream ifs(path, std::ios::binary);
  if (!ifs) return false;
  std::ostringstream ss;
  ss << ifs.rdbuf();
  out = ss.str();
  return true;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  using namespace ztools::native_trust;

  // 1. SemVer 边界检查
  {
    SemVer a, b, c;
    if (!ParseSemVer("1.2.3-alpha.1", a) || !ParseSemVer("1.2.3", b) || !ParseSemVer("1.2.3-alpha.2", c)) {
      std::cerr << "SemVer parse failed\n";
      return 1;
    }
    if (!(CompareSemVer(a, b) < 0 && CompareSemVer(a, c) < 0 && CompareSemVer(b, b) == 0)) {
      std::cerr << "SemVer compare failed\n";
      return 2;
    }
    SemVer bad;
    if (ParseSemVer("01.0.0", bad) || ParseSemVer("1.0.0-01", bad) || ParseSemVer("1.2", bad)) {
      std::cerr << "SemVer invalid accepted\n";
      return 3;
    }
  }

  // 2. 受限 JSON 解析器边界检查
  {
    JsonValue v;
    if (ParseStrictJson("\xef\xbb\xbf{\"a\":1}", v)) return 4;
    if (ParseStrictJson("{\"a\":1,\"a\":2}", v)) return 5;
    if (ParseStrictJson("{\"a\":-1}", v)) return 6;
    if (ParseStrictJson("{\"a\":1.5}", v)) return 7;
    if (ParseStrictJson("{\"a\":\"\\uD800\"}", v)) return 8;
    if (ParseStrictJson("{\"a\":\"\\x41\"}", v)) return 9;
    std::string deep = "{\"a\":";
    for (int i = 0; i < 64; ++i) deep += "[";
    deep += "1";
    for (int i = 0; i < 64; ++i) deep += "]";
    deep += "}";
    if (ParseStrictJson(deep, v)) return 10;
  }

  // 3. 跨语言黄金向量验收（与 Node.js sign-native-trust.mjs 字节对齐）
  if (argc < 2) {
    std::cerr << "Usage: ZToolsNativeTrustVectorTest <path-to-vectors.json>\n";
    return 11;
  }

  std::string raw_file;
  if (!ReadAllText(argv[1], raw_file)) {
    std::cerr << "Failed to read vectors.json\n";
    return 12;
  }

  // 解析外层向量集：使用简单受限解析（深度 <= 5，字符串可能超过 4096 吗？manifestJson 约 700 字节 < 4096）
  JsonValue root;
  if (!ParseStrictJson(raw_file, root)) {
    std::cerr << "Failed to parse vectors.json with ParseStrictJson\n";
    return 13;
  }

  const JsonValue* pub_keys_node = root.Find("publicKeys");
  const JsonValue* vectors_node = root.Find("vectors");
  if (!pub_keys_node || pub_keys_node->type != JsonType::Array ||
      !vectors_node || vectors_node->type != JsonType::Object) {
    std::cerr << "Malformed vectors.json structure\n";
    return 14;
  }

  std::vector<TrustPublicKey> keys;
  for (const auto& item : pub_keys_node->array_value) {
    const JsonValue* kid = item.Find("keyId");
    const JsonValue* hex = item.Find("publicKeyHex");
    const JsonValue* usages = item.Find("usages");
    if (!kid || !hex || !usages || usages->type != JsonType::Array) return 15;
    TrustPublicKey k;
    k.key_id = kid->string_value;
    if (!ztools::dll_paths::ParseHexAscii(hex->string_value, k.pub_xy)) return 16;
    for (const auto& u : usages->array_value) {
      if (u.string_value == "native") k.allow_native = true;
      if (u.string_value == "native-privileged") k.allow_privileged = true;
    }
    keys.push_back(std::move(k));
  }

  TrustRevocations empty_revocations;
  auto run_vector = [&](const char* name, TrustMode mode, bool expect_ok, const char* expected_code) -> bool {
    const JsonValue* v = vectors_node->Find(name);
    if (!v) {
      std::cerr << "Missing vector: " << name << "\n";
      return false;
    }
    const JsonValue* mj = v->Find("manifestJson");
    const JsonValue* sl = v->Find("signatureLine");
    if (!mj || !sl) return false;
    const std::span<const std::uint8_t> raw_bytes(
      reinterpret_cast<const std::uint8_t*>(mj->string_value.data()),
      mj->string_value.size());
    PayloadVerifyResult res = VerifySignedPayload(raw_bytes, sl->string_value, mode, keys, empty_revocations);
    if (res.success != expect_ok) {
      std::cerr << "Vector " << name << " unexpected success=" << res.success
                << " code=" << res.code << " msg=" << res.message << "\n";
      return false;
    }
    if (!expect_ok && res.code != expected_code) {
      std::cerr << "Vector " << name << " expected code=" << expected_code
                << " actual=" << res.code << "\n";
      return false;
    }
    return true;
  };

  if (!run_vector("validNormal", TrustMode::Normal, true, "")) return 20;
  if (!run_vector("validPrivileged", TrustMode::Privileged, true, "")) return 21;
  if (!run_vector("tamperedPayload", TrustMode::Normal, false, "MANIFEST_UNTRUSTED")) return 22;
  if (!run_vector("duplicateKey", TrustMode::Normal, false, "MANIFEST_INVALID")) return 23;
  if (!run_vector("deepNesting", TrustMode::Normal, false, "MANIFEST_INVALID")) return 24;
  if (!run_vector("unknownField", TrustMode::Normal, false, "MANIFEST_INVALID")) return 25;
  if (!run_vector("malformedSig", TrustMode::Normal, false, "MANIFEST_INVALID")) return 26;
  if (!run_vector("keyIdMismatch", TrustMode::Normal, false, "MANIFEST_INVALID")) return 27;
  if (!run_vector("wrongUsage", TrustMode::Privileged, false, "MANIFEST_UNTRUSTED")) return 28;

  std::cout << "{\"success\":true,\"vectors\":9}\n";
  return 0;
}
