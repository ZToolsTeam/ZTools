#pragma once

#include <Windows.h>

#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace ztools::service {

inline constexpr std::size_t kPrivilegedManifestSha256Bytes = 32;

struct PrivilegedManifestTrustConfig {
  std::wstring data_root;
  std::array<std::uint8_t, kPrivilegedManifestSha256Bytes> manifest_sha256{};
  bool trusted = false;
};

struct PrivilegedManifestCheckResult {
  bool success = false;
  std::string code;
  std::string message;
};

struct PrivilegedManifestResolveResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;

  PrivilegedManifestResolveResult() = default;
  ~PrivilegedManifestResolveResult();
  PrivilegedManifestResolveResult(const PrivilegedManifestResolveResult&) = delete;
  PrivilegedManifestResolveResult& operator=(
      const PrivilegedManifestResolveResult&) = delete;
  PrivilegedManifestResolveResult(PrivilegedManifestResolveResult&& other) noexcept;
  PrivilegedManifestResolveResult& operator=(
      PrivilegedManifestResolveResult&& other) noexcept;
};

bool ParsePrivilegedManifestSha256(
    const std::wstring& value,
    std::array<std::uint8_t, kPrivilegedManifestSha256Bytes>* output) noexcept;

bool ReadInstalledPrivilegedManifestTrustConfig(
    const std::wstring& data_root,
    PrivilegedManifestTrustConfig* config,
    DWORD* error) noexcept;

class PrivilegedManifestResolver final {
 public:
  explicit PrivilegedManifestResolver(PrivilegedManifestTrustConfig config);
  ~PrivilegedManifestResolver();

  PrivilegedManifestResolver(const PrivilegedManifestResolver&) = delete;
  PrivilegedManifestResolver& operator=(const PrivilegedManifestResolver&) = delete;

  bool trusted() const noexcept;
  PrivilegedManifestCheckResult Check(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& function_name) const;
  PrivilegedManifestResolveResult Resolve(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::optional<std::string>& function_name) const;

 private:
  PrivilegedManifestTrustConfig config_;
};

}  // namespace ztools::service
