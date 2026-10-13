#pragma once

#include "ztools_service/privileged_dll_resolver.hpp"

#include <Windows.h>

#include <optional>
#include <memory>
#include <string>

namespace ztools::service {

struct PrivilegedDllSessionLease;
struct PrivilegedDllSessionRegistry;

struct PrivilegedDllLoadResult {
  bool success = false;
  std::string code;
  std::string message;
  HMODULE module = nullptr;
  PrivilegedDllResolveResult validation;
  std::shared_ptr<PrivilegedDllSessionLease> session;

  PrivilegedDllLoadResult() = default;
  ~PrivilegedDllLoadResult();
  PrivilegedDllLoadResult(const PrivilegedDllLoadResult&) = delete;
  PrivilegedDllLoadResult& operator=(const PrivilegedDllLoadResult&) = delete;
  PrivilegedDllLoadResult(PrivilegedDllLoadResult&& other) noexcept;
  PrivilegedDllLoadResult& operator=(PrivilegedDllLoadResult&& other) noexcept;
};

class PrivilegedDllLoader final {
 public:
  explicit PrivilegedDllLoader(const PrivilegedDllResolver* resolver);

  bool system_only_ready() const noexcept;
  DWORD last_error() const noexcept;
  PrivilegedDllLoadResult Load(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::optional<std::string>& function_name) const;

 private:
  const PrivilegedDllResolver* resolver_ = nullptr;
  bool system_only_ready_ = false;
  DWORD last_error_ = ERROR_SUCCESS;
  std::shared_ptr<PrivilegedDllSessionRegistry> sessions_;
};

}  // namespace ztools::service
