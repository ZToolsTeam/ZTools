#include "ztools_service/service_auth.hpp"

#include <bcrypt.h>

#include <algorithm>
#include <limits>
#include <string_view>
#include <vector>

namespace ztools::service {
namespace {

constexpr std::string_view kServerDomain = "ZTOOLS_SERVICE_SERVER_V1";
constexpr std::string_view kClientDomain = "ZTOOLS_SERVICE_CLIENT_V1";
constexpr std::string_view kSessionDomain = "ZTOOLS_SERVICE_SESSION_V1";
constexpr std::string_view kClientFrameDomain = "ZTOOLS_SERVICE_FRAME_CLIENT_V1";
constexpr std::string_view kServiceFrameDomain = "ZTOOLS_SERVICE_FRAME_SERVER_V1";

std::span<const std::uint8_t> ByteSpan(const std::string_view value) noexcept {
  return {
      reinterpret_cast<const std::uint8_t*>(value.data()), value.size()};
}

class AlgorithmHandle final {
 public:
  ~AlgorithmHandle() {
    if (value_ != nullptr) {
      BCryptCloseAlgorithmProvider(value_, 0);
    }
  }
  BCRYPT_ALG_HANDLE get() const noexcept { return value_; }
  BCRYPT_ALG_HANDLE* address() noexcept { return &value_; }

 private:
  BCRYPT_ALG_HANDLE value_ = nullptr;
};

class HashHandle final {
 public:
  ~HashHandle() {
    if (value_ != nullptr) {
      BCryptDestroyHash(value_);
    }
  }
  BCRYPT_HASH_HANDLE get() const noexcept { return value_; }
  BCRYPT_HASH_HANDLE* address() noexcept { return &value_; }

 private:
  BCRYPT_HASH_HANDLE value_ = nullptr;
};

std::array<std::uint8_t, sizeof(std::uint16_t)> Uint16Bytes(
    const std::uint16_t value) noexcept {
  return {
      static_cast<std::uint8_t>(value & 0xff),
      static_cast<std::uint8_t>((value >> 8) & 0xff),
  };
}

std::array<std::uint8_t, sizeof(std::uint32_t)> Uint32Bytes(
    const std::uint32_t value) noexcept {
  return {
      static_cast<std::uint8_t>(value & 0xff),
      static_cast<std::uint8_t>((value >> 8) & 0xff),
      static_cast<std::uint8_t>((value >> 16) & 0xff),
      static_cast<std::uint8_t>((value >> 24) & 0xff),
  };
}

std::array<std::uint8_t, sizeof(std::uint64_t)> Uint64Bytes(
    const std::uint64_t value) noexcept {
  std::array<std::uint8_t, sizeof(std::uint64_t)> encoded{};
  for (unsigned int shift = 0; shift < 64; shift += 8) {
    encoded[shift / 8] = static_cast<std::uint8_t>((value >> shift) & 0xff);
  }
  return encoded;
}

bool HmacSha256(
    const std::span<const std::uint8_t> secret,
    const std::vector<std::span<const std::uint8_t>>& parts,
    ServiceProof* const output) noexcept {
  if (output == nullptr || secret.empty() ||
      secret.size() > std::numeric_limits<ULONG>::max()) {
    return false;
  }
  AlgorithmHandle algorithm;
  if (BCryptOpenAlgorithmProvider(
          algorithm.address(),
          BCRYPT_SHA256_ALGORITHM,
          nullptr,
          BCRYPT_ALG_HANDLE_HMAC_FLAG) != 0) {
    return false;
  }
  DWORD object_size = 0;
  DWORD copied = 0;
  if (BCryptGetProperty(
          algorithm.get(),
          BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_size),
          sizeof(object_size),
          &copied,
          0) != 0 ||
      object_size == 0) {
    return false;
  }
  std::vector<std::uint8_t> object(object_size);
  HashHandle hash;
  if (BCryptCreateHash(
          algorithm.get(),
          hash.address(),
          object.data(),
          object_size,
          const_cast<PUCHAR>(secret.data()),
          static_cast<ULONG>(secret.size()),
          0) != 0) {
    SecureEraseServiceBytes(object);
    return false;
  }
  for (const std::span<const std::uint8_t> part : parts) {
    if (part.size() > std::numeric_limits<ULONG>::max() ||
        BCryptHashData(
            hash.get(),
            const_cast<PUCHAR>(part.data()),
            static_cast<ULONG>(part.size()),
            0) != 0) {
      SecureEraseServiceBytes(object);
      return false;
    }
  }
  const bool success = BCryptFinishHash(
                           hash.get(),
                           output->data(),
                           static_cast<ULONG>(output->size()),
                           0) == 0;
  SecureEraseServiceBytes(object);
  return success;
}

bool MakeHandshakeValue(
    const std::span<const std::uint8_t> secret,
    const std::string_view domain,
    const DWORD client_process_id,
    const std::span<const std::uint8_t> client_nonce,
    const std::span<const std::uint8_t> server_nonce,
    ServiceProof* const output) noexcept {
  if (client_nonce.size() != kServiceNonceSize ||
      server_nonce.size() != kServiceNonceSize) {
    return false;
  }
  const auto version = Uint16Bytes(kServiceProtocolVersion);
  const auto process_id = Uint32Bytes(client_process_id);
  const std::uint8_t separator = 0;
  // With no installation secret, Windows pipe identity is the access boundary.
  // The per-connection nonce supplies session framing material, not peer authentication.
  return HmacSha256(
      IsValidServiceSecret(secret) ? secret : server_nonce,
      {
          ByteSpan(domain),
          std::span(&separator, 1),
          version,
          process_id,
          client_nonce,
          server_nonce,
      },
      output);
}

bool MakeFrameProof(
    const std::span<const std::uint8_t> session_key,
    const ServiceAuthDirection direction,
    const ServiceFrame& frame,
    const std::span<const std::uint8_t> payload,
    ServiceProof* const output) noexcept {
  const std::string_view domain = direction == ServiceAuthDirection::client_to_service
                                      ? kClientFrameDomain
                                      : kServiceFrameDomain;
  const auto version = Uint16Bytes(kServiceProtocolVersion);
  const auto type = Uint16Bytes(static_cast<std::uint16_t>(frame.type));
  const auto flags = Uint32Bytes(kServiceFrameFlagAuthenticated);
  const auto request_id = Uint64Bytes(frame.request_id);
  if (payload.size() > std::numeric_limits<std::uint32_t>::max()) {
    return false;
  }
  const auto payload_size = Uint32Bytes(static_cast<std::uint32_t>(payload.size()));
  const std::uint8_t separator = 0;
  return HmacSha256(
      session_key,
      {
          ByteSpan(domain),
          std::span(&separator, 1),
          version,
          type,
          flags,
          request_id,
          payload_size,
          payload,
      },
      output);
}

}  // namespace

