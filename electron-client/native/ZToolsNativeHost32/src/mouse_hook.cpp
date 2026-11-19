#include "mouse_hook.hpp"

#include "input_inject.hpp"

#include <atomic>
#include <utility>

namespace ztools::native_host {
namespace {

constexpr UINT_PTR kLongPressTimerId = 1;
constexpr DWORD kHookStartupTimeoutMs = 3'000;
constexpr UINT kTriggerMessage = WM_APP + 1;
constexpr UINT kExternalActivityMessage = WM_APP + 3;
std::atomic<MouseHook*> g_active_hook = nullptr;

bool IsButtonMessage(WPARAM message, UINT down, UINT up) {
  return message == down || message == up;
}

bool IsMatchedButtonDown(WPARAM message) {
  return message == WM_MBUTTONDOWN || message == WM_RBUTTONDOWN ||
    message == WM_XBUTTONDOWN;
}

bool IsMatchedButtonUp(WPARAM message) {
  return message == WM_MBUTTONUP || message == WM_RBUTTONUP ||
    message == WM_XBUTTONUP;
}

bool IsAnyMouseButtonDownMessage(WPARAM message) {
  return message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN ||
    message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN;
}

}  // namespace

MouseHook::MouseHook(TriggerCallback callback) : callback_(std::move(callback)) {}

MouseHook::~MouseHook() {
  Stop();
}

void MouseHook::SetActivityCallback(ActivityCallback callback) {
  std::lock_guard lock(state_mutex_);
  activity_callback_ = std::move(callback);
}

bool MouseHook::Configure(const MouseHookConfig& config, std::string& error) {
  Stop();
  if (config.button == MouseButton::Right && config.action == MouseAction::Press) {
    error = "right mouse button does not support press action";
    return false;
  }
  if (!state_machine_.Configure(config)) {
    error = "mouse hook configuration is invalid";
    return false;
  }

  dnd_throttle_.Reset();
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
    const DWORD tid = thread_id_.load(std::memory_order_acquire);
    if (tid != 0) PostThreadMessageW(tid, WM_QUIT, 0, 0);
    if (thread_.joinable()) thread_.join();
    thread_id_.store(0, std::memory_order_release);
    error = wait_result == WAIT_TIMEOUT
      ? "mouse hook startup timed out"
      : "mouse hook installation failed (Win32=" + std::to_string(startup_error) + ")";
    return false;
  }
  return true;
}

void MouseHook::NotifyExternalActivity() {
  external_activity_seq_.fetch_add(1, std::memory_order_release);
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) {
    PostThreadMessageW(tid, kExternalActivityMessage, 0, 0);
  }
}

void MouseHook::Stop() {
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) PostThreadMessageW(tid, WM_QUIT, 0, 0);
  if (thread_.joinable()) thread_.join();
  thread_id_.store(0, std::memory_order_release);
  startup_succeeded_ = false;
  state_machine_.Reset();
  dnd_throttle_.Reset();
}

bool MouseHook::active() const {
  std::lock_guard lock(state_mutex_);
  return hook_ != nullptr;
}

void MouseHook::Run() {
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  thread_id_.store(GetCurrentThreadId(), std::memory_order_release);
  consumed_external_seq_ = external_activity_seq_.load(std::memory_order_acquire);

  MouseHook* expected = nullptr;
  if (!g_active_hook.compare_exchange_strong(expected, this)) {
    startup_error_ = ERROR_BUSY;
    if (ready_event_ != nullptr) SetEvent(ready_event_);
    thread_id_.store(0, std::memory_order_release);
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
    thread_id_.store(0, std::memory_order_release);
    return;
  }

  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER && message.hwnd == nullptr &&
        timer_id_ != 0 && message.wParam == timer_id_) {
      CancelLongPressTimer();
      SyncExternalActivity();
      ApplyDecision(state_machine_.OnLongPressTimerFired());
      continue;
    }
    if (message.message == kExternalActivityMessage) {
      SyncExternalActivity();
      continue;
    }
    if (message.message == kTriggerMessage) {
      if (callback_) callback_(state_machine_.config());
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
  thread_id_.store(0, std::memory_order_release);
  state_machine_.Reset();
  g_active_hook.store(nullptr);
}

