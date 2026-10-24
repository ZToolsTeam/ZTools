#include "ztools_service/service_runtime.hpp"
#include "ztools_service/console_log.hpp"

#include "ztools_service/named_pipe_server.hpp"
#include "ztools_service/pipe_protocol.hpp"
#include "ztools_service/privileged_dll_resolver.hpp"
#include "ztools_service/privileged_manifest.hpp"
#include "ztools_service/service_auth.hpp"
#include "ztools_service/service_secret.hpp"

#include <Windows.h>

#include <algorithm>
#include <atomic>
#include <array>
#include <iostream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

using ztools::service::RuntimeState;
using ztools::service::ServiceRuntime;

// Set once by wmain before the SCM callback or console runtime starts.
std::wstring g_data_root_override;

bool SetDataRootOverride(const std::wstring& value) {
  if (value.empty() || !g_data_root_override.empty()) return false;
  const DWORD size = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
  if (size == 0) return false;
  std::vector<wchar_t> buffer(size);
  const DWORD length = GetFullPathNameW(value.c_str(), size, buffer.data(), nullptr);
  if (length == 0 || length >= size) return false;
  const DWORD attributes = GetFileAttributesW(buffer.data());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
  g_data_root_override.assign(buffer.data(), length);
  return true;
}

ztools::service::ServiceSecret TestSecret() noexcept {
  ztools::service::ServiceSecret secret{};
  for (std::size_t index = 0; index < secret.size(); ++index) {
    secret[index] = static_cast<std::uint8_t>(index + 1);
  }
  return secret;
}

bool MatchesHex(
    const std::span<const std::uint8_t> bytes,
    const std::string_view expected) noexcept {
  constexpr char alphabet[] = "0123456789abcdef";
  if (expected.size() != bytes.size() * 2) {
    return false;
  }
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    if (expected[index * 2] != alphabet[bytes[index] >> 4] ||
        expected[index * 2 + 1] != alphabet[bytes[index] & 0x0f]) {
      return false;
    }
  }
  return true;
}

bool VerifyAuthenticationKnownAnswer() {
  ztools::service::ServiceSecret secret = TestSecret();
  ztools::service::ServiceNonce client_nonce{};
  ztools::service::ServiceNonce server_nonce{};
  for (std::size_t index = 0; index < client_nonce.size(); ++index) {
    client_nonce[index] = static_cast<std::uint8_t>(0xa0 + index);
    server_nonce[index] = static_cast<std::uint8_t>(0xc0 + index);
  }
  ztools::service::ServiceProof server_proof{};
  ztools::service::ServiceProof client_proof{};
  ztools::service::ServiceSecret session_key{};
  const bool handshake = ztools::service::MakeServiceServerProof(
                             secret,
                             0x12345678,
                             client_nonce,
                             server_nonce,
                             &server_proof) &&
                         ztools::service::MakeServiceClientProof(
                             secret,
                             0x12345678,
                             client_nonce,
                             server_nonce,
                             &client_proof) &&
                         ztools::service::DeriveServiceSessionKey(
                             secret,
                             0x12345678,
                             client_nonce,
                             server_nonce,
                             &session_key) &&
                         MatchesHex(
                             server_proof,
                             "eccc3881d58dc948eb07923dd17714c4ca2f464460a0e920e0193785b3e161fb") &&
                         MatchesHex(
                             client_proof,
                             "6ceaff2ec90bccac78bf70f41a49e2090aa27637a1933790c1e6ad4997bee2b0") &&
                         MatchesHex(
                             session_key,
                             "8b48aa9f93a388434dae013c9a60dc47e0c713e3aceed5ed6b02a8f36624286b");
  ztools::service::ServiceFrame frame;
  frame.type = ztools::service::ServiceFrameType::request;
  frame.request_id = 3;
  frame.payload = {'p', 'r', 'o', 'b', 'e'};
  const bool frame_valid = handshake &&
                           ztools::service::SealServiceFrame(
                               session_key,
                               ztools::service::ServiceAuthDirection::client_to_service,
                               &frame) &&
                           frame.payload.size() ==
                               5 + ztools::service::kServiceProofSize &&
                           MatchesHex(
                               std::span(
                                   frame.payload.data() + 5,
                                   ztools::service::kServiceProofSize),
                               "90bdd0a49a8ca806f5e754d4120225667fc95167ae1c1d7d9ea1a3e2a2061ccb") &&
                           ztools::service::OpenServiceFrame(
                               session_key,
                               ztools::service::ServiceAuthDirection::client_to_service,
                               &frame) &&
                           std::string(frame.payload.begin(), frame.payload.end()) == "probe";
  ztools::service::SecureEraseServiceBytes(secret);
  ztools::service::SecureEraseServiceBytes(client_nonce);
  ztools::service::SecureEraseServiceBytes(server_nonce);
  ztools::service::SecureEraseServiceBytes(server_proof);
  ztools::service::SecureEraseServiceBytes(client_proof);
  ztools::service::SecureEraseServiceBytes(session_key);
  return frame_valid;
}

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
  UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.handle_) {
    other.handle_ = nullptr;
  }
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      if (handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE) {
        CloseHandle(handle_);
      }
      handle_ = other.handle_;
      other.handle_ = nullptr;
    }
    return *this;
  }
  HANDLE get() const noexcept { return handle_; }

 private:
  HANDLE handle_;
};

