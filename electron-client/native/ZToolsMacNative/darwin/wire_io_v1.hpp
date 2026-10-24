#ifndef ZTOOLS_MAC_NATIVE_WIRE_IO_V1_HPP
#define ZTOOLS_MAC_NATIVE_WIRE_IO_V1_HPP

#include "worker_session_v1.h"

#include <algorithm>
#include <cstddef>
#include <cerrno>
#include <cstdint>
#include <string>
#include <vector>

#include <unistd.h>

namespace ztools::macnative {

struct WireFrameV1 {
  FrameHeaderV1 header;
  std::vector<uint8_t> payload;
};

inline bool readExactFd(int descriptor, uint8_t* output, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t count = read(descriptor, output + offset, length - offset);
    if (count == 0) return false;
    if (count < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  return true;
}

inline bool writeExactFd(int descriptor, const uint8_t* data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    const ssize_t count = write(descriptor, data + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (count == 0) return false;
    offset += static_cast<size_t>(count);
  }
  return true;
}

inline bool readFrameBlockingV1(int descriptor, WireFrameV1* output) {
  if (output == nullptr) return false;
  uint8_t headerBytes[ZT_MAC_NATIVE_WIRE_HEADER_BYTES]{};
  if (!readExactFd(descriptor, headerBytes, sizeof(headerBytes))) return false;
  const uint32_t payloadLength = static_cast<uint32_t>(headerBytes[8]) |
      (static_cast<uint32_t>(headerBytes[9]) << 8) |
      (static_cast<uint32_t>(headerBytes[10]) << 16) |
      (static_cast<uint32_t>(headerBytes[11]) << 24);
  if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  std::vector<uint8_t> encoded(sizeof(headerBytes) + payloadLength);
  std::copy(headerBytes, headerBytes + sizeof(headerBytes), encoded.begin());
  if (payloadLength != 0 && !readExactFd(descriptor, encoded.data() + sizeof(headerBytes), payloadLength)) return false;
  FrameHeaderV1 decoded{};
  if (decodeFrameHeaderV1(encoded.data(), encoded.size(), &decoded) != WireError::None) return false;
  output->header = decoded;
  output->payload.assign(encoded.begin() + static_cast<std::ptrdiff_t>(sizeof(headerBytes)), encoded.end());
  return true;
}

inline bool writeFrameV1(int descriptor, uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId,
                         const uint8_t* payload, uint32_t payloadLength) {
  if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES || (payload == nullptr && payloadLength != 0)) return false;
  FrameHeaderV1 header{ZT_MAC_NATIVE_WIRE_V1, type, payloadLength, owner, generation, taskId};
  uint8_t encodedHeader[ZT_MAC_NATIVE_WIRE_HEADER_BYTES]{};
  if (!encodeFrameHeaderV1(header, encodedHeader, sizeof(encodedHeader)) ||
      !writeExactFd(descriptor, encodedHeader, sizeof(encodedHeader))) return false;
  return payloadLength == 0 || writeExactFd(descriptor, payload, payloadLength);
}

inline bool writeFrameTextV1(int descriptor, uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId,
                             const std::string& payload) {
  if (payload.size() > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return writeFrameV1(descriptor, type, owner, generation, taskId,
      reinterpret_cast<const uint8_t*>(payload.data()), static_cast<uint32_t>(payload.size()));
}

class FrameAccumulatorV1 final {
 public:
  bool append(const uint8_t* bytes, size_t length) {
    if (bytes == nullptr && length != 0) return false;
    if (length == 0) return true;
    constexpr size_t kMaximumBufferedBytes = 4u *
        (ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES + ZT_MAC_NATIVE_WIRE_HEADER_BYTES);
    if (length > kMaximumBufferedBytes || buffer_.size() > kMaximumBufferedBytes - length) return false;
    buffer_.insert(buffer_.end(), bytes, bytes + length);
    return true;
  }

  bool take(WireFrameV1* output) {
    if (output == nullptr || buffer_.size() < ZT_MAC_NATIVE_WIRE_HEADER_BYTES) return false;
    const uint32_t payloadLength = static_cast<uint32_t>(buffer_[8]) |
        (static_cast<uint32_t>(buffer_[9]) << 8) |
        (static_cast<uint32_t>(buffer_[10]) << 16) |
        (static_cast<uint32_t>(buffer_[11]) << 24);
    if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
    const size_t frameLength = ZT_MAC_NATIVE_WIRE_HEADER_BYTES + payloadLength;
    if (buffer_.size() < frameLength) return false;
    FrameHeaderV1 header{};
    if (decodeFrameHeaderV1(buffer_.data(), frameLength, &header) != WireError::None) return false;
    output->header = header;
    output->payload.assign(buffer_.begin() + static_cast<std::ptrdiff_t>(ZT_MAC_NATIVE_WIRE_HEADER_BYTES),
                           buffer_.begin() + static_cast<std::ptrdiff_t>(frameLength));
    buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(frameLength));
    return true;
  }

  bool invalidPrefix() const noexcept {
    if (buffer_.size() < ZT_MAC_NATIVE_WIRE_HEADER_BYTES) return false;
    if (buffer_[0] != 'Z' || buffer_[1] != 'T' || buffer_[2] != 'M' || buffer_[3] != 'N') return true;
    const uint32_t payloadLength = static_cast<uint32_t>(buffer_[8]) |
        (static_cast<uint32_t>(buffer_[9]) << 8) |
        (static_cast<uint32_t>(buffer_[10]) << 16) |
        (static_cast<uint32_t>(buffer_[11]) << 24);
    if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return true;
    if (buffer_[4] != 1 || buffer_[5] != 0) return true;
    const uint16_t type = static_cast<uint16_t>(buffer_[6]) |
        static_cast<uint16_t>(static_cast<uint16_t>(buffer_[7]) << 8);
    const uint64_t owner = readU64(buffer_.data() + 12);
    const uint64_t generation = readU64(buffer_.data() + 20);
    const uint64_t taskId = readU64(buffer_.data() + 28);
    if (owner == 0 || generation == 0 || !knownType(type)) return true;
    const bool invalidTaskId = needsTaskId(type) ? taskId == 0 :
        ((type == ZT_MAC_FRAME_RESPONSE || type == ZT_MAC_FRAME_ERROR) ? false : taskId != 0);
    if (invalidTaskId) return true;
    const size_t frameLength = ZT_MAC_NATIVE_WIRE_HEADER_BYTES + payloadLength;
    if (buffer_.size() < frameLength) return false;
    return false;
  }

  size_t size() const noexcept { return buffer_.size(); }

 private:
  static uint64_t readU64(const uint8_t* bytes) noexcept {
    uint64_t value = 0;
    for (size_t index = 0; index < 8; ++index) value |= static_cast<uint64_t>(bytes[index]) << (index * 8);
    return value;
  }

  static bool knownType(uint16_t type) noexcept {
    switch (type) {
      case ZT_MAC_FRAME_HANDSHAKE:
      case ZT_MAC_FRAME_INIT:
      case ZT_MAC_FRAME_INFO:
      case ZT_MAC_FRAME_CALL:
      case ZT_MAC_FRAME_CANCEL:
      case ZT_MAC_FRAME_QUERY:
      case ZT_MAC_FRAME_CLEAR:
      case ZT_MAC_FRAME_DESTROY:
      case ZT_MAC_FRAME_SHUTDOWN:
      case ZT_MAC_FRAME_PROGRESS:
      case ZT_MAC_FRAME_CALLBACK:
      case ZT_MAC_FRAME_RESPONSE:
      case ZT_MAC_FRAME_CANCELLED:
      case ZT_MAC_FRAME_ERROR:
        return true;
      default:
        return false;
    }
  }

  static bool needsTaskId(uint16_t type) noexcept {
    return type == ZT_MAC_FRAME_CALL || type == ZT_MAC_FRAME_CANCEL || type == ZT_MAC_FRAME_QUERY ||
        type == ZT_MAC_FRAME_CLEAR || type == ZT_MAC_FRAME_PROGRESS || type == ZT_MAC_FRAME_CALLBACK ||
        type == ZT_MAC_FRAME_CANCELLED;
  }

  std::vector<uint8_t> buffer_;
};

}  // namespace ztools::macnative

#endif
