#include "mouse_hook.hpp"

#include <atomic>
#include <utility>

namespace ztools::native_host {
namespace {

constexpr UINT_PTR kLongPressTimerId = 1;
constexpr DWORD kHookStartupTimeoutMs = 3'000;
constexpr UINT kTriggerMessage = WM_APP + 1;
std::atomic<MouseHook*> g_active_hook = nullptr;

bool IsButtonMessage(WPARAM message, UINT down, UINT up) {
  return message == down || message == up;
}

bool IsButtonDown(WPARAM message) {
  return message == WM_MBUTTONDOWN || message == WM_RBUTTONDOWN ||
    message == WM_XBUTTONDOWN;
}

bool IsButtonUp(WPARAM message) {
  return message == WM_MBUTTONUP || message == WM_RBUTTONUP ||
    message == WM_XBUTTONUP;
}

}  // namespace

MouseHook::MouseHook(TriggerCallback callback) : callback_(std::move(callback)) {}

MouseHook::~MouseHook() {
  Stop();
}

bool MouseHook::Configure(const MouseHookConfig& config, std::string& error) {
  Stop();
  if (config.long_press_ms < 200 || config.long_press_ms > 500) {
    error = "mouse long-press threshold is invalid";
    return false;
  }

  config_ = config;
  ready_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (ready_event_ == nullptr) {
    error = "mouse hook readiness event creation failed";
    return false;
  }
  startup_succeeded_ = false;
  startup_error_ = ERROR_SUCCESS;
  thread_ = std::thread([this]() { Run(); });

  const DWORD wait_result = WaitForSingleObject(ready_event_, kHookStartupTimeoutMs);
  CloseHandle(ready_event_);
  ready_event_ = nullptr;
  if (wait_result != WAIT_OBJECT_0 || !startup_succeeded_) {
    const DWORD startup_error = startup_error_;
    if (thread_id_ != 0) PostThreadMessageW(thread_id_, WM_QUIT, 0, 0);
    if (thread_.joinable()) thread_.join();
    error = wait_result == WAIT_TIMEOUT
      ? "mouse hook startup timed out"
      : "mouse hook installation failed (Win32=" + std::to_string(startup_error) + ")";
    return false;
  }
  return true;
}

void MouseHook::Stop() {
  const DWORD thread_id = thread_id_;
  if (thread_id != 0) PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
  if (thread_.joinable()) thread_.join();
  thread_id_ = 0;
  startup_succeeded_ = false;
}

bool MouseHook::active() const {
  std::lock_guard lock(state_mutex_);
  return hook_ != nullptr;
}

void MouseHook::Run() {
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  thread_id_ = GetCurrentThreadId();

  MouseHook* expected = nullptr;
  if (!g_active_hook.compare_exchange_strong(expected, this)) {
    startup_error_ = ERROR_BUSY;
    if (ready_event_ != nullptr) SetEvent(ready_event_);
    return;
  }

  {
    std::lock_guard lock(state_mutex_);
    hook_ = SetWindowsHookExW(WH_MOUSE_LL, HookProc, GetModuleHandleW(nullptr), 0);
    startup_succeeded_ = hook_ != nullptr;
    if (!startup_succeeded_) startup_error_ = GetLastError();
  }
  if (ready_event_ != nullptr) SetEvent(ready_event_);
  if (!startup_succeeded_) {
    g_active_hook.store(nullptr);
    return;
  }

  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER && message.wParam == timer_id_) {
      CancelLongPressTimer();
      if (pressed_ && config_.action == MouseAction::LongPress && !long_press_triggered_) {
        long_press_triggered_ = true;
        EmitTrigger();
      }
      continue;
    }
    if (message.message == kTriggerMessage) {
      if (callback_) callback_(config_);
      continue;
    }
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  CancelLongPressTimer();
  {
    std::lock_guard lock(state_mutex_);
    if (hook_ != nullptr) {
      UnhookWindowsHookEx(hook_);
      hook_ = nullptr;
    }
  }
  pressed_ = false;
  long_press_triggered_ = false;
  g_active_hook.store(nullptr);
}

LRESULT CALLBACK MouseHook::HookProc(int code, WPARAM message, LPARAM data) {
  MouseHook* hook = g_active_hook.load();
  if (code == HC_ACTION && hook != nullptr && data != 0) {
    return hook->HandleMouseMessage(message, data);
  }
  return CallNextHookEx(nullptr, code, message, data);
}

LRESULT MouseHook::HandleMouseMessage(WPARAM message, LPARAM data) {
  const auto& info = *reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
  if (!MatchesButton(message, info)) {
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  if (IsButtonDown(message) && !pressed_) {
    pressed_ = true;
    long_press_triggered_ = false;
    if (config_.action == MouseAction::LongPress) {
      timer_id_ = SetTimer(nullptr, kLongPressTimerId, config_.long_press_ms, nullptr);
    }
  } else if (IsButtonUp(message) && pressed_) {
    CancelLongPressTimer();
    if (config_.action == MouseAction::Press && !long_press_triggered_) EmitTrigger();
    pressed_ = false;
    long_press_triggered_ = false;
  }
  return CallNextHookEx(nullptr, HC_ACTION, message, data);
}

bool MouseHook::MatchesButton(WPARAM message, const MSLLHOOKSTRUCT& info) const {
  switch (config_.button) {
    case MouseButton::Middle:
      return IsButtonMessage(message, WM_MBUTTONDOWN, WM_MBUTTONUP);
    case MouseButton::Right:
      return IsButtonMessage(message, WM_RBUTTONDOWN, WM_RBUTTONUP);
    case MouseButton::Forward:
      return IsButtonMessage(message, WM_XBUTTONDOWN, WM_XBUTTONUP) &&
        HIWORD(info.mouseData) == XBUTTON1;
    case MouseButton::Backward:
      return IsButtonMessage(message, WM_XBUTTONDOWN, WM_XBUTTONUP) &&
        HIWORD(info.mouseData) == XBUTTON2;
    default:
      return false;
  }
}

void MouseHook::CancelLongPressTimer() {
  if (timer_id_ == 0) return;
  KillTimer(nullptr, timer_id_);
  timer_id_ = 0;
}

void MouseHook::EmitTrigger() {
  if (thread_id_ != 0) PostThreadMessageW(thread_id_, kTriggerMessage, 0, 0);
}

}  // namespace ztools::native_host
