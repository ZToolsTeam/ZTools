#include "ztools_service/named_pipe_server.hpp"

#include "ztools_service/command_dispatcher.hpp"
#include "ztools_service/console_log.hpp"
#include "ztools_service/service_command_protocol.hpp"

#include "ztools_service/pipe_protocol.hpp"
#include "ztools_service/service_auth.hpp"

#include <array>
#include <iterator>
#include <mutex>
#include <utility>
#include <vector>

namespace ztools::service {
namespace {

constexpr DWORD kPipeBufferSize = 64 * 1024;
constexpr DWORD kPipeIoTimeoutMs = 5'000;
constexpr DWORD kPipeStartTimeoutMs = 5'000;

enum class ConnectionAuthState {
  await_client_hello,
  await_client_auth,
  ready,
};

class ConnectionAuthContext final {
 public:
  ~ConnectionAuthContext() {
    SecureEraseServiceBytes(client_nonce);
    SecureEraseServiceBytes(server_nonce);
    SecureEraseServiceBytes(session_key);
  }

  ConnectionAuthState state = ConnectionAuthState::await_client_hello;
  ServiceNonce client_nonce{};
  ServiceNonce server_nonce{};
  ServiceSecret session_key{};
  std::uint64_t last_request_id = 0;
};

class UniqueHandle final {
 public:
  explicit UniqueHandle(const HANDLE handle = nullptr) noexcept : handle_(handle) {}
  ~UniqueHandle() {
    if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
    }
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  HANDLE get() const noexcept { return handle_; }

