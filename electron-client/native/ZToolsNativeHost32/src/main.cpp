#include "dll_host.hpp"
#include "input_inject.hpp"
#include "keyboard_hook.hpp"
#include "dll_resolver.hpp"
#include "mouse_hook.hpp"
#include "protocol.hpp"

#include <Windows.h>

#include <array>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ztools::native_host {
namespace {

constexpr std::string_view kClientDomain = "ztools-native-host-client-v1";
constexpr std::string_view kServerDomain = "ztools-native-host-server-v1";
constexpr std::uint32_t kDefaultOrphanShutdownDeadlineMs = 12'000;
constexpr std::uint32_t kMinimumShutdownDeadlineMs = 50;
constexpr std::uint32_t kMaximumShutdownDeadlineMs = 60'000;

class ProcessTreeJob {
 public:
  ProcessTreeJob() = default;
  ProcessTreeJob(const ProcessTreeJob&) = delete;
  ProcessTreeJob& operator=(const ProcessTreeJob&) = delete;

  ~ProcessTreeJob() = default;

  bool AttachCurrentProcess(const char*& failed_operation, DWORD& error) noexcept {
    failed_operation = "CreateJobObjectW";
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job == nullptr) {
      error = GetLastError();
      return false;
    }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    failed_operation = "SetInformationJobObject";
    if (!SetInformationJobObject(
          job, JobObjectExtendedLimitInformation, &limits,
          static_cast<DWORD>(sizeof(limits)))) {
      error = GetLastError();
      CloseHandle(job);
      return false;
    }

    failed_operation = "AssignProcessToJobObject";
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
      error = GetLastError();
      CloseHandle(job);
      return false;
    }

    handle_ = job;
    error = ERROR_SUCCESS;
    return true;
  }

 private:
  // This process belongs to the job, so an explicit CloseHandle in the C++
  // destructor would terminate the host itself. The OS closes this handle at
  // process teardown, after DllHost destruction and the final response write.
  HANDLE handle_ = nullptr;
};

enum class HostState {
  AwaitHello,
  Ready,
  Stopping,
  Closed,
};

Frame ErrorFrame(const Frame& request, std::string_view code, std::string_view message) {
  auto escape_json = [](std::string_view value) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string escaped;
    escaped.reserve(value.size() + 2);
    escaped.push_back('"');
    for (const unsigned char character : value) {
      if (character == '"') escaped += "\\\"";
      else if (character == '\\') escaped += "\\\\";
      else if (character < 0x20U) {
        escaped += "\\u00";
        escaped.push_back(hex[(character >> 4U) & 0x0fU]);
        escaped.push_back(hex[character & 0x0fU]);
      } else escaped.push_back(static_cast<char>(character));
    }
    escaped.push_back('"');
    return escaped;
  };
  Frame response;
  response.type = FrameType::Error;
  response.session_id = request.session_id.empty() ? "unbound" : request.session_id;
  response.request_id = request.request_id.empty() ? "unbound" : request.request_id;
  response.method = "error";
  const std::string json =
    "{\"code\":" + escape_json(code) + ",\"message\":" + escape_json(message) + "}";
  response.payload = Bytes(json);
  return response;
}

class FrameWriter {
 public:
  explicit FrameWriter(HANDLE output) : output_(output) {}

  bool Send(const Frame& frame) {
    std::lock_guard lock(mutex_);
    std::string error;
    if (WriteFrame(output_, frame, error)) return true;
    std::cerr << error << '\n';
    return false;
  }

 private:
  HANDLE output_;
  std::mutex mutex_;
};

