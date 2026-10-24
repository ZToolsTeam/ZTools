#pragma once

#include "ztools_service/pipe_security.hpp"
#include "ztools_service/service_auth.hpp"

#include <Windows.h>

#include <string>

namespace ztools::service {

bool ResolveServiceDataRoot(
    PipeIdentityMode identity_mode,
    std::wstring* data_root,
    std::wstring* user_sid_string,
    DWORD* error) noexcept;

bool LoadInstalledServiceSecret(
    PipeIdentityMode identity_mode,
    ServiceSecret* secret,
    std::wstring* data_root,
    std::wstring* resolved_path,
    std::wstring* user_sid_string,
    DWORD* error) noexcept;

}  // namespace ztools::service
