#include "ztools_service/client_bridge.hpp"
#include "ztools_service/service_runtime.hpp"

#include <TlHelp32.h>
#include <shellapi.h>

#include <algorithm>
#include <array>
#include <cstdio>
#include <limits>
#include <string>
#include <vector>

namespace ztools::service {
namespace {

class UniqueHandle final {
 public:
  explicit UniqueHandle(const HANDLE value = nullptr) noexcept : value_(value) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  HANDLE get() const noexcept { return value_; }
  void reset(const HANDLE value = nullptr) noexcept {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_;
};

class UniqueServiceHandle final {
 public:
  explicit UniqueServiceHandle(const SC_HANDLE value) noexcept : value_(value) {}
  ~UniqueServiceHandle() { if (value_ != nullptr) CloseServiceHandle(value_); }
  UniqueServiceHandle(const UniqueServiceHandle&) = delete;
  UniqueServiceHandle& operator=(const UniqueServiceHandle&) = delete;
  SC_HANDLE get() const noexcept { return value_; }

 private:
  SC_HANDLE value_;
};

enum class BridgeFailure { unavailable, authentication };

bool SameText(const std::wstring_view left, const std::wstring_view right) noexcept {
  if (left.empty() || right.empty() ||
      left.size() > static_cast<std::size_t>((std::numeric_limits<int>::max)()) ||
      right.size() > static_cast<std::size_t>((std::numeric_limits<int>::max)())) return false;
  return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

bool CanonicalServiceImage(const std::wstring_view image) noexcept {
  if (image.size() < 3 || image[1] != L':' || image[2] != L'\\' ||
      image.find(L'\0') != std::wstring_view::npos ||
      image.find(L"\\..\\") != std::wstring_view::npos ||
      image.find(L"\\.\\") != std::wstring_view::npos) return false;
  const std::size_t leaf = image.find_last_of(L'\\');
  return leaf != std::wstring_view::npos && SameText(image.substr(leaf + 1), L"ZToolsService.exe");
}

bool WriteAll(const HANDLE handle, const void* data, const DWORD length) noexcept {
  const auto* bytes = static_cast<const unsigned char*>(data);
  DWORD offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (WriteFile(handle, bytes + offset, length - offset, &written, nullptr) == FALSE ||
        written == 0) return false;
    offset += written;
  }
  return true;
}

int Fail(const BridgeFailure failure, const DWORD error) noexcept {
  const char* const code = failure == BridgeFailure::authentication
                               ? "SERVICE_AUTHENTICATION_FAILED" : "SERVICE_UNAVAILABLE";
  std::array<char, 160> text{};
  const int length = std::snprintf(text.data(), text.size(),
      "{\"status\":\"error\",\"code\":\"%s\",\"win32\":%lu}\n", code,
      static_cast<unsigned long>(error));
  if (length > 0 && static_cast<std::size_t>(length) < text.size()) {
    WriteAll(GetStdHandle(STD_ERROR_HANDLE), text.data(), static_cast<DWORD>(length));
  }
  return failure == BridgeFailure::authentication ? 2 : 1;
}

bool ParseTimeout(const std::wstring_view text, DWORD* const timeout) noexcept {
  if (text.empty() || text.size() > 5) return false;
  DWORD value = 0;
  for (const wchar_t character : text) {
    if (character < L'0' || character > L'9') return false;
    value = value * 10 + static_cast<DWORD>(character - L'0');
    if (value > 60'000) return false;
  }
  if (value == 0) return false;
  *timeout = value;
  return true;
}

bool LocalPipeName(const std::wstring_view name) noexcept {
  constexpr std::wstring_view prefix = L"\\\\.\\pipe\\";
  if (!name.starts_with(prefix) || name.size() <= prefix.size() || name.size() > 240) return false;
  for (const wchar_t character : name.substr(prefix.size())) {
    if (character < L' ' || character == 0x7f || character == L'\\' ||
        character == L'/' || character == L':') return false;
  }
  return true;
}

bool Running(const HANDLE process) noexcept {
  return process != nullptr && process != INVALID_HANDLE_VALUE &&
         WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
}

bool OpenParent(UniqueHandle* const parent, DWORD* const error) noexcept {
  const DWORD current_id = GetCurrentProcessId();
  UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.get() == INVALID_HANDLE_VALUE) { *error = GetLastError(); return false; }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  DWORD parent_id = 0;
  if (Process32FirstW(snapshot.get(), &entry) != FALSE) {
    do {
      if (entry.th32ProcessID == current_id) { parent_id = entry.th32ParentProcessID; break; }
    } while (Process32NextW(snapshot.get(), &entry) != FALSE);
  }
  if (parent_id == 0 || parent_id == current_id) { *error = ERROR_INVALID_HANDLE; return false; }
  parent->reset(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent_id));
  if (parent->get() == nullptr) { *error = GetLastError(); return false; }
  FILETIME parent_created{}, child_created{}, exited{}, kernel{}, user{};
  if (GetProcessTimes(parent->get(), &parent_created, &exited, &kernel, &user) == FALSE ||
      GetProcessTimes(GetCurrentProcess(), &child_created, &exited, &kernel, &user) == FALSE) {
    *error = GetLastError(); return false;
  }
  if (CompareFileTime(&parent_created, &child_created) > 0 || !Running(parent->get())) {
    *error = ERROR_CANCELLED; return false;
  }
  return true;
}

bool ConnectPipe(const std::wstring& name, const ULONGLONG deadline, const HANDLE parent,
                 UniqueHandle* const pipe, DWORD* const error) noexcept {
  for (;;) {
    if (!Running(parent)) { *error = ERROR_CANCELLED; return false; }
    pipe->reset(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION | FILE_FLAG_OVERLAPPED,
        nullptr));
    if (pipe->get() != INVALID_HANDLE_VALUE) return true;
    *error = GetLastError();
    // A missing or inaccessible optional service never becomes an identity failure.
    if (*error != ERROR_PIPE_BUSY && *error != ERROR_SEM_TIMEOUT) return false;
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) { *error = ERROR_SEM_TIMEOUT; return false; }
    const DWORD wait = static_cast<DWORD>((std::min)(deadline - now, 25ULL));
    if (*error == ERROR_PIPE_BUSY) WaitNamedPipeW(name.c_str(), wait);
    else Sleep(wait);
  }
}

