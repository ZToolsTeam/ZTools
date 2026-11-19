#include "ztools_service/client_bridge.hpp"
#include "ztools_service/service_process_security.hpp"

#include <Aclapi.h>
#include <Sddl.h>

#include <algorithm>
#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void Require(const bool condition, const char* const message) {
  if (!condition) throw std::runtime_error(message);
}

class UniqueHandle final {
 public:
  ~UniqueHandle() { reset(); }
  UniqueHandle() = default;
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  HANDLE get() const noexcept { return value_; }
  void reset(const HANDLE value = nullptr) noexcept {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

class UniqueLocalMemory final {
 public:
  UniqueLocalMemory() = default;
  ~UniqueLocalMemory() { if (value_ != nullptr) LocalFree(value_); }
  UniqueLocalMemory(const UniqueLocalMemory&) = delete;
  UniqueLocalMemory& operator=(const UniqueLocalMemory&) = delete;
  void* get() const noexcept { return value_; }
  void reset(void* const value) noexcept {
    if (value_ != nullptr) LocalFree(value_);
    value_ = value;
  }
 private:
  void* value_ = nullptr;
};

std::vector<BYTE> CurrentUserSid() {
  HANDLE raw_token = nullptr;
  Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) != FALSE, "Read fixture TokenUser failed");
  UniqueHandle token;
  token.reset(raw_token);
  DWORD needed = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &needed);
  Require(GetLastError() == ERROR_INSUFFICIENT_BUFFER && needed != 0, "TokenUser size failed");
  std::vector<BYTE> information(needed);
  Require(GetTokenInformation(token.get(), TokenUser, information.data(), needed, &needed) != FALSE, "Read TokenUser failed");
  const PSID user = reinterpret_cast<TOKEN_USER*>(information.data())->User.Sid;
  std::vector<BYTE> sid(GetLengthSid(user));
  Require(CopySid(static_cast<DWORD>(sid.size()), sid.data(), user) != FALSE, "Copy fixture user SID failed");
  return sid;
}

class OwnedProcessFixture final {
 public:
  OwnedProcessFixture() {
    job_.reset(CreateJobObjectW(nullptr, nullptr));
    Require(job_.get() != nullptr, "Create test process job failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(SetInformationJobObject(job_.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE,
        "Set fixture job cleanup policy failed");
    std::vector<wchar_t> image(32'768);
    const DWORD length = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
    Require(length != 0 && length < image.size(), "Resolve fixture executable failed");
    std::wstring command = L"\"" + std::wstring(image.data(), length) + L"\" --process-security-fixture";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    Require(CreateProcessW(image.data(), command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &startup, &child) != FALSE, "Create ACL fixture process failed");
    process_.reset(child.hProcess);
    thread_.reset(child.hThread);
    if (AssignProcessToJobObject(job_.get(), process_.get()) == FALSE) {
      TerminateProcess(process_.get(), 1);
      WaitForSingleObject(process_.get(), 5000);
      Require(false, "Assign ACL fixture cleanup job failed");
    }
    PSECURITY_DESCRIPTOR original = nullptr;
    const DWORD status = GetSecurityInfo(process_.get(), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &original_dacl_, nullptr, &original);
    original_.reset(original);
    Require(status == ERROR_SUCCESS && original_dacl_ != nullptr, "Read original fixture DACL failed");
    Require(ResumeThread(thread_.get()) != static_cast<DWORD>(-1), "Start ACL fixture failed");
  }
  ~OwnedProcessFixture() {
    if (process_.get() != nullptr) {
      if (original_dacl_ != nullptr) {
        SetSecurityInfo(process_.get(), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, original_dacl_, nullptr);
      }
      // Retained creation/job handles are unaffected by the deliberately restrictive DACL.
      if (TerminateJobObject(job_.get(), 0) == FALSE) TerminateProcess(process_.get(), 0);
      WaitForSingleObject(process_.get(), 5000);
    }
  }
  HANDLE get() const noexcept { return process_.get(); }
  DWORD id() const noexcept { return GetProcessId(process_.get()); }
 private:
  UniqueHandle job_;
  UniqueHandle process_;
  UniqueHandle thread_;
  UniqueLocalMemory original_;
  PACL original_dacl_ = nullptr;
};

void SetFixtureDacl(const HANDLE process, const std::wstring& sddl) {
  PSECURITY_DESCRIPTOR raw = nullptr;
  Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &raw, nullptr) != FALSE,
      "Parse fixture DACL failed");
  UniqueLocalMemory descriptor;
  descriptor.reset(raw);
  PACL dacl = nullptr;
  BOOL present = FALSE, defaulted = FALSE;
  Require(GetSecurityDescriptorDacl(raw, &present, &dacl, &defaulted) != FALSE && present && dacl,
      "Read fixture DACL failed");
  Require(SetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
      nullptr, nullptr, dacl, nullptr) == ERROR_SUCCESS, "Restrict fixture process DACL failed");
}

