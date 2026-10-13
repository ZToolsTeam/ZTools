#include "keyboard_hook.hpp"

#include <atomic>
#include <utility>

namespace ztools::native_host {
namespace {

constexpr DWORD kHookStartupTimeoutMs = 3'000;
constexpr DWORD kDoubleTapIntervalMs = 400;
constexpr UINT kTriggerMessage = WM_APP + 2;
std::atomic<KeyboardHook*> g_active_hook = nullptr;

bool IsModifierConfigured(std::uint8_t modifier_mask, int index) {
  return index >= 0 && index < 3 && (modifier_mask & (1U << index)) != 0;
}

KeyboardModifier ModifierFromIndex(int index) {
  switch (index) {
    case 0:
      return KeyboardModifier::Control;
    case 1:
      return KeyboardModifier::Alt;
    case 2:
      return KeyboardModifier::Shift;
    default:
      return KeyboardModifier::Control;
  }
}

}  // namespace

KeyboardHook::KeyboardHook(TriggerCallback callback) : callback_(std::move(callback)) {}

KeyboardHook::~KeyboardHook() {
  Stop();
}

bool KeyboardHook::Configure(std::uint8_t modifier_mask, std::string& error) {
  Stop();
  if (modifier_mask == 0 || modifier_mask > 0x07U) {
    error = "keyboard modifier mask is invalid";
    return false;
  }

  modifier_mask_ = modifier_mask;
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
    if (thread_id_ != 0) PostThreadMessageW(thread_id_, WM_QUIT, 0, 0);
    if (thread_.joinable()) thread_.join();
    error = wait_result == WAIT_TIMEOUT
      ? "keyboard hook startup timed out"
      : "keyboard hook installation failed (Win32=" + std::to_string(startup_error) + ")";
    return false;
  }
  return true;
}

void KeyboardHook::Stop() {
  const DWORD thread_id = thread_id_;
  if (thread_id != 0) PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
  if (thread_.joinable()) thread_.join();
  thread_id_ = 0;
  startup_succeeded_ = false;
  modifier_mask_ = 0;
}

bool KeyboardHook::active() const {
  std::lock_guard lock(state_mutex_);
  return hook_ != nullptr;
}

void KeyboardHook::Run() {
  MSG message{};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  thread_id_ = GetCurrentThreadId();

  KeyboardHook* expected = nullptr;
  if (!g_active_hook.compare_exchange_strong(expected, this)) {
    startup_error_ = ERROR_BUSY;
    if (ready_event_ != nullptr) SetEvent(ready_event_);
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
    return;
  }

  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
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
  pressed_ = {false, false, false};
  ResetDoubleTap();
  g_active_hook.store(nullptr);
}

LRESULT CALLBACK KeyboardHook::HookProc(int code, WPARAM message, LPARAM data) {
  KeyboardHook* hook = g_active_hook.load();
  if (code == HC_ACTION && hook != nullptr && data != 0) {
    return hook->HandleKeyboardMessage(message, data);
  }
  return CallNextHookEx(nullptr, code, message, data);
}

LRESULT KeyboardHook::HandleKeyboardMessage(WPARAM message, LPARAM data) {
  const auto& info = *reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
  const int index = ModifierIndex(info);
  if (index < 0) {
    if (IsKeyDown(message, info)) ResetDoubleTap();
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }
  if (!IsModifierConfigured(modifier_mask_, index)) {
    return CallNextHookEx(nullptr, HC_ACTION, message, data);
  }

  if (IsKeyDown(message, info)) {
    if (pressed_[static_cast<std::size_t>(index)]) {
      return CallNextHookEx(nullptr, HC_ACTION, message, data);
    }
    pressed_[static_cast<std::size_t>(index)] = true;
    const DWORD now = GetTickCount();
    if (last_modifier_index_ == index &&
        static_cast<DWORD>(now - last_tap_tick_) <= kDoubleTapIntervalMs) {
      ResetDoubleTap();
      EmitTrigger(ModifierFromIndex(index));
    } else {
      last_modifier_index_ = index;
      last_tap_tick_ = now;
    }
  } else if (IsKeyUp(message, info)) {
    pressed_[static_cast<std::size_t>(index)] = false;
  }
  return CallNextHookEx(nullptr, HC_ACTION, message, data);
}

int KeyboardHook::ModifierIndex(const KBDLLHOOKSTRUCT& info) {
  switch (info.vkCode) {
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
      return 0;
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
      return 1;
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
      return 2;
    default:
      return -1;
  }
}

bool KeyboardHook::IsKeyDown(WPARAM message, const KBDLLHOOKSTRUCT& info) {
  return (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) &&
    (info.flags & LLKHF_UP) == 0;
}

bool KeyboardHook::IsKeyUp(WPARAM message, const KBDLLHOOKSTRUCT& info) {
  return (message == WM_KEYUP || message == WM_SYSKEYUP) ||
    (info.flags & LLKHF_UP) != 0;
}

void KeyboardHook::ResetDoubleTap() {
  last_modifier_index_ = -1;
  last_tap_tick_ = 0;
}

void KeyboardHook::EmitTrigger(KeyboardModifier modifier) {
  if (thread_id_ != 0) {
    PostThreadMessageW(thread_id_, kTriggerMessage, static_cast<WPARAM>(modifier), 0);
  }
}

}  // namespace ztools::native_host
