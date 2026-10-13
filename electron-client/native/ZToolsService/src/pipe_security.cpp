#include "ztools_service/pipe_security.hpp"

#include "ztools_service/service_runtime.hpp"

#include <Aclapi.h>
#include <Sddl.h>
#include <WtsApi32.h>

#include <array>

namespace ztools::service {
namespace {

bool CopyTokenUserSid(
    const HANDLE token,
    std::vector<std::uint8_t>* const sid,
    DWORD* const error) {
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<std::uint8_t> buffer(size);
  if (GetTokenInformation(token, TokenUser, buffer.data(), size, &size) == FALSE) {
    *error = GetLastError();
    return false;
  }
  const auto* const token_user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  const DWORD sid_size = GetLengthSid(token_user->User.Sid);
  sid->resize(sid_size);
  if (CopySid(sid_size, sid->data(), token_user->User.Sid) == FALSE) {
    *error = GetLastError();
    return false;
  }
  return true;
}

bool GetCurrentProcessUserSid(
    std::vector<std::uint8_t>* const sid,
    DWORD* const error) {
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == FALSE) {
    *error = GetLastError();
    return false;
  }
  const bool copied = CopyTokenUserSid(token, sid, error);
  CloseHandle(token);
  return copied;
}

bool GetActiveConsoleUserSid(
    std::vector<std::uint8_t>* const sid,
    DWORD* const error) {
  const DWORD session_id = WTSGetActiveConsoleSessionId();
  if (session_id == 0xffffffff) {
    *error = ERROR_NO_SUCH_LOGON_SESSION;
    return false;
  }
  HANDLE token = nullptr;
  if (WTSQueryUserToken(session_id, &token) == FALSE) {
    *error = GetLastError();
    return false;
  }
  const bool copied = CopyTokenUserSid(token, sid, error);
  CloseHandle(token);
  return copied;
}

bool LookupServiceSid(
    std::vector<std::uint8_t>* const sid,
    DWORD* const error) {
  const std::wstring account =
      std::wstring(L"NT SERVICE\\") + kServiceName;
  DWORD sid_size = 0;
  DWORD domain_size = 0;
  SID_NAME_USE sid_type = SidTypeUnknown;
  LookupAccountNameW(
      nullptr, account.c_str(), nullptr, &sid_size, nullptr, &domain_size, &sid_type);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || sid_size == 0) {
    *error = GetLastError();
    return false;
  }
  sid->resize(sid_size);
  std::vector<wchar_t> domain(domain_size);
  if (LookupAccountNameW(
          nullptr,
          account.c_str(),
          sid->data(),
          &sid_size,
          domain.empty() ? nullptr : domain.data(),
          &domain_size,
          &sid_type) == FALSE) {
    *error = GetLastError();
    return false;
  }
  const auto* const identifier = GetSidIdentifierAuthority(sid->data());
  if (IsValidSid(sid->data()) == FALSE || identifier == nullptr ||
      identifier->Value[5] != 5 ||
      *GetSidSubAuthorityCount(sid->data()) < 2 ||
      *GetSidSubAuthority(sid->data(), 0) != SECURITY_SERVICE_ID_BASE_RID) {
    *error = ERROR_INVALID_SID;
    return false;
  }
  return true;
}

bool TokenContainsEnabledSid(const PSID sid, DWORD* const error) {
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == FALSE) {
    *error = GetLastError();
    return false;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenGroups, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) {
    *error = GetLastError();
    CloseHandle(token);
    return false;
  }
  std::vector<std::uint8_t> buffer(size);
  if (GetTokenInformation(token, TokenGroups, buffer.data(), size, &size) == FALSE) {
    *error = GetLastError();
    CloseHandle(token);
    return false;
  }
  CloseHandle(token);
  const auto* const groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if (EqualSid(groups->Groups[index].Sid, sid) != FALSE &&
        (groups->Groups[index].Attributes & SE_GROUP_ENABLED) != 0 &&
        (groups->Groups[index].Attributes & SE_GROUP_USE_FOR_DENY_ONLY) == 0) {
      return true;
    }
  }
  *error = ERROR_ACCESS_DENIED;
  return false;
}

bool SidToString(const PSID sid, std::wstring* const value, DWORD* const error) {
  wchar_t* text = nullptr;
  if (ConvertSidToStringSidW(sid, &text) == FALSE) {
    *error = GetLastError();
    return false;
  }
  *value = text;
  LocalFree(text);
  return true;
}

bool ValidateMinimalDacl(
    const PSECURITY_DESCRIPTOR descriptor,
    const PSID user_sid,
    const PSID service_sid,
    DWORD* const error) {
  std::array<std::uint8_t, SECURITY_MAX_SID_SIZE> system_sid{};
  DWORD system_sid_size = static_cast<DWORD>(system_sid.size());
  if (CreateWellKnownSid(
          WinLocalSystemSid, nullptr, system_sid.data(), &system_sid_size) == FALSE) {
    *error = GetLastError();
    return false;
  }
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL dacl = nullptr;
  if (GetSecurityDescriptorDacl(
          descriptor, &dacl_present, &dacl, &dacl_defaulted) == FALSE ||
      dacl_present == FALSE || dacl == nullptr || dacl->AceCount != 3) {
    *error = ERROR_INVALID_ACL;
    return false;
  }
  bool found_system = false;
  bool found_user = false;
  bool found_service = false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, index, &raw_ace) == FALSE) {
      *error = GetLastError();
      return false;
    }
    const auto* const header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || header->AceFlags != 0) {
      *error = ERROR_INVALID_ACL;
      return false;
    }
    const auto* const ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    const PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
    if (EqualSid(ace_sid, system_sid.data()) != FALSE) {
      if (found_system || ace->Mask != GENERIC_ALL) {
        *error = ERROR_INVALID_ACL;
        return false;
      }
      found_system = true;
    } else if (EqualSid(ace_sid, user_sid) != FALSE) {
      if (found_user || ace->Mask != (GENERIC_READ | GENERIC_WRITE)) {
        *error = ERROR_INVALID_ACL;
        return false;
      }
      found_user = true;
    } else if (EqualSid(ace_sid, service_sid) != FALSE) {
      if (found_service || ace->Mask != GENERIC_ALL) {
        *error = ERROR_INVALID_ACL;
        return false;
      }
      found_service = true;
    } else {
      *error = ERROR_INVALID_ACL;
      return false;
    }
  }
  if (!found_system || !found_user || !found_service) {
    *error = ERROR_INVALID_ACL;
    return false;
  }
  return true;
}

}  // namespace