bool IsValidServiceSecret(const std::span<const std::uint8_t> secret) noexcept {
  return secret.size() == kServiceSecretSize &&
         std::any_of(secret.begin(), secret.end(), [](const std::uint8_t byte) {
           return byte != 0;
         });
}

bool RandomServiceBytes(const std::span<std::uint8_t> output) noexcept {
  return output.size() <= std::numeric_limits<ULONG>::max() &&
         BCryptGenRandom(
             nullptr,
             output.data(),
             static_cast<ULONG>(output.size()),
             BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0;
}

bool MakeServiceServerProof(
    const std::span<const std::uint8_t> secret,
    const DWORD client_process_id,
    const std::span<const std::uint8_t> client_nonce,
    const std::span<const std::uint8_t> server_nonce,
    ServiceProof* const proof) noexcept {
  return MakeHandshakeValue(
      secret, kServerDomain, client_process_id, client_nonce, server_nonce, proof);
}

bool MakeServiceClientProof(
    const std::span<const std::uint8_t> secret,
    const DWORD client_process_id,
    const std::span<const std::uint8_t> client_nonce,
    const std::span<const std::uint8_t> server_nonce,
    ServiceProof* const proof) noexcept {
  return MakeHandshakeValue(
      secret, kClientDomain, client_process_id, client_nonce, server_nonce, proof);
}

bool DeriveServiceSessionKey(
    const std::span<const std::uint8_t> secret,
    const DWORD client_process_id,
    const std::span<const std::uint8_t> client_nonce,
    const std::span<const std::uint8_t> server_nonce,
    ServiceSecret* const session_key) noexcept {
  return MakeHandshakeValue(
      secret, kSessionDomain, client_process_id, client_nonce, server_nonce, session_key);
}

bool SealServiceFrame(
    const std::span<const std::uint8_t> session_key,
    const ServiceAuthDirection direction,
    ServiceFrame* const frame) noexcept {
  if (frame == nullptr || !IsValidServiceSecret(session_key) || frame->flags != 0 ||
      frame->payload.size() > kServiceMaxPayloadSize - kServiceProofSize) {
    return false;
  }
  ServiceProof proof{};
  if (!MakeFrameProof(session_key, direction, *frame, frame->payload, &proof)) {
    return false;
  }
  try {
    frame->payload.insert(frame->payload.end(), proof.begin(), proof.end());
  } catch (...) {
    SecureEraseServiceBytes(proof);
    return false;
  }
  frame->flags = kServiceFrameFlagAuthenticated;
  SecureEraseServiceBytes(proof);
  return true;
}

bool OpenServiceFrame(
    const std::span<const std::uint8_t> session_key,
    const ServiceAuthDirection direction,
    ServiceFrame* const frame) noexcept {
  if (frame == nullptr || !IsValidServiceSecret(session_key) ||
      frame->flags != kServiceFrameFlagAuthenticated ||
      frame->payload.size() < kServiceProofSize) {
    return false;
  }
  const std::size_t content_size = frame->payload.size() - kServiceProofSize;
  const std::span<const std::uint8_t> content(frame->payload.data(), content_size);
  const std::span<const std::uint8_t> supplied(
      frame->payload.data() + content_size, kServiceProofSize);
  ServiceProof expected{};
  const bool valid = MakeFrameProof(
                         session_key, direction, *frame, content, &expected) &&
                     ConstantTimeServiceEqual(supplied, expected);
  SecureEraseServiceBytes(expected);
  if (!valid) {
    return false;
  }
  frame->payload.resize(content_size);
  return true;
}

bool ConstantTimeServiceEqual(
    const std::span<const std::uint8_t> left,
    const std::span<const std::uint8_t> right) noexcept {
  if (left.size() != right.size()) {
    return false;
  }
  std::uint8_t difference = 0;
  for (std::size_t index = 0; index < left.size(); ++index) {
    difference = static_cast<std::uint8_t>(difference | (left[index] ^ right[index]));
  }
  return difference == 0;
}

void SecureEraseServiceBytes(const std::span<std::uint8_t> bytes) noexcept {
  if (!bytes.empty()) {
    SecureZeroMemory(bytes.data(), bytes.size());
  }
}

}  // namespace ztools::service
