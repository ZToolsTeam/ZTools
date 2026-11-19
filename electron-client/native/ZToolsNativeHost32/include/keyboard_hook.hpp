#pragma once

#include "hook_state.hpp"

#include <Windows.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace ztools::native_host {

class KeyboardHook final {
 public:
  using TriggerCallback = std::function<void(KeyboardModifier)>;
  using ActivityCallback = std::function<void()>;

  explicit KeyboardHook(TriggerCallback callback);
  ~KeyboardHook();

  KeyboardHook(const KeyboardHook&) = delete;
  KeyboardHook& operator=(const KeyboardHook&) = delete;

  // 在启动钩子前设置外部键盘按键按下通知回调（用于跨钩子打断未决鼠标长按）
  void SetActivityCallback(ActivityCallback callback);

  // 配置修饰键掩码与全屏免打扰开关
  bool Configure(std::uint8_t modifier_mask, bool fullscreen_dnd, std::string& error);
  bool Configure(std::uint8_t modifier_mask, std::string& error);

  // 跨组件原子通知：外部鼠标按键按压立即打断并重置键盘双击序列
  void NotifyExternalActivity();

  void Stop();
  bool active() const;

 private:
  static LRESULT CALLBACK HookProc(int code, WPARAM message, LPARAM data);
  void Run();
  LRESULT HandleKeyboardMessage(WPARAM message, LPARAM data);
  void SyncExternalActivity();
  static bool IsKeyDown(WPARAM message, const KBDLLHOOKSTRUCT& info);
  static bool IsKeyUp(WPARAM message, const KBDLLHOOKSTRUCT& info);
  void EmitTrigger(KeyboardModifier modifier);

  TriggerCallback callback_;
  ActivityCallback activity_callback_;
  bool fullscreen_dnd_ = true;
  FullscreenDndThrottle dnd_throttle_{};
  KeyboardDoubleTapStateMachine state_machine_{};
  // 仅用于过滤长按系统连发 KeyDown 时向 MouseHook 重复通知的轻量位图
  std::array<bool, 256> key_down_bitmap_{};
  std::thread thread_;
  HANDLE ready_event_ = nullptr;
  std::atomic<DWORD> thread_id_{0};
  HHOOK hook_ = nullptr;
  std::atomic<std::uint64_t> external_activity_seq_{0};
  std::uint64_t consumed_external_seq_ = 0;
  bool startup_succeeded_ = false;
  DWORD startup_error_ = ERROR_SUCCESS;
  mutable std::mutex state_mutex_;
};

}  // namespace ztools::native_host
