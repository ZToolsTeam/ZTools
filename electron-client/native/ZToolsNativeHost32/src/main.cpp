#include "dll_host.hpp"
#include "input_inject.hpp"
#include "keyboard_hook.hpp"
#include "dll_resolver.hpp"
#include "mouse_hook.hpp"
#include "protocol.hpp"

#include <Windows.h>
#include <io.h>

#include <array>
#include <condition_variable>
#include <cstdio>
#include <cstdint>
#include <deque>
#include <iostream>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
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

// 协议输出管道隔离守卫：复制专用不可继承写句柄，并将进程默认标准输出与 CRT stdout 解绑重定向
class ProtocolOutputIsolation final {
 public:
  ProtocolOutputIsolation() = default;
  ProtocolOutputIsolation(const ProtocolOutputIsolation&) = delete;
  ProtocolOutputIsolation& operator=(const ProtocolOutputIsolation&) = delete;

  ~ProtocolOutputIsolation() {
    Close();
  }

  bool Initialize(HANDLE raw_output, DWORD& error) noexcept {
    Close();
    if (raw_output == nullptr || raw_output == INVALID_HANDLE_VALUE) {
      error = ERROR_INVALID_HANDLE;
      return false;
    }

    // 复制一份不可继承的专用协议输出句柄，避免子进程或已加载 DLL 获取协议管道写端
    HANDLE duplicated = nullptr;
    if (!DuplicateHandle(
          GetCurrentProcess(),
          raw_output,
          GetCurrentProcess(),
          &duplicated,
          0,
          FALSE,
          DUPLICATE_SAME_ACCESS) ||
        duplicated == nullptr || duplicated == INVALID_HANDLE_VALUE) {
      error = GetLastError();
      return false;
    }
    protocol_output_ = duplicated;

    // 切换前先刷新宿主输出缓冲，并记录宿主 CRT stdout 初始绑定的底层 OS 句柄
    std::fflush(stdout);
    std::cout.flush();
    const int stdout_fd = _fileno(stdout);
    const intptr_t initial_crt_stdout_handle = stdout_fd >= 0 ? _get_osfhandle(stdout_fd) : -1;
    const bool crt_owns_raw_output =
      initial_crt_stdout_handle == reinterpret_cast<intptr_t>(raw_output);

    // 准备安全重定向目标：优先使用独立于协议管道的 STD_ERROR_HANDLE，否则回退到 NUL 设备
    const HANDLE raw_stderr = GetStdHandle(STD_ERROR_HANDLE);
    const bool has_distinct_stderr =
      raw_stderr != nullptr &&
      raw_stderr != INVALID_HANDLE_VALUE &&
      raw_stderr != raw_output;

    HANDLE redirect_handle = INVALID_HANDLE_VALUE;
    bool crt_stdout_rebound = false;

    if (has_distinct_stderr && stdout_fd >= 0) {
      const int stderr_fd = _fileno(stderr);
      const intptr_t crt_stderr_handle = stderr_fd >= 0 ? _get_osfhandle(stderr_fd) : -1;
      if (crt_stderr_handle != -1 && crt_stderr_handle != -2 && _dup2(stderr_fd, stdout_fd) == 0) {
        crt_stdout_rebound = true;
        // 优先使用 _dup2 复制出的独立 stderr 句柄作为 STD_OUTPUT_HANDLE，避免卸载 DLL 时误伤宿主 stderr
        const intptr_t rebound_stdout_handle = _get_osfhandle(stdout_fd);
        if (rebound_stdout_handle != -1 && rebound_stdout_handle != -2) {
          redirect_handle = reinterpret_cast<HANDLE>(rebound_stdout_handle);
        } else {
          redirect_handle = raw_stderr;
        }
      }
    }

    if (!crt_stdout_rebound) {
      FILE* redirected_stream = nullptr;
      if (freopen_s(&redirected_stream, "NUL", "w", stdout) == 0 && redirected_stream != nullptr) {
        crt_stdout_rebound = true;
      }
      if (has_distinct_stderr) {
        redirect_handle = raw_stderr;
      } else {
        nul_handle_ = CreateFileW(
          L"NUL",
          GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          nullptr,
          OPEN_EXISTING,
          FILE_ATTRIBUTE_NORMAL,
          nullptr);
        if (nul_handle_ == nullptr || nul_handle_ == INVALID_HANDLE_VALUE) {
          error = GetLastError();
          nul_handle_ = nullptr;
          Close();
          return false;
        }
        redirect_handle = nul_handle_;
      }
    }

    // 清除 C++ 标准输出流状态标志，避免重定向前后残留异常状态
    std::cout.clear();

    // 显式更新进程 STD_OUTPUT_HANDLE，确保后续 LoadLibrary 加载的任意 /MT 静态 CRT DLL
    // 初始化 _iob[1] 或直接调用 GetStdHandle(STD_OUTPUT_HANDLE) 时均指向安全目标
    if (!SetStdHandle(STD_OUTPUT_HANDLE, redirect_handle)) {
      error = GetLastError();
      Close();
      return false;
    }

    // 仅在 CRT 未通过 _dup2/freopen_s 关闭原 raw_output 时显式关闭，杜绝重复 CloseHandle
    if ((!crt_owns_raw_output || !crt_stdout_rebound) && raw_output != redirect_handle) {
      CloseHandle(raw_output);
    }

    error = ERROR_SUCCESS;
    return true;
  }

