#include "ztools_service/service_process_security.hpp"

#include <Aclapi.h>

namespace ztools::service {
namespace {

bool BroadPrincipal(const PSID sid) noexcept {
  return IsWellKnownSid(sid, WinWorldSid) != FALSE ||
         IsWellKnownSid(sid, WinAuthenticatedUserSid) != FALSE ||
         IsWellKnownSid(sid, WinBuiltinUsersSid) != FALSE ||
         IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != FALSE ||
         IsWellKnownSid(sid, WinAnonymousSid) != FALSE ||
         IsWellKnownSid(sid, WinInteractiveSid) != FALSE ||
         IsWellKnownSid(sid, WinNetworkSid) != FALSE;
}

bool ExplicitQueryDenial(const PACL dacl, const PSID user_sid, DWORD* const error) noexcept {
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw = nullptr;
    if (GetAce(dacl, index, &raw) == FALSE) { *error = GetLastError(); return true; }
    const auto* const header = static_cast<const ACE_HEADER*>(raw);
    if (header->AceType != ACCESS_DENIED_ACE_TYPE || (header->AceFlags & INHERIT_ONLY_ACE) != 0) continue;
    const auto* const denied = static_cast<const ACCESS_DENIED_ACE*>(raw);
    const PSID denied_sid = const_cast<DWORD*>(&denied->SidStart);
    if (EqualSid(denied_sid, user_sid) == FALSE &&
        IsWellKnownSid(denied_sid, WinWorldSid) == FALSE &&
        IsWellKnownSid(denied_sid, WinAuthenticatedUserSid) == FALSE) continue;
    if ((denied->Mask & (kServiceProcessQueryAccess | GENERIC_ALL | GENERIC_READ | GENERIC_EXECUTE)) != 0) {
      *error = ERROR_ACCESS_DENIED;
      return true;
    }
  }
  return false;
}

}  // namespace

bool GrantServiceProcessQueryAccess(const HANDLE process, const PSID user_sid, DWORD* const error) noexcept {
  if (error == nullptr) return false;
  *error = ERROR_SUCCESS;
  // GetCurrentProcess() is the valid (HANDLE)-1 pseudo handle; OpenProcess fails with nullptr.
  if (process == nullptr || user_sid == nullptr || IsValidSid(user_sid) == FALSE) {
    *error = ERROR_INVALID_PARAMETER; return false;
  }
  if (BroadPrincipal(user_sid)) { *error = ERROR_INVALID_SID; return false; }
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PACL existing = nullptr;
  DWORD status = GetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &existing, nullptr, &descriptor);
  if (status != ERROR_SUCCESS) { *error = status; return false; }
  if (existing == nullptr || IsValidAcl(existing) == FALSE) {
    LocalFree(descriptor); *error = ERROR_INVALID_ACL; return false;
  }
  if (ExplicitQueryDenial(existing, user_sid, error)) { LocalFree(descriptor); return false; }
  EXPLICIT_ACCESSW entry{};
  entry.grfAccessPermissions = kServiceProcessQueryAccess;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = NO_INHERITANCE;
  BuildTrusteeWithSidW(&entry.Trustee, user_sid);
  entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
  PACL updated = nullptr;
  status = SetEntriesInAclW(1, &entry, existing, &updated);
  if (status == ERROR_SUCCESS) {
    status = SetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, updated, nullptr);
  }
  if (updated != nullptr) LocalFree(updated);
  LocalFree(descriptor);
  *error = status;
  return status == ERROR_SUCCESS;
}

}  // namespace ztools::service