bool WriteAll(
    const HANDLE handle,
    const std::uint8_t* const bytes,
    const std::size_t size) noexcept {
  std::size_t offset = 0;
  while (offset < size) {
    DWORD written = 0;
    const DWORD remaining = static_cast<DWORD>(size - offset);
    if (WriteFile(handle, bytes + offset, remaining, &written, nullptr) == FALSE ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool WriteAll(const HANDLE handle, const std::vector<std::uint8_t>& bytes) noexcept {
  return WriteAll(handle, bytes.data(), bytes.size());
}

bool ReadAll(
    const HANDLE handle,
    std::uint8_t* const output,
    const std::size_t size) noexcept {
  std::size_t offset = 0;
  while (offset < size) {
    DWORD read = 0;
    const DWORD remaining = static_cast<DWORD>(size - offset);
    if (ReadFile(handle, output + offset, remaining, &read, nullptr) == FALSE || read == 0) {
      return false;
    }
    offset += read;
  }
  return true;
}

std::uint32_t ReadUint32(const std::uint8_t* const input) noexcept {
  std::uint32_t value = 0;
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    value |= static_cast<std::uint32_t>(input[shift / 8]) << shift;
  }
  return value;
}

UniqueHandle OpenPipe(const std::wstring& pipe_name) noexcept {
  const ULONGLONG deadline = GetTickCount64() + 5'000;
  do {
    if (WaitNamedPipeW(pipe_name.c_str(), 100) != FALSE) {
      const HANDLE handle = CreateFileW(
          pipe_name.c_str(),
          GENERIC_READ | GENERIC_WRITE,
          0,
          nullptr,
          OPEN_EXISTING,
          SECURITY_SQOS_PRESENT | SECURITY_IMPERSONATION,
          nullptr);
      if (handle != INVALID_HANDLE_VALUE) {
        return UniqueHandle(handle);
      }
      const DWORD error = GetLastError();
      if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) {
        return UniqueHandle(INVALID_HANDLE_VALUE);
      }
    } else {
      const DWORD error = GetLastError();
      if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND &&
          error != ERROR_SEM_TIMEOUT) {
        return UniqueHandle(INVALID_HANDLE_VALUE);
      }
    }
    Sleep(10);
  } while (GetTickCount64() < deadline);
  return UniqueHandle(INVALID_HANDLE_VALUE);
}

bool WriteEncoded(
    const HANDLE pipe,
    const std::vector<std::uint8_t>& encoded,
    const std::size_t chunk_size = 0) noexcept {
  if (chunk_size == 0) {
    return WriteAll(pipe, encoded);
  } else {
    std::size_t offset = 0;
    while (offset < encoded.size()) {
      const std::size_t remaining = encoded.size() - offset;
      const std::size_t size = remaining < chunk_size ? remaining : chunk_size;
      if (!WriteAll(pipe, encoded.data() + offset, size)) {
        return false;
      }
      offset += size;
    }
  }
  return true;
}

bool ReadServiceFrame(
    const HANDLE pipe,
    ztools::service::ServiceFrame* const frame) {
  if (frame == nullptr) {
    return false;
  }
  std::array<std::uint8_t, sizeof(std::uint32_t)> prefix{};
  if (!ReadAll(pipe, prefix.data(), prefix.size())) {
    return false;
  }
  const std::uint32_t body_size = ReadUint32(prefix.data());
  if (body_size < ztools::service::kServiceFrameHeaderSize ||
      body_size > ztools::service::kServiceMaxFrameSize) {
    return false;
  }
  std::vector<std::uint8_t> body(body_size);
  if (!ReadAll(pipe, body.data(), body.size())) {
    return false;
  }
  return ztools::service::ParseServiceFrameBody(body, frame);
}

bool IsErrorFrame(
    const ztools::service::ServiceFrame& frame,
    const std::uint64_t request_id,
    const std::string_view error) {
  return frame.type == ztools::service::ServiceFrameType::error &&
         frame.request_id == request_id &&
         std::string_view(
             reinterpret_cast<const char*>(frame.payload.data()),
             frame.payload.size()) == error;
}