PipeSecurity::~PipeSecurity() {
  if (descriptor_ != nullptr) {
    LocalFree(descriptor_);
    descriptor_ = nullptr;
  }
}

std::unique_ptr<PipeSecurity> PipeSecurity::Create(
    const PipeIdentityMode mode,
    const std::wstring& expected_user_sid_string,
    DWORD* const error) {
  if (error == nullptr) {
    return nullptr;
  }
  *error = ERROR_SUCCESS;
  auto security = std::unique_ptr<PipeSecurity>(new PipeSecurity());
  const bool have_user = mode == PipeIdentityMode::service
                             ? GetActiveConsoleUserSid(&security->user_sid_, error)
                             : GetCurrentProcessUserSid(&security->user_sid_, error);
  if (!have_user || !LookupServiceSid(&security->service_sid_, error)) {
    return nullptr;
  }
  if (mode == PipeIdentityMode::service &&
      !TokenContainsEnabledSid(security->service_sid_.data(), error)) {
    return nullptr;
  }
  if (!SidToString(
          security->user_sid_.data(), &security->user_sid_string_, error) ||
      !SidToString(
          security->service_sid_.data(), &security->service_sid_string_, error)) {
    return nullptr;
  }
  if (!expected_user_sid_string.empty() &&
      security->user_sid_string_ != expected_user_sid_string) {
    *error = ERROR_RETRY;
    return nullptr;
  }
  const std::wstring sddl =
      L"D:P(A;;GA;;;SY)(A;;GRGW;;;" + security->user_sid_string_ +
      L")(A;;GA;;;" + security->service_sid_string_ + L")";
  if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(),
          SDDL_REVISION_1,
          &security->descriptor_,
          nullptr) == FALSE) {
    *error = GetLastError();
    return nullptr;
  }
  if (!ValidateMinimalDacl(
          security->descriptor_,
          security->user_sid_.data(),
          security->service_sid_.data(),
          error)) {
    return nullptr;
  }
  security->attributes_.nLength = sizeof(SECURITY_ATTRIBUTES);
  security->attributes_.lpSecurityDescriptor = security->descriptor_;
  security->attributes_.bInheritHandle = FALSE;
  return security;
}

SECURITY_ATTRIBUTES* PipeSecurity::attributes() noexcept {
  return &attributes_;
}

PipeClientValidation PipeSecurity::ValidateClient(
    const HANDLE pipe,
    DWORD* const client_process_id,
    DWORD* const client_session_id,
    DWORD* const error) const noexcept {
  if (client_process_id == nullptr || client_session_id == nullptr ||
      error == nullptr) {
    return PipeClientValidation::fatal;
  }
  *client_process_id = 0;
  *client_session_id = 0;
  *error = ERROR_SUCCESS;
  ULONG process_id = 0;
  if (GetNamedPipeClientProcessId(pipe, &process_id) == FALSE) {
    *error = GetLastError();
    return PipeClientValidation::rejected;
  }
  if (process_id == 0) {
    *error = ERROR_INVALID_DATA;
    return PipeClientValidation::rejected;
  }
  ULONG session_id = 0;
  if (GetNamedPipeClientSessionId(pipe, &session_id) == FALSE) {
    *error = GetLastError();
    return PipeClientValidation::rejected;
  }
  if (session_id == 0) {
    *error = ERROR_INVALID_DATA;
    return PipeClientValidation::rejected;
  }
  if (ImpersonateNamedPipeClient(pipe) == FALSE) {
    *error = GetLastError();
    return PipeClientValidation::rejected;
  }
  HANDLE token = nullptr;
  bool allowed = false;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token) != FALSE) {
    std::vector<std::uint8_t> client_sid;
    allowed = CopyTokenUserSid(token, &client_sid, error) &&
              EqualSid(
                  client_sid.data(),
                  const_cast<std::uint8_t*>(user_sid_.data())) != FALSE;
    CloseHandle(token);
  } else {
    *error = GetLastError();
  }
  if (RevertToSelf() == FALSE) {
    *error = GetLastError();
    return PipeClientValidation::fatal;
  }
  if (!allowed) {
    if (*error == ERROR_SUCCESS) {
      *error = ERROR_ACCESS_DENIED;
    }
    return PipeClientValidation::rejected;
  }
  *client_process_id = static_cast<DWORD>(process_id);
  *client_session_id = static_cast<DWORD>(session_id);
  return PipeClientValidation::allowed;
}

const std::wstring& PipeSecurity::user_sid_string() const noexcept {
  return user_sid_string_;
}

const std::wstring& PipeSecurity::service_sid_string() const noexcept {
  return service_sid_string_;
}

}  // namespace ztools::service
