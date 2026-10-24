#include "protocol.hpp"

#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <limits>
#include <memory>
#include <string_view>

namespace ztools::native_host {
namespace {

constexpr std::array<std::uint8_t, 4> kMagic{'Z', 'T', 'H', '1'};
constexpr std::size_t kHeaderBytes = 36;
constexpr std::uint32_t kMaxTextBytes = 128;

class AlgorithmHandle {
 public:
  ~AlgorithmHandle() {
    if (value_ != nullptr) BCryptCloseAlgorithmProvider(value_, 0);
  }

  BCRYPT_ALG_HANDLE* Address() { return &value_; }
  BCRYPT_ALG_HANDLE Get() const { return value_; }

 private:
  BCRYPT_ALG_HANDLE value_ = nullptr;
};

class HashHandle {
 public:
  ~HashHandle() {
    if (value_ != nullptr) BCryptDestroyHash(value_);
  }

  BCRYPT_HASH_HANDLE* Address() { return &value_; }
  BCRYPT_HASH_HANDLE Get() const { return value_; }

 private:
  BCRYPT_HASH_HANDLE value_ = nullptr;
};

std::uint16_t ReadU16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(value[0]) |
    static_cast<std::uint16_t>(static_cast<std::uint16_t>(value[1]) << 8U);
}

std::uint32_t ReadU32(const std::uint8_t* value) {
  return static_cast<std::uint32_t>(value[0]) |
    (static_cast<std::uint32_t>(value[1]) << 8U) |
    (static_cast<std::uint32_t>(value[2]) << 16U) |
    (static_cast<std::uint32_t>(value[3]) << 24U);
}

void WriteU16(std::vector<std::uint8_t>& output, std::uint16_t value) {
  output.push_back(static_cast<std::uint8_t>(value & 0xffU));
  output.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
}

void WriteU32(std::vector<std::uint8_t>& output, std::uint32_t value) {
  output.push_back(static_cast<std::uint8_t>(value & 0xffU));
  output.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
  output.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xffU));
  output.push_back(static_cast<std::uint8_t>((value >> 24U) & 0xffU));
}

bool ReadExact(HANDLE input, std::span<std::uint8_t> output, bool& end_of_stream) {
  end_of_stream = false;
  std::size_t offset = 0;
  while (offset < output.size()) {
    DWORD read = 0;
    const auto remaining = output.size() - offset;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(remaining, MAXDWORD));
    if (!ReadFile(input, output.data() + offset, requested, &read, nullptr)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) end_of_stream = offset == 0;
      return false;
    }
    if (read == 0) {
      end_of_stream = offset == 0;
      return false;
    }
    offset += read;
  }
  return true;
}