bool QueryStatus(const SC_HANDLE service, SERVICE_STATUS_PROCESS* const status,
                 DWORD* const error) noexcept {
  DWORD needed = 0;
  if (QueryServiceStatusEx(service, SC_STATUS_PROCESS_INFO,
          reinterpret_cast<BYTE*>(status), sizeof(*status), &needed) == FALSE) {
    *error = GetLastError(); return false;
  }
  return true;
}

bool CanonicalImage(const std::wstring& image, std::wstring* const result, DWORD* const error) {
  if (image.size() < 3 || image[1] != L':' || image[2] != L'\\' ||
      image.find(L'\0') != std::wstring::npos) {
    *error = ERROR_INVALID_NAME; return false;
  }
  UniqueHandle file(CreateFileW(image.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) { *error = GetLastError(); return false; }
  const DWORD needed = GetFinalPathNameByHandleW(file.get(), nullptr, 0, FILE_NAME_NORMALIZED);
  if (needed == 0 || needed > 32'768) { *error = needed == 0 ? GetLastError() : ERROR_INVALID_NAME; return false; }
  std::vector<wchar_t> buffer(static_cast<std::size_t>(needed) + 1);
  const DWORD length = GetFinalPathNameByHandleW(file.get(), buffer.data(),
      static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED);
  if (length == 0 || length >= buffer.size()) { *error = GetLastError(); return false; }
  std::wstring_view canonical(buffer.data(), length);
  if (canonical.starts_with(L"\\\\?\\")) canonical.remove_prefix(4);
  if (canonical.size() < 3 || canonical[1] != L':' || canonical[2] != L'\\') {
    *error = ERROR_INVALID_NAME; return false;
  }
  result->assign(canonical);
  return true;
}

bool VerifyPeer(const HANDLE pipe, const ULONGLONG deadline, const HANDLE parent,
                UniqueHandle* const process, BridgeFailure* const failure, DWORD* const error) {
  *failure = BridgeFailure::authentication;
  ULONG peer_id = 0;
  if (GetNamedPipeServerProcessId(pipe, &peer_id) == FALSE) {
    *error = GetLastError(); return false;
  }
  if (peer_id == 0 || peer_id == GetCurrentProcessId()) { *error = ERROR_ACCESS_DENIED; return false; }
  UniqueServiceHandle manager(OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT));
  if (manager.get() == nullptr) { *error = GetLastError(); return false; }
  UniqueServiceHandle service(OpenServiceW(manager.get(), kServiceName,
      SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG));
  if (service.get() == nullptr) { *error = GetLastError(); return false; }
  SERVICE_STATUS_PROCESS status{};
  for (;;) {
    if (!QueryStatus(service.get(), &status, error)) return false;
    if (status.dwCurrentState != SERVICE_START_PENDING) break;
    if (!Running(parent) || GetTickCount64() >= deadline) {
      *failure = BridgeFailure::unavailable;
      *error = !Running(parent) ? ERROR_CANCELLED : ERROR_SERVICE_REQUEST_TIMEOUT;
      return false;
    }
    Sleep(20);
  }
  if (status.dwCurrentState == SERVICE_STOP_PENDING) {
    *failure = BridgeFailure::unavailable; *error = ERROR_SERVICE_NOT_ACTIVE; return false;
  }
  if (status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0 ||
      status.dwProcessId != peer_id || status.dwServiceType != SERVICE_WIN32_OWN_PROCESS) {
    *error = ERROR_ACCESS_DENIED; return false;
  }
  process->reset(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, peer_id));
  if (process->get() == nullptr) { *error = GetLastError(); return false; }
  if (!Running(process->get())) { *error = ERROR_PROCESS_ABORTED; return false; }
  DWORD needed = 0;
  QueryServiceConfigW(service.get(), nullptr, 0, &needed);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || needed < sizeof(QUERY_SERVICE_CONFIGW) || needed > 65'536) {
    *error = ERROR_INVALID_DATA; return false;
  }
  std::vector<BYTE> config_buffer(needed);
  auto* const config = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(config_buffer.data());
  if (QueryServiceConfigW(service.get(), config, needed, &needed) == FALSE) {
    *error = GetLastError(); return false;
  }
  if (config->lpServiceStartName == nullptr || config->lpBinaryPathName == nullptr ||
      config->dwServiceType != SERVICE_WIN32_OWN_PROCESS) { *error = ERROR_INVALID_DATA; return false; }
  int argument_count = 0;
  wchar_t** const arguments = CommandLineToArgvW(config->lpBinaryPathName, &argument_count);
  if (arguments == nullptr) { *error = GetLastError(); return false; }
  std::wstring configured_path;
  try {
    if (argument_count > 0) configured_path = arguments[0];
  } catch (...) { LocalFree(arguments); throw; }
  LocalFree(arguments);
  std::wstring configured_image;
  if (!CanonicalImage(configured_path, &configured_image, error)) return false;
  std::vector<wchar_t> process_path(32'768);
  DWORD process_path_length = static_cast<DWORD>(process_path.size());
  if (QueryFullProcessImageNameW(process->get(), 0, process_path.data(), &process_path_length) == FALSE) {
    *error = GetLastError(); return false;
  }
  std::wstring running_image;
  if (!CanonicalImage(std::wstring(process_path.data(), process_path_length), &running_image, error)) return false;
  const ClientBridgePeerIdentity identity{peer_id, status.dwProcessId, status.dwServiceType,
      status.dwCurrentState, config->lpServiceStartName, configured_image, running_image};
  if (!IsTrustedClientBridgePeer(identity)) { *error = ERROR_ACCESS_DENIED; return false; }
  SERVICE_STATUS_PROCESS confirmed{};
  ULONG confirmed_peer = 0;
  if (!QueryStatus(service.get(), &confirmed, error)) return false;
  if (confirmed.dwCurrentState == SERVICE_STOP_PENDING || confirmed.dwCurrentState == SERVICE_STOPPED ||
      !Running(process->get())) {
    *failure = BridgeFailure::unavailable; *error = ERROR_SERVICE_NOT_ACTIVE; return false;
  }
  if (GetNamedPipeServerProcessId(pipe, &confirmed_peer) == FALSE) { *error = GetLastError(); return false; }
  if (confirmed.dwCurrentState != SERVICE_RUNNING ||
      confirmed.dwServiceType != SERVICE_WIN32_OWN_PROCESS ||
      confirmed.dwProcessId != peer_id || confirmed_peer != peer_id) {
    *error = ERROR_ACCESS_DENIED; return false;
  }
  return true;
}

