#include "ztools_mac_native_trust_gate_v1.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

namespace {

int checks = 0;

bool expect(bool condition, const char* code) {
  if (!condition) {
    std::cerr << code << '\n';
    return false;
  }
  ++checks;
  return true;
}

zt_mac_native_trust_request_v1 makeRequest(uint32_t requireAdmin) {
  static const uint8_t path[] = "/__ztools_native_trust_gate_missing_root__";
  static const uint8_t plugin[] = "fixture-plugin";
  static const uint8_t relativePath[] = "lib/fixture-native.dylib";
  static const uint8_t team[] = "ABCDE12345";
  static const uint8_t appPath[] = "/__ztools_native_trust_gate_missing_app__.app";
  static const uint8_t appIdentifier[] = "com.example.ztools";
  static const uint8_t runtimeIdentifier[] = "com.example.ztools.native-worker";
  static const uint8_t identifier[] = "com.example.ztools.fixture";
  static const uint8_t sha256[] = "0000000000000000000000000000000000000000000000000000000000000000";
#if defined(__arm64__)
  static const uint8_t architecture[] = "arm64";
#else
  static const uint8_t architecture[] = "x86_64";
#endif
  static const uint8_t minimumOs[] = "13.0";
  return {
      static_cast<uint32_t>(sizeof(zt_mac_native_trust_request_v1)),
      requireAdmin,
      path,
      static_cast<uint32_t>(sizeof(path) - 1),
      plugin,
      static_cast<uint32_t>(sizeof(plugin) - 1),
      relativePath,
      static_cast<uint32_t>(sizeof(relativePath) - 1),
      team,
      static_cast<uint32_t>(sizeof(team) - 1),
      appPath,
      static_cast<uint32_t>(sizeof(appPath) - 1),
      appIdentifier,
      static_cast<uint32_t>(sizeof(appIdentifier) - 1),
      runtimeIdentifier,
      static_cast<uint32_t>(sizeof(runtimeIdentifier) - 1),
      identifier,
      static_cast<uint32_t>(sizeof(identifier) - 1),
      sha256,
      static_cast<uint32_t>(sizeof(sha256) - 1),
      architecture,
      static_cast<uint32_t>(sizeof(architecture) - 1),
      minimumOs,
      static_cast<uint32_t>(sizeof(minimumOs) - 1),
  };
}

int fail() {
  std::cout << "{\"status\":\"FAIL\",\"scope\":\"darwin-trust-gate-fail-closed-contract\"}\n";
  return 1;
}

}  // namespace

int main() {
  zt_mac_native_trust_result_v1 result{};
  if (!expect(zt_mac_native_validate_candidate_v1(nullptr, &result) == ZT_MAC_TRUST_POLICY_INVALID,
              "TRUST_NULL_REQUEST_NOT_REJECTED") ||
      !expect(result.may_load == 0, "TRUST_NULL_REQUEST_MAY_LOAD")) {
    return fail();
  }
  zt_mac_native_loaded_component_v1 loaded{};
  if (!expect(zt_mac_native_load_candidate_v1(nullptr, &result, &loaded) == ZT_MAC_TRUST_POLICY_INVALID,
              "TRUST_LOAD_NULL_REQUEST_NOT_REJECTED") ||
      !expect(loaded.library_handle == nullptr && loaded.api == nullptr && loaded.pinned_descriptor == -1,
              "TRUST_LOAD_NULL_REQUEST_LEFT_COMPONENT_LOADED")) {
    return fail();
  }

  zt_mac_native_trust_request_v1 admin = makeRequest(1);
  if (!expect(zt_mac_native_validate_candidate_v1(&admin, &result) == ZT_MAC_TRUST_ADMIN_NATIVE_DENIED,
              "TRUST_ADMIN_NATIVE_NOT_DENIED") ||
      !expect(result.may_load == 0 && result.signature_validated == 0,
              "TRUST_ADMIN_REACHED_SIGNATURE_OR_LOAD")) {
    return fail();
  }
  if (!expect(zt_mac_native_load_candidate_v1(&admin, &result, &loaded) == ZT_MAC_TRUST_ADMIN_NATIVE_DENIED,
              "TRUST_LOAD_ADMIN_NATIVE_NOT_DENIED") ||
      !expect(loaded.library_handle == nullptr && loaded.api == nullptr && loaded.pinned_descriptor == -1,
              "TRUST_LOAD_ADMIN_LEFT_COMPONENT_LOADED")) {
    return fail();
  }

  zt_mac_native_trust_request_v1 invalid = makeRequest(0);
  static const uint8_t invalidArchitecture[] = "i386";
  invalid.expected_architecture_utf8 = invalidArchitecture;
  invalid.expected_architecture_length = sizeof(invalidArchitecture) - 1;
  if (!expect(zt_mac_native_validate_candidate_v1(&invalid, &result) == ZT_MAC_TRUST_ARCHITECTURE_INVALID,
              "TRUST_INVALID_ARCHITECTURE_NOT_REJECTED") ||
      !expect(result.may_load == 0, "TRUST_INVALID_ARCHITECTURE_MAY_LOAD")) {
    return fail();
  }

  zt_mac_native_trust_request_v1 missing = makeRequest(0);
  const uint32_t status = zt_mac_native_validate_candidate_v1(&missing, &result);
  if (!expect(status == ZT_MAC_TRUST_HOST_IDENTITY_INVALID, "TRUST_UNSIGNED_RUNTIME_NOT_REJECTED") ||
      !expect(result.may_load == 0 && result.same_object_load_proven == 0 &&
                  result.dependency_closure_validated == 0,
              "TRUST_UNPROVEN_COMPONENT_AUTHORIZED")) {
    return fail();
  }

  std::cout << "{\"status\":\"PASS\",\"scope\":\"darwin-trust-gate-fail-closed-contract\",\"checks\":"
            << checks << ",\"validSignedComponent\":\"NOT_RUN\",\"componentLoad\":\"BLOCKED_SAME_OBJECT_LOAD_UNPROVEN\"}\n";
  return 0;
}
