#pragma once

#include <Windows.h>

#include <array>
#include <cstdint>
#include <optional>
#include <string>

namespace ztools::native_host {

constexpr std::size_t kSha256Bytes = 32;

struct ManifestTrustConfig {
  std::wstring plugin_root;
  std::array<std::uint8_t, kSha256Bytes> manifest_sha256{};
  bool trusted = false;
};

struct ManifestCheckResult {
  bool success = false;
  std::string code;
  std::string message;
};

struct ManifestResolveResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;

  ManifestResolveResult() = default;
  ~ManifestResolveResult();
  ManifestResolveResult(const ManifestResolveResult&) = delete;
  ManifestResolveResult& operator=(const ManifestResolveResult&) = delete;
  ManifestResolveResult(ManifestResolveResult&& other) noexcept;
  ManifestResolveResult& operator=(ManifestResolveResult&& other) noexcept;
};

void ReadManifestTrustConfig(ManifestTrustConfig& config);
void ReadManifestTrustConfig(
  ManifestTrustConfig& config,
  const wchar_t* root_environment,
  const wchar_t* digest_environment);

class ManifestResolver {
 public:
  explicit ManifestResolver(ManifestTrustConfig config);

  ManifestCheckResult Check(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name) const;
  ManifestResolveResult Resolve(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name) const;

 private:
  ManifestTrustConfig config_;
};

}  // namespace ztools::native_host
