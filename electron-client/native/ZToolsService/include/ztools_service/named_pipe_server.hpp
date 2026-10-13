#pragma once

#include "ztools_service/pipe_security.hpp"
#include "ztools_service/service_auth.hpp"

#include <Windows.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>

namespace ztools::service {

inline constexpr wchar_t kServicePipeName[] =
    L"\\\\.\\pipe\\ZToolsPrivilegedService.v1";

enum class PipeServerState {
  stopped,
  starting,
  listening,
  stopping,
  failed,
};

class CommandDispatcher;

class NamedPipeServer final {
 public:
  NamedPipeServer(
      std::wstring pipe_name,
      PipeIdentityMode identity_mode,
      ServiceSecret secret,
      std::wstring expected_user_sid_string,
      const CommandDispatcher* command_dispatcher);
  ~NamedPipeServer();

  NamedPipeServer(const NamedPipeServer&) = delete;
  NamedPipeServer& operator=(const NamedPipeServer&) = delete;

  bool Start() noexcept;
  void Stop() noexcept;

  PipeServerState state() const noexcept;
  DWORD last_error() const noexcept;
  HANDLE failure_event() const noexcept;
  const std::wstring& pipe_name() const noexcept;
  const std::wstring& user_sid_string() const noexcept;
  const std::wstring& service_sid_string() const noexcept;
  DWORD last_client_process_id() const noexcept;
  DWORD last_client_session_id() const noexcept;

 private:
  void WorkerMain() noexcept;
  bool ServeClient(HANDLE pipe, DWORD* fatal_error) noexcept;
  void Fail(DWORD error) noexcept;

  std::wstring pipe_name_;
  PipeIdentityMode identity_mode_;
  ServiceSecret secret_{};
  std::wstring expected_user_sid_string_;
  const CommandDispatcher* command_dispatcher_ = nullptr;
  HANDLE stop_event_ = nullptr;
  HANDLE ready_event_ = nullptr;
  HANDLE failure_event_ = nullptr;
  std::unique_ptr<PipeSecurity> security_;
  std::thread worker_;
  std::atomic<PipeServerState> state_{PipeServerState::stopped};
  std::atomic<DWORD> last_error_{ERROR_SUCCESS};
  std::atomic<DWORD> last_client_process_id_{0};
  std::atomic<DWORD> last_client_session_id_{0};
};

}  // namespace ztools::service
