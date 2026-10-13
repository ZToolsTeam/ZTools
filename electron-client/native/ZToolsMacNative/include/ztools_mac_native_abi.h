#ifndef ZTOOLS_MAC_NATIVE_ABI_H
#define ZTOOLS_MAC_NATIVE_ABI_H

#include <stdint.h>

#if defined(_WIN32)
#define ZT_MAC_NATIVE_EXPORT extern "C" __declspec(dllexport)
#define ZT_MAC_NATIVE_CALL __cdecl
#else
#define ZT_MAC_NATIVE_EXPORT extern "C" __attribute__((visibility("default")))
#define ZT_MAC_NATIVE_CALL
#endif

#define ZT_MAC_NATIVE_ABI_V1 1u
#define ZT_MAC_NATIVE_MAX_JSON_BYTES (1024u * 1024u)

typedef int32_t zt_mac_native_status;

enum {
  ZT_MAC_NATIVE_OK = 0,
  ZT_MAC_NATIVE_INVALID_ARGUMENT = 1,
  ZT_MAC_NATIVE_ABI_MISMATCH = 2,
  ZT_MAC_NATIVE_SIZE_LIMIT = 3,
  ZT_MAC_NATIVE_INVALID_UTF8 = 4,
  ZT_MAC_NATIVE_INVALID_JSON = 5,
  ZT_MAC_NATIVE_INVALID_STATE = 6,
  ZT_MAC_NATIVE_OUT_OF_MEMORY = 7,
  ZT_MAC_NATIVE_BUSY = 8,
};

typedef struct zt_mac_native_input_v1 {
  const uint8_t* data;
  uint32_t length;
} zt_mac_native_input_v1;

typedef struct zt_mac_native_output_v1 {
  uint8_t* data;
  uint32_t length;
} zt_mac_native_output_v1;

typedef zt_mac_native_status(ZT_MAC_NATIVE_CALL* zt_mac_native_init_v1_fn)(zt_mac_native_input_v1 config);
typedef zt_mac_native_status(ZT_MAC_NATIVE_CALL* zt_mac_native_get_info_v1_fn)(zt_mac_native_output_v1* output);
typedef zt_mac_native_status(ZT_MAC_NATIVE_CALL* zt_mac_native_call_v1_fn)(zt_mac_native_input_v1 request,
                                                                            zt_mac_native_output_v1* output);
typedef zt_mac_native_status(ZT_MAC_NATIVE_CALL* zt_mac_native_destroy_v1_fn)(void);
typedef zt_mac_native_status(ZT_MAC_NATIVE_CALL* zt_mac_native_free_v1_fn)(uint8_t* data, uint32_t length);

typedef struct zt_mac_native_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  zt_mac_native_init_v1_fn init;
  zt_mac_native_get_info_v1_fn get_info;
  zt_mac_native_call_v1_fn call;
  zt_mac_native_destroy_v1_fn destroy;
  zt_mac_native_free_v1_fn free_buffer;
} zt_mac_native_api_v1;

/* Stable negotiation entrypoint: call this before resolving or invoking any v1 symbol. */
typedef uint32_t(ZT_MAC_NATIVE_CALL* zt_mac_native_get_abi_version_fn)(void);
typedef const zt_mac_native_api_v1*(ZT_MAC_NATIVE_CALL* zt_mac_native_get_api_v1_fn)(void);

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_get_abi_version(void);
ZT_MAC_NATIVE_EXPORT const zt_mac_native_api_v1* ZT_MAC_NATIVE_CALL zt_mac_get_api_v1(void);

#endif