 private:
  HANDLE handle_;
};

struct TaskEventPump {
  UniqueHandle stop{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::thread worker;
  ~TaskEventPump() {
    if (stop.get()) SetEvent(stop.get());
    if (worker.joinable()) worker.join();
  }
};

enum class IoResult {
  success,
  closed,
  stopping,
  failed,
};

void CancelAndDrainOverlapped(
    const HANDLE pipe,
    OVERLAPPED* const overlapped) noexcept {
  CancelIoEx(pipe, overlapped);
  DWORD ignored = 0;
  GetOverlappedResult(pipe, overlapped, &ignored, TRUE);
}

std::uint32_t ReadUint32(const std::uint8_t* const input) noexcept {
  std::uint32_t value = 0;
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    value |= static_cast<std::uint32_t>(input[shift / 8]) << shift;
  }
  return value;
}

IoResult WaitForOverlapped(
    const HANDLE pipe,
    OVERLAPPED* const overlapped,
    const HANDLE stop_event,
    const DWORD timeout_ms,
    DWORD* const transferred,
    DWORD* const error) noexcept {
  const HANDLE handles[] = {stop_event, overlapped->hEvent};
  const DWORD wait_result = WaitForMultipleObjects(
      static_cast<DWORD>(std::size(handles)), handles, FALSE, timeout_ms);
  if (wait_result == WAIT_OBJECT_0) {
    CancelAndDrainOverlapped(pipe, overlapped);
    return IoResult::stopping;
  }
  if (wait_result == WAIT_TIMEOUT) {
    CancelAndDrainOverlapped(pipe, overlapped);
    *error = ERROR_TIMEOUT;
    return IoResult::closed;
  }
  if (wait_result != WAIT_OBJECT_0 + 1) {
    *error = GetLastError();
    CancelAndDrainOverlapped(pipe, overlapped);
    return IoResult::failed;
  }
  if (GetOverlappedResult(pipe, overlapped, transferred, FALSE) == FALSE) {
    *error = GetLastError();
    if (*error == ERROR_BROKEN_PIPE || *error == ERROR_NO_DATA ||
        *error == ERROR_OPERATION_ABORTED) {
      return IoResult::closed;
    }
    return IoResult::failed;
  }
  return IoResult::success;
}

IoResult ReadExact(
    const HANDLE pipe,
    const HANDLE stop_event,
    std::uint8_t* output,
    const std::size_t size,
    const DWORD timeout_ms,
    DWORD* const error) noexcept {
  std::size_t offset = 0;
  while (offset < size) {
    UniqueHandle io_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (io_event.get() == nullptr) {
      *error = GetLastError();
      return IoResult::failed;
    }
    OVERLAPPED overlapped{};
    overlapped.hEvent = io_event.get();
    DWORD transferred = 0;
    const DWORD remaining = static_cast<DWORD>(size - offset);
    if (ReadFile(pipe, output + offset, remaining, &transferred, &overlapped) == FALSE) {
      const DWORD read_error = GetLastError();
      if (read_error != ERROR_IO_PENDING) {
        *error = read_error;
        return read_error == ERROR_BROKEN_PIPE || read_error == ERROR_NO_DATA
                   ? IoResult::closed
                   : IoResult::failed;
      }
      const IoResult result = WaitForOverlapped(
          pipe, &overlapped, stop_event, timeout_ms, &transferred, error);
      if (result != IoResult::success) {
        return result;
      }
    }
    if (transferred == 0) {
      return IoResult::closed;
    }
    offset += transferred;
  }
  return IoResult::success;
}

IoResult WriteExact(
    const HANDLE pipe,
    const HANDLE stop_event,
    const std::uint8_t* input,
    const std::size_t size,
    DWORD* const error) noexcept {
  std::size_t offset = 0;
  while (offset < size) {
    UniqueHandle io_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    if (io_event.get() == nullptr) {
      *error = GetLastError();
      return IoResult::failed;
    }
    OVERLAPPED overlapped{};
    overlapped.hEvent = io_event.get();
    DWORD transferred = 0;
    const DWORD remaining = static_cast<DWORD>(size - offset);
    if (WriteFile(pipe, input + offset, remaining, &transferred, &overlapped) == FALSE) {
      const DWORD write_error = GetLastError();
      if (write_error != ERROR_IO_PENDING) {
        *error = write_error;
        return write_error == ERROR_BROKEN_PIPE || write_error == ERROR_NO_DATA
                   ? IoResult::closed
                   : IoResult::failed;
      }
      const IoResult result = WaitForOverlapped(
          pipe,
          &overlapped,
          stop_event,
          kPipeIoTimeoutMs,
          &transferred,
          error);
      if (result != IoResult::success) {
        return result;
      }
    }
    if (transferred == 0) {
      return IoResult::closed;
    }
    offset += transferred;
  }
  return IoResult::success;
}

bool ConnectClient(
    const HANDLE pipe,
    const HANDLE stop_event,
    DWORD* const error) noexcept {
  UniqueHandle connect_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (connect_event.get() == nullptr) {
    *error = GetLastError();
    return false;
  }
  OVERLAPPED overlapped{};
  overlapped.hEvent = connect_event.get();
  if (ConnectNamedPipe(pipe, &overlapped) != FALSE) {
    return true;
  }
  const DWORD connect_error = GetLastError();
  if (connect_error == ERROR_PIPE_CONNECTED) {
    return true;
  }
  if (connect_error != ERROR_IO_PENDING) {
    *error = connect_error;
    return false;
  }
  DWORD transferred = 0;
  const IoResult result = WaitForOverlapped(
      pipe, &overlapped, stop_event, INFINITE, &transferred, error);
  return result == IoResult::success;
}

}  // namespace

NamedPipeServer::NamedPipeServer(
    std::wstring pipe_name,
    const PipeIdentityMode identity_mode,
    ServiceSecret secret,
    std::wstring expected_user_sid_string,
    const CommandDispatcher* const command_dispatcher)
    : pipe_name_(std::move(pipe_name)),
      identity_mode_(identity_mode),
      secret_(std::move(secret)),
      expected_user_sid_string_(std::move(expected_user_sid_string)),
      command_dispatcher_(command_dispatcher) {
  SecureEraseServiceBytes(secret);
  stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  DWORD creation_error = stop_event_ == nullptr ? GetLastError() : ERROR_SUCCESS;
  ready_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (ready_event_ == nullptr && creation_error == ERROR_SUCCESS) {
    creation_error = GetLastError();
  }
  failure_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (failure_event_ == nullptr && creation_error == ERROR_SUCCESS) {
    creation_error = GetLastError();
  }
  if (stop_event_ == nullptr || ready_event_ == nullptr || failure_event_ == nullptr) {
    last_error_.store(creation_error, std::memory_order_relaxed);
    state_.store(PipeServerState::failed, std::memory_order_release);
  }
}

NamedPipeServer::~NamedPipeServer() {
  Stop();
  SecureEraseServiceBytes(secret_);
  if (failure_event_ != nullptr) {
    CloseHandle(failure_event_);
  }
  if (ready_event_ != nullptr) {
    CloseHandle(ready_event_);
  }
  if (stop_event_ != nullptr) {
    CloseHandle(stop_event_);
  }
}

bool NamedPipeServer::Start() noexcept {
  PipeServerState expected = PipeServerState::stopped;
  if (!state_.compare_exchange_strong(
          expected, PipeServerState::starting, std::memory_order_acq_rel)) {
    return false;
  }
  if (stop_event_ == nullptr || ready_event_ == nullptr || failure_event_ == nullptr) {
    state_.store(PipeServerState::failed, std::memory_order_release);
    return false;
  }
  ResetEvent(stop_event_);
  ResetEvent(ready_event_);
  ResetEvent(failure_event_);
  last_client_process_id_.store(0, std::memory_order_relaxed);
  last_client_session_id_.store(0, std::memory_order_relaxed);
  DWORD security_error = ERROR_SUCCESS;
  security_ = PipeSecurity::Create(
      identity_mode_, expected_user_sid_string_, &security_error);
  if (security_ == nullptr) {
    Fail(security_error);
    return false;
  }
  try {
    worker_ = std::thread(&NamedPipeServer::WorkerMain, this);
  } catch (...) {
    Fail(ERROR_NOT_ENOUGH_MEMORY);
    return false;
  }
  const HANDLE handles[] = {ready_event_, failure_event_};
  const DWORD wait_result = WaitForMultipleObjects(
      static_cast<DWORD>(std::size(handles)), handles, FALSE, kPipeStartTimeoutMs);
  if (wait_result != WAIT_OBJECT_0 ||
      state_.load(std::memory_order_acquire) != PipeServerState::listening) {
    if (wait_result == WAIT_TIMEOUT) {
      last_error_.store(ERROR_TIMEOUT, std::memory_order_relaxed);
    }
    Stop();
    return false;
  }
  return true;
}

void NamedPipeServer::Stop() noexcept {
  PipeServerState current = state_.load(std::memory_order_acquire);
  if (current == PipeServerState::stopped) {
    return;
  }
  if (current != PipeServerState::failed) {
    state_.store(PipeServerState::stopping, std::memory_order_release);
  }
  if (stop_event_ != nullptr) {
    SetEvent(stop_event_);
  }
  if (worker_.joinable()) {
    worker_.join();
  }
  security_.reset();
  if (current != PipeServerState::failed &&
      state_.load(std::memory_order_acquire) != PipeServerState::failed) {
    state_.store(PipeServerState::stopped, std::memory_order_release);
  }
}

PipeServerState NamedPipeServer::state() const noexcept {
  return state_.load(std::memory_order_acquire);
}

DWORD NamedPipeServer::last_error() const noexcept {
  return last_error_.load(std::memory_order_relaxed);
}

HANDLE NamedPipeServer::failure_event() const noexcept {
  return failure_event_;
}

const std::wstring& NamedPipeServer::pipe_name() const noexcept {
  return pipe_name_;
}

const std::wstring& NamedPipeServer::user_sid_string() const noexcept {
  static const std::wstring empty;
  return security_ == nullptr ? empty : security_->user_sid_string();
}

const std::wstring& NamedPipeServer::service_sid_string() const noexcept {
  static const std::wstring empty;
  return security_ == nullptr ? empty : security_->service_sid_string();
}

DWORD NamedPipeServer::last_client_process_id() const noexcept {
  return last_client_process_id_.load(std::memory_order_relaxed);
}

DWORD NamedPipeServer::last_client_session_id() const noexcept {
  return last_client_session_id_.load(std::memory_order_relaxed);
}

void NamedPipeServer::WorkerMain() noexcept {
  bool announced_ready = false;
  while (WaitForSingleObject(stop_event_, 0) == WAIT_TIMEOUT) {
    const HANDLE raw_pipe = CreateNamedPipeW(
        pipe_name_.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        kPipeBufferSize,
        kPipeBufferSize,
        kPipeIoTimeoutMs,
        security_->attributes());
    if (raw_pipe == INVALID_HANDLE_VALUE) {
      Fail(GetLastError());
      return;
    }
    UniqueHandle pipe(raw_pipe);
    state_.store(PipeServerState::listening, std::memory_order_release);
    if (!announced_ready) {
      announced_ready = true;
      SetEvent(ready_event_);
    }
    DWORD connect_error = ERROR_SUCCESS;
    if (!ConnectClient(pipe.get(), stop_event_, &connect_error)) {
      if (WaitForSingleObject(stop_event_, 0) == WAIT_OBJECT_0) {
        break;
      }
      Fail(connect_error);
      return;
    }
    DWORD fatal_error = ERROR_SUCCESS;
    ServeClient(pipe.get(), &fatal_error);
    DisconnectNamedPipe(pipe.get());
    if (fatal_error != ERROR_SUCCESS) {
      Fail(fatal_error);
      return;
    }
  }
  if (state_.load(std::memory_order_acquire) != PipeServerState::failed) {
    state_.store(PipeServerState::stopped, std::memory_order_release);
  }
}

bool NamedPipeServer::ServeClient(
    const HANDLE pipe,
    DWORD* const fatal_error) noexcept {
  if (fatal_error == nullptr) {
    return false;
  }
  *fatal_error = ERROR_SUCCESS;
  DWORD client_process_id = 0;
  DWORD client_session_id = 0;
  ConnectionAuthContext auth;
  std::mutex write_mutex;
  const auto write_frame = [pipe, this, &write_mutex](ServiceFrame response) noexcept {
    std::lock_guard lock(write_mutex);
    std::vector<std::uint8_t> encoded;
    try {
      encoded = EncodeServiceFrame(response);
    } catch (...) {
      return false;
    }
    DWORD io_error = ERROR_SUCCESS;
    return WriteExact(
               pipe, stop_event_, encoded.data(), encoded.size(), &io_error) ==
           IoResult::success;
  };
  const auto write_error = [&write_frame](
                               const std::uint64_t request_id,
                               const std::string_view error_code) noexcept {
    return write_frame(MakeServiceErrorFrame(request_id, error_code));
  };
  const auto write_authenticated = [&auth, &write_frame](
                                       ServiceFrame response) noexcept {
    return SealServiceFrame(
               auth.session_key,
               ServiceAuthDirection::service_to_client,
               &response) &&
           write_frame(std::move(response));
  };
  TaskEventPump events;
  while (WaitForSingleObject(stop_event_, 0) == WAIT_TIMEOUT) {
    std::array<std::uint8_t, sizeof(std::uint32_t)> prefix{};
    DWORD io_error = ERROR_SUCCESS;
    const DWORD prefix_timeout = auth.state == ConnectionAuthState::ready
                                     ? INFINITE
                                     : kPipeIoTimeoutMs;
    const IoResult prefix_result = ReadExact(
        pipe,
        stop_event_,
        prefix.data(),
        prefix.size(),
        prefix_timeout,
        &io_error);
    if (prefix_result != IoResult::success) {
      return prefix_result != IoResult::failed;
    }
    const std::uint32_t frame_size = ReadUint32(prefix.data());
    if (frame_size < kServiceFrameHeaderSize || frame_size > kServiceMaxFrameSize) {
      return true;
    }
    std::vector<std::uint8_t> body(frame_size);
    const IoResult body_result = ReadExact(
        pipe,
        stop_event_,
        body.data(),
        body.size(),
        kPipeIoTimeoutMs,
        &io_error);
    if (body_result != IoResult::success) {
      return body_result != IoResult::failed;
    }
    // Named-pipe impersonation uses the last server read. Validate after the
    // bounded first frame is read, but before parsing or sending a response.
    if (client_process_id == 0) {
      DWORD identity_error = ERROR_SUCCESS;
      const PipeClientValidation validation = security_->ValidateClient(
          pipe, &client_process_id, &client_session_id, &identity_error);
      if (validation != PipeClientValidation::allowed) {
        if (validation == PipeClientValidation::fatal) {
          *fatal_error = identity_error == ERROR_SUCCESS
                             ? ERROR_GEN_FAILURE
                             : identity_error;
        }
        return false;
      }
      last_client_process_id_.store(client_process_id, std::memory_order_relaxed);
      last_client_session_id_.store(client_session_id, std::memory_order_relaxed);
    }
    ServiceFrame request;
    if (!ParseServiceFrameBody(body, &request)) {
      write_error(0, "PROTOCOL_ERROR");
      return true;
    }

    switch (auth.state) {
      case ConnectionAuthState::await_client_hello: {
        if (request.type != ServiceFrameType::client_hello || request.flags != 0 ||
            request.request_id == 0 ||
            request.request_id <= auth.last_request_id ||
            request.payload.size() != auth.client_nonce.size()) {
          write_error(request.request_id, "AUTH_REQUIRED");
          return true;
        }
        std::copy(
            request.payload.begin(), request.payload.end(), auth.client_nonce.begin());
        ServiceProof server_proof{};
        if (!RandomServiceBytes(auth.server_nonce) ||
            !MakeServiceServerProof(
                secret_,
                client_process_id,
                auth.client_nonce,
                auth.server_nonce,
                &server_proof)) {
          SecureEraseServiceBytes(server_proof);
          return false;
        }
        ServiceFrame response;
        response.type = ServiceFrameType::server_hello;
        response.request_id = request.request_id;
        try {
          response.payload.insert(
              response.payload.end(),
              auth.server_nonce.begin(),
              auth.server_nonce.end());
          response.payload.insert(
              response.payload.end(), server_proof.begin(), server_proof.end());
        } catch (...) {
          SecureEraseServiceBytes(server_proof);
          return false;
        }
        SecureEraseServiceBytes(server_proof);
        auth.last_request_id = request.request_id;
        auth.state = ConnectionAuthState::await_client_auth;
        if (!write_frame(std::move(response))) {
          return false;
        }
        break;
      }
      case ConnectionAuthState::await_client_auth: {
        if (request.type != ServiceFrameType::client_auth || request.flags != 0 ||
            request.request_id == 0 ||
            request.request_id <= auth.last_request_id ||
            request.payload.size() != kServiceProofSize) {
          write_error(request.request_id, "AUTH_FAILED");
          return true;
        }
        ServiceProof expected{};
        const bool authenticated = MakeServiceClientProof(
                                       secret_,
                                       client_process_id,
                                       auth.client_nonce,
                                       auth.server_nonce,
                                       &expected) &&
                                   ConstantTimeServiceEqual(request.payload, expected) &&
                                   DeriveServiceSessionKey(
                                       secret_,
                                       client_process_id,
                                       auth.client_nonce,
                                       auth.server_nonce,
                                       &auth.session_key);
        SecureEraseServiceBytes(expected);
        if (!authenticated) {
          write_error(request.request_id, "AUTH_FAILED");
          return true;
        }
        auth.last_request_id = request.request_id;
        auth.state = ConnectionAuthState::ready;
        ServiceFrame response;
        response.type = ServiceFrameType::response;
        response.request_id = request.request_id;
        constexpr std::string_view acknowledged = "AUTHENTICATED";
        response.payload.assign(acknowledged.begin(), acknowledged.end());
        if (!write_authenticated(std::move(response))) {
          return false;
        }
        break;
      }
      case ConnectionAuthState::ready: {
        if (!OpenServiceFrame(
                auth.session_key,
                ServiceAuthDirection::client_to_service,
                &request)) {
          ServiceFrame response =
              MakeServiceErrorFrame(request.request_id, "AUTH_FAILED");
          write_authenticated(std::move(response));
          return true;
        }
        if (request.request_id == 0 ||
            request.request_id <= auth.last_request_id) {
          ServiceFrame response =
              MakeServiceErrorFrame(request.request_id, "REPLAY_DETECTED");
          write_authenticated(std::move(response));
          return true;
        }
        auth.last_request_id = request.request_id;
        if (request.type != ServiceFrameType::request) {
          ServiceFrame response =
              MakeServiceErrorFrame(request.request_id, "PROTOCOL_ERROR");
          write_authenticated(std::move(response));
          return true;
        }
        ServiceFrame response;
        bool subscribe_events = false;
        try {
          if (command_dispatcher_ == nullptr) {
            response = MakeServiceErrorFrame(
                request.request_id, "NOT_SUPPORTED");
          } else {
            ServiceCommandView command;
            ParseServiceCommand(request.payload, &command);
            const ULONGLONG started = GetTickCount64();
            const bool quiet_query = command.type == ServiceCommandType::dll_query_task;
            if (!quiet_query) ConsoleLog("request id=", request.request_id, " clientPid=", client_process_id,
                " type=", static_cast<unsigned>(command.type), " plugin=", command.plugin_id,
                " dll=", command.dll_id, " function=", command.function_name,
                " payloadBytes=", command.payload.size());
            CommandDispatchResult dispatched =
                command_dispatcher_->Dispatch(
                    request.payload, client_session_id);
            if (!quiet_query || !dispatched.success || GetTickCount64() - started >= 100)
              ConsoleLog("response id=", request.request_id, " clientPid=", client_process_id,
                " success=", dispatched.success, " code=", dispatched.code,
                " bytes=", dispatched.payload.size(), " elapsedMs=", GetTickCount64() - started);
            subscribe_events = dispatched.success &&
                command.type == ServiceCommandType::dll_subscribe_events;
            if (subscribe_events && !events.stop.get()) {
              dispatched = {false, "DLL_HOST_INTERNAL", {}};
              subscribe_events = false;
            }
            if (dispatched.success) {
              response.type = ServiceFrameType::response;
              response.request_id = request.request_id;
              response.payload = std::move(dispatched.payload);
            } else {
              response = MakeServiceErrorFrame(
                  request.request_id, dispatched.code);
            }
          }
        } catch (...) {
          ConsoleLog("request id=", request.request_id, " failed: INTERNAL_ERROR");
          response = MakeServiceErrorFrame(
              request.request_id, "INTERNAL_ERROR");
        }
        if (!write_authenticated(std::move(response))) {
          return false;
        }
        if (subscribe_events && !events.worker.joinable()) {
          try {
            events.worker = std::thread([&]() {
              const HANDLE handles[] = {events.stop.get(), stop_event_, command_dispatcher_->TaskChangedEvent()};
              std::uint64_t sequence = 0;
              try {
                while (WaitForMultipleObjects(3, handles, FALSE, INFINITE) == WAIT_OBJECT_0 + 2) {
                  // Bound notification traffic without blocking DLL callback threads.
                  if (WaitForSingleObject(events.stop.get(), 100) != WAIT_TIMEOUT) break;
                  ServiceFrame changed;
                  changed.type = ServiceFrameType::task_changed;
                  changed.request_id = ++sequence;
                  changed.payload = command_dispatcher_->TakeTaskChanges();
                  if (changed.payload.size() <= 2) continue;
                  if (!write_authenticated(std::move(changed))) {
                    CancelIoEx(pipe, nullptr);
                    break;
                  }
                }
              } catch (...) {
                CancelIoEx(pipe, nullptr);
              }
            });
          } catch (...) {
            return false;
          }
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

void NamedPipeServer::Fail(const DWORD error) noexcept {
  last_error_.store(error == ERROR_SUCCESS ? ERROR_GEN_FAILURE : error,
                    std::memory_order_relaxed);
  state_.store(PipeServerState::failed, std::memory_order_release);
  if (failure_event_ != nullptr) {
    SetEvent(failure_event_);
  }
  if (ready_event_ != nullptr) {
    SetEvent(ready_event_);
  }
}

}  // namespace ztools::service
