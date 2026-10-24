#pragma once

#include "ztools_service/privileged_manifest.hpp"

#include <Windows.h>

#include <optional>
#include <string>

namespace ztools::service {

struct PrivilegedDllPathConfig {
  std::wstring data_root;
  PrivilegedManifestTrustConfig manifest_trust;
};

struct PrivilegedDllCheckResult {
  bool success = false;
  std::string code;
  std::string message;
};

struct PrivilegedDllResolveResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;

  PrivilegedDllResolveResult() = default;
  ~PrivilegedDllResolveResult();
  PrivilegedDllResolveResult(const PrivilegedDllResolveResult&) = delete;
  PrivilegedDllResolveResult& operator=(
      const PrivilegedDllResolveResult&) = delete;
  PrivilegedDllResolveResult(PrivilegedDllResolveResult&& other) noexcept;
  PrivilegedDllResolveResult& operator=(
      PrivilegedDllResolveResult&& other) noexcept;
};

bool ReadInstalledPrivilegedDllPathConfig(
    const std::wstring& data_root,
    PrivilegedDllPathConfig* config,
    DWORD* error) noexcept;

class PrivilegedDllResolver final {
 public:
  explicit PrivilegedDllResolver(PrivilegedDllPathConfig config);
  ~PrivilegedDllResolver();

  PrivilegedDllResolver(const PrivilegedDllResolver&) = delete;
  PrivilegedDllResolver& operator=(const PrivilegedDllResolver&) = delete;

  bool trusted() const noexcept;

  PrivilegedDllCheckResult Check(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& function_name) const;
  PrivilegedDllResolveResult Resolve(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::optional<std::string>& function_name) const;

 private:
  PrivilegedDllPathConfig config_;
};

}  // namespace ztools::service