struct RelayState {
  HANDLE input;
  HANDLE output;
  HANDLE pipe;
  HANDLE gate;
  HANDLE stop;
};

struct RelayDirection {
  RelayState* state;
  bool to_service;
};

bool ReadPipeOverlapped(
    const HANDLE pipe,
    const HANDLE event,
    void* const buffer,
    const DWORD size,
    DWORD* const bytes_read) noexcept {
  *bytes_read = 0;
  ResetEvent(event);
  OVERLAPPED overlapped{};
  overlapped.hEvent = event;
  if (ReadFile(pipe, buffer, size, bytes_read, &overlapped) != FALSE) {
    return *bytes_read > 0;
  }
  if (GetLastError() != ERROR_IO_PENDING) {
    return false;
  }
  return GetOverlappedResult(pipe, &overlapped, bytes_read, TRUE) != FALSE && *bytes_read > 0;
}

bool WritePipeOverlapped(
    const HANDLE pipe,
    const HANDLE event,
    const void* const data,
    const DWORD length) noexcept {
  const auto* bytes = static_cast<const unsigned char*>(data);
  DWORD offset = 0;
  while (offset < length) {
    ResetEvent(event);
    OVERLAPPED overlapped{};
    overlapped.hEvent = event;
    DWORD written = 0;
    if (WriteFile(pipe, bytes + offset, length - offset, &written, &overlapped) == FALSE) {
      if (GetLastError() != ERROR_IO_PENDING) {
        return false;
      }
      if (GetOverlappedResult(pipe, &overlapped, &written, TRUE) == FALSE) {
        return false;
      }
    }
    if (written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

DWORD WINAPI Relay(void* const parameter) noexcept {
  auto& direction = *static_cast<RelayDirection*>(parameter);
  auto& state = *direction.state;
  UniqueHandle io_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (io_event.get() == nullptr || WaitForSingleObject(state.gate, INFINITE) != WAIT_OBJECT_0) {
    SetEvent(state.stop); return 1;
  }
  std::array<unsigned char, 16'384> buffer{};
  while (WaitForSingleObject(state.stop, 0) == WAIT_TIMEOUT) {
    DWORD read = 0;
    const bool read_ok = direction.to_service
        ? (ReadFile(state.input, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) != FALSE &&
           read > 0)
        : ReadPipeOverlapped(
              state.pipe, io_event.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &read);
    if (!read_ok || WaitForSingleObject(state.stop, 0) != WAIT_TIMEOUT) {
      break;
    }
    const bool write_ok = direction.to_service
        ? WritePipeOverlapped(state.pipe, io_event.get(), buffer.data(), read)
        : WriteAll(state.output, buffer.data(), read);
    if (!write_ok) {
      break;
    }
  }
  SetEvent(state.stop);
  return 0;
}

void JoinRelay(const HANDLE first, const HANDLE second, RelayState* const state) noexcept {
  SetEvent(state->stop);
  SetEvent(state->gate);
  // Cancellation can race the next synchronous ReadFile; retry until both owned threads exit.
  for (;;) {
    const bool first_done = first == nullptr || WaitForSingleObject(first, 0) == WAIT_OBJECT_0;
    const bool second_done = second == nullptr || WaitForSingleObject(second, 0) == WAIT_OBJECT_0;
    if (first_done && second_done) return;
    if (!first_done) CancelSynchronousIo(first);
    if (!second_done) CancelSynchronousIo(second);
    CancelIoEx(state->pipe, nullptr);
    if (!first_done) WaitForSingleObject(first, 10);
    if (!second_done) WaitForSingleObject(second, 10);
  }
}

int Forward(const HANDLE pipe, const HANDLE parent, const HANDLE service) noexcept {
  UniqueHandle gate(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  UniqueHandle stop(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (gate.get() == nullptr || stop.get() == nullptr) return Fail(BridgeFailure::unavailable, GetLastError());
  RelayState state{GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), pipe, gate.get(), stop.get()};
  RelayDirection to_service{&state, true};
  RelayDirection from_service{&state, false};
  UniqueHandle first(CreateThread(nullptr, 0, Relay, &to_service, 0, nullptr));
  if (first.get() == nullptr) return Fail(BridgeFailure::unavailable, GetLastError());
  UniqueHandle second(CreateThread(nullptr, 0, Relay, &from_service, 0, nullptr));
  if (second.get() == nullptr) {
    const DWORD error = GetLastError();
    JoinRelay(first.get(), nullptr, &state);
    return Fail(BridgeFailure::unavailable, error);
  }
  std::array<char, 96> ready{};
  const int length = std::snprintf(ready.data(), ready.size(),
      "{\"status\":\"ready\",\"clientPid\":%lu}\n", static_cast<unsigned long>(GetCurrentProcessId()));
  if (length <= 0 || static_cast<std::size_t>(length) >= ready.size() ||
      !WriteAll(GetStdHandle(STD_ERROR_HANDLE), ready.data(), static_cast<DWORD>(length))) {
    JoinRelay(first.get(), second.get(), &state); return 1;
  }
  SetEvent(gate.get());
  const std::array<HANDLE, 3> exits{stop.get(), parent, service};
  const DWORD waited = WaitForMultipleObjects(static_cast<DWORD>(exits.size()), exits.data(), FALSE, INFINITE);
  JoinRelay(first.get(), second.get(), &state);
  return waited == WAIT_FAILED ? 1 : 0;
}

}  // namespace

bool IsTrustedClientBridgePeer(const ClientBridgePeerIdentity& identity) noexcept {
  return identity.pipe_server_process_id != 0 &&
         identity.pipe_server_process_id == identity.service_process_id &&
         identity.service_type == SERVICE_WIN32_OWN_PROCESS &&
         identity.service_state == SERVICE_RUNNING &&
         (SameText(identity.service_account, L"LocalSystem") ||
          SameText(identity.service_account, L"NT AUTHORITY\\SYSTEM")) &&
         CanonicalServiceImage(identity.configured_image) &&
         CanonicalServiceImage(identity.running_image) &&
         SameText(identity.configured_image, identity.running_image);
}

int RunClientBridge(const std::wstring_view pipe_name, const std::wstring_view timeout) noexcept {
  try {
    DWORD timeout_ms = 0;
    if (!LocalPipeName(pipe_name) || !ParseTimeout(timeout, &timeout_ms) ||
        GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE ||
        GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE ||
        GetFileType(GetStdHandle(STD_ERROR_HANDLE)) != FILE_TYPE_PIPE) {
      return Fail(BridgeFailure::authentication, ERROR_INVALID_PARAMETER);
    }
    const ULONGLONG deadline = GetTickCount64() + timeout_ms;
    DWORD error = ERROR_SUCCESS;
    UniqueHandle parent;
    if (!OpenParent(&parent, &error)) return Fail(BridgeFailure::unavailable, error);
    UniqueHandle pipe;
    BridgeFailure failure = BridgeFailure::unavailable;
    if (!ConnectPipe(std::wstring(pipe_name), deadline, parent.get(), &pipe, &error)) {
      return Fail(failure, error);
    }
    UniqueHandle service;
    if (!VerifyPeer(pipe.get(), deadline, parent.get(), &service, &failure, &error)) return Fail(failure, error);
    return Forward(pipe.get(), parent.get(), service.get());
  } catch (...) {
    return Fail(BridgeFailure::authentication, ERROR_NOT_ENOUGH_MEMORY);
  }
}

#if defined(ZTOOLS_BUILD_SERVICE_MANIFEST_TESTS)
int RunClientBridgeRelayForTest(const HANDLE pipe, const HANDLE parent, const HANDLE service) noexcept {
  return Forward(pipe, parent, service);
}
#endif

}  // namespace ztools::service
