#ifndef ZTOOLS_MAC_NATIVE_WIRE_V1_H
#define ZTOOLS_MAC_NATIVE_WIRE_V1_H

#include <stddef.h>
#include <stdint.h>

#define ZT_MAC_NATIVE_WIRE_V1 1u
#define ZT_MAC_NATIVE_WIRE_HEADER_BYTES 36u
#define ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES (1024u * 1024u)

typedef enum zt_mac_native_frame_type_v1 {
  ZT_MAC_FRAME_HANDSHAKE = 1,
  ZT_MAC_FRAME_INIT = 2,
  ZT_MAC_FRAME_INFO = 3,
  ZT_MAC_FRAME_CALL = 4,
  ZT_MAC_FRAME_CANCEL = 5,
  ZT_MAC_FRAME_QUERY = 6,
  ZT_MAC_FRAME_CLEAR = 7,
  ZT_MAC_FRAME_DESTROY = 8,
  ZT_MAC_FRAME_SHUTDOWN = 9,
  ZT_MAC_FRAME_PROGRESS = 0x8001,
  ZT_MAC_FRAME_CALLBACK = 0x8002,
  ZT_MAC_FRAME_RESPONSE = 0x8003,
  ZT_MAC_FRAME_CANCELLED = 0x8004,
  ZT_MAC_FRAME_ERROR = 0x80ff,
} zt_mac_native_frame_type_v1;

/* Wire fields are little-endian byte offsets; no C struct is sent across the pipe.
 * 0 magic[4]="ZTMN", 4 version:u16, 6 type:u16, 8 payloadLength:u32,
 * 12 owner:u64, 20 generation:u64, 28 taskId:u64, then payload bytes.
 */

#endif
