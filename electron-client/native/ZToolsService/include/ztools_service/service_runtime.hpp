#pragma once

#include "ztools_service/command_dispatcher.hpp"
#include "ztools_service/command_policy.hpp"
#include "ztools_service/explorer_restarter.hpp"
#include "ztools_service/privileged_dll_loader.hpp"
#include "ztools_service/privileged_dll_resolver.hpp"
#include "ztools_service/service_auth.hpp"

#include <Windows.h>

#include <atomic>
#include <memory>
#include <string>

namespace ztools::service {

inline constexpr wchar_t kServiceName[] = L"ZToolsPrivilegedService";
inline constexpr wchar_t kServiceDisplayName[] = L"ZTools Privileged Service";
enum class RuntimeState {
  cold,
  starting,
  running,
  stopping,
  stopped,
  failed,
};

enum class RuntimeMode {
  service,
  console,
};

struct RuntimeOptions {
  RuntimeMode mode = RuntimeMode::service;
  std::wstring pipe_name;
  // Optional shared secret for protocol tests; production uses Windows pipe identity.
  ServiceSecret secret{};
  std::wstring expected_user_sid_string;
  PrivilegedDllPathConfig privileged_dll_resolver;
};

class NamedPipeServer;

const wchar_t* StateName(RuntimeState state) noexcept;

class ServiceRuntime final {
 public:
  explicit ServiceRuntime(RuntimeOptions options);
  ~ServiceRuntime();

  ServiceRuntime(const ServiceRuntime&) = delete;
  ServiceRuntime& operator=(const ServiceRuntime&) = delete;

  bool Start() noexcept;
  void RequestStop() noexcept;
  DWORD WaitForStop(DWORD timeout_ms) noexcept;
  void Stop() noexcept;

  RuntimeState state() const noexcept;
  DWORD last_error() const noexcept;
  const NamedPipeServer* pipe_server() const noexcept;
  const PrivilegedDllResolver* privileged_dll_resolver() const noexcept;
  const PrivilegedDllLoader* privileged_dll_loader() const noexcept;
  const CommandPolicy* command_policy() const noexcept;
  const CommandDispatcher* command_dispatcher() const noexcept;

 private:
  HANDLE stop_event_ = nullptr;
  RuntimeOptions options_;
  std::unique_ptr<PrivilegedDllResolver> privileged_dll_resolver_;
  std::unique_ptr<PrivilegedDllLoader> privileged_dll_loader_;
  std::unique_ptr<CommandPolicy> command_policy_;
  std::unique_ptr<ExplorerRestartExecutor> explorer_restarter_;
  std::unique_ptr<CommandDispatcher> command_dispatcher_;
  std::unique_ptr<NamedPipeServer> pipe_server_;
  std::atomic<RuntimeState> state_{RuntimeState::cold};
  std::atomic<DWORD> last_error_{ERROR_SUCCESS};
};

}  // namespace ztools::service
