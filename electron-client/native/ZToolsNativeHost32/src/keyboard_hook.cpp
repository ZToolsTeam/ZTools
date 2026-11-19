#include "keyboard_hook.hpp"

#include "input_inject.hpp"

#include <atomic>
#include <utility>

namespace ztools::native_host {
namespace {

constexpr DWORD kHookStartupTimeoutMs = 3'000;
constexpr UINT kTriggerMessage = WM_APP + 2;
constexpr UINT kExternalActivityMessage = WM_APP + 4;
std::atomic<KeyboardHook*> g_active_hook = nullptr;

}  // namespace

KeyboardHook::KeyboardHook(TriggerCallback callback) : callback_(std::move(callback)) {}

KeyboardHook::~KeyboardHook() {
  Stop();
}

void KeyboardHook::SetActivityCallback(ActivityCallback callback) {
  std::lock_guard lock(state_mutex_);
  activity_callback_ = std::move(callback);
}

bool KeyboardHook::Configure(std::uint8_t modifier_mask, std::string& error) {
  return Configure(modifier_mask, true, error);
}

bool KeyboardHook::Configure(
  std::uint8_t modifier_mask,
  bool fullscreen_dnd,
  std::string& error) {
  Stop();
  if (!state_machine_.Configure(modifier_mask)) {
    error = "keyboard modifier mask is invalid";
    return false;
  }

  fullscreen_dnd_ = fullscreen_dnd;
  dnd_throttle_.Reset();
  key_down_bitmap_.fill(false);

  ready_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (ready_event_ == nullptr) {
    error = "keyboard hook readiness event creation failed";
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
      ? "keyboard hook startup timed out"
      : "keyboard hook installation failed (Win32=" + std::to_string(startup_error) + ")";
    return false;
  }
  return true;
}

void KeyboardHook::NotifyExternalActivity() {
  external_activity_seq_.fetch_add(1, std::memory_order_release);
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) {
    PostThreadMessageW(tid, kExternalActivityMessage, 0, 0);
  }
}

void KeyboardHook::Stop() {
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) PostThreadMessageW(tid, WM_QUIT, 0, 0);
  if (thread_.joinable()) thread_.join();
  thread_id_.store(0, std::memory_order_release);
  startup_succeeded_ = false;
  state_machine_.Reset();
  dnd_throttle_.Reset();
  key_down_bitmap_.fill(false);
}

bool KeyboardHook::active() const {
  std::lock_guard lock(state_mutex_);
  return hook_ != nullptr;
}

void KeyboardHook::Run() {
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  thread_id_.store(GetCurrentThreadId(), std::memory_order_release);
  consumed_external_seq_ = external_activity_seq_.load(std::memory_order_acquire);

  KeyboardHook* expected = nullptr;
  if (!g_active_hook.compare_exchange_strong(expected, this)) {
    startup_error_ = ERROR_BUSY;
    if (ready_event_ != nullptr) SetEvent(ready_event_);
    thread_id_.store(0, std::memory_order_release);
    return;
  }

  {
    std::lock_guard lock(state_mutex_);
    hook_ = SetWindowsHookExW(WH_KEYBOARD_LL, HookProc, GetModuleHandleW(nullptr), 0);
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
    if (message.message == kExternalActivityMessage) {
      SyncExternalActivity();
      continue;
    }
    if (message.message == kTriggerMessage) {
      if (callback_) callback_(static_cast<KeyboardModifier>(message.wParam));
      continue;
    }
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  {
    std::lock_guard lock(state_mutex_);
    if (hook_ != nullptr) {
      UnhookWindowsHookEx(hook_);
      hook_ = nullptr;
    }
  }
  thread_id_.store(0, std::memory_order_release);
  state_machine_.Reset();
  key_down_bitmap_.fill(false);
  g_active_hook.store(nullptr);
}

LRESULT CALLBACK KeyboardHook::HookProc(int code, WPARAM message, LPARAM data) {
  KeyboardHook* hook = g_active_hook.load();
  if (code == HC_ACTION && hook != nullptr && data != 0) {
    return hook->HandleKeyboardMessage(message, data);
  }
  return CallNextHookEx(nullptr, code, message, data);
}

void KeyboardHook::SyncExternalActivity() {
  const std::uint64_t latest = external_activity_seq_.load(std::memory_order_acquire);
  if (latest != consumed_external_seq_) {
    consumed_external_seq_ = latest;
    state_machine_.NotifyExternalActivity();
  }
}

LRESULT KeyboardHook::HandleKeyboardMessage(WPARAM message, LPARAM data) {
  const auto& info = *reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
  // 忽略由系统注入或本侧车自身注入的键盘事件，避免模拟组合键触发或破坏双击状态
  if ((info.flags & LLKHF_INJECTED) != 0 ||
      info.dwExtraInfo == static_cast<ULONG_PTR>(kZToolsInjectedExtraInfo)) {
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  const bool is_down = IsKeyDown(message, info);
  const bool is_up = !is_down && IsKeyUp(message, info);
  if (!is_down && !is_up) {
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  // 先在钩子线程消费跨线程投递的鼠标活动通知，防止队列微秒级乱序
  SyncExternalActivity();

  // 对非系统自动重复的新按键按下事件，同步通知鼠标钩子取消未决长按
  if (is_down) {
    bool is_fresh_press = true;
    if (info.vkCode < key_down_bitmap_.size()) {
      is_fresh_press = !key_down_bitmap_[info.vkCode];
      key_down_bitmap_[info.vkCode] = true;
    }
    if (is_fresh_press && activity_callback_) {
      activity_callback_();
    }
  } else if (info.vkCode < key_down_bitmap_.size()) {
    key_down_bitmap_[info.vkCode] = false;
  }

  const std::uint64_t now_ms = GetTickCount64();
  // 仅在目标修饰键首次 KeyDown 开启敲击时按 200ms 节流检测全屏免打扰
  bool fullscreen_dnd_active = false;
  if (is_down && fullscreen_dnd_ &&
      state_machine_.ShouldCheckFullscreenDndOnKeyDown(info.vkCode)) {
    fullscreen_dnd_active = IsFullscreenDndActive(dnd_throttle_, now_ms);
  }

  // 即使未开启鼠标钩子，也通过 O(1) 检测物理鼠标按键按住态屏蔽 Ctrl+鼠标点击误触
  const bool mouse_held =
    ModifierIndexFromVirtualKey(info.vkCode) >= 0 && IsAnyMouseButtonPressed();

  const std::optional<KeyboardModifier> triggered = state_machine_.ProcessKeyEvent(
    info.vkCode,
    is_down,
    now_ms,
    mouse_held,
    fullscreen_dnd_active);
  if (triggered.has_value()) {
    EmitTrigger(*triggered);
  }

  return CallNextHookEx(nullptr, HC_ACTION, message, data);
}

bool KeyboardHook::IsKeyDown(WPARAM message, const KBDLLHOOKSTRUCT& info) {
  return (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) &&
    (info.flags & LLKHF_UP) == 0;
}

bool KeyboardHook::IsKeyUp(WPARAM message, const KBDLLHOOKSTRUCT& info) {
  return (message == WM_KEYUP || message == WM_SYSKEYUP) ||
    (info.flags & LLKHF_UP) != 0;
}

void KeyboardHook::EmitTrigger(KeyboardModifier modifier) {
  const DWORD tid = thread_id_.load(std::memory_order_acquire);
  if (tid != 0) {
    PostThreadMessageW(tid, kTriggerMessage, static_cast<WPARAM>(modifier), 0);
  }
}

}  // namespace ztools::native_host
