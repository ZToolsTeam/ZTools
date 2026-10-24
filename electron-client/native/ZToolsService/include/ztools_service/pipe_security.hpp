#pragma once

#include <Windows.h>

#include <memory>
#include <string>
#include <vector>

namespace ztools::service {

enum class PipeIdentityMode {
  service,
  current_process,
};

enum class PipeClientValidation {
  allowed,
  rejected,
  fatal,
};

class PipeSecurity final {
 public:
  ~PipeSecurity();

  PipeSecurity(const PipeSecurity&) = delete;
  PipeSecurity& operator=(const PipeSecurity&) = delete;

  static std::unique_ptr<PipeSecurity> Create(
      PipeIdentityMode mode,
      const std::wstring& expected_user_sid_string,
      DWORD* error);

  SECURITY_ATTRIBUTES* attributes() noexcept;
  PipeClientValidation ValidateClient(
      HANDLE pipe,
      DWORD* client_process_id,
      DWORD* client_session_id,
      DWORD* error) const noexcept;
  const std::wstring& user_sid_string() const noexcept;
  const std::wstring& service_sid_string() const noexcept;

 private:
  PipeSecurity() = default;

  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_{};
  std::vector<std::uint8_t> user_sid_;
  std::vector<std::uint8_t> service_sid_;
  std::wstring user_sid_string_;
  std::wstring service_sid_string_;
};

}  // namespace ztools::service
