#pragma once

#include <cstdint>
#include <cstddef>
#include <string_view>
#include <vector>

namespace ztools::service {

inline constexpr std::uint32_t kServiceFrameMagic = 0x3153545A;
inline constexpr std::uint16_t kServiceProtocolVersion = 1;
inline constexpr std::uint32_t kServiceFrameFlagAuthenticated = 1;
inline constexpr std::size_t kServiceFrameHeaderSize = 24;
inline constexpr std::size_t kServiceMaxFrameSize = 1024 * 1024;
inline constexpr std::size_t kServiceMaxPayloadSize =
    kServiceMaxFrameSize - kServiceFrameHeaderSize;

enum class ServiceFrameType : std::uint16_t {
  client_hello = 1,
  server_hello = 2,
  client_auth = 3,
  request = 4,
  response = 5,
  error = 6,
  task_changed = 7,
};

struct ServiceFrame {
  ServiceFrameType type = ServiceFrameType::error;
  std::uint32_t flags = 0;
  std::uint64_t request_id = 0;
  std::vector<std::uint8_t> payload;
};

std::vector<std::uint8_t> EncodeServiceFrame(const ServiceFrame& frame);
bool ParseServiceFrameBody(
    const std::vector<std::uint8_t>& body,
    ServiceFrame* frame) noexcept;
ServiceFrame MakeServiceErrorFrame(
    std::uint64_t request_id,
    std::string_view error_code);

}  // namespace ztools::service
