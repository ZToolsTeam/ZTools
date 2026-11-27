cmake_minimum_required(VERSION 3.24)

project(ZToolsNativeComponents LANGUAGES CXX RC)

if(NOT WIN32)
  message(FATAL_ERROR "ZTools native components only support Windows")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
  message(FATAL_ERROR "ZTools native components must be built for Win32/ia32")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(ZTOOLS_BUILD_NATIVE_TEST_FIXTURE "Build the NativeHost32 ABI test fixture" OFF)
option(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS "Build the Service manifest test probe" OFF)

# 原生信任根 JSON 输入路径（允许通过 -D 覆写；开源仓缺失时生成空表 Fail-Closed，存在但非法时 FATAL_ERROR）
set(ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON
  "${CMAKE_CURRENT_SOURCE_DIR}/../resources/native/native-trust-public-keys.json"
  CACHE FILEPATH "Path to native-trust-public-keys.json")
set(ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON
  "${CMAKE_CURRENT_SOURCE_DIR}/../resources/native/native-trust-revocations.json"
  CACHE FILEPATH "Path to native-trust-revocations.json")
set(ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON
  "${CMAKE_CURRENT_SOURCE_DIR}/../resources/native/legacy-frozen-dlls.json"
  CACHE FILEPATH "Path to legacy-frozen-dlls.json")

function(ztools_escape_cxx_string input_str out_var)
  # 拒绝包含 \r、\n 或任意 ASCII 控制字符（0x00-0x1F、0x7F）的字符串，防止破坏生成的 C++ 头文件
  string(HEX "${input_str}" _hex_bytes)
  string(LENGTH "${_hex_bytes}" _hex_len)
  if(_hex_len GREATER 0)
    math(EXPR _hex_last "${_hex_len} - 2")
    foreach(_hex_pos RANGE 0 ${_hex_last} 2)
      string(SUBSTRING "${_hex_bytes}" ${_hex_pos} 2 _byte_hex)
      if(_byte_hex MATCHES "^(0[0-9a-f]|1[0-9a-f]|7f)$")
        message(FATAL_ERROR "Control character (0x${_byte_hex}) is not allowed in embedded native trust string")
      endif()
    endforeach()
  endif()
  string(REPLACE "\\" "\\\\" escaped "${input_str}")
  string(REPLACE "\"" "\\\"" escaped "${escaped}")
  set(${out_var} "${escaped}" PARENT_SCOPE)
endfunction()