void ExpectProcessDenied(const DWORD pid, const DWORD mask) {
  UniqueHandle attempt;
  SetLastError(ERROR_SUCCESS);
  attempt.reset(OpenProcess(mask, FALSE, pid));
  Require(attempt.get() == nullptr && GetLastError() == ERROR_ACCESS_DENIED,
      "Fixture process did not reject an ungranted access mask");
}

void AssertMinimalProcessAce(const HANDLE process, const PSID user, const DWORD denied_mask) {
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR raw = nullptr;
  const DWORD status = GetSecurityInfo(process, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &dacl, nullptr, &raw);
  UniqueLocalMemory descriptor;
  descriptor.reset(raw);
  Require(status == ERROR_SUCCESS && dacl != nullptr, "Read merged process DACL failed");
  DWORD allowed = 0, denied = 0;
  bool system = false;
  for (DWORD index = 0; index < dacl->AceCount; ++index) {
    void* raw_ace = nullptr;
    Require(GetAce(dacl, index, &raw_ace) != FALSE, "Read merged process ACE failed");
    const auto* const header = static_cast<ACE_HEADER*>(raw_ace);
    Require(header->AceType == ACCESS_ALLOWED_ACE_TYPE || header->AceType == ACCESS_DENIED_ACE_TYPE,
        "Unexpected fixture ACE type");
    const auto* const ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
    const PSID sid = const_cast<DWORD*>(&ace->SidStart);
    Require(IsWellKnownSid(sid, WinWorldSid) == FALSE && IsWellKnownSid(sid, WinAuthenticatedUserSid) == FALSE &&
            IsWellKnownSid(sid, WinBuiltinUsersSid) == FALSE, "Process query grant added a global principal");
    if (IsWellKnownSid(sid, WinLocalSystemSid) != FALSE) system = true;
    if (EqualSid(sid, user) == FALSE) continue;
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) allowed |= ace->Mask;
    else denied |= ace->Mask;
  }
  Require(system && allowed == ztools::service::kServiceProcessQueryAccess && denied == denied_mask,
      "Process DACL did not preserve the exact minimal grant or original deny");
}

int CheckCurrentProcessPseudoHandle() {
  auto user = CurrentUserSid();
  PSECURITY_DESCRIPTOR raw = nullptr;
  PACL original_dacl = nullptr;
  Require(GetSecurityInfo(GetCurrentProcess(), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
      nullptr, nullptr, &original_dacl, nullptr, &raw) == ERROR_SUCCESS && original_dacl != nullptr,
      "Read pseudo-handle process DACL failed");
  UniqueLocalMemory descriptor;
  descriptor.reset(raw);
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  Require(GetSecurityDescriptorControl(raw, &control, &revision) != FALSE, "Read pseudo-handle DACL flags failed");
  struct Restore final {
    PACL dacl;
    SECURITY_INFORMATION information;
    bool restored = false;
    DWORD Apply() noexcept {
      const DWORD status = SetSecurityInfo(GetCurrentProcess(), SE_KERNEL_OBJECT, information,
          nullptr, nullptr, dacl, nullptr);
      if (status == ERROR_SUCCESS) restored = true;
      return status;
    }
    ~Restore() { if (!restored) Apply(); }
  } restore{original_dacl, DACL_SECURITY_INFORMATION | ((control & SE_DACL_PROTECTED) != 0
      ? PROTECTED_DACL_SECURITY_INFORMATION : UNPROTECTED_DACL_SECURITY_INFORMATION)};
  DWORD error = ERROR_SUCCESS;
  Require(ztools::service::GrantServiceProcessQueryAccess(GetCurrentProcess(), user.data(), &error) && error == ERROR_SUCCESS,
      "Current-process pseudo handle could not grant query access");
  Require(ztools::service::GrantServiceProcessQueryAccess(GetCurrentProcess(), user.data(), &error) && error == ERROR_SUCCESS,
      "Current-process pseudo handle grant is not idempotent");
  Require(restore.Apply() == ERROR_SUCCESS, "Restore pseudo-handle process DACL failed");
  return 2;
}