bool ReadAuthenticatedErrorOrClose(
    const HANDLE pipe,
    const ztools::service::ServiceSecret& session_key,
    const std::uint64_t request_id,
    const std::string_view error) {
  ztools::service::ServiceFrame response;
  if (!ReadServiceFrame(pipe, &response)) {
    return true;
  }
  return ztools::service::OpenServiceFrame(
             session_key,
             ztools::service::ServiceAuthDirection::service_to_client,
             &response) &&
         IsErrorFrame(response, request_id, error);
}

bool AuthenticatePipe(
    const HANDLE pipe,
    const ztools::service::ServiceSecret& secret,
    ztools::service::ServiceSecret* const session_key,
    ztools::service::ServiceNonce* const observed_server_nonce,
    const std::size_t hello_chunk_size = 0) {
  if (session_key == nullptr) {
    return false;
  }
  ztools::service::ServiceNonce client_nonce{};
  ztools::service::ServiceNonce server_nonce{};
  ztools::service::ServiceProof expected_server_proof{};
  ztools::service::ServiceProof client_proof{};
  const auto erase = [&]() noexcept {
    ztools::service::SecureEraseServiceBytes(client_nonce);
    ztools::service::SecureEraseServiceBytes(server_nonce);
    ztools::service::SecureEraseServiceBytes(expected_server_proof);
    ztools::service::SecureEraseServiceBytes(client_proof);
  };
  if (!ztools::service::RandomServiceBytes(client_nonce)) {
    erase();
    return false;
  }
  ztools::service::ServiceFrame hello;
  hello.type = ztools::service::ServiceFrameType::client_hello;
  hello.request_id = 1;
  hello.payload.assign(client_nonce.begin(), client_nonce.end());
  if (!WriteEncoded(
          pipe,
          ztools::service::EncodeServiceFrame(hello),
          hello_chunk_size)) {
    erase();
    return false;
  }
  ztools::service::ServiceFrame server_hello;
  if (!ReadServiceFrame(pipe, &server_hello) ||
      server_hello.type != ztools::service::ServiceFrameType::server_hello ||
      server_hello.flags != 0 || server_hello.request_id != hello.request_id ||
      server_hello.payload.size() !=
          ztools::service::kServiceNonceSize + ztools::service::kServiceProofSize) {
    erase();
    return false;
  }
  std::copy_n(
      server_hello.payload.begin(), server_nonce.size(), server_nonce.begin());
  const std::span<const std::uint8_t> supplied_server_proof(
      server_hello.payload.data() + server_nonce.size(),
      ztools::service::kServiceProofSize);
  if (!ztools::service::MakeServiceServerProof(
          secret,
          GetCurrentProcessId(),
          client_nonce,
          server_nonce,
          &expected_server_proof) ||
      !ztools::service::ConstantTimeServiceEqual(
          supplied_server_proof, expected_server_proof) ||
      !ztools::service::MakeServiceClientProof(
          secret,
          GetCurrentProcessId(),
          client_nonce,
          server_nonce,
          &client_proof) ||
      !ztools::service::DeriveServiceSessionKey(
          secret,
          GetCurrentProcessId(),
          client_nonce,
          server_nonce,
          session_key)) {
    erase();
    return false;
  }
  if (observed_server_nonce != nullptr) {
    *observed_server_nonce = server_nonce;
  }
  ztools::service::ServiceFrame client_auth;
  client_auth.type = ztools::service::ServiceFrameType::client_auth;
  client_auth.request_id = 2;
  client_auth.payload.assign(client_proof.begin(), client_proof.end());
  if (!WriteEncoded(pipe, ztools::service::EncodeServiceFrame(client_auth))) {
    erase();
    return false;
  }
  ztools::service::ServiceFrame response;
  if (!ReadServiceFrame(pipe, &response) ||
      !ztools::service::OpenServiceFrame(
          *session_key,
          ztools::service::ServiceAuthDirection::service_to_client,
          &response) ||
      response.type != ztools::service::ServiceFrameType::response ||
      response.request_id != client_auth.request_id ||
      std::string_view(
          reinterpret_cast<const char*>(response.payload.data()),
          response.payload.size()) != "AUTHENTICATED") {
    erase();
    ztools::service::SecureEraseServiceBytes(*session_key);
    return false;
  }
  erase();
  return true;
}

bool ExchangeUnauthenticatedError(
    const std::wstring& pipe_name,
    const std::vector<std::uint8_t>& encoded,
    const std::uint64_t expected_request_id,
    const std::string_view expected_error) {
  UniqueHandle pipe = OpenPipe(pipe_name);
  if (pipe.get() == INVALID_HANDLE_VALUE ||
      !WriteEncoded(pipe.get(), encoded)) {
    return false;
  }
  ztools::service::ServiceFrame response;
  if (!ReadServiceFrame(pipe.get(), &response)) {
    return true;
  }
  return response.flags == 0 &&
         IsErrorFrame(response, expected_request_id, expected_error);
}

