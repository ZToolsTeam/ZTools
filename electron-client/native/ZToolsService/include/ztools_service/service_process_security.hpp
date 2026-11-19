#pragma once

#include <Windows.h>

namespace ztools::service {

inline constexpr DWORD kServiceProcessQueryAccess = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;

// user_sid must be the TokenUser already authorized for the service pipe.
// Existing ACEs, including denies, are retained; no global principal is granted access.
bool GrantServiceProcessQueryAccess(HANDLE process, PSID user_sid, DWORD* error) noexcept;

}  // namespace ztools::service