bool WriteExact(HANDLE output, std::span<const std::uint8_t> input) {
  std::size_t offset = 0;
  while (offset < input.size()) {
    DWORD written = 0;
    const auto remaining = input.size() - offset;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(remaining, MAXDWORD));
    if (!WriteFile(output, input.data() + offset, requested, &written, nullptr) || written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool IsValidUtf8(std::string_view value) {
  if (value.empty()) return true;
  return MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0) > 0;
}

bool IsSafeIdentifier(std::string_view value, bool allow_empty) {
  if (value.empty()) return allow_empty;
  if (value.size() > 128) return false;
  for (const unsigned char character : value) {
    const bool valid =
      (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      (character >= '0' && character <= '9') ||
      character == '_' || character == '-' || character == '.' || character == ':';
    if (!valid) return false;
  }
  return true;
}

bool ReadText(
  std::span<const std::uint8_t> body,
  std::size_t& offset,
  std::uint32_t length,
  bool allow_empty,
  std::string& output) {
  if (length > kMaxTextBytes || offset + length > body.size()) return false;
  output.assign(reinterpret_cast<const char*>(body.data() + offset), length);
  offset += length;
  return IsValidUtf8(output) && IsSafeIdentifier(output, allow_empty);
}

bool ParseHexNibble(wchar_t character, std::uint8_t& value) {
  if (character >= L'0' && character <= L'9') {
    value = static_cast<std::uint8_t>(character - L'0');
    return true;
  }
  if (character >= L'a' && character <= L'f') {
    value = static_cast<std::uint8_t>(character - L'a' + 10);
    return true;
  }
  if (character >= L'A' && character <= L'F') {
    value = static_cast<std::uint8_t>(character - L'A' + 10);
    return true;
  }
  return false;
}

}  // namespace

ReadStatus ReadFrame(HANDLE input, Frame& frame, std::string& error) {
  std::array<std::uint8_t, 4> prefix{};
  bool end_of_stream = false;
  if (!ReadExact(input, prefix, end_of_stream)) {
    if (end_of_stream) return ReadStatus::EndOfStream;
    error = "failed to read frame length";
    return ReadStatus::Invalid;
  }

  const std::uint32_t body_length = ReadU32(prefix.data());
  if (body_length < kHeaderBytes || body_length > kMaxFrameBytes) {
    error = "frame length is outside the allowed range";
    return ReadStatus::Invalid;
  }

  std::vector<std::uint8_t> body(body_length);
  if (!ReadExact(input, body, end_of_stream)) {
    error = "frame body is truncated";
    return ReadStatus::Invalid;
  }
  if (!std::equal(kMagic.begin(), kMagic.end(), body.begin())) {
    error = "frame magic is invalid";
    return ReadStatus::Invalid;
  }

  frame.protocol_version = ReadU16(body.data() + 4);
  const std::uint16_t raw_type = ReadU16(body.data() + 6);
  if (raw_type < static_cast<std::uint16_t>(FrameType::Hello) ||
      raw_type > static_cast<std::uint16_t>(FrameType::Error)) {
    error = "frame type is invalid";
    return ReadStatus::Invalid;
  }
  frame.type = static_cast<FrameType>(raw_type);
  if (ReadU32(body.data() + 8) != 0) {
    error = "frame flags are not supported";
    return ReadStatus::Invalid;
  }

  const std::array<std::uint32_t, 6> lengths{
    ReadU32(body.data() + 12), ReadU32(body.data() + 16), ReadU32(body.data() + 20),
    ReadU32(body.data() + 24), ReadU32(body.data() + 28), ReadU32(body.data() + 32)};
  std::uint64_t total = kHeaderBytes;
  for (const std::uint32_t length : lengths) total += length;
  if (total != body.size() || lengths[5] > kMaxPayloadBytes) {
    error = "frame field lengths are invalid";
    return ReadStatus::Invalid;
  }

  std::size_t offset = kHeaderBytes;
  if (!ReadText(body, offset, lengths[0], false, frame.session_id) ||
      !ReadText(body, offset, lengths[1], false, frame.request_id) ||
      !ReadText(body, offset, lengths[2], true, frame.plugin_id) ||
      !ReadText(body, offset, lengths[3], true, frame.dll_id) ||
      !ReadText(body, offset, lengths[4], false, frame.method)) {
    error = "frame text field is invalid";
    return ReadStatus::Invalid;
  }
  frame.payload.assign(body.begin() + static_cast<std::ptrdiff_t>(offset), body.end());
  return ReadStatus::Ok;
}

bool WriteFrame(HANDLE output, const Frame& frame, std::string& error) {
  const std::array<std::string_view, 5> values{
    frame.session_id, frame.request_id, frame.plugin_id, frame.dll_id, frame.method};
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (values[index].size() > kMaxTextBytes || !IsValidUtf8(values[index]) ||
        !IsSafeIdentifier(values[index], index == 2 || index == 3)) {
      error = "frame text field is invalid";
      return false;
    }
  }
  if (frame.payload.size() > kMaxPayloadBytes) {
    error = "frame payload is too large";
    return false;
  }

  std::uint64_t body_length = kHeaderBytes + frame.payload.size();
  for (const auto value : values) body_length += value.size();
  if (body_length > kMaxFrameBytes || body_length > std::numeric_limits<std::uint32_t>::max()) {
    error = "frame is too large";
    return false;
  }

  std::vector<std::uint8_t> body;
  body.reserve(static_cast<std::size_t>(body_length));
  body.insert(body.end(), kMagic.begin(), kMagic.end());
  WriteU16(body, frame.protocol_version);
  WriteU16(body, static_cast<std::uint16_t>(frame.type));
  WriteU32(body, 0);
  for (const auto value : values) WriteU32(body, static_cast<std::uint32_t>(value.size()));
  WriteU32(body, static_cast<std::uint32_t>(frame.payload.size()));
  for (const auto value : values) body.insert(body.end(), value.begin(), value.end());
  body.insert(body.end(), frame.payload.begin(), frame.payload.end());

  std::vector<std::uint8_t> prefix;
  prefix.reserve(4);
  WriteU32(prefix, static_cast<std::uint32_t>(body.size()));
  if (!WriteExact(output, prefix) || !WriteExact(output, body)) {
    error = "failed to write frame";
    return false;
  }
  return true;
}

