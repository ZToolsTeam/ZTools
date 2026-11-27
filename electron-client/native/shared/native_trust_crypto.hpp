#pragma once

#include <Windows.h>
#include <bcrypt.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace ztools::native_trust {

inline constexpr std::size_t kSha256Bytes = 32;
inline constexpr std::size_t kP256PublicKeyBytes = 64;
inline constexpr std::size_t kP256SignatureBytes = 64;

inline void SecureEraseBytes(std::span<std::uint8_t> bytes) noexcept {
  if (!bytes.empty()) {
    SecureZeroMemory(bytes.data(), bytes.size());
  }
}

inline bool ConstantTimeEqualBytes(
  std::span<const std::uint8_t> left,
  std::span<const std::uint8_t> right) noexcept {
  if (left.size() != right.size()) return false;
  std::uint8_t diff = 0;
  for (std::size_t i = 0; i < left.size(); ++i) {
    diff |= static_cast<std::uint8_t>(left[i] ^ right[i]);
  }
  return diff == 0;
}

inline std::string BytesToLowerHex(std::span<const std::uint8_t> bytes) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(bytes.size() * 2);
  for (const std::uint8_t byte : bytes) {
    out.push_back(kHex[(byte >> 4U) & 0x0fU]);
    out.push_back(kHex[byte & 0x0fU]);
  }
  return out;
}

namespace detail {

class AlgHandle {
 public:
  ~AlgHandle() {
    if (value_ != nullptr) BCryptCloseAlgorithmProvider(value_, 0);
  }
  BCRYPT_ALG_HANDLE* Address() noexcept { return &value_; }
  BCRYPT_ALG_HANDLE Get() const noexcept { return value_; }

 private:
  BCRYPT_ALG_HANDLE value_ = nullptr;
};

class HashHandle {
 public:
  ~HashHandle() {
    if (value_ != nullptr) BCryptDestroyHash(value_);
  }
  BCRYPT_HASH_HANDLE* Address() noexcept { return &value_; }
  BCRYPT_HASH_HANDLE Get() const noexcept { return value_; }

 private:
  BCRYPT_HASH_HANDLE value_ = nullptr;
};

class KeyHandle {
 public:
  ~KeyHandle() {
    if (value_ != nullptr) BCryptDestroyKey(value_);
  }
  BCRYPT_KEY_HANDLE* Address() noexcept { return &value_; }
  BCRYPT_KEY_HANDLE Get() const noexcept { return value_; }

 private:
  BCRYPT_KEY_HANDLE value_ = nullptr;
};

inline bool CreateSha256(
  AlgHandle& algorithm,
  HashHandle& hash,
  std::vector<std::uint8_t>& object) {
  if (BCryptOpenAlgorithmProvider(
        algorithm.Address(), BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    return false;
  }
  DWORD object_length = 0;
  DWORD copied = 0;
  if (BCryptGetProperty(
        algorithm.Get(), BCRYPT_OBJECT_LENGTH,
        reinterpret_cast<PUCHAR>(&object_length), sizeof(object_length), &copied, 0) != 0) {
    return false;
  }
  object.resize(object_length);
  return BCryptCreateHash(
    algorithm.Get(), hash.Address(), object.data(), object_length,
    nullptr, 0, 0) == 0;
}

}  // namespace detail

inline bool Sha256Bytes(
  std::span<const std::uint8_t> bytes,
  std::array<std::uint8_t, kSha256Bytes>& output) {
  if (bytes.size() > std::numeric_limits<ULONG>::max()) return false;
  detail::AlgHandle algorithm;
  detail::HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!detail::CreateSha256(algorithm, hash, object)) return false;
  const bool ok =
    (bytes.empty() || BCryptHashData(
      hash.Get(), const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0) == 0) &&
    BCryptFinishHash(hash.Get(), output.data(), static_cast<ULONG>(output.size()), 0) == 0;
  SecureEraseBytes(object);
  return ok;
}

inline bool Sha256PrefixedBytes(
  std::span<const std::uint8_t> prefix,
  std::span<const std::uint8_t> payload,
  std::array<std::uint8_t, kSha256Bytes>& output) {
  if (prefix.size() > std::numeric_limits<ULONG>::max() ||
      payload.size() > std::numeric_limits<ULONG>::max()) {
    return false;
  }
  detail::AlgHandle algorithm;
  detail::HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!detail::CreateSha256(algorithm, hash, object)) return false;
  const bool ok =
    (prefix.empty() || BCryptHashData(
      hash.Get(), const_cast<PUCHAR>(prefix.data()), static_cast<ULONG>(prefix.size()), 0) == 0) &&
    (payload.empty() || BCryptHashData(
      hash.Get(), const_cast<PUCHAR>(payload.data()), static_cast<ULONG>(payload.size()), 0) == 0) &&
    BCryptFinishHash(hash.Get(), output.data(), static_cast<ULONG>(output.size()), 0) == 0;
  SecureEraseBytes(object);
  return ok;
}