int CheckServiceProcessAccess() {
  int cases = 0;
  auto user = CurrentUserSid();
  OwnedProcessFixture child;
  SetFixtureDacl(child.get(), L"D:P(A;;GA;;;SY)");
  ExpectProcessDenied(child.id(), ztools::service::kServiceProcessQueryAccess);
  ++cases;
  DWORD error = ERROR_SUCCESS;
  Require(ztools::service::GrantServiceProcessQueryAccess(child.get(), user.data(), &error) && error == ERROR_SUCCESS,
      "Grant minimal service process access failed");
  UniqueHandle query;
  query.reset(OpenProcess(ztools::service::kServiceProcessQueryAccess, FALSE, child.id()));
  Require(query.get() != nullptr && WaitForSingleObject(query.get(), 0) == WAIT_TIMEOUT,
      "Granted process query/synchronize access is unavailable");
  std::vector<wchar_t> image(32'768);
  DWORD length = static_cast<DWORD>(image.size());
  Require(QueryFullProcessImageNameW(query.get(), 0, image.data(), &length) != FALSE && length != 0,
      "Granted process handle cannot read the real process image");
  AssertMinimalProcessAce(child.get(), user.data(), 0);
  ++cases;
  for (const DWORD mask : {PROCESS_VM_READ, PROCESS_VM_WRITE, PROCESS_TERMINATE,
       PROCESS_CREATE_THREAD, PROCESS_DUP_HANDLE}) { ExpectProcessDenied(child.id(), mask); ++cases; }
  Require(ztools::service::GrantServiceProcessQueryAccess(child.get(), user.data(), &error), "Repeated minimal grant failed");
  AssertMinimalProcessAce(child.get(), user.data(), 0);
  ++cases;
  wchar_t* raw_user_string = nullptr;
  Require(ConvertSidToStringSidW(user.data(), &raw_user_string) != FALSE, "Format fixture user SID failed");
  UniqueLocalMemory user_string;
  user_string.reset(raw_user_string);
  const std::wstring sid(raw_user_string);
  constexpr DWORD denied_mask = PROCESS_VM_WRITE | PROCESS_TERMINATE;
  SetFixtureDacl(child.get(), L"D:P(D;;0x00000021;;;" + sid + L")(A;;GA;;;SY)");
  Require(ztools::service::GrantServiceProcessQueryAccess(child.get(), user.data(), &error), "Grant with unrelated deny failed");
  AssertMinimalProcessAce(child.get(), user.data(), denied_mask);
  ExpectProcessDenied(child.id(), denied_mask);
  ++cases;
  SetFixtureDacl(child.get(), L"D:P(D;;0x00101000;;;" + sid + L")(A;;GA;;;SY)");
  Require(!ztools::service::GrantServiceProcessQueryAccess(child.get(), user.data(), &error) && error == ERROR_ACCESS_DENIED,
      "An explicit process query deny was overridden");
  ExpectProcessDenied(child.id(), ztools::service::kServiceProcessQueryAccess);
  ++cases;
  std::array<BYTE, SECURITY_MAX_SID_SIZE> broad{};
  for (const WELL_KNOWN_SID_TYPE kind : {WinWorldSid, WinAuthenticatedUserSid, WinBuiltinUsersSid}) {
    DWORD size = static_cast<DWORD>(broad.size());
    Require(CreateWellKnownSid(kind, nullptr, broad.data(), &size) != FALSE, "Create broad SID test fixture failed");
    Require(!ztools::service::GrantServiceProcessQueryAccess(child.get(), broad.data(), &error) && error == ERROR_INVALID_SID,
        "A broad principal received process query access");
    ++cases;
  }
  Require(!ztools::service::GrantServiceProcessQueryAccess(nullptr, user.data(), &error) && error == ERROR_INVALID_PARAMETER,
      "Null process handle was accepted");
  ++cases;
  Require(!ztools::service::GrantServiceProcessQueryAccess(child.get(), nullptr, &error) && error == ERROR_INVALID_PARAMETER,
      "Null TokenUser SID was accepted");
  ++cases;
  std::array<BYTE, SECURITY_MAX_SID_SIZE> invalid_sid{};
  Require(!ztools::service::GrantServiceProcessQueryAccess(child.get(), invalid_sid.data(), &error) && error == ERROR_INVALID_PARAMETER,
      "Invalid TokenUser SID was accepted");
  ++cases;
  return cases;
}

void NewPipe(UniqueHandle* const reader, UniqueHandle* const writer) {
  HANDLE read = nullptr;
  HANDLE write = nullptr;
  Require(CreatePipe(&read, &write, nullptr, 4096) != FALSE, "CreatePipe failed");
  reader->reset(read);
  writer->reset(write);
}

std::string ReadAll(const HANDLE reader) {
  std::string result;
  std::array<char, 256> buffer{};
  for (;;) {
    DWORD read = 0;
    if (ReadFile(reader, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) == FALSE) {
      Require(GetLastError() == ERROR_BROKEN_PIPE, "Capture read failed");
      return result;
    }
    if (read == 0) return result;
    result.append(buffer.data(), read);
    Require(result.size() <= 4096, "Capture output exceeded limit");
  }
}

struct BridgeResult {
  int code;
  std::string output;
  std::string control;
};

template <typename Run>
BridgeResult Capture(Run run, const bool close_input = false) {
  UniqueHandle input_read, input_write, output_read, output_write, error_read, error_write;
  NewPipe(&input_read, &input_write);
  NewPipe(&output_read, &output_write);
  NewPipe(&error_read, &error_write);
  const HANDLE original_input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE original_output = GetStdHandle(STD_OUTPUT_HANDLE);
  const HANDLE original_error = GetStdHandle(STD_ERROR_HANDLE);
  constexpr std::string_view marker = "must-not-reach-untrusted-server";
  DWORD written = 0;
  Require(WriteFile(input_write.get(), marker.data(), static_cast<DWORD>(marker.size()), &written, nullptr) != FALSE &&
          written == marker.size(), "Test input failed");
  if (close_input) input_write.reset();
  Require(SetStdHandle(STD_INPUT_HANDLE, input_read.get()) != FALSE &&
          SetStdHandle(STD_OUTPUT_HANDLE, output_write.get()) != FALSE &&
          SetStdHandle(STD_ERROR_HANDLE, error_write.get()) != FALSE, "Redirect stdio failed");
  const int code = run();
  const bool restored = SetStdHandle(STD_INPUT_HANDLE, original_input) != FALSE &&
                        SetStdHandle(STD_OUTPUT_HANDLE, original_output) != FALSE &&
                        SetStdHandle(STD_ERROR_HANDLE, original_error) != FALSE;
  output_write.reset();
  error_write.reset();
  Require(restored, "Restore stdio failed");
  return {code, ReadAll(output_read.get()), ReadAll(error_read.get())};
}

BridgeResult CaptureBridge(const std::wstring_view pipe, const std::wstring_view timeout) {
  return Capture([pipe, timeout]() { return ztools::service::RunClientBridge(pipe, timeout); });
}

void ExpectError(const BridgeResult& result, const char* const code) {
  Require(result.code != 0 && result.output.empty(), "Untrusted bridge emitted wire output or succeeded");
  Require(result.control.starts_with("{\"status\":\"error\",\"code\":\"") &&
          result.control.find(std::string("\"code\":\"") + code + "\"") != std::string::npos &&
          result.control.find("\"win32\":") != std::string::npos && result.control.ends_with("}\n") &&
          std::count(result.control.begin(), result.control.end(), '\n') == 1,
          "Bridge failure control frame is invalid");
}

struct FakeServer {
  HANDLE pipe;
  DWORD received = 0;
  bool connected = false;
  bool echo = false;
  bool echoed = false;
};

DWORD WINAPI FakeServerMain(void* const parameter) noexcept {
  auto& server = *static_cast<FakeServer*>(parameter);
  if (ConnectNamedPipe(server.pipe, nullptr) == FALSE && GetLastError() != ERROR_PIPE_CONNECTED) return 1;
  server.connected = true;
  std::array<char, 64> bytes{};
  ReadFile(server.pipe, bytes.data(), static_cast<DWORD>(bytes.size()), &server.received, nullptr);
  if (server.echo && server.received != 0) {
    DWORD written = 0;
    server.echoed = WriteFile(server.pipe, bytes.data(), server.received, &written, nullptr) != FALSE &&
                    written == server.received;
    FlushFileBuffers(server.pipe);
  }
  DisconnectNamedPipe(server.pipe);
  return 0;
}

void JoinFakeServer(const HANDLE thread) noexcept {
  while (WaitForSingleObject(thread, 10) != WAIT_OBJECT_0) CancelSynchronousIo(thread);
}

void CheckRelayShutdown(const std::wstring& suffix, const int mode) {
  const std::wstring name = L"\\\\.\\pipe\\ZToolsBridge.relay." + suffix + L"." + std::to_wstring(mode);
  UniqueHandle server_pipe, client_pipe, parent, service, thread;
  server_pipe.reset(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 4096, 4096, 0, nullptr));
  Require(server_pipe.get() != INVALID_HANDLE_VALUE, "Create relay fixture failed");
  FakeServer server{server_pipe.get()};
  server.echo = mode == 0;
  thread.reset(CreateThread(nullptr, 0, FakeServerMain, &server, 0, nullptr));
  Require(thread.get() != nullptr, "Create relay fixture thread failed");
  client_pipe.reset(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr));
  if (client_pipe.get() == INVALID_HANDLE_VALUE) {
    JoinFakeServer(thread.get());
    Require(false, "Connect relay fixture failed");
  }
  parent.reset(CreateEventW(nullptr, TRUE, mode == 2 ? TRUE : FALSE, nullptr));
  service.reset(CreateEventW(nullptr, TRUE, mode == 3 ? TRUE : FALSE, nullptr));
  Require(parent.get() != nullptr && service.get() != nullptr, "Create relay exit fixture failed");
  const ULONGLONG started = GetTickCount64();
  const BridgeResult result = Capture([&]() {
    return ztools::service::RunClientBridgeRelayForTest(client_pipe.get(), parent.get(), service.get());
  }, mode == 1);
  client_pipe.reset();
  JoinFakeServer(thread.get());
  Require(result.code == 0 && GetTickCount64() - started < 3000, "Relay did not join all threads promptly");
  const std::string expected_ready = "{\"status\":\"ready\",\"clientPid\":" +
      std::to_string(GetCurrentProcessId()) + "}\n";
  Require(result.control == expected_ready, "Relay readiness PID or control frame is invalid");
  if (mode == 0) {
    Require(server.echoed && result.output == "must-not-reach-untrusted-server", "Relay changed or lost wire bytes");
  }
}

