#pragma once

#include "../../shared/native_trust_verifier.hpp"

#include <Windows.h>

#include <optional>
#include <set>
#include <string>
#include <vector>

namespace ztools::native_host {

struct NativeTrustRuntimeConfig {
  std::wstring plugin_root;
  std::wstring resources_root;
  bool has_plugin_root = false;
  bool has_resources_root = false;
  ztools::native_trust::TestTrustOverrides test_overrides;
};

using DllPathConfig = NativeTrustRuntimeConfig;

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
  bool restrict_functions = true;
  std::set<std::string> allowed_functions;
  // 会话期内锁定的全部 PE 句柄（main / dependency / helper，不含 native-trust.json / .sig）
  std::vector<HANDLE> locked_handles;

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
  ztools::native_trust::TrustBundle bundle_;
};

}  // namespace ztools::native_host