inline bool Sha256File(HANDLE file, std::array<std::uint8_t, kSha256Bytes>& output) {
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) return false;
  detail::AlgHandle algorithm;
  detail::HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!detail::CreateSha256(algorithm, hash, object)) return false;
  std::array<std::uint8_t, 64U * 1024U> buffer{};
  while (true) {
    DWORD read = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      SecureEraseBytes(object);
      return false;
    }
    if (read == 0) break;
    if (BCryptHashData(hash.Get(), buffer.data(), read, 0) != 0) {
      SecureEraseBytes(object);
      return false;
    }
  }
  const bool ok = BCryptFinishHash(
    hash.Get(), output.data(), static_cast<ULONG>(output.size()), 0) == 0;
  SecureEraseBytes(object);
  return ok;
}

// 从已锁定源句柄单遍流式复制到目标句柄并同步计算 SHA-256 与总字节数（用于特权执行快照）
inline bool CopyAndHashFile(
  HANDLE source,
  HANDLE destination,
  std::uint64_t& total_bytes_out,
  std::array<std::uint8_t, kSha256Bytes>& output) {
  total_bytes_out = 0;
  LARGE_INTEGER start{};
  if (!SetFilePointerEx(source, start, nullptr, FILE_BEGIN)) return false;
  detail::AlgHandle algorithm;
  detail::HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!detail::CreateSha256(algorithm, hash, object)) return false;
  std::array<std::uint8_t, 64U * 1024U> buffer{};
  while (true) {
    DWORD read = 0;
    if (!ReadFile(source, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      SecureEraseBytes(object);
      return false;
    }
    if (read == 0) break;
    if (BCryptHashData(hash.Get(), buffer.data(), read, 0) != 0) {
      SecureEraseBytes(object);
      return false;
    }
    DWORD offset = 0;
    while (offset < read) {
      DWORD written = 0;
      if (!WriteFile(destination, buffer.data() + offset, read - offset, &written, nullptr) || written == 0) {
        SecureEraseBytes(object);
        return false;
      }
      offset += written;
    }
    total_bytes_out += read;
  }
  const bool ok = BCryptFinishHash(
    hash.Get(), output.data(), static_cast<ULONG>(output.size()), 0) == 0;
  SecureEraseBytes(object);
  return ok;
}

// 域分离 ECDSA P-256 + SHA-256 验签（签名格式为 64 字节 IEEE P1363 r||s）
inline bool VerifyEcdsaP256Sha256(
  const std::array<std::uint8_t, kP256PublicKeyBytes>& pub_xy,
  std::span<const std::uint8_t> domain_prefix,
  std::span<const std::uint8_t> raw_bytes,
  const std::array<std::uint8_t, kP256SignatureBytes>& sig_rs) {
  std::array<std::uint8_t, kSha256Bytes> digest{};
  if (!Sha256PrefixedBytes(domain_prefix, raw_bytes, digest)) {
    SecureEraseBytes(digest);
    return false;
  }

  detail::AlgHandle ecdsa_alg;
  if (BCryptOpenAlgorithmProvider(
        ecdsa_alg.Address(), BCRYPT_ECDSA_P256_ALGORITHM, nullptr, 0) != 0) {
    SecureEraseBytes(digest);
    return false;
  }

  std::array<std::uint8_t, sizeof(BCRYPT_ECCKEY_BLOB) + kP256PublicKeyBytes> blob{};
  BCRYPT_ECCKEY_BLOB header{};
  header.dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
  header.cbKey = 32;
  std::memcpy(blob.data(), &header, sizeof(header));
  std::memcpy(blob.data() + sizeof(header), pub_xy.data(), kP256PublicKeyBytes);

  detail::KeyHandle pub_key;
  if (BCryptImportKeyPair(
        ecdsa_alg.Get(), nullptr, BCRYPT_ECCPUBLIC_BLOB, pub_key.Address(),
        blob.data(), static_cast<ULONG>(blob.size()), 0) != 0) {
    SecureEraseBytes(digest);
    return false;
  }

  const NTSTATUS status = BCryptVerifySignature(
    pub_key.Get(),
    nullptr,
    digest.data(),
    static_cast<ULONG>(digest.size()),
    const_cast<PUCHAR>(sig_rs.data()),
    static_cast<ULONG>(sig_rs.size()),
    0);
  SecureEraseBytes(digest);
  return status == 0;
}

}  // namespace ztools::native_trust