bool ParseTaskCallPayload(
  const std::vector<std::uint8_t>& payload,
  std::string& task_id,
  std::string& function_name,
  std::vector<std::uint8_t>& params_json) {
  if (payload.size() < 7) return false;
  const std::size_t task_length = static_cast<std::size_t>(payload[0]) |
    (static_cast<std::size_t>(payload[1]) << 8U);
  const std::size_t function_length = static_cast<std::size_t>(payload[2]) |
    (static_cast<std::size_t>(payload[3]) << 8U);
  if (task_length == 0 || task_length > 128 ||
      function_length == 0 || function_length > 128 ||
      4 + task_length + function_length >= payload.size()) {
    return false;
  }
  auto current = payload.begin() + 4;
  task_id.assign(current, current + static_cast<std::ptrdiff_t>(task_length));
  current += static_cast<std::ptrdiff_t>(task_length);
  function_name.assign(current, current + static_cast<std::ptrdiff_t>(function_length));
  current += static_cast<std::ptrdiff_t>(function_length);
  params_json.assign(current, payload.end());
  return true;
}

std::vector<std::span<const std::uint8_t>> ClientProofParts(
  const Frame& hello,
  std::span<const std::uint8_t> nonce) {
  static constexpr std::array<std::uint8_t, 1> separator{0};
  return {
    std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(kClientDomain.data()), kClientDomain.size()),
    separator,
    std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(hello.session_id.data()), hello.session_id.size()),
    separator,
    nonce,
  };
}

std::vector<std::span<const std::uint8_t>> ServerProofParts(
  const Frame& hello,
  std::span<const std::uint8_t> client_nonce,
  std::span<const std::uint8_t> server_nonce) {
  static constexpr std::array<std::uint8_t, 1> separator{0};
  return {
    std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(kServerDomain.data()), kServerDomain.size()),
    separator,
    std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(hello.session_id.data()), hello.session_id.size()),
    separator,
    client_nonce,
    server_nonce,
  };
}

bool Authenticate(
  FrameWriter& writer,
  const Frame& hello,
  std::array<std::uint8_t, kSecretBytes>& secret,
  std::string& session_id) {
  if (hello.protocol_version != kProtocolVersion) {
    writer.Send(ErrorFrame(hello, "PROTOCOL_MISMATCH", "unsupported protocol version"));
    return false;
  }
  if (hello.type != FrameType::Hello || hello.method != "hello" ||
      !hello.plugin_id.empty() || !hello.dll_id.empty() ||
      hello.payload.size() != kNonceBytes + kProofBytes) {
    writer.Send(ErrorFrame(hello, "AUTH_REQUIRED", "valid hello frame required"));
    return false;
  }

  const std::span<const std::uint8_t> client_nonce(hello.payload.data(), kNonceBytes);
  const std::span<const std::uint8_t> supplied_proof(
    hello.payload.data() + kNonceBytes, kProofBytes);
  std::array<std::uint8_t, kProofBytes> expected_proof{};
  if (!HmacSha256(secret, ClientProofParts(hello, client_nonce), expected_proof) ||
      !ConstantTimeEqual(supplied_proof, expected_proof)) {
    SecureErase(expected_proof);
    writer.Send(ErrorFrame(hello, "AUTH_FAILED", "native host authentication failed"));
    return false;
  }
  SecureErase(expected_proof);

  std::array<std::uint8_t, kNonceBytes> server_nonce{};
  std::array<std::uint8_t, kProofBytes> server_proof{};
  if (!RandomBytes(server_nonce) ||
      !HmacSha256(secret, ServerProofParts(hello, client_nonce, server_nonce), server_proof)) {
    SecureErase(server_nonce);
    SecureErase(server_proof);
    writer.Send(ErrorFrame(hello, "AUTH_FAILED", "native host authentication failed"));
    return false;
  }

  Frame response;
  response.type = FrameType::HelloAck;
  response.session_id = hello.session_id;
  response.request_id = hello.request_id;
  response.method = "hello_ack";
  response.payload.insert(response.payload.end(), server_nonce.begin(), server_nonce.end());
  response.payload.insert(response.payload.end(), server_proof.begin(), server_proof.end());
  const bool sent = writer.Send(response);
  SecureErase(server_nonce);
  SecureErase(server_proof);
  if (sent) session_id = hello.session_id;
  return sent;
}