bool ReadBootstrapSecret(std::array<std::uint8_t, kSecretBytes>& secret) {
  std::array<wchar_t, 65> encoded{};
  const DWORD length = GetEnvironmentVariableW(
    L"ZTOOLS_NATIVE_HOST_TOKEN", encoded.data(), static_cast<DWORD>(encoded.size()));
  SetEnvironmentVariableW(L"ZTOOLS_NATIVE_HOST_TOKEN", nullptr);
  if (length != 64) return false;
  for (std::size_t index = 0; index < secret.size(); ++index) {
    std::uint8_t high = 0;
    std::uint8_t low = 0;
    if (!ParseHexNibble(encoded[index * 2], high) || !ParseHexNibble(encoded[index * 2 + 1], low)) {
      SecureZeroMemory(encoded.data(), encoded.size() * sizeof(wchar_t));
      return false;
    }
    secret[index] = static_cast<std::uint8_t>((high << 4U) | low);
  }
  SecureZeroMemory(encoded.data(), encoded.size() * sizeof(wchar_t));
  return true;
}

bool RandomBytes(std::span<std::uint8_t> output) {
  if (output.size() > std::numeric_limits<ULONG>::max()) return false;
  return BCryptGenRandom(
    nullptr,
    output.data(),
    static_cast<ULONG>(output.size()),
    BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
}

bool HmacSha256(
  std::span<const std::uint8_t> secret,
  const std::vector<std::span<const std::uint8_t>>& parts,
  std::array<std::uint8_t, kProofBytes>& output) {
  if (secret.size() > std::numeric_limits<ULONG>::max()) return false;
  AlgorithmHandle algorithm;
  if (BCryptOpenAlgorithmProvider(
        algorithm.Address(), BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) {
    return false;
  }

  DWORD object_length = 0;
  DWORD copied = 0;
  if (BCryptGetProperty(
        algorithm.Get(), BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length), &copied, 0) != 0) {
    return false;
  }
  std::vector<std::uint8_t> object(object_length);
  HashHandle hash;
  if (BCryptCreateHash(
        algorithm.Get(), hash.Address(), object.data(), object_length,
        const_cast<PUCHAR>(secret.data()), static_cast<ULONG>(secret.size()), 0) != 0) {
    SecureErase(object);
    return false;
  }
  for (const auto part : parts) {
    if (part.size() > std::numeric_limits<ULONG>::max() ||
        BCryptHashData(
          hash.Get(), const_cast<PUCHAR>(part.data()), static_cast<ULONG>(part.size()), 0) != 0) {
      SecureErase(object);
      return false;
    }
  }
  const bool success = BCryptFinishHash(
    hash.Get(), output.data(), static_cast<ULONG>(output.size()), 0) == 0;
  SecureErase(object);
  return success;
}

bool ConstantTimeEqual(std::span<const std::uint8_t> left, std::span<const std::uint8_t> right) {
  if (left.size() != right.size()) return false;
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < left.size(); ++index) {
    difference = static_cast<std::uint8_t>(difference | (left[index] ^ right[index]));
  }
  return difference == 0;
}

void SecureErase(std::span<std::uint8_t> bytes) {
  if (!bytes.empty()) SecureZeroMemory(bytes.data(), bytes.size());
}

std::vector<std::uint8_t> Bytes(std::string_view value) {
  return {value.begin(), value.end()};
}

}  // namespace ztools::native_host
