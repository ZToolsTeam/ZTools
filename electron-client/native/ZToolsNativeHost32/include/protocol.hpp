#pragma once

#include <Windows.h>

#include <array>
#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace ztools::native_host {

constexpr std::uint16_t kProtocolVersion = 1;
constexpr std::uint32_t kMaxFrameBytes = 1024U * 1024U;
constexpr std::uint32_t kMaxPayloadBytes = 768U * 1024U;
constexpr std::size_t kSecretBytes = 32;
constexpr std::size_t kNonceBytes = 32;
constexpr std::size_t kProofBytes = 32;

enum class FrameType : std::uint16_t {
  Hello = 1,
  HelloAck = 2,
  Request = 3,
  Response = 4,
  Event = 5,
  Error = 6,
};

struct Frame {
  std::uint16_t protocol_version = kProtocolVersion;
  FrameType type = FrameType::Error;
  std::string session_id;
  std::string request_id;
  std::string plugin_id;
  std::string dll_id;
  std::string method;
  std::vector<std::uint8_t> payload;
};

enum class ReadStatus {
  Ok,
  EndOfStream,
  Invalid,
};

ReadStatus ReadFrame(HANDLE input, Frame& frame, std::string& error);
bool WriteFrame(HANDLE output, const Frame& frame, std::string& error);
bool ReadBootstrapSecret(std::array<std::uint8_t, kSecretBytes>& secret);
bool RandomBytes(std::span<std::uint8_t> output);
bool HmacSha256(
  std::span<const std::uint8_t> secret,
  const std::vector<std::span<const std::uint8_t>>& parts,
  std::array<std::uint8_t, kProofBytes>& output);
bool ConstantTimeEqual(std::span<const std::uint8_t> left, std::span<const std::uint8_t> right);
void SecureErase(std::span<std::uint8_t> bytes);
std::vector<std::uint8_t> Bytes(std::string_view value);

}  // namespace ztools::native_host
