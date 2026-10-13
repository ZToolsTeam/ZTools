#include "ztools_service/pipe_protocol.hpp"

#include <limits>
#include <stdexcept>

namespace ztools::service {
namespace {

void AppendUint16(std::vector<std::uint8_t>* output, const std::uint16_t value) {
  output->push_back(static_cast<std::uint8_t>(value & 0xff));
  output->push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
}

void AppendUint32(std::vector<std::uint8_t>* output, const std::uint32_t value) {
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    output->push_back(static_cast<std::uint8_t>((value >> shift) & 0xff));
  }
}

void AppendUint64(std::vector<std::uint8_t>* output, const std::uint64_t value) {
  for (unsigned int shift = 0; shift < 64; shift += 8) {
    output->push_back(static_cast<std::uint8_t>((value >> shift) & 0xff));
  }
}

std::uint16_t ReadUint16(const std::uint8_t* const input) noexcept {
  return static_cast<std::uint16_t>(input[0]) |
         static_cast<std::uint16_t>(input[1] << 8);
}

std::uint32_t ReadUint32(const std::uint8_t* const input) noexcept {
  std::uint32_t value = 0;
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    value |= static_cast<std::uint32_t>(input[shift / 8]) << shift;
  }
  return value;
}

std::uint64_t ReadUint64(const std::uint8_t* const input) noexcept {
  std::uint64_t value = 0;
  for (unsigned int shift = 0; shift < 64; shift += 8) {
    value |= static_cast<std::uint64_t>(input[shift / 8]) << shift;
  }
  return value;
}

bool IsKnownFrameType(const ServiceFrameType type) noexcept {
  switch (type) {
    case ServiceFrameType::client_hello:
    case ServiceFrameType::server_hello:
    case ServiceFrameType::client_auth:
    case ServiceFrameType::request:
    case ServiceFrameType::response:
    case ServiceFrameType::error:
    case ServiceFrameType::task_changed:
      return true;
    default:
      return false;
  }
}

}  // namespace

std::vector<std::uint8_t> EncodeServiceFrame(const ServiceFrame& frame) {
  if (!IsKnownFrameType(frame.type) ||
      (frame.flags != 0 && frame.flags != kServiceFrameFlagAuthenticated) ||
      frame.payload.size() > kServiceMaxPayloadSize ||
      frame.payload.size() > std::numeric_limits<std::uint32_t>::max()) {
    throw std::invalid_argument("invalid service frame");
  }
  const auto body_size = static_cast<std::uint32_t>(
      kServiceFrameHeaderSize + frame.payload.size());
  std::vector<std::uint8_t> encoded;
  encoded.reserve(sizeof(std::uint32_t) + body_size);
  AppendUint32(&encoded, body_size);
  AppendUint32(&encoded, kServiceFrameMagic);
  AppendUint16(&encoded, kServiceProtocolVersion);
  AppendUint16(&encoded, static_cast<std::uint16_t>(frame.type));
  AppendUint32(&encoded, frame.flags);
  AppendUint64(&encoded, frame.request_id);
  AppendUint32(&encoded, static_cast<std::uint32_t>(frame.payload.size()));
  encoded.insert(encoded.end(), frame.payload.begin(), frame.payload.end());
  return encoded;
}

bool ParseServiceFrameBody(
    const std::vector<std::uint8_t>& body,
    ServiceFrame* const frame) noexcept {
  if (frame == nullptr || body.size() < kServiceFrameHeaderSize ||
      body.size() > kServiceMaxFrameSize) {
    return false;
  }
  const std::uint8_t* const data = body.data();
  if (ReadUint32(data) != kServiceFrameMagic ||
      ReadUint16(data + 4) != kServiceProtocolVersion) {
    return false;
  }
  const auto type = static_cast<ServiceFrameType>(ReadUint16(data + 6));
  const std::uint32_t flags = ReadUint32(data + 8);
  const std::uint32_t payload_size = ReadUint32(data + 20);
  if (!IsKnownFrameType(type) ||
      (flags != 0 && flags != kServiceFrameFlagAuthenticated) ||
      payload_size > kServiceMaxPayloadSize ||
      body.size() != kServiceFrameHeaderSize + payload_size) {
    return false;
  }
  frame->type = type;
  frame->flags = flags;
  frame->request_id = ReadUint64(data + 12);
  frame->payload.assign(body.begin() + kServiceFrameHeaderSize, body.end());
  return true;
}

ServiceFrame MakeServiceErrorFrame(
    const std::uint64_t request_id,
    const std::string_view error_code) {
  ServiceFrame frame;
  frame.type = ServiceFrameType::error;
  frame.request_id = request_id;
  frame.payload.assign(error_code.begin(), error_code.end());
  return frame;
}

}  // namespace ztools::service