LRESULT CALLBACK MouseHook::HookProc(int code, WPARAM message, LPARAM data) {
  MouseHook* hook = g_active_hook.load();
  if (code == HC_ACTION && hook != nullptr && data != 0) {
    return hook->HandleMouseMessage(message, data);
  }
  return CallNextHookEx(nullptr, code, message, data);
}

void MouseHook::SyncExternalActivity() {
  const std::uint64_t latest = external_activity_seq_.load(std::memory_order_acquire);
  if (latest != consumed_external_seq_) {
    consumed_external_seq_ = latest;
    ApplyDecision(state_machine_.OnExternalInterrupt());
  }
}

void MouseHook::ApplyDecision(const MouseEventDecision& decision) {
  if (decision.cancel_timer) {
    CancelLongPressTimer();
  }
  if (decision.replay_down) {
    ReplayMouseButtonDown(state_machine_.config().button);
  }
  if (decision.replay_down_up) {
    ReplayMouseButtonClick(state_machine_.config().button);
  }
  if (decision.start_timer) {
    CancelLongPressTimer();
    timer_id_ = SetTimer(
      nullptr,
      kLongPressTimerId,
      state_machine_.config().long_press_ms,
      nullptr);
  }
  if (decision.emit_trigger) {
    EmitTrigger();
  }
}

LRESULT MouseHook::HandleMouseMessage(WPARAM message, LPARAM data) {
  const auto& info = *reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
  // 忽略由系统注入或本侧车自身补发的鼠标事件，防止自回放陷入死循环
  if ((info.flags & LLMHF_INJECTED) != 0 ||
      info.dwExtraInfo == static_cast<ULONG_PTR>(kZToolsInjectedExtraInfo)) {
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  // 先在钩子线程同步跨组件外部活动通知（如键盘敲击）
  SyncExternalActivity();

  // 任意真实鼠标按键按下时联动通知键盘钩子重置双击序列
  const bool any_button_down = IsAnyMouseButtonDownMessage(message);
  if (any_button_down && activity_callback_) {
    activity_callback_();
  }

  if (!MatchesButton(message, info)) {
    if (message == WM_MOUSEMOVE && state_machine_.is_pending()) {
      const int cx_drag = GetSystemMetrics(SM_CXDRAG);
      const int cy_drag = GetSystemMetrics(SM_CYDRAG);
      ApplyDecision(state_machine_.OnMouseMove(info.pt.x, info.pt.y, cx_drag, cy_drag));
    } else if (any_button_down && state_machine_.is_pending()) {
      // 未决期间按下了其他鼠标按键：取消未决触发并立即补发 Down 进入直通态
      ApplyDecision(state_machine_.OnExternalInterrupt());
    }
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  MouseEventDecision decision{};
  if (IsMatchedButtonDown(message)) {
    bool fullscreen_dnd_active = false;
    if (state_machine_.state() == MouseHookStateMachine::PendingState::Idle &&
        state_machine_.config().fullscreen_dnd) {
      fullscreen_dnd_active = IsFullscreenDndActive(dnd_throttle_, GetTickCount64());
    }
    decision = state_machine_.OnTargetButtonDown(
      info.pt.x,
      info.pt.y,
      fullscreen_dnd_active);
  } else if (IsMatchedButtonUp(message)) {
    decision = state_machine_.OnTargetButtonUp();
  }

  ApplyDecision(decision);
  if (decision.suppress_original) {
    return 1;
  }
  return CallNextHookEx(nullptr, HC_ACTION, message, data);
}

bool MouseHook::MatchesButton(WPARAM message, const MSLLHOOKSTRUCT& info) const {
  switch (state_machine_.config().button) {
    case MouseButton::Middle:
      return IsButtonMessage(message, WM_MBUTTONDOWN, WM_MBUTTONUP);
    case MouseButton::Right:
      return IsButtonMessage(message, WM_RBUTTONDOWN, WM_RBUTTONUP);
    case MouseButton::Forward:
      // Win32 XBUTTON2 对应鼠标前进键，XBUTTON1 对应鼠标后退键
      return IsButtonMessage(message, WM_XBUTTONDOWN, WM_XBUTTONUP) &&
        HIWORD(info.mouseData) == XBUTTON2;
    case MouseButton::Backward:
      return IsButtonMessage(message, WM_XBUTTONDOWN, WM_XBUTTONUP) &&
        HIWORD(info.mouseData) == XBUTTON1;
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
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) PostThreadMessageW(tid, kTriggerMessage, 0, 0);
}

}  // namespace ztools::native_host
