#include "ztools_service/service_runtime.hpp"

#include "ztools_service/named_pipe_server.hpp"

#include <iterator>
#include <utility>

namespace ztools::service {

const wchar_t* StateName(const RuntimeState state) noexcept {
  switch (state) {
    case RuntimeState::cold:
      return L"cold";
    case RuntimeState::starting:
      return L"starting";
    case RuntimeState::running:
      return L"running";
    case RuntimeState::stopping:
      return L"stopping";
    case RuntimeState::stopped:
      return L"stopped";
    case RuntimeState::failed:
      return L"failed";
    default:
      return L"unknown";
  }
}

ServiceRuntime::ServiceRuntime(RuntimeOptions options)
    : options_(std::move(options)) {
  SecureEraseServiceBytes(options.secret);
  stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (stop_event_ == nullptr) {
    last_error_.store(GetLastError(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
  }
}

ServiceRuntime::~ServiceRuntime() {
  if (pipe_server_ != nullptr) {
    pipe_server_->Stop();
    pipe_server_.reset();
  }
  if (stop_event_ != nullptr) {
    SetEvent(stop_event_);
    CloseHandle(stop_event_);
    stop_event_ = nullptr;
  }
  state_.store(RuntimeState::stopped, std::memory_order_release);
  SecureEraseServiceBytes(options_.secret);
}

bool ServiceRuntime::Start() noexcept {
  RuntimeState expected = RuntimeState::cold;
  if (!state_.compare_exchange_strong(
          expected, RuntimeState::starting, std::memory_order_acq_rel)) {
    return false;
  }
  if (options_.mode == RuntimeMode::service && !IsValidServiceSecret(options_.secret)) {
    last_error_.store(ERROR_INVALID_DATA, std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return false;
  }
  if (stop_event_ == nullptr) {
    state_.store(RuntimeState::failed, std::memory_order_release);
    return false;
  }
  if (ResetEvent(stop_event_) == FALSE) {
    last_error_.store(GetLastError(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return false;
  }
  try {
    const PipeIdentityMode identity_mode =
        options_.mode == RuntimeMode::service
            ? PipeIdentityMode::service
            : PipeIdentityMode::current_process;
    privileged_dll_resolver_ = std::make_unique<PrivilegedDllResolver>(
        options_.privileged_dll_resolver);
    privileged_dll_loader_ = std::make_unique<PrivilegedDllLoader>(
        privileged_dll_resolver_.get());
    if (!privileged_dll_loader_->system_only_ready()) {
      last_error_.store(
          privileged_dll_loader_->last_error() == ERROR_SUCCESS
              ? ERROR_NOT_SUPPORTED
              : privileged_dll_loader_->last_error(),
          std::memory_order_relaxed);
      state_.store(RuntimeState::failed, std::memory_order_release);
      return false;
    }
    command_policy_ = std::make_unique<CommandPolicy>();
    explorer_restarter_ = std::make_unique<WindowsExplorerRestarter>();
    command_dispatcher_ = std::make_unique<CommandDispatcher>(
        privileged_dll_resolver_.get(),
        privileged_dll_loader_.get(),
        command_policy_.get(),
        explorer_restarter_.get());
    pipe_server_ = std::make_unique<NamedPipeServer>(
        options_.pipe_name,
        identity_mode,
        options_.secret,
        options_.expected_user_sid_string,
        command_dispatcher_.get());
  } catch (...) {
    last_error_.store(ERROR_NOT_ENOUGH_MEMORY, std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return false;
  }
  if (!pipe_server_->Start()) {
    last_error_.store(pipe_server_->last_error(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return false;
  }
  last_error_.store(ERROR_SUCCESS, std::memory_order_relaxed);
  state_.store(RuntimeState::running, std::memory_order_release);
  return true;
}

void ServiceRuntime::RequestStop() noexcept {
  RuntimeState current = state_.load(std::memory_order_acquire);
  while (current == RuntimeState::starting || current == RuntimeState::running) {
    if (state_.compare_exchange_weak(
            current, RuntimeState::stopping, std::memory_order_acq_rel)) {
      if (stop_event_ != nullptr && SetEvent(stop_event_) == FALSE) {
        last_error_.store(GetLastError(), std::memory_order_relaxed);
        state_.store(RuntimeState::failed, std::memory_order_release);
      }
      return;
    }
  }
}

DWORD ServiceRuntime::WaitForStop(const DWORD timeout_ms) noexcept {
  if (stop_event_ == nullptr || pipe_server_ == nullptr ||
      pipe_server_->failure_event() == nullptr) {
    last_error_.store(ERROR_INVALID_HANDLE, std::memory_order_relaxed);
    return WAIT_FAILED;
  }
  const HANDLE handles[] = {stop_event_, pipe_server_->failure_event()};
  const DWORD result = WaitForMultipleObjects(
      static_cast<DWORD>(std::size(handles)), handles, FALSE, timeout_ms);
  if (result == WAIT_OBJECT_0 + 1) {
    last_error_.store(pipe_server_->last_error(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return WAIT_FAILED;
  }
  if (result == WAIT_FAILED) {
    last_error_.store(GetLastError(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
  }
  return result;
}

void ServiceRuntime::Stop() noexcept {
  RequestStop();
  if (pipe_server_ != nullptr) {
    pipe_server_->Stop();
  }
  if (state_.load(std::memory_order_acquire) == RuntimeState::failed) {
    return;
  }
  if (stop_event_ != nullptr && SetEvent(stop_event_) == FALSE) {
    last_error_.store(GetLastError(), std::memory_order_relaxed);
    state_.store(RuntimeState::failed, std::memory_order_release);
    return;
  }
  state_.store(RuntimeState::stopped, std::memory_order_release);
}

RuntimeState ServiceRuntime::state() const noexcept {
  return state_.load(std::memory_order_acquire);
}

DWORD ServiceRuntime::last_error() const noexcept {
  return last_error_.load(std::memory_order_relaxed);
}

const NamedPipeServer* ServiceRuntime::pipe_server() const noexcept {
  return pipe_server_.get();
}

const PrivilegedDllResolver* ServiceRuntime::privileged_dll_resolver() const noexcept {
  return privileged_dll_resolver_.get();
}

const PrivilegedDllLoader* ServiceRuntime::privileged_dll_loader() const noexcept {
  return privileged_dll_loader_.get();
}

const CommandPolicy* ServiceRuntime::command_policy() const noexcept {
  return command_policy_.get();
}

const CommandDispatcher* ServiceRuntime::command_dispatcher() const noexcept {
  return command_dispatcher_.get();
}

}  // namespace ztools::service