  HANDLE Get() const noexcept { return protocol_output_; }

 private:
  void Close() noexcept {
    if (protocol_output_ != nullptr && protocol_output_ != INVALID_HANDLE_VALUE) {
      CloseHandle(protocol_output_);
      protocol_output_ = nullptr;
    }
    if (nul_handle_ != nullptr && nul_handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(nul_handle_);
      nul_handle_ = nullptr;
    }
  }

  HANDLE protocol_output_ = nullptr;
  HANDLE nul_handle_ = nullptr;
};

// 异步事件发送器：用有界队列与独立工作线程解耦低级钩子回调与同步管道 I/O，防止触发 LowLevelHooksTimeout
class AsyncEventSender final {
 public:
  static constexpr std::size_t kDefaultMaxQueuedEvents = 256;

  explicit AsyncEventSender(
    FrameWriter& writer,
    std::size_t max_queue_size = kDefaultMaxQueuedEvents)
      : writer_(writer), max_queue_size_(max_queue_size) {
    worker_ = std::thread([this]() { Run(); });
  }

  ~AsyncEventSender() {
    StopAndDrain();
  }

  AsyncEventSender(const AsyncEventSender&) = delete;
  AsyncEventSender& operator=(const AsyncEventSender&) = delete;

  // 非阻塞入队事件帧；队列已满、正在停止或管道已断开时直接丢弃并返回 false
  bool Enqueue(Frame frame) noexcept {
    try {
      std::lock_guard lock(mutex_);
      if (stopping_ || pipe_broken_ || queue_.size() >= max_queue_size_) {
        return false;
      }
      queue_.push_back(std::move(frame));
      cv_.notify_one();
      return true;
    } catch (...) {
      return false;
    }
  }

  // 优雅停止发送线程：确保排空已入队事件后再 join
  void StopAndDrain() noexcept {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    cv_.notify_all();
    std::lock_guard join_lock(join_mutex_);
    if (worker_.joinable()) {
      worker_.join();
    }
  }

 private:
  void Run() {
    for (;;) {
      Frame frame;
      {
        std::unique_lock lock(mutex_);
        cv_.wait(lock, [this]() { return stopping_ || !queue_.empty(); });
        if (queue_.empty()) {
          if (stopping_) break;
          continue;
        }
        frame = std::move(queue_.front());
        queue_.pop_front();
        if (pipe_broken_) continue;
      }
      if (!writer_.Send(frame)) {
        std::lock_guard lock(mutex_);
        pipe_broken_ = true;
        queue_.clear();
      }
    }
  }

