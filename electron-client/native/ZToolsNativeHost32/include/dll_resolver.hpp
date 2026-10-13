#pragma once

#include "manifest.hpp"

#include <Windows.h>

#include <optional>
#include <string>

namespace ztools::native_host {

struct DllPathConfig {
  ManifestTrustConfig plugin_trust;
  ManifestTrustConfig resources_trust;
};

struct DllCheckResult {
  bool success = false;
  std::string code;
  std::string message;
};

struct DllResolveResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;

  DllResolveResult() = default;
  ~DllResolveResult();
  DllResolveResult(const DllResolveResult&) = delete;
  DllResolveResult& operator=(const DllResolveResult&) = delete;
  DllResolveResult(DllResolveResult&& other) noexcept;
  DllResolveResult& operator=(DllResolveResult&& other) noexcept;
};

void ReadDllPathConfig(DllPathConfig& config);

class DllResolver {
 public:
  explicit DllResolver(DllPathConfig config);

  DllCheckResult Check(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name) const;
  DllResolveResult Resolve(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name) const;

 private:
  DllPathConfig config_;
};

}  // namespace ztools::native_host