int RunTests() {
  using ztools::service::ClientBridgePeerIdentity;
  using ztools::service::IsTrustedClientBridgePeer;
  constexpr std::wstring_view image = L"D:\\ZTools\\ZToolsService.exe";
  const ClientBridgePeerIdentity valid{4000, 4000, SERVICE_WIN32_OWN_PROCESS, SERVICE_RUNNING,
      L"LocalSystem", image, image};
  int cases = 0;
  const auto check = [&cases](const ClientBridgePeerIdentity& identity, const bool expected) {
    Require(IsTrustedClientBridgePeer(identity) == expected, "Client bridge identity policy failed");
    ++cases;
  };
  check(valid, true);
  auto changed = valid;
  changed.service_account = L"nt authority\\system";
  changed.running_image = L"d:\\ztools\\ZTOOLSSERVICE.EXE";
  check(changed, true);
  for (const DWORD pid : {0UL, 4001UL}) {
    changed = valid; changed.pipe_server_process_id = pid; check(changed, false);
    changed = valid; changed.service_process_id = pid; check(changed, false);
  }
  for (const DWORD state : {SERVICE_STOPPED, SERVICE_START_PENDING, SERVICE_STOP_PENDING, SERVICE_PAUSED}) {
    changed = valid; changed.service_state = state; check(changed, false);
  }
  for (const DWORD type : {0UL, static_cast<DWORD>(SERVICE_WIN32_SHARE_PROCESS),
       static_cast<DWORD>(SERVICE_WIN32_OWN_PROCESS | SERVICE_INTERACTIVE_PROCESS)}) {
    changed = valid; changed.service_type = type; check(changed, false);
  }
  for (const std::wstring_view account : {L"", L"LocalService", L"NetworkService", L"user"}) {
    changed = valid; changed.service_account = account; check(changed, false);
  }
  for (const std::wstring_view invalid : {L"", L"ZToolsService.exe", L"D:\\Other\\ZToolsService.exe",
       L"D:\\ZTools\\other.exe", L"D:\\ZTools\\..\\ZToolsService.exe"}) {
    changed = valid; changed.running_image = invalid; check(changed, false);
    changed = valid; changed.configured_image = invalid; check(changed, false);
  }
  changed = valid; changed.configured_image = changed.running_image = L"D:\\ZTools\\other.exe";
  check(changed, false);
  changed = valid; changed.configured_image = changed.running_image = L"ZToolsService.exe";
  check(changed, false);
  const std::wstring unique = std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
  const std::wstring absent = L"\\\\.\\pipe\\ZToolsBridge.absent." + unique;
  for (const std::wstring_view timeout : {L"", L"0", L"60001", L"-1", L"1.5", L"x"}) {
    ExpectError(CaptureBridge(absent, timeout), "SERVICE_AUTHENTICATION_FAILED"); ++cases;
  }
  for (const std::wstring_view name : {L"", L"\\\\remote\\pipe\\service", L"\\\\.\\pipe\\", L"\\\\.\\pipe\\nested\\pipe"}) {
    ExpectError(CaptureBridge(name, L"25"), "SERVICE_AUTHENTICATION_FAILED"); ++cases;
  }
  const ULONGLONG absent_started = GetTickCount64();
  ExpectError(CaptureBridge(absent, L"60000"), "SERVICE_UNAVAILABLE");
  Require(GetTickCount64() - absent_started < 1000, "Absent optional service waited for the connection deadline");
  ++cases;
  const std::wstring denied_name = L"\\\\.\\pipe\\ZToolsBridge.denied." + unique;
  PSECURITY_DESCRIPTOR denied_descriptor = nullptr;
  Require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(D;;GA;;;WD)",
      SDDL_REVISION_1, &denied_descriptor, nullptr) != FALSE, "Create denied pipe descriptor failed");
  SECURITY_ATTRIBUTES denied_security{sizeof(SECURITY_ATTRIBUTES), denied_descriptor, FALSE};
  UniqueHandle denied_pipe;
  denied_pipe.reset(CreateNamedPipeW(denied_name.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 4096, 4096, 0, &denied_security));
  LocalFree(denied_descriptor);
  Require(denied_pipe.get() != INVALID_HANDLE_VALUE, "Create denied pipe fixture failed");
  const ULONGLONG denied_started = GetTickCount64();
  const BridgeResult denied = CaptureBridge(denied_name, L"60000");
  ExpectError(denied, "SERVICE_UNAVAILABLE");
  Require(denied.control.find("\"win32\":5}") != std::string::npos &&
          GetTickCount64() - denied_started < 1000, "Denied optional service did not preserve immediate access failure");
  ++cases;
  const std::wstring fake_name = L"\\\\.\\pipe\\ZToolsBridge.fake." + unique;
  UniqueHandle fake_pipe;
  fake_pipe.reset(CreateNamedPipeW(fake_name.c_str(), PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 4096, 4096, 0, nullptr));
  Require(fake_pipe.get() != INVALID_HANDLE_VALUE, "Create fake server failed");
  FakeServer fake{fake_pipe.get()};
  UniqueHandle fake_thread;
  fake_thread.reset(CreateThread(nullptr, 0, FakeServerMain, &fake, 0, nullptr));
  Require(fake_thread.get() != nullptr, "Create fake server thread failed");
  const BridgeResult result = CaptureBridge(fake_name, L"500");
  JoinFakeServer(fake_thread.get());
  ExpectError(result, "SERVICE_AUTHENTICATION_FAILED");
  Require(fake.connected && fake.received == 0, "Fake server received unauthenticated input");
  ++cases;
  for (const int mode : {0, 1, 2, 3}) { CheckRelayShutdown(unique, mode); ++cases; }
  cases += CheckServiceProcessAccess();
  cases += CheckCurrentProcessPseudoHandle();
  return cases;
}

}  // namespace

int wmain(const int argument_count, wchar_t* arguments[]) {
  if (argument_count == 2 && std::wstring_view(arguments[1]) == L"--process-security-fixture") {
    // A broken parent/job cleanup can never leave a permanently protected fixture.
    Sleep(15'000);
    return 0;
  }
  try {
    const int cases = RunTests();
    std::cout << "{\"test\":\"client-bridge\",\"cases\":" << cases << ",\"state\":\"passed\"}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Client bridge regression failed: " << error.what() << '\n';
    return 1;
  }
}