bool HandleReadyFrame(
  FrameWriter& writer,
  const Frame& request,
  std::string_view session_id,
  HostState& state,
  const DllResolver& manifest,
  DllHost& dll_host,
  MouseHook& mouse_hook,
  KeyboardHook& keyboard_hook,
  bool& shutdown_timed_out) {
  if (request.protocol_version != kProtocolVersion || request.session_id != session_id) {
    writer.Send(ErrorFrame(request, "PROTOCOL_MISMATCH", "protocol or session mismatch"));
    return false;
  }
  if (request.type != FrameType::Request) {
    writer.Send(ErrorFrame(request, "INVALID_REQUEST", "request frame is invalid"));
    return true;
  }

  Frame response;
  response.type = FrameType::Response;
  response.session_id = request.session_id;
  response.request_id = request.request_id;
  response.method = request.method;
  if (request.method == "ping") {
    if (!request.plugin_id.empty() || !request.dll_id.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "ping identity must be empty"));
      return true;
    }
    response.payload = request.payload;
    return writer.Send(response);
  }
  if (request.method == "shutdown") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 4) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "shutdown request is invalid"));
      return true;
    }
    const std::uint32_t deadline_ms = static_cast<std::uint32_t>(request.payload[0]) |
      (static_cast<std::uint32_t>(request.payload[1]) << 8U) |
      (static_cast<std::uint32_t>(request.payload[2]) << 16U) |
      (static_cast<std::uint32_t>(request.payload[3]) << 24U);
    if (deadline_ms < kMinimumShutdownDeadlineMs || deadline_ms > kMaximumShutdownDeadlineMs) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "shutdown deadline is invalid"));
      return true;
    }
    state = HostState::Stopping;
    mouse_hook.Stop();
    keyboard_hook.Stop();
    DllHostShutdownResult result = dll_host.Shutdown(deadline_ms);
    shutdown_timed_out = result.timed_out;
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "mouse_hook_configure") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 5) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse hook request is invalid"));
      return true;
    }
    const bool enabled = request.payload[0] == 1;
    if (request.payload[0] > 1) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse hook enabled flag is invalid"));
      return true;
    }
    if (!enabled) {
      if (request.payload[1] != 0 || request.payload[2] != 0 ||
          request.payload[3] != 0 || request.payload[4] != 0) {
        writer.Send(ErrorFrame(request, "INVALID_REQUEST", "disabled mouse hook payload is invalid"));
        return true;
      }
      mouse_hook.Stop();
      response.payload = Bytes("{\"success\":true,\"enabled\":false}");
      return writer.Send(response);
    }

    const MouseButton button = static_cast<MouseButton>(request.payload[1]);
    const MouseAction action = static_cast<MouseAction>(request.payload[2]);
    const std::uint16_t threshold = static_cast<std::uint16_t>(request.payload[3]) |
      (static_cast<std::uint16_t>(request.payload[4]) << 8U);
    if ((button < MouseButton::Middle || button > MouseButton::Backward) ||
        (action != MouseAction::Press && action != MouseAction::LongPress) ||
        threshold < 200 || threshold > 500) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse hook configuration is invalid"));
      return true;
    }
    std::string mouse_error;
    if (!mouse_hook.Configure({button, action, threshold}, mouse_error)) {
      writer.Send(ErrorFrame(request, "MOUSE_HOOK_UNAVAILABLE", mouse_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true,\"enabled\":true}");
    return writer.Send(response);
  }
  if (request.method == "keyboard_hook_configure") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 1) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "keyboard hook request is invalid"));
      return true;
    }
    const std::uint8_t modifier_mask = request.payload[0];
    if (modifier_mask > 0x07U) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "keyboard hook modifier mask is invalid"));
      return true;
    }
    if (modifier_mask == 0) {
      keyboard_hook.Stop();
      response.payload = Bytes("{\"success\":true,\"enabled\":false}");
      return writer.Send(response);
    }
    std::string keyboard_error;
    if (!keyboard_hook.Configure(modifier_mask, keyboard_error)) {
      writer.Send(ErrorFrame(request, "KEYBOARD_HOOK_UNAVAILABLE", keyboard_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true,\"enabled\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_get_foreground") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || !request.payload.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "foreground request is invalid"));
      return true;
    }
    std::uint64_t handle = 0;
    std::string input_error;
    if (!GetForegroundWindowHandle(handle, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload.resize(8);
    for (std::size_t index = 0; index < 8; ++index) {
      response.payload[index] = static_cast<std::uint8_t>((handle >> (index * 8U)) & 0xffU);
    }
    return writer.Send(response);
  }
  if (request.method == "input_restore_foreground") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 8) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "foreground restore request is invalid"));
      return true;
    }
    std::uint64_t handle = 0;
    for (std::size_t index = 0; index < 8; ++index) {
      handle |= static_cast<std::uint64_t>(request.payload[index]) << (index * 8U);
    }
    std::string input_error;
    if (!RestoreForegroundWindow(handle, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_key_press") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 2) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "key press request is invalid"));
      return true;
    }
    const std::uint16_t virtual_key = static_cast<std::uint16_t>(request.payload[0]) |
      static_cast<std::uint16_t>(static_cast<std::uint16_t>(request.payload[1]) << 8U);
    std::string input_error;
    if (!InjectKeyPress(virtual_key, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_key_combo") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "key combo request is invalid"));
      return true;
    }
    const std::size_t count = request.payload[0];
    if (count == 0 || count > 32 || request.payload.size() != 1 + count * 2) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "key combo payload is invalid"));
      return true;
    }
    std::vector<std::uint16_t> virtual_keys;
    virtual_keys.reserve(count);
    for (std::size_t index = 0; index < count; ++index) {
      const std::size_t offset = 1 + index * 2;
      virtual_keys.push_back(static_cast<std::uint16_t>(request.payload[offset]) |
        static_cast<std::uint16_t>(static_cast<std::uint16_t>(request.payload[offset + 1]) << 8U));
    }
    std::string input_error;
    if (!InjectKeyCombo(virtual_keys, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_text") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "text input request is invalid"));
      return true;
    }
    std::string input_error;
    if (!InjectText(request.payload, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_mouse_move") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 8) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse move request is invalid"));
      return true;
    }
    const auto read_int32 = [&request](std::size_t offset) {
      const std::uint32_t value = static_cast<std::uint32_t>(request.payload[offset]) |
        (static_cast<std::uint32_t>(request.payload[offset + 1]) << 8U) |
        (static_cast<std::uint32_t>(request.payload[offset + 2]) << 16U) |
        (static_cast<std::uint32_t>(request.payload[offset + 3]) << 24U);
      return static_cast<std::int32_t>(value);
    };
    std::string input_error;
    if (!InjectMouseMove(read_int32(0), read_int32(4), input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_mouse_click") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() ||
        (request.payload.size() != 2 && request.payload.size() != 10)) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse click request is invalid"));
      return true;
    }
    const bool has_position = request.payload[1] == 1;
    if ((has_position && request.payload.size() != 10) ||
        (!has_position && request.payload.size() != 2) || request.payload[1] > 1) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse click payload is invalid"));
      return true;
    }
    const auto read_int32 = [&request](std::size_t offset) {
      const std::uint32_t value = static_cast<std::uint32_t>(request.payload[offset]) |
        (static_cast<std::uint32_t>(request.payload[offset + 1]) << 8U) |
        (static_cast<std::uint32_t>(request.payload[offset + 2]) << 16U) |
        (static_cast<std::uint32_t>(request.payload[offset + 3]) << 24U);
      return static_cast<std::int32_t>(value);
    };
    const std::int32_t x = has_position ? read_int32(2) : 0;
    const std::int32_t y = has_position ? read_int32(6) : 0;
    std::string input_error;
    if (!InjectMouseClick(request.payload[0], has_position, x, y, input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "input_mouse_wheel") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() || request.payload.size() != 4) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "mouse wheel request is invalid"));
      return true;
    }
    const std::uint32_t value = static_cast<std::uint32_t>(request.payload[0]) |
      (static_cast<std::uint32_t>(request.payload[1]) << 8U) |
      (static_cast<std::uint32_t>(request.payload[2]) << 16U) |
      (static_cast<std::uint32_t>(request.payload[3]) << 24U);
    std::string input_error;
    if (!InjectMouseWheel(static_cast<std::int32_t>(value), input_error)) {
      writer.Send(ErrorFrame(request, "INPUT_UNAVAILABLE", input_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "manifest_check") {
    const std::string function_name(request.payload.begin(), request.payload.end());
    const DllCheckResult result = manifest.Check(
      request.plugin_id, request.dll_id, function_name);
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = Bytes("{\"success\":true}");
    return writer.Send(response);
  }
  if (request.method == "dll_get_info") {
    if (request.plugin_id.empty() || request.dll_id.empty() || !request.payload.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll_get_info request is invalid"));
      return true;
    }
    DllHostResult result = dll_host.GetInfo(request.plugin_id, request.dll_id);
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "dll_call") {
    if (request.plugin_id.empty() || request.dll_id.empty() || request.payload.size() < 3) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll_call request is invalid"));
      return true;
    }
    const std::size_t function_length = static_cast<std::size_t>(request.payload[0]) |
      (static_cast<std::size_t>(request.payload[1]) << 8U);
    if (function_length == 0 || function_length > 128 ||
        2 + function_length >= request.payload.size()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll_call payload is invalid"));
      return true;
    }
    const std::string function_name(
      request.payload.begin() + 2,
      request.payload.begin() + static_cast<std::ptrdiff_t>(2 + function_length));
    const std::vector<std::uint8_t> params_json(
      request.payload.begin() + static_cast<std::ptrdiff_t>(2 + function_length),
      request.payload.end());
    DllHostResult result = dll_host.Call(
      request.plugin_id, request.dll_id, function_name, params_json);
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "dll_call_async" || request.method == "dll_call_with_callback") {
    if (request.plugin_id.empty() || request.dll_id.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll task request identity is invalid"));
      return true;
    }
    std::string task_id;
    std::string function_name;
    std::vector<std::uint8_t> params_json;
    if (!ParseTaskCallPayload(request.payload, task_id, function_name, params_json)) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll task payload is invalid"));
      return true;
    }
    DllHostResult result = request.method == "dll_call_async"
      ? dll_host.CallAsync(
          request.plugin_id, request.dll_id, task_id, function_name, params_json)
      : dll_host.CallWithCallback(
          request.plugin_id, request.dll_id, task_id, function_name, params_json);
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "dll_query_task" || request.method == "dll_cancel_task" ||
      request.method == "dll_clear_task") {
    if (request.plugin_id.empty() || request.dll_id.empty() || request.payload.empty() ||
        request.payload.size() > 128) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll task control request is invalid"));
      return true;
    }
    const std::string task_id(request.payload.begin(), request.payload.end());
    DllHostResult result;
    if (request.method == "dll_query_task") {
      result = dll_host.QueryTask(request.plugin_id, request.dll_id, task_id);
    } else if (request.method == "dll_cancel_task") {
      result = dll_host.CancelTask(request.plugin_id, request.dll_id, task_id);
    } else {
      result = dll_host.ClearTask(request.plugin_id, request.dll_id, task_id);
    }
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "dll_unload") {
    if (request.plugin_id.empty() || request.dll_id.empty() || !request.payload.empty()) {
      writer.Send(ErrorFrame(request, "INVALID_REQUEST", "dll_unload request is invalid"));
      return true;
    }
    DllHostResult result = dll_host.Unload(request.plugin_id, request.dll_id);
    if (!result.success) {
      writer.Send(ErrorFrame(request, result.code, result.message));
      return true;
    }
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }

  writer.Send(ErrorFrame(request, "METHOD_NOT_FOUND", "unsupported native host method"));
  return true;
}

}  // namespace
}  // namespace ztools::native_host