  FrameWriter& writer_;
  std::size_t max_queue_size_;
  std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable cv_;
  std::deque<Frame> queue_;
  bool stopping_ = false;
  bool pipe_broken_ = false;
  std::thread worker_;
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
  AsyncEventSender& event_sender,
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
    event_sender.StopAndDrain();
    DllHostShutdownResult result = dll_host.Shutdown(deadline_ms);
    shutdown_timed_out = result.timed_out;
    response.payload = std::move(result.payload);
    return writer.Send(response);
  }
  if (request.method == "mouse_hook_configure") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() ||
        (request.payload.size() != 5 && request.payload.size() != 6)) {
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
    // 5 字节旧协议默认开启全屏免打扰，6 字节时取第 6 字节 bit 0
    const bool fullscreen_dnd = request.payload.size() == 5
      ? true
      : (request.payload[5] & 0x01U) != 0;
    const MouseHookConfig config{button, action, threshold, fullscreen_dnd};
    if (!IsValidMouseHookConfig(config)) {
      writer.Send(ErrorFrame(
        request,
        "INVALID_REQUEST",
        (button == MouseButton::Right && action == MouseAction::Press)
          ? "right mouse button does not support press action"
          : "mouse hook configuration is invalid"));
      return true;
    }
    std::string mouse_error;
    if (!mouse_hook.Configure(config, mouse_error)) {
      writer.Send(ErrorFrame(request, "MOUSE_HOOK_UNAVAILABLE", mouse_error));
      return true;
    }
    response.payload = Bytes("{\"success\":true,\"enabled\":true}");
    return writer.Send(response);
  }
  if (request.method == "keyboard_hook_configure") {
    if (!request.plugin_id.empty() || !request.dll_id.empty() ||
        (request.payload.size() != 1 && request.payload.size() != 2)) {
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
    // 1 字节旧协议默认开启全屏免打扰，2 字节时取第 2 字节 bit 0
    const bool fullscreen_dnd = request.payload.size() == 1
      ? true
      : (request.payload[1] & 0x01U) != 0;
    std::string keyboard_error;
    if (!keyboard_hook.Configure(modifier_mask, fullscreen_dnd, keyboard_error)) {
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
  const HANDLE raw_output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE ||
      raw_output == nullptr || raw_output == INVALID_HANDLE_VALUE) {
    return 10;
  }
  // 隔离协议输出管道并先于 FrameWriter/AsyncEventSender 声明，确保全部写操作完成后再关闭句柄
  ProtocolOutputIsolation protocol_output;
  DWORD isolation_error = ERROR_SUCCESS;
  if (!protocol_output.Initialize(raw_output, isolation_error)) {
    std::cerr << "NativeHost32 stdout protocol isolation failed, Win32 error "
      << isolation_error << '\n';
    return 10;
  }
  FrameWriter writer(protocol_output.Get());
  AsyncEventSender event_sender(writer);

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
    // 钩子事件仅做非阻塞异步入队，避免写管道阻塞消息循环
    event_sender.Enqueue(std::move(frame));
  });
  KeyboardHook keyboard_hook([&](KeyboardModifier modifier) {
    Frame frame;
    frame.type = FrameType::Event;
    frame.session_id = session_id;
    frame.request_id = "keyboard_double_tap";
    frame.method = "keyboard_double_tap";
    frame.payload = {static_cast<std::uint8_t>(modifier)};
    // 钩子事件仅做非阻塞异步入队，避免写管道阻塞消息循环
    event_sender.Enqueue(std::move(frame));
  });
  // 双向绑定跨组件活动打断通知，并由 RAII 守卫确保线程先于回调对象安全退出
  mouse_hook.SetActivityCallback([&]() { keyboard_hook.NotifyExternalActivity(); });
  keyboard_hook.SetActivityCallback([&]() { mouse_hook.NotifyExternalActivity(); });
  struct HookLifecycleGuard {
    MouseHook& mouse_hook_ref;
    KeyboardHook& keyboard_hook_ref;
    AsyncEventSender& event_sender_ref;
    ~HookLifecycleGuard() {
      mouse_hook_ref.Stop();
      keyboard_hook_ref.Stop();
      event_sender_ref.StopAndDrain();
    }
  } hook_lifecycle_guard{mouse_hook, keyboard_hook, event_sender};

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
          writer, event_sender, request, session_id, state, manifest, dll_host,
          mouse_hook, keyboard_hook, shutdown_timed_out)) {
      exit_code = 15;
      break;
    }
  }

  if (state == HostState::Ready) {
    state = HostState::Stopping;
    mouse_hook.Stop();
    keyboard_hook.Stop();
    event_sender.StopAndDrain();
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