bool ProbeInvalidClientProof(
    const std::wstring& pipe_name,
    const ztools::service::ServiceSecret& secret) {
  UniqueHandle pipe = OpenPipe(pipe_name);
  if (pipe.get() == INVALID_HANDLE_VALUE) {
    return false;
  }
  ztools::service::ServiceNonce nonce{};
  if (!ztools::service::RandomServiceBytes(nonce)) {
    return false;
  }
  ztools::service::ServiceFrame request;
  request.type = ztools::service::ServiceFrameType::client_hello;
  request.request_id = 1;
  request.payload.assign(nonce.begin(), nonce.end());
  if (!WriteEncoded(pipe.get(), ztools::service::EncodeServiceFrame(request), 3)) {
    return false;
  }
  ztools::service::ServiceFrame server_hello;
  if (!ReadServiceFrame(pipe.get(), &server_hello) ||
      server_hello.type != ztools::service::ServiceFrameType::server_hello) {
    return false;
  }
  ztools::service::ServiceFrame client_auth;
  client_auth.type = ztools::service::ServiceFrameType::client_auth;
  client_auth.request_id = 2;
  client_auth.payload.assign(ztools::service::kServiceProofSize, 0);
  if (!WriteEncoded(pipe.get(), ztools::service::EncodeServiceFrame(client_auth))) {
    return false;
  }
  ztools::service::SecureEraseServiceBytes(nonce);
  ztools::service::ServiceFrame response;
  if (!ReadServiceFrame(pipe.get(), &response)) {
    return ztools::service::IsValidServiceSecret(secret);
  }
  return response.flags == 0 && IsErrorFrame(response, 2, "AUTH_FAILED") &&
         ztools::service::IsValidServiceSecret(secret);
}

bool ProbeAuthenticatedFrames(
    const std::wstring& pipe_name,
    const ztools::service::ServiceSecret& secret) {
  UniqueHandle pipe = OpenPipe(pipe_name);
  ztools::service::ServiceSecret session_key{};
  if (pipe.get() == INVALID_HANDLE_VALUE ||
      !AuthenticatePipe(pipe.get(), secret, &session_key, nullptr, 3)) {
    return false;
  }
  ztools::service::ServiceFrame request;
  request.type = ztools::service::ServiceFrameType::request;
  request.request_id = 3;
  if (!ztools::service::SealServiceFrame(
          session_key,
          ztools::service::ServiceAuthDirection::client_to_service,
          &request)) {
    ztools::service::SecureEraseServiceBytes(session_key);
    return false;
  }
  const std::vector<std::uint8_t> encoded =
      ztools::service::EncodeServiceFrame(request);
  ztools::service::ServiceFrame response;
  const bool first = WriteEncoded(pipe.get(), encoded) &&
                     ReadServiceFrame(pipe.get(), &response) &&
                     ztools::service::OpenServiceFrame(
                         session_key,
                         ztools::service::ServiceAuthDirection::service_to_client,
                         &response) &&
                     IsErrorFrame(response, 3, "COMMAND_INVALID");
  const bool replay = first && WriteEncoded(pipe.get(), encoded) &&
                      ReadAuthenticatedErrorOrClose(
                          pipe.get(), session_key, 3, "REPLAY_DETECTED");
  ztools::service::SecureEraseServiceBytes(session_key);
  return replay;
}

bool ProbeTamperedFrame(
    const std::wstring& pipe_name,
    const ztools::service::ServiceSecret& secret) {
  UniqueHandle pipe = OpenPipe(pipe_name);
  ztools::service::ServiceSecret session_key{};
  if (pipe.get() == INVALID_HANDLE_VALUE ||
      !AuthenticatePipe(pipe.get(), secret, &session_key, nullptr)) {
    return false;
  }
  ztools::service::ServiceFrame request;
  request.type = ztools::service::ServiceFrameType::request;
  request.request_id = 3;
  if (!ztools::service::SealServiceFrame(
          session_key,
          ztools::service::ServiceAuthDirection::client_to_service,
          &request)) {
    ztools::service::SecureEraseServiceBytes(session_key);
    return false;
  }
  request.payload.back() ^= 0x80;
  const bool rejected =
      WriteEncoded(pipe.get(), ztools::service::EncodeServiceFrame(request)) &&
      ReadAuthenticatedErrorOrClose(pipe.get(), session_key, 3, "AUTH_FAILED");
  ztools::service::SecureEraseServiceBytes(session_key);
  return rejected;
}