int wmain() {
  using namespace ztools::native_host;
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  ProcessTreeJob process_tree_job;
  const char* failed_job_operation = nullptr;
  DWORD job_error = ERROR_SUCCESS;
  if (!process_tree_job.AttachCurrentProcess(failed_job_operation, job_error)) {
    std::cerr << "NativeHost32 process job setup failed at "
      << (failed_job_operation == nullptr ? "unknown operation" : failed_job_operation)
      << ", Win32 error " << job_error << '\n';
    return 9;
  }
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE ||
      output == nullptr || output == INVALID_HANDLE_VALUE) {
    return 10;
  }
  FrameWriter writer(output);

  std::array<std::uint8_t, kSecretBytes> secret{};
  if (!ReadBootstrapSecret(secret)) {
    SecureErase(secret);
    return 11;
  }

  HostState state = HostState::AwaitHello;
  Frame hello;
  std::string error;
  const ReadStatus hello_status = ReadFrame(input, hello, error);
  if (hello_status != ReadStatus::Ok) {
    SecureErase(secret);
    return hello_status == ReadStatus::EndOfStream ? 0 : 12;
  }

  std::string session_id;
  if (!Authenticate(writer, hello, secret, session_id)) {
    SecureErase(secret);
    return 13;
  }
  SecureErase(secret);
  state = HostState::Ready;

  DllPathConfig manifest_config;
  ReadDllPathConfig(manifest_config);
  const DllResolver manifest(std::move(manifest_config));
  DllHost dll_host(manifest, [&](DllHostEvent event) {
    Frame frame;
    frame.type = FrameType::Event;
    frame.session_id = session_id;
    frame.request_id = event.task_id;
    frame.plugin_id = std::move(event.plugin_id);
    frame.dll_id = std::move(event.dll_id);
    frame.method = std::move(event.method);
    frame.payload = std::move(event.payload);
    if (!writer.Send(frame)) throw std::runtime_error("native host event write failed");
  });
  MouseHook mouse_hook([&](const MouseHookConfig& config) {
    Frame frame;
    frame.type = FrameType::Event;
    frame.session_id = session_id;
    frame.request_id = "mouse_trigger";
    frame.method = "mouse_trigger";
    frame.payload = {
      static_cast<std::uint8_t>(config.button),
      static_cast<std::uint8_t>(config.action),
      static_cast<std::uint8_t>(config.long_press_ms & 0xffU),
      static_cast<std::uint8_t>((config.long_press_ms >> 8U) & 0xffU),
    };
    writer.Send(frame);
  });
  KeyboardHook keyboard_hook([&](KeyboardModifier modifier) {
    Frame frame;
    frame.type = FrameType::Event;
    frame.session_id = session_id;
    frame.request_id = "keyboard_double_tap";
    frame.method = "keyboard_double_tap";
    frame.payload = {static_cast<std::uint8_t>(modifier)};
    writer.Send(frame);
  });

  int exit_code = 0;
  bool shutdown_timed_out = false;
  while (state == HostState::Ready) {
    Frame request;
    error.clear();
    const ReadStatus status = ReadFrame(input, request, error);
    if (status == ReadStatus::EndOfStream) break;
    if (status == ReadStatus::Invalid) {
      std::cerr << error << '\n';
      exit_code = 14;
      break;
    }
    if (!HandleReadyFrame(
          writer, request, session_id, state, manifest, dll_host, mouse_hook,
          keyboard_hook,
          shutdown_timed_out)) {
      exit_code = 15;
      break;
    }
  }

  if (state == HostState::Ready) {
    state = HostState::Stopping;
    mouse_hook.Stop();
    keyboard_hook.Stop();
    const DllHostShutdownResult orphan_shutdown =
      dll_host.Shutdown(kDefaultOrphanShutdownDeadlineMs);
    shutdown_timed_out = orphan_shutdown.timed_out;
  }
  if (shutdown_timed_out) {
    TerminateProcess(GetCurrentProcess(), 18);
    return 18;
  }

  state = HostState::Closed;
  return state == HostState::Closed ? exit_code : 16;
}
