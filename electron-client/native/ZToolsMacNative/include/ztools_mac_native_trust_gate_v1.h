#ifndef ZTOOLS_MAC_NATIVE_TRUST_GATE_V1_H
#define ZTOOLS_MAC_NATIVE_TRUST_GATE_V1_H

#include "ztools_mac_native_abi.h"

#include <stdint.h>

typedef enum zt_mac_native_trust_status_v1 {
  ZT_MAC_TRUST_SIGNATURE_INVALID = 1,
  ZT_MAC_TRUST_POLICY_INVALID = 2,
  ZT_MAC_TRUST_ADMIN_NATIVE_DENIED = 3,
  ZT_MAC_TRUST_IDENTITY_MISMATCH = 4,
  ZT_MAC_TRUST_SHA256_MISMATCH = 5,
  ZT_MAC_TRUST_ARCHITECTURE_INVALID = 6,
  ZT_MAC_TRUST_DEPENDENCY_CLOSURE_UNPROVEN = 7,
  ZT_MAC_TRUST_SAME_OBJECT_LOAD_UNPROVEN = 8,
  ZT_MAC_TRUST_PREFLIGHT_OK = 9,
  ZT_MAC_TRUST_HOST_IDENTITY_INVALID = 10,
  ZT_MAC_TRUST_HARDENED_RUNTIME_REQUIRED = 11,
  ZT_MAC_TRUST_COMPONENT_READY = 12,
} zt_mac_native_trust_status_v1;

typedef struct zt_mac_native_trust_request_v1 {
  uint32_t struct_size;
  uint32_t require_admin;
  const uint8_t* plugin_root_utf8;
  uint32_t plugin_root_length;
  const uint8_t* plugin_id_utf8;
  uint32_t plugin_id_length;
  const uint8_t* relative_path_utf8;
  uint32_t relative_path_length;
  const uint8_t* approved_team_id_utf8;
  uint32_t approved_team_id_length;
  const uint8_t* approved_app_path_utf8;
  uint32_t approved_app_path_length;
  const uint8_t* approved_app_bundle_identifier_utf8;
  uint32_t approved_app_bundle_identifier_length;
  const uint8_t* expected_runtime_identifier_utf8;
  uint32_t expected_runtime_identifier_length;
  const uint8_t* expected_component_identifier_utf8;
  uint32_t expected_component_identifier_length;
  const uint8_t* expected_sha256_hex_utf8;
  uint32_t expected_sha256_hex_length;
  const uint8_t* expected_architecture_utf8;
  uint32_t expected_architecture_length;
  const uint8_t* approved_minimum_os_utf8;
  uint32_t approved_minimum_os_length;
} zt_mac_native_trust_request_v1;

typedef struct zt_mac_native_trust_result_v1 {
  uint32_t struct_size;
  uint32_t status;
  int32_t security_status;
  uint32_t signature_validated;
  uint32_t all_architectures_validated;
  uint32_t selected_architecture_validated;
  uint32_t identifier_matched;
  uint32_t team_id_matched;
  uint32_t manifest_sha256_matched;
  uint32_t dependency_closure_validated;
  uint32_t same_object_load_proven;
  uint32_t may_load;
} zt_mac_native_trust_result_v1;

typedef struct zt_mac_native_loaded_component_v1 {
  void* library_handle;
  const zt_mac_native_api_v1* api;
  zt_mac_native_api_v1* api_snapshot;
  uint32_t abi_version;
  uint32_t initialized;
  int32_t pinned_descriptor;
} zt_mac_native_loaded_component_v1;

/* Preflight validates a pinned file descriptor but never authorizes load. */
uint32_t zt_mac_native_validate_candidate_v1(const zt_mac_native_trust_request_v1* request,
                                             zt_mac_native_trust_result_v1* result);

/* Production load gate. Static trust preflight is retained, but successful preflight is rejected
 * until same-object identity can be proven before dyld runs any component initializer. */
uint32_t zt_mac_native_load_candidate_v1(const zt_mac_native_trust_request_v1* request,
                                         zt_mac_native_trust_result_v1* result,
                                         zt_mac_native_loaded_component_v1* loaded);
void zt_mac_native_unload_candidate_v1(zt_mac_native_loaded_component_v1* loaded);

#endif
