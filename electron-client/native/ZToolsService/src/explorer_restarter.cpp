#include "ztools_service/explorer_restarter.hpp"

#include <TlHelp32.h>
#include <UserEnv.h>
#include <WtsApi32.h>

#include <algorithm>
#include <cwchar>
#include <string>
#include <utility>
#include <vector>

namespace ztools::service {
namespace {

constexpr DWORD kExplorerStopTimeoutMs = 5'000;

class UniqueHandle final {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(const HANDLE value) noexcept : value_(value) {}
  ~UniqueHandle() {
    if (valid()) {
      CloseHandle(value_);
    }
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      if (valid()) {
        CloseHandle(value_);
      }
      value_ = other.release();
    }
    return *this;
  }

  HANDLE get() const noexcept { return value_; }
  bool valid() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() noexcept {
    const HANDLE value = value_;
    value_ = nullptr;
    return value;
  }

 private:
  HANDLE value_ = nullptr;
};

class EnvironmentBlock final {
 public:
  ~EnvironmentBlock() {
    if (value_ != nullptr) {
      DestroyEnvironmentBlock(value_);
    }
  }
  void** address() noexcept { return &value_; }
  void* get() const noexcept { return value_; }

 private:
  void* value_ = nullptr;
};

class SuspendedProcess final {
 public:
  SuspendedProcess() = default;
  ~SuspendedProcess() {
    if (!resumed_ && process_.valid()) {
      TerminateProcess(process_.get(), ERROR_CANCELLED);
    }
  }
  SuspendedProcess(const SuspendedProcess&) = delete;
  SuspendedProcess& operator=(const SuspendedProcess&) = delete;

  void Adopt(const PROCESS_INFORMATION& process) noexcept {
    process_ = UniqueHandle(process.hProcess);
    thread_ = UniqueHandle(process.hThread);
  }
  bool Resume() noexcept {
    if (!process_.valid() || !thread_.valid() ||
        ResumeThread(thread_.get()) == static_cast<DWORD>(-1)) {
      return false;
    }
    resumed_ = true;
    return true;
  }

 private:
  UniqueHandle process_;
  UniqueHandle thread_;
  bool resumed_ = false;
};

ExplorerRestartResult Failure(
    const std::string& code,
    const std::string& message) {
  return {false, code, message};
}

bool SamePath(const std::wstring& left, const std::wstring& right) noexcept {
  return left.size() == right.size() &&
         CompareStringOrdinal(
             left.data(),
             static_cast<int>(left.size()),
             right.data(),
             static_cast<int>(right.size()),
             TRUE) == CSTR_EQUAL;
}

bool ReadProcessPath(const HANDLE process, std::wstring* const path) {
  std::vector<wchar_t> buffer(512);
  while (buffer.size() <= 32768) {
    DWORD length = static_cast<DWORD>(buffer.size());
    if (QueryFullProcessImageNameW(process, 0, buffer.data(), &length) != FALSE) {
      path->assign(buffer.data(), length);
      return true;
    }
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
      return false;
    }
    buffer.resize(buffer.size() * 2);
  }
  return false;
}

bool GetExplorerPath(
    std::wstring* const windows_directory,
    std::wstring* const explorer_path) {
  std::vector<wchar_t> buffer(MAX_PATH + 1);
  const UINT length = GetWindowsDirectoryW(
      buffer.data(), static_cast<UINT>(buffer.size()));
  if (length == 0 || length >= buffer.size()) {
    return false;
  }
  windows_directory->assign(buffer.data(), length);
  *explorer_path = *windows_directory;
  if (!explorer_path->empty() && explorer_path->back() != L'\\') {
    explorer_path->push_back(L'\\');
  }
  explorer_path->append(L"explorer.exe");
  return true;
}

bool IsStopped(const HANDLE process) noexcept {
  DWORD exit_code = STILL_ACTIVE;
  return GetExitCodeProcess(process, &exit_code) != FALSE &&
         exit_code != STILL_ACTIVE;
}

ExplorerRestartResult OpenSessionExplorers(
    const DWORD session_id,
    const std::wstring& expected_path,
    std::vector<UniqueHandle>* const processes) {
  UniqueHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.valid()) {
    return Failure("EXPLORER_ENUM_FAILED", "process snapshot could not be created");
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.get(), &entry) == FALSE) {
    return Failure("EXPLORER_ENUM_FAILED", "process snapshot could not be read");
  }
  do {
    if (_wcsicmp(entry.szExeFile, L"explorer.exe") != 0) {
      continue;
    }
    DWORD process_session_id = 0;
    if (ProcessIdToSessionId(entry.th32ProcessID, &process_session_id) == FALSE ||
        process_session_id != session_id) {
      continue;
    }
    UniqueHandle process(OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
        FALSE,
        entry.th32ProcessID));
    if (!process.valid()) {
      return Failure(
          "EXPLORER_OPEN_FAILED", "a session Explorer process could not be opened");
    }
    const DWORD opened_process_id = GetProcessId(process.get());
    DWORD opened_session_id = 0;
    if (opened_process_id == 0 ||
        ProcessIdToSessionId(opened_process_id, &opened_session_id) == FALSE ||
        opened_session_id != session_id) {
      return Failure(
          "EXPLORER_SESSION_INVALID",
          "a session Explorer process changed identity before validation");
    }
    std::wstring actual_path;
    if (!ReadProcessPath(process.get(), &actual_path)) {
      return Failure(
          "EXPLORER_PATH_INVALID", "a session Explorer path could not be verified");
    }
    if (SamePath(actual_path, expected_path)) {
      processes->push_back(std::move(process));
    }
  } while (Process32NextW(snapshot.get(), &entry) != FALSE);
  if (GetLastError() != ERROR_NO_MORE_FILES) {
    return Failure("EXPLORER_ENUM_FAILED", "process snapshot enumeration failed");
  }
  if (processes->empty()) {
    return Failure(
        "EXPLORER_NOT_FOUND", "no trusted Explorer process exists in the client session");
  }
  return {true, {}, {}};
}

