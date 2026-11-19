#pragma once

#include <Windows.h>

#include <string_view>

namespace ztools::service {

struct ClientBridgePeerIdentity {
  DWORD pipe_server_process_id = 0;
  DWORD service_process_id = 0;
  DWORD service_type = 0;
  DWORD service_state = 0;
  std::wstring_view service_account;
  std::wstring_view configured_image;
  std::wstring_view running_image;
};

// Pure policy shared by the real HANDLE verifier and native regression tests.
bool IsTrustedClientBridgePeer(const ClientBridgePeerIdentity& identity) noexcept;

// Owns the one verified pipe connection until both forwarding threads finish.
int RunClientBridge(std::wstring_view pipe_name, std::wstring_view timeout) noexcept;

#if defined(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
// No command-line entry: isolated tests exercise forwarding after policy validation.
int RunClientBridgeRelayForTest(HANDLE pipe, HANDLE parent, HANDLE service) noexcept;
#endif

}  // namespace ztools::service
