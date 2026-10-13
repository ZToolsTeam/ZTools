#pragma once

#include "ztools_service/pipe_protocol.hpp"

#include <Windows.h>

#include <array>
#include <cstdint>
#include <span>

namespace ztools::service {

inline constexpr std::size_t kServiceSecretSize = 32;
inline constexpr std::size_t kServiceNonceSize = 32;
inline constexpr std::size_t kServiceProofSize = 32;

using ServiceSecret = std::array<std::uint8_t, kServiceSecretSize>;
using ServiceNonce = std::array<std::uint8_t, kServiceNonceSize>;
using ServiceProof = std::array<std::uint8_t, kServiceProofSize>;

enum class ServiceAuthDirection {
  client_to_service,
  service_to_client,
};

bool IsValidServiceSecret(std::span<const std::uint8_t> secret) noexcept;
bool RandomServiceBytes(std::span<std::uint8_t> output) noexcept;
bool MakeServiceServerProof(
    std::span<const std::uint8_t> secret,
    DWORD client_process_id,
    std::span<const std::uint8_t> client_nonce,
    std::span<const std::uint8_t> server_nonce,
    ServiceProof* proof) noexcept;
bool MakeServiceClientProof(
    std::span<const std::uint8_t> secret,
    DWORD client_process_id,
    std::span<const std::uint8_t> client_nonce,
    std::span<const std::uint8_t> server_nonce,
    ServiceProof* proof) noexcept;
bool DeriveServiceSessionKey(
    std::span<const std::uint8_t> secret,
    DWORD client_process_id,
    std::span<const std::uint8_t> client_nonce,
    std::span<const std::uint8_t> server_nonce,
    ServiceSecret* session_key) noexcept;
bool SealServiceFrame(
    std::span<const std::uint8_t> session_key,
    ServiceAuthDirection direction,
    ServiceFrame* frame) noexcept;
bool OpenServiceFrame(
    std::span<const std::uint8_t> session_key,
    ServiceAuthDirection direction,
    ServiceFrame* frame) noexcept;
bool ConstantTimeServiceEqual(
    std::span<const std::uint8_t> left,
    std::span<const std::uint8_t> right) noexcept;
void SecureEraseServiceBytes(std::span<std::uint8_t> bytes) noexcept;

}  // namespace ztools::service