bool ProbeDistinctServerNonces(
    const std::wstring& pipe_name,
    const ztools::service::ServiceSecret& secret) {
  ztools::service::ServiceNonce first_nonce{};
  ztools::service::ServiceNonce second_nonce{};
  ztools::service::ServiceSecret first_key{};
  ztools::service::ServiceSecret second_key{};
  {
    UniqueHandle first = OpenPipe(pipe_name);
    if (first.get() == INVALID_HANDLE_VALUE ||
        !AuthenticatePipe(
            first.get(), secret, &first_key, &first_nonce)) {
      return false;
    }
  }
  {
    UniqueHandle second = OpenPipe(pipe_name);
    if (second.get() == INVALID_HANDLE_VALUE ||
        !AuthenticatePipe(
            second.get(), secret, &second_key, &second_nonce)) {
      ztools::service::SecureEraseServiceBytes(first_key);
      ztools::service::SecureEraseServiceBytes(first_nonce);
      return false;
    }
  }
  const bool distinct = !ztools::service::ConstantTimeServiceEqual(
      first_nonce, second_nonce);
  ztools::service::SecureEraseServiceBytes(first_key);
  ztools::service::SecureEraseServiceBytes(second_key);
  ztools::service::SecureEraseServiceBytes(first_nonce);
  ztools::service::SecureEraseServiceBytes(second_nonce);
  return distinct;
}

bool ProbeProtocolMismatch(const std::wstring& pipe_name) {
  ztools::service::ServiceFrame request;
  request.type = ztools::service::ServiceFrameType::client_hello;
  request.request_id = 9;
  std::vector<std::uint8_t> encoded =
      ztools::service::EncodeServiceFrame(request);
  encoded[8] = 2;
  encoded[9] = 0;
  return ExchangeUnauthenticatedError(pipe_name, encoded, 0, "PROTOCOL_ERROR");
}

bool ProbeOversizedFrame(const std::wstring& pipe_name) noexcept {
  UniqueHandle pipe = OpenPipe(pipe_name);
  if (pipe.get() == INVALID_HANDLE_VALUE) {
    return false;
  }
  const std::uint32_t oversized =
      static_cast<std::uint32_t>(ztools::service::kServiceMaxFrameSize + 1);
  std::vector<std::uint8_t> prefix = {
      static_cast<std::uint8_t>(oversized & 0xff),
      static_cast<std::uint8_t>((oversized >> 8) & 0xff),
      static_cast<std::uint8_t>((oversized >> 16) & 0xff),
      static_cast<std::uint8_t>((oversized >> 24) & 0xff),
  };
  if (!WriteAll(pipe.get(), prefix)) {
    return false;
  }
  std::uint8_t byte = 0;
  DWORD read = 0;
  if (ReadFile(pipe.get(), &byte, 1, &read, nullptr) != FALSE) {
    return read == 0;
  }
  const DWORD error = GetLastError();
  return error == ERROR_BROKEN_PIPE || error == ERROR_NO_DATA ||
         error == ERROR_PIPE_NOT_CONNECTED;
}

bool VerifySinglePipeInstance(const std::wstring& pipe_name) noexcept {
  UniqueHandle duplicate(CreateNamedPipeW(
      pipe_name.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1,
      4096,
      4096,
      0,
      nullptr));
  return duplicate.get() == INVALID_HANDLE_VALUE;
}

SRWLOCK g_runtime_lock = SRWLOCK_INIT;
ServiceRuntime* g_runtime = nullptr;
SERVICE_STATUS_HANDLE g_status_handle = nullptr;
std::atomic<DWORD> g_checkpoint{1};

void PublishRuntime(ServiceRuntime* const runtime) noexcept {
  AcquireSRWLockExclusive(&g_runtime_lock);
  g_runtime = runtime;
  ReleaseSRWLockExclusive(&g_runtime_lock);
}

void ClearRuntime() noexcept {
  AcquireSRWLockExclusive(&g_runtime_lock);
  g_runtime = nullptr;
  ReleaseSRWLockExclusive(&g_runtime_lock);
}

void RequestRuntimeStop() noexcept {
  AcquireSRWLockShared(&g_runtime_lock);
  if (g_runtime != nullptr) {
    g_runtime->RequestStop();
  }
  ReleaseSRWLockShared(&g_runtime_lock);
}

void ReportServiceStatus(
    const DWORD state, const DWORD win32_error, const DWORD wait_hint) noexcept {
  if (g_status_handle == nullptr) {
    return;
  }
  SERVICE_STATUS status{};
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwWin32ExitCode = win32_error;
  status.dwWaitHint = wait_hint;
  status.dwControlsAccepted = state == SERVICE_RUNNING
                                  ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
                                  : 0;
  status.dwCheckPoint = state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING
                             ? g_checkpoint.fetch_add(1, std::memory_order_relaxed)
                             : 0;
  SetServiceStatus(g_status_handle, &status);
}

void WINAPI ServiceControlHandler(const DWORD control) {
  switch (control) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN: {
      ReportServiceStatus(SERVICE_STOP_PENDING, NO_ERROR, 5'000);
      RequestRuntimeStop();
      break;
    }
    case SERVICE_CONTROL_INTERROGATE:
      break;
    default:
      break;
  }
}