ExplorerRestartResult StopExplorers(
    const std::vector<UniqueHandle>& processes) {
  for (const UniqueHandle& process : processes) {
    if (IsStopped(process.get())) {
      continue;
    }
    if (TerminateProcess(process.get(), 0) == FALSE && !IsStopped(process.get())) {
      return Failure("EXPLORER_STOP_FAILED", "a trusted Explorer process did not stop");
    }
  }
  const ULONGLONG deadline = GetTickCount64() + kExplorerStopTimeoutMs;
  for (const UniqueHandle& process : processes) {
    if (IsStopped(process.get())) {
      continue;
    }
    const ULONGLONG now = GetTickCount64();
    const DWORD remaining = now >= deadline
                                ? 0
                                : static_cast<DWORD>(deadline - now);
    if (WaitForSingleObject(process.get(), remaining) != WAIT_OBJECT_0) {
      return Failure(
          "EXPLORER_STOP_TIMEOUT", "a trusted Explorer process exceeded the stop deadline");
    }
  }
  return {true, {}, {}};
}

ExplorerRestartResult PrepareSessionLaunch(
    const DWORD session_id,
    UniqueHandle* const primary_token,
    EnvironmentBlock* const environment) {
  HANDLE raw_user_token = nullptr;
  if (WTSQueryUserToken(session_id, &raw_user_token) == FALSE) {
    return Failure(
        "USER_TOKEN_UNAVAILABLE", "the client session user token is unavailable");
  }
  UniqueHandle user_token(raw_user_token);
  HANDLE raw_primary_token = nullptr;
  constexpr DWORD token_access =
      TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
      TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
  if (DuplicateTokenEx(
          user_token.get(),
          token_access,
          nullptr,
          SecurityImpersonation,
          TokenPrimary,
          &raw_primary_token) == FALSE) {
    return Failure(
        "USER_TOKEN_UNAVAILABLE", "the client session primary token is unavailable");
  }
  *primary_token = UniqueHandle(raw_primary_token);
  if (CreateEnvironmentBlock(
          environment->address(), primary_token->get(), FALSE) == FALSE) {
    return Failure(
        "USER_ENVIRONMENT_UNAVAILABLE", "the client session environment is unavailable");
  }
  return {true, {}, {}};
}

ExplorerRestartResult PrepareExplorer(
    const HANDLE primary_token,
    void* const environment,
    const std::wstring& windows_directory,
    const std::wstring& explorer_path,
    SuspendedProcess* const replacement) {
  std::vector<wchar_t> command_line;
  command_line.reserve(explorer_path.size() + 3);
  command_line.push_back(L'"');
  command_line.insert(
      command_line.end(), explorer_path.begin(), explorer_path.end());
  command_line.push_back(L'"');
  command_line.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  wchar_t desktop[] = L"winsta0\\default";
  startup.lpDesktop = desktop;
  PROCESS_INFORMATION process{};
  if (CreateProcessAsUserW(
          primary_token,
          explorer_path.c_str(),
          command_line.data(),
          nullptr,
          nullptr,
          FALSE,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
          environment,
          windows_directory.c_str(),
          &startup,
          &process) == FALSE) {
    return Failure(
        "EXPLORER_START_FAILED", "Explorer could not be started in the client session");
  }
  replacement->Adopt(process);
  return {true, {}, {}};
}

}  // namespace

ExplorerRestartResult WindowsExplorerRestarter::Restart(
    const DWORD client_session_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (client_session_id == 0) {
    return Failure(
        "CLIENT_SESSION_INVALID", "authenticated client session is invalid");
  }
  std::wstring windows_directory;
  std::wstring explorer_path;
  if (!GetExplorerPath(&windows_directory, &explorer_path)) {
    return Failure("EXPLORER_PATH_INVALID", "Windows Explorer path is unavailable");
  }
  std::vector<UniqueHandle> processes;
  ExplorerRestartResult opened =
      OpenSessionExplorers(client_session_id, explorer_path, &processes);
  if (!opened.success) {
    return opened;
  }
  UniqueHandle primary_token;
  EnvironmentBlock environment;
  ExplorerRestartResult prepared =
      PrepareSessionLaunch(client_session_id, &primary_token, &environment);
  if (!prepared.success) {
    return prepared;
  }
  SuspendedProcess replacement;
  ExplorerRestartResult replacement_prepared = PrepareExplorer(
      primary_token.get(),
      environment.get(),
      windows_directory,
      explorer_path,
      &replacement);
  if (!replacement_prepared.success) {
    return replacement_prepared;
  }
  ExplorerRestartResult stopped = StopExplorers(processes);
  if (!stopped.success) {
    replacement.Resume();
    return stopped;
  }
  if (!replacement.Resume()) {
    return Failure(
        "EXPLORER_START_FAILED", "the prepared Explorer process could not be resumed");
  }
  return {true, {}, {}};
}

}  // namespace ztools::service