set(_ZTOOLS_PK_CANON "[]")
set(_ZTOOLS_PK_CPP_LINES "")
if(EXISTS "${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
  file(READ "${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}" _ZTOOLS_PK_RAW)
  string(REPLACE "\r\n" "\n" _ZTOOLS_PK_CANON "${_ZTOOLS_PK_RAW}")
  string(STRIP "${_ZTOOLS_PK_CANON}" _ZTOOLS_PK_CANON)
  string(JSON _ZTOOLS_PK_TYPE ERROR_VARIABLE _ZTOOLS_JSON_ERR TYPE "${_ZTOOLS_PK_RAW}")
  if(NOT _ZTOOLS_JSON_ERR STREQUAL "NOTFOUND" OR NOT _ZTOOLS_PK_TYPE STREQUAL "ARRAY")
    message(FATAL_ERROR "Invalid JSON array in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}: ${_ZTOOLS_JSON_ERR}")
  endif()
  string(JSON _ZTOOLS_PK_LEN LENGTH "${_ZTOOLS_PK_RAW}")
  if(_ZTOOLS_PK_LEN GREATER 0)
    math(EXPR _ZTOOLS_PK_LAST "${_ZTOOLS_PK_LEN} - 1")
    foreach(_idx RANGE 0 ${_ZTOOLS_PK_LAST})
      string(JSON _entry_type ERROR_VARIABLE _e0 TYPE "${_ZTOOLS_PK_RAW}" ${_idx})
      if(NOT _e0 STREQUAL "NOTFOUND" OR NOT _entry_type STREQUAL "OBJECT")
        message(FATAL_ERROR "Public key entry #${_idx} must be an object in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
      endif()
      string(JSON _kid_type ERROR_VARIABLE _e1_t TYPE "${_ZTOOLS_PK_RAW}" ${_idx} keyId)
      string(JSON _kid ERROR_VARIABLE _e1 GET "${_ZTOOLS_PK_RAW}" ${_idx} keyId)
      string(JSON _hex_type ERROR_VARIABLE _e2_t TYPE "${_ZTOOLS_PK_RAW}" ${_idx} publicKeyHex)
      string(JSON _hex ERROR_VARIABLE _e2 GET "${_ZTOOLS_PK_RAW}" ${_idx} publicKeyHex)
      string(JSON _usages_type ERROR_VARIABLE _e3 TYPE "${_ZTOOLS_PK_RAW}" ${_idx} usages)
      if(NOT _e1_t STREQUAL "NOTFOUND" OR NOT _e1 STREQUAL "NOTFOUND" OR NOT _kid_type STREQUAL "STRING" OR
         NOT _e2_t STREQUAL "NOTFOUND" OR NOT _e2 STREQUAL "NOTFOUND" OR NOT _hex_type STREQUAL "STRING" OR
         NOT _e3 STREQUAL "NOTFOUND" OR NOT _usages_type STREQUAL "ARRAY")
        message(FATAL_ERROR "Malformed public key entry #${_idx} in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
      endif()
      string(LENGTH "${_kid}" _kid_len)
      if(NOT _kid_len GREATER 0)
        message(FATAL_ERROR "Public key entry #${_idx} keyId must be a non-empty string in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
      endif()
      string(LENGTH "${_hex}" _hex_len)
      if(NOT _hex_len EQUAL 128 OR NOT _hex MATCHES "^[0-9a-f]+$")
        message(FATAL_ERROR "Invalid publicKeyHex in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON} entry #${_idx}")
      endif()
      set(_allow_native "false")
      set(_allow_priv "false")
      string(JSON _ulen LENGTH "${_ZTOOLS_PK_RAW}" ${_idx} usages)
      if(NOT _ulen GREATER 0)
        message(FATAL_ERROR "Public key entry #${_idx} usages must be a non-empty array in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
      endif()
      math(EXPR _ulast "${_ulen} - 1")
      foreach(_ui RANGE 0 ${_ulast})
        string(JSON _uval_type ERROR_VARIABLE _eu_t TYPE "${_ZTOOLS_PK_RAW}" ${_idx} usages ${_ui})
        string(JSON _uval ERROR_VARIABLE _eu GET "${_ZTOOLS_PK_RAW}" ${_idx} usages ${_ui})
        if(NOT _eu_t STREQUAL "NOTFOUND" OR NOT _eu STREQUAL "NOTFOUND" OR NOT _uval_type STREQUAL "STRING")
          message(FATAL_ERROR "Public key entry #${_idx} usage #${_ui} must be a string in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
        endif()
        if(_uval STREQUAL "native")
          set(_allow_native "true")
        elseif(_uval STREQUAL "native-privileged")
          set(_allow_priv "true")
        elseif(NOT _uval STREQUAL "commonlibs")
          message(FATAL_ERROR "Unknown key usage '${_uval}' in ${ZTOOLS_NATIVE_TRUST_PUBLIC_KEYS_JSON}")
        endif()
      endforeach()
      ztools_escape_cxx_string("${_kid}" _kid_esc)
      string(APPEND _ZTOOLS_PK_CPP_LINES "  AddPublicKey(bundle, \"${_kid_esc}\", \"${_hex}\", ${_allow_native}, ${_allow_priv});\n")
    endforeach()
  endif()
endif()

set(_ZTOOLS_REV_CANON "{\"schemaVersion\":1,\"revokedKeyIds\":[],\"revokedManifestSha256\":[],\"revokedFileSha256\":[],\"minPluginVersions\":{}}")
set(_ZTOOLS_REV_CPP_LINES "")
if(EXISTS "${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  file(READ "${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}" _ZTOOLS_REV_RAW)
  string(REPLACE "\r\n" "\n" _ZTOOLS_REV_CANON "${_ZTOOLS_REV_RAW}")
  string(STRIP "${_ZTOOLS_REV_CANON}" _ZTOOLS_REV_CANON)
  string(JSON _ZTOOLS_REV_TYPE ERROR_VARIABLE _ZTOOLS_JSON_ERR TYPE "${_ZTOOLS_REV_RAW}")
  if(NOT _ZTOOLS_JSON_ERR STREQUAL "NOTFOUND" OR NOT _ZTOOLS_REV_TYPE STREQUAL "OBJECT")
    message(FATAL_ERROR "Invalid JSON object in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}: ${_ZTOOLS_JSON_ERR}")
  endif()
  string(JSON _rev_schema_type ERROR_VARIABLE _es_t TYPE "${_ZTOOLS_REV_RAW}" schemaVersion)
  string(JSON _rev_schema ERROR_VARIABLE _es GET "${_ZTOOLS_REV_RAW}" schemaVersion)
  if(NOT _es_t STREQUAL "NOTFOUND" OR NOT _es STREQUAL "NOTFOUND" OR
     NOT _rev_schema_type STREQUAL "NUMBER" OR NOT _rev_schema MATCHES "^1$" OR NOT _rev_schema EQUAL 1)
    message(FATAL_ERROR "revocations schemaVersion must be number 1 in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()

  string(JSON _rk_type ERROR_VARIABLE _e_rk_t TYPE "${_ZTOOLS_REV_RAW}" revokedKeyIds)
  if(NOT _e_rk_t STREQUAL "NOTFOUND" OR NOT _rk_type STREQUAL "ARRAY")
    message(FATAL_ERROR "revokedKeyIds must be an array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  string(JSON _rk_len ERROR_VARIABLE _e_rk LENGTH "${_ZTOOLS_REV_RAW}" revokedKeyIds)
  if(NOT _e_rk STREQUAL "NOTFOUND")
    message(FATAL_ERROR "Missing revokedKeyIds array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  if(_rk_len GREATER 0)
    math(EXPR _rk_last "${_rk_len} - 1")
    foreach(_idx RANGE 0 ${_rk_last})
      string(JSON _rk_item_type ERROR_VARIABLE _e_rk_it TYPE "${_ZTOOLS_REV_RAW}" revokedKeyIds ${_idx})
      string(JSON _rk ERROR_VARIABLE _e_rk_iv GET "${_ZTOOLS_REV_RAW}" revokedKeyIds ${_idx})
      if(NOT _e_rk_it STREQUAL "NOTFOUND" OR NOT _e_rk_iv STREQUAL "NOTFOUND" OR NOT _rk_item_type STREQUAL "STRING")
        message(FATAL_ERROR "revokedKeyIds entry #${_idx} must be a string in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(LENGTH "${_rk}" _rk_str_len)
      if(NOT _rk_str_len GREATER 0)
        message(FATAL_ERROR "revokedKeyIds entry #${_idx} must be non-empty in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      ztools_escape_cxx_string("${_rk}" _rk_esc)
      string(APPEND _ZTOOLS_REV_CPP_LINES "  bundle.revocations.revoked_key_ids.insert(\"${_rk_esc}\");\n")
    endforeach()
  endif()

  string(JSON _rm_type ERROR_VARIABLE _e_rm_t TYPE "${_ZTOOLS_REV_RAW}" revokedManifestSha256)
  if(NOT _e_rm_t STREQUAL "NOTFOUND" OR NOT _rm_type STREQUAL "ARRAY")
    message(FATAL_ERROR "revokedManifestSha256 must be an array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  string(JSON _rm_len ERROR_VARIABLE _e_rm LENGTH "${_ZTOOLS_REV_RAW}" revokedManifestSha256)
  if(NOT _e_rm STREQUAL "NOTFOUND")
    message(FATAL_ERROR "Missing revokedManifestSha256 array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  if(_rm_len GREATER 0)
    math(EXPR _rm_last "${_rm_len} - 1")
    foreach(_idx RANGE 0 ${_rm_last})
      string(JSON _rm_item_type ERROR_VARIABLE _e_rm_it TYPE "${_ZTOOLS_REV_RAW}" revokedManifestSha256 ${_idx})
      string(JSON _rm ERROR_VARIABLE _e_rm_iv GET "${_ZTOOLS_REV_RAW}" revokedManifestSha256 ${_idx})
      if(NOT _e_rm_it STREQUAL "NOTFOUND" OR NOT _e_rm_iv STREQUAL "NOTFOUND" OR NOT _rm_item_type STREQUAL "STRING")
        message(FATAL_ERROR "revokedManifestSha256 entry #${_idx} must be a string in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(LENGTH "${_rm}" _rm_str_len)
      if(NOT _rm_str_len EQUAL 64 OR NOT _rm MATCHES "^[0-9a-f]+$")
        message(FATAL_ERROR "Invalid revokedManifestSha256 entry in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(APPEND _ZTOOLS_REV_CPP_LINES "  AddRevokedManifestSha(bundle, \"${_rm}\");\n")
    endforeach()
  endif()

  string(JSON _rf_type ERROR_VARIABLE _e_rf_t TYPE "${_ZTOOLS_REV_RAW}" revokedFileSha256)
  if(NOT _e_rf_t STREQUAL "NOTFOUND" OR NOT _rf_type STREQUAL "ARRAY")
    message(FATAL_ERROR "revokedFileSha256 must be an array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  string(JSON _rf_len ERROR_VARIABLE _e_rf LENGTH "${_ZTOOLS_REV_RAW}" revokedFileSha256)
  if(NOT _e_rf STREQUAL "NOTFOUND")
    message(FATAL_ERROR "Missing revokedFileSha256 array in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  if(_rf_len GREATER 0)
    math(EXPR _rf_last "${_rf_len} - 1")
    foreach(_idx RANGE 0 ${_rf_last})
      string(JSON _rf_item_type ERROR_VARIABLE _e_rf_it TYPE "${_ZTOOLS_REV_RAW}" revokedFileSha256 ${_idx})
      string(JSON _rf ERROR_VARIABLE _e_rf_iv GET "${_ZTOOLS_REV_RAW}" revokedFileSha256 ${_idx})
      if(NOT _e_rf_it STREQUAL "NOTFOUND" OR NOT _e_rf_iv STREQUAL "NOTFOUND" OR NOT _rf_item_type STREQUAL "STRING")
        message(FATAL_ERROR "revokedFileSha256 entry #${_idx} must be a string in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(LENGTH "${_rf}" _rf_str_len)
      if(NOT _rf_str_len EQUAL 64 OR NOT _rf MATCHES "^[0-9a-f]+$")
        message(FATAL_ERROR "Invalid revokedFileSha256 entry in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(APPEND _ZTOOLS_REV_CPP_LINES "  AddRevokedFileSha(bundle, \"${_rf}\");\n")
    endforeach()
  endif()

  string(JSON _mv_type ERROR_VARIABLE _e_mv_t TYPE "${_ZTOOLS_REV_RAW}" minPluginVersions)
  if(NOT _e_mv_t STREQUAL "NOTFOUND" OR NOT _mv_type STREQUAL "OBJECT")
    message(FATAL_ERROR "minPluginVersions must be an object in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  string(JSON _mv_len ERROR_VARIABLE _e_mv LENGTH "${_ZTOOLS_REV_RAW}" minPluginVersions)
  if(NOT _e_mv STREQUAL "NOTFOUND")
    message(FATAL_ERROR "Missing minPluginVersions object in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
  endif()
  if(_mv_len GREATER 0)
    math(EXPR _mv_last "${_mv_len} - 1")
    foreach(_idx RANGE 0 ${_mv_last})
      string(JSON _mkey MEMBER "${_ZTOOLS_REV_RAW}" minPluginVersions ${_idx})
      string(JSON _mval_type ERROR_VARIABLE _e_mval_t TYPE "${_ZTOOLS_REV_RAW}" minPluginVersions "${_mkey}")
      string(JSON _mval ERROR_VARIABLE _e_mval GET "${_ZTOOLS_REV_RAW}" minPluginVersions "${_mkey}")
      if(NOT _e_mval_t STREQUAL "NOTFOUND" OR NOT _e_mval STREQUAL "NOTFOUND" OR NOT _mval_type STREQUAL "STRING")
        message(FATAL_ERROR "minPluginVersions['${_mkey}'] must be a string in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(LENGTH "${_mkey}" _mkey_len)
      string(LENGTH "${_mval}" _mval_len)
      if(NOT _mkey_len GREATER 0 OR NOT _mval_len GREATER 0)
        message(FATAL_ERROR "minPluginVersions entries must be non-empty strings in ${ZTOOLS_NATIVE_TRUST_REVOCATIONS_JSON}")
      endif()
      string(TOLOWER "${_mkey}" _mkey_lower)
      ztools_escape_cxx_string("${_mkey_lower}" _mkey_esc)
      ztools_escape_cxx_string("${_mval}" _mval_esc)
      string(APPEND _ZTOOLS_REV_CPP_LINES "  bundle.revocations.min_plugin_versions.emplace(\"${_mkey_esc}\", \"${_mval_esc}\");\n")
    endforeach()
  endif()
endif()

set(_ZTOOLS_FROZEN_CANON "[]")
set(_ZTOOLS_FROZEN_CPP_LINES "")
if(EXISTS "${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
  file(READ "${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}" _ZTOOLS_FROZEN_RAW)
  string(REPLACE "\r\n" "\n" _ZTOOLS_FROZEN_CANON "${_ZTOOLS_FROZEN_RAW}")
  string(STRIP "${_ZTOOLS_FROZEN_CANON}" _ZTOOLS_FROZEN_CANON)
  string(JSON _ZTOOLS_FR_TYPE ERROR_VARIABLE _ZTOOLS_JSON_ERR TYPE "${_ZTOOLS_FROZEN_RAW}")
  if(NOT _ZTOOLS_JSON_ERR STREQUAL "NOTFOUND" OR NOT _ZTOOLS_FR_TYPE STREQUAL "ARRAY")
    message(FATAL_ERROR "Invalid JSON array in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}: ${_ZTOOLS_JSON_ERR}")
  endif()
  string(JSON _ZTOOLS_FR_LEN LENGTH "${_ZTOOLS_FROZEN_RAW}")
  if(_ZTOOLS_FR_LEN GREATER 0)
    math(EXPR _ZTOOLS_FR_LAST "${_ZTOOLS_FR_LEN} - 1")
    foreach(_idx RANGE 0 ${_ZTOOLS_FR_LAST})
      string(JSON _fr_entry_type ERROR_VARIABLE _e0 TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx})
      if(NOT _e0 STREQUAL "NOTFOUND" OR NOT _fr_entry_type STREQUAL "OBJECT")
        message(FATAL_ERROR "Legacy frozen entry #${_idx} must be an object in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
      endif()
      string(JSON _pid_type ERROR_VARIABLE _e1_t TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx} pluginId)
      string(JSON _pid ERROR_VARIABLE _e1 GET "${_ZTOOLS_FROZEN_RAW}" ${_idx} pluginId)
      string(JSON _did_type ERROR_VARIABLE _e2_t TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx} dllId)
      string(JSON _did ERROR_VARIABLE _e2 GET "${_ZTOOLS_FROZEN_RAW}" ${_idx} dllId)
      string(JSON _sha_type ERROR_VARIABLE _e3_t TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx} sha256)
      string(JSON _sha ERROR_VARIABLE _e3 GET "${_ZTOOLS_FROZEN_RAW}" ${_idx} sha256)
      string(JSON _fn_type ERROR_VARIABLE _e4 TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx} functions)
      if(NOT _e1_t STREQUAL "NOTFOUND" OR NOT _e1 STREQUAL "NOTFOUND" OR NOT _pid_type STREQUAL "STRING" OR
         NOT _e2_t STREQUAL "NOTFOUND" OR NOT _e2 STREQUAL "NOTFOUND" OR NOT _did_type STREQUAL "STRING" OR
         NOT _e3_t STREQUAL "NOTFOUND" OR NOT _e3 STREQUAL "NOTFOUND" OR NOT _sha_type STREQUAL "STRING" OR
         NOT _e4 STREQUAL "NOTFOUND" OR NOT _fn_type STREQUAL "ARRAY")
        message(FATAL_ERROR "Malformed legacy frozen entry #${_idx} in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
      endif()
      string(LENGTH "${_pid}" _pid_len)
      string(LENGTH "${_did}" _did_len)
      if(NOT _pid_len GREATER 0 OR NOT _did_len GREATER 0)
        message(FATAL_ERROR "Legacy frozen entry #${_idx} pluginId/dllId must be non-empty in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
      endif()
      string(LENGTH "${_sha}" _sha_len)
      if(NOT _sha_len EQUAL 64 OR NOT _sha MATCHES "^[0-9a-f]+$")
        message(FATAL_ERROR "Invalid legacy frozen sha256 entry #${_idx} in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
      endif()
      string(JSON _fn_len LENGTH "${_ZTOOLS_FROZEN_RAW}" ${_idx} functions)
      if(NOT _fn_len GREATER 0)
        message(FATAL_ERROR "Legacy frozen entry #${_idx} must declare non-empty functions")
      endif()
      set(_fn_list_cpp "")
      math(EXPR _fn_last "${_fn_len} - 1")
      foreach(_fi RANGE 0 ${_fn_last})
        string(JSON _fn_item_type ERROR_VARIABLE _e_fn_t TYPE "${_ZTOOLS_FROZEN_RAW}" ${_idx} functions ${_fi})
        string(JSON _fn_val ERROR_VARIABLE _e_fn GET "${_ZTOOLS_FROZEN_RAW}" ${_idx} functions ${_fi})
        if(NOT _e_fn_t STREQUAL "NOTFOUND" OR NOT _e_fn STREQUAL "NOTFOUND" OR NOT _fn_item_type STREQUAL "STRING")
          message(FATAL_ERROR "Legacy frozen entry #${_idx} function #${_fi} must be a string in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
        endif()
        string(LENGTH "${_fn_val}" _fn_val_len)
        if(NOT _fn_val_len GREATER 0)
          message(FATAL_ERROR "Legacy frozen entry #${_idx} function #${_fi} must be non-empty in ${ZTOOLS_NATIVE_TRUST_LEGACY_FROZEN_JSON}")
        endif()
        ztools_escape_cxx_string("${_fn_val}" _fn_esc)
        if(NOT _fn_list_cpp STREQUAL "")
          string(APPEND _fn_list_cpp ", ")
        endif()
        string(APPEND _fn_list_cpp "\"${_fn_esc}\"")
      endforeach()
      ztools_escape_cxx_string("${_pid}" _pid_esc)
      ztools_escape_cxx_string("${_did}" _did_esc)
      string(APPEND _ZTOOLS_FROZEN_CPP_LINES "  AddLegacyFrozen(bundle, \"${_pid_esc}\", \"${_did_esc}\", \"${_sha}\", {${_fn_list_cpp}});\n")
    endforeach()
  endif()
endif()

set(_ZTOOLS_BUNDLE_CANON_TEXT "publicKeys=${_ZTOOLS_PK_CANON}\nrevocations=${_ZTOOLS_REV_CANON}\nlegacyFrozen=${_ZTOOLS_FROZEN_CANON}\n")
string(SHA256 ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256 "${_ZTOOLS_BUNDLE_CANON_TEXT}")

set(ZTOOLS_NATIVE_TRUST_GENERATED_DIR "${CMAKE_BINARY_DIR}/generated")
file(MAKE_DIRECTORY "${ZTOOLS_NATIVE_TRUST_GENERATED_DIR}")
set(ZTOOLS_NATIVE_TRUST_GENERATED_HPP "${ZTOOLS_NATIVE_TRUST_GENERATED_DIR}/native_trust_bundle.generated.hpp")

file(WRITE "${ZTOOLS_NATIVE_TRUST_GENERATED_HPP}"
"#pragma once
// Auto-generated by electron-client/native/CMakeLists.txt. Do not edit manually.
#include \"native_trust_verifier.hpp\"
#include <initializer_list>
#include <string_view>

#define ZTOOLS_NATIVE_TRUST_BUNDLE_MARKER_LITERAL \"ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256=${ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256}\"

namespace ztools::native_trust {

inline constexpr const char kNativeTrustBundleSha256[] = \"${ZTOOLS_NATIVE_TRUST_BUNDLE_SHA256}\";
inline constexpr const char kNativeTrustBundleMarker[] = ZTOOLS_NATIVE_TRUST_BUNDLE_MARKER_LITERAL;

inline void AddPublicKey(
  TrustBundle& bundle,
  const char* key_id,
  const char* pub_hex,
  bool allow_native,
  bool allow_privileged) {
  TrustPublicKey key;
  key.key_id = key_id;
  key.allow_native = allow_native;
  key.allow_privileged = allow_privileged;
  if (dll_paths::ParseHexAscii(pub_hex, key.pub_xy)) {
    bundle.public_keys.push_back(std::move(key));
  }
}

inline void AddRevokedManifestSha(TrustBundle& bundle, const char* sha_hex) {
  std::array<std::uint8_t, kSha256Bytes> sha{};
  if (dll_paths::ParseHexAscii(sha_hex, sha)) {
    bundle.revocations.revoked_manifest_sha256.insert(sha);
  }
}

inline void AddRevokedFileSha(TrustBundle& bundle, const char* sha_hex) {
  std::array<std::uint8_t, kSha256Bytes> sha{};
  if (dll_paths::ParseHexAscii(sha_hex, sha)) {
    bundle.revocations.revoked_file_sha256.insert(sha);
  }
}

inline void AddLegacyFrozen(
  TrustBundle& bundle,
  const char* plugin_id,
  const char* dll_id,
  const char* sha_hex,
  std::initializer_list<const char*> functions) {
  LegacyFrozenEntry entry;
  entry.plugin_id = plugin_id;
  entry.dll_id = dll_id;
  if (!dll_paths::ParseHexAscii(sha_hex, entry.sha256)) return;
  for (const char* fn : functions) {
    entry.functions.emplace(fn);
  }
  bundle.legacy_frozen.push_back(std::move(entry));
}

inline TrustBundle BuildEmbeddedTrustBundle() {
  TrustBundle bundle;
${_ZTOOLS_PK_CPP_LINES}${_ZTOOLS_REV_CPP_LINES}${_ZTOOLS_FROZEN_CPP_LINES}  return bundle;
}

}  // namespace ztools::native_trust
")

add_subdirectory(ZToolsNativeHost32)
add_subdirectory(ZToolsService)