void WINAPI ServiceMain(const DWORD /*argument_count*/, wchar_t** /*arguments*/) {
  g_status_handle = RegisterServiceCtrlHandlerW(
      ztools::service::kServiceName, ServiceControlHandler);
  if (g_status_handle == nullptr) {
    return;
  }
  g_checkpoint.store(1, std::memory_order_relaxed);
  ReportServiceStatus(SERVICE_START_PENDING, NO_ERROR, 3'000);

  ztools::service::ServiceSecret secret{};
  std::wstring data_root;
  std::wstring user_sid_string;
  std::wstring secret_path;
  DWORD identity_error = ERROR_SUCCESS;
  if (!ztools::service::LoadInstalledServiceSecret(
          ztools::service::PipeIdentityMode::service,
          &secret,
          &data_root,
          &secret_path,
          &user_sid_string,
          &identity_error)) {
    ReportServiceStatus(SERVICE_STOPPED, identity_error, 0);
    return;
  }
  if (!g_data_root_override.empty()) data_root = g_data_root_override;
  ztools::service::PrivilegedDllPathConfig manifest_config;
  DWORD manifest_error = ERROR_SUCCESS;
  ztools::service::ReadInstalledPrivilegedDllPathConfig(
      data_root,
      &manifest_config,
      &manifest_error);

  ServiceRuntime runtime({
      ztools::service::RuntimeMode::service,
      ztools::service::kServicePipeName,
      secret,
      user_sid_string,
      manifest_config,
  });
  ztools::service::SecureEraseServiceBytes(secret);
  if (!runtime.Start()) {
    ReportServiceStatus(SERVICE_STOPPED, runtime.last_error(), 0);
    return;
  }

  PublishRuntime(&runtime);
  ReportServiceStatus(SERVICE_RUNNING, NO_ERROR, 0);
  const DWORD wait_result = runtime.WaitForStop(INFINITE);
  ReportServiceStatus(SERVICE_STOP_PENDING, NO_ERROR, 3'000);
  runtime.Stop();
  ClearRuntime();

  const DWORD error = wait_result == WAIT_OBJECT_0 ? NO_ERROR : runtime.last_error();
  ReportServiceStatus(SERVICE_STOPPED, error, 0);
}

BOOL WINAPI ConsoleControlHandler(const DWORD control) {
  switch (control) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT: {
      RequestRuntimeStop();
      return TRUE;
    }
    default:
      return FALSE;
  }
}

int RunConsole() {
  ztools::service::g_console_logging.store(true, std::memory_order_relaxed);
  ztools::service::ServiceSecret secret{};
  std::wstring data_root;
  std::wstring user_sid_string;
  std::wstring secret_path;
  DWORD identity_error = ERROR_SUCCESS;
  if (!ztools::service::LoadInstalledServiceSecret(
          ztools::service::PipeIdentityMode::current_process,
          &secret,
          &data_root,
          &secret_path,
          &user_sid_string,
          &identity_error)) {
    std::wcerr << L"ZToolsService user identity unavailable: " << identity_error << L'\n';
    return 9;
  }
  if (!g_data_root_override.empty()) data_root = g_data_root_override;
  std::wcout << L"ZToolsService console; pid=" << GetCurrentProcessId()
             << L"; data-root=" << data_root << std::endl;
  ztools::service::PrivilegedDllPathConfig manifest_config;
  DWORD manifest_error = ERROR_SUCCESS;
  ztools::service::ReadInstalledPrivilegedDllPathConfig(
      data_root,
      &manifest_config,
      &manifest_error);
  ServiceRuntime runtime({
      ztools::service::RuntimeMode::console,
      ztools::service::kServicePipeName,
      secret,
      user_sid_string,
      manifest_config,
  });
  ztools::service::SecureEraseServiceBytes(secret);
  if (!runtime.Start()) {
    std::wcerr << L"ZToolsService failed to start: " << runtime.last_error() << L'\n';
    return 10;
  }
  if (SetConsoleCtrlHandler(ConsoleControlHandler, TRUE) == FALSE) {
    std::wcerr << L"SetConsoleCtrlHandler failed: " << GetLastError() << L'\n';
    runtime.Stop();
    return 11;
  }
  PublishRuntime(&runtime);
  std::wcout << L"ZToolsService ready; transport=named-pipe; protocolVersion="
             << ztools::service::kServiceProtocolVersion << L"; pipe="
             << ztools::service::kServicePipeName << std::endl;
  const DWORD wait_result = runtime.WaitForStop(INFINITE);
  runtime.Stop();
  ClearRuntime();
  SetConsoleCtrlHandler(ConsoleControlHandler, FALSE);
  return wait_result == WAIT_OBJECT_0 ? 0 : 12;
}

int RunSelfTest() {
  const std::wstring pipe_name =
      std::wstring(ztools::service::kServicePipeName) + L".selftest." +
      std::to_wstring(GetCurrentProcessId());
  ztools::service::ServiceSecret secret = TestSecret();
  if (!VerifyAuthenticationKnownAnswer()) {
    return 18;
  }
  ServiceRuntime mismatched_user_runtime({
      ztools::service::RuntimeMode::console,
      pipe_name + L".mismatched-user",
      secret,
      L"S-1-5-18",
  });
  if (mismatched_user_runtime.Start() ||
      mismatched_user_runtime.state() != RuntimeState::failed ||
      mismatched_user_runtime.last_error() != ERROR_RETRY) {
    return 17;
  }
  const std::wstring keyless_pipe = pipe_name + L".keyless";
  ServiceRuntime keyless_runtime({
      ztools::service::RuntimeMode::console,
      keyless_pipe,
      {},
  });
  if (!keyless_runtime.Start() ||
      !ProbeAuthenticatedFrames(keyless_pipe, {}) ||
      !ProbeTamperedFrame(keyless_pipe, {}) ||
      !ProbeDistinctServerNonces(keyless_pipe, {})) {
    return 19;
  }
  keyless_runtime.Stop();
  ServiceRuntime runtime({
      ztools::service::RuntimeMode::console,
      pipe_name,
      secret,
  });
  if (runtime.state() != RuntimeState::cold || !runtime.Start()) {
    return 20;
  }
  if (runtime.state() != RuntimeState::running || runtime.Start()) {
    return 21;
  }
  const ztools::service::NamedPipeServer* const pipe_server = runtime.pipe_server();
  const ztools::service::PrivilegedDllResolver* const manifest =
      runtime.privileged_dll_resolver();
  const ztools::service::PrivilegedDllLoader* const dll_loader =
      runtime.privileged_dll_loader();
  const ztools::service::CommandPolicy* const command_policy =
      runtime.command_policy();
  if (pipe_server == nullptr || pipe_server->state() !=
                                    ztools::service::PipeServerState::listening ||
      pipe_server->user_sid_string().empty() ||
      pipe_server->service_sid_string().empty() || manifest == nullptr ||
      dll_loader == nullptr ||
      !dll_loader->system_only_ready() || command_policy == nullptr ||
      command_policy->allowed_target_count() != 1 ||
      runtime.command_dispatcher() == nullptr) {
    return 22;
  }
  if (!VerifySinglePipeInstance(pipe_name)) {
    return 23;
  }
  if (!ProbeInvalidClientProof(pipe_name, secret)) {
    return 24;
  }
  if (!ProbeProtocolMismatch(pipe_name)) {
    return 25;
  }
  if (!ProbeOversizedFrame(pipe_name)) {
    return 26;
  }
  if (!ProbeAuthenticatedFrames(pipe_name, secret)) {
    return 27;
  }
  if (!ProbeTamperedFrame(pipe_name, secret)) {
    return 28;
  }
  if (!ProbeDistinctServerNonces(pipe_name, secret)) {
    return 29;
  }
  if (pipe_server->last_client_process_id() != GetCurrentProcessId() ||
      pipe_server->last_client_session_id() == 0) {
    return 30;
  }
  if (runtime.WaitForStop(0) != WAIT_TIMEOUT) {
    return 31;
  }
  UniqueHandle stalled_client = OpenPipe(pipe_name);
  if (stalled_client.get() == INVALID_HANDLE_VALUE) {
    return 32;
  }
  runtime.RequestStop();
  if (runtime.state() != RuntimeState::stopping ||
      runtime.WaitForStop(1'000) != WAIT_OBJECT_0) {
    return 33;
  }
  runtime.RequestStop();
  runtime.Stop();
  runtime.Stop();
  if (runtime.state() != RuntimeState::stopped) {
    return 34;
  }
  ztools::service::SecureEraseServiceBytes(secret);
  std::wcout << L"{\"service\":\"ZToolsService\",\"protocolVersion\":"
             << ztools::service::kServiceProtocolVersion
             << L",\"transport\":\"named-pipe\",\"acl\":\"system+service+user\""
             << L",\"productVersion\":\"" << ZTOOLS_PRODUCT_VERSION << L"\""
             << L",\"auth\":\"hmac-sha256\",\"replay\":\"strict\",\"clientPid\":"
             << pipe_server->last_client_process_id()
             << L",\"clientSessionId\":" << pipe_server->last_client_session_id()
             << L",\"dllResolution\":\"plugin-directory\",\"dependencies\":\"system32-only\""
             << L",\"commandPolicy\":\"single-owner\",\"state\":\""
             << ztools::service::StateName(runtime.state()) << L"\"}" << L'\n';
  return 0;
}

#if defined(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
int RunIntegrationTestServer(
    const std::wstring_view pipe_name,
    const std::wstring_view data_root = {},
    const std::wstring_view manifest_sha256 = {}) {
  constexpr std::wstring_view prefix =
      L"\\\\.\\pipe\\ZToolsPrivilegedService.v1.integration.";
  if (!pipe_name.starts_with(prefix) || pipe_name.size() > 240 ||
      pipe_name.find(L'\0') != std::wstring_view::npos ||
      data_root.find(L'\0') != std::wstring_view::npos ||
      manifest_sha256.find(L'\0') != std::wstring_view::npos ||
      (!manifest_sha256.empty() && data_root.empty())) {
    return 40;
  }
  ztools::service::RuntimeOptions options;
  options.mode = ztools::service::RuntimeMode::console;
  options.pipe_name = std::wstring(pipe_name);
  auto& dll_path_config = options.privileged_dll_resolver;
  dll_path_config.data_root = std::wstring(data_root);
  dll_path_config.manifest_trust.data_root = std::wstring(data_root);
  if (!manifest_sha256.empty()) {
    if (!ztools::service::ParsePrivilegedManifestSha256(
            std::wstring(manifest_sha256),
            &dll_path_config.manifest_trust.manifest_sha256)) {
      return 40;
    }
    dll_path_config.manifest_trust.trusted = true;
  }
  ServiceRuntime runtime(std::move(options));
  if (!runtime.Start()) {
    return 41;
  }
  std::wcout << L"READY" << L'\n' << std::flush;
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    runtime.Stop();
    return 42;
  }
  const ULONGLONG deadline = GetTickCount64() + 30'000;
  bool input_closed = false;
  while (GetTickCount64() < deadline) {
    DWORD available = 0;
    if (PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) == FALSE) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
        input_closed = true;
        break;
      }
      runtime.Stop();
      return 43;
    }
    if (available != 0) {
      std::array<std::uint8_t, 64> discard{};
      DWORD read = 0;
      if (ReadFile(
              input,
              discard.data(),
              static_cast<DWORD>(discard.size()),
              &read,
              nullptr) == FALSE) {
        const DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
          input_closed = true;
          break;
        }
        runtime.Stop();
        return 44;
      }
    }
    Sleep(25);
  }
  runtime.Stop();
  return input_closed ? 0 : 45;
}
#endif

void ShowUsage() {
  std::wcout << L"ZToolsService\n"
             << L"  --console    Run the fail-closed console lifecycle\n"
             << L"  --data-root <directory> (or --data-root=<directory>)\n"
             << L"              Override Data for console or SCM mode; directory must exist\n"
             << L"              Relative paths use the process working directory\n"
             << L"  --self-test  Verify lifecycle transitions and exit\n"
#if defined(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
             << L"  --integration-test-server <pipe> [data-root [manifest-sha256]]\n"
#endif
             << L"  --help       Show this help\n";
}

}  // namespace

int wmain(const int argument_count, wchar_t* arguments[]) {
#if defined(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
  if ((argument_count >= 3 && argument_count <= 5) &&
      std::wstring_view(arguments[1]) == L"--integration-test-server") {
    return RunIntegrationTestServer(
        arguments[2],
        argument_count >= 4 ? std::wstring_view(arguments[3]) : std::wstring_view{},
        argument_count == 5 ? std::wstring_view(arguments[4]) : std::wstring_view{});
  }
#endif
  if (argument_count == 2) {
    const std::wstring_view argument(arguments[1]);
    if (argument == L"--self-test") {
      return RunSelfTest();
    }
    if (argument == L"--help") {
      ShowUsage();
      return 0;
    }
  }
  bool console_mode = false;
  for (int index = 1; index < argument_count; ++index) {
    const std::wstring_view argument(arguments[index]);
    if (argument == L"--console" && !console_mode) {
      console_mode = true;
      continue;
    }
    std::wstring value;
    if (argument == L"--data-root" && index + 1 < argument_count) {
      value = arguments[++index];
    } else if (argument.starts_with(L"--data-root=")) {
      value = argument.substr(std::wstring_view(L"--data-root=").size());
    } else {
      std::wcerr << L"Unknown or incomplete argument: " << argument << L'\n';
      ShowUsage();
      return 2;
    }
    if (!SetDataRootOverride(value)) {
      std::wcerr << L"Invalid or duplicate --data-root (expected an existing directory): "
                 << value << L'\n';
      return 2;
    }
  }
  if (console_mode) return RunConsole();

  SERVICE_TABLE_ENTRYW service_table[] = {
      {const_cast<wchar_t*>(ztools::service::kServiceName), ServiceMain},
      {nullptr, nullptr},
  };
  if (StartServiceCtrlDispatcherW(service_table) == FALSE) {
    const DWORD error = GetLastError();
    std::wcerr << L"StartServiceCtrlDispatcher failed: " << error << L'\n';
    return static_cast<int>(error == ERROR_FAILED_SERVICE_CONTROLLER_CONNECT ? 3 : 4);
  }
  return 0;
}
