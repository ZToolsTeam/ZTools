#pragma once

#include <Windows.h>

#include <array>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace ztools::native_host {

enum class KeyboardModifier : std::uint8_t {
  Control = 1,
  Alt = 2,
  Shift = 3,
};

class KeyboardHook final {
 public:
  using TriggerCallback = std::function<void(KeyboardModifier)>;

  explicit KeyboardHook(TriggerCallback callback);
  ~KeyboardHook();

  KeyboardHook(const KeyboardHook&) = delete;
  KeyboardHook& operator=(const KeyboardHook&) = delete;

  bool Configure(std::uint8_t modifier_mask, std::string& error);
  void Stop();
  bool active() const;

 private:
  static LRESULT CALLBACK HookProc(int code, WPARAM message, LPARAM data);
  void Run();
  LRESULT HandleKeyboardMessage(WPARAM message, LPARAM data);
  static int ModifierIndex(const KBDLLHOOKSTRUCT& info);
  static bool IsKeyDown(WPARAM message, const KBDLLHOOKSTRUCT& info);
  static bool IsKeyUp(WPARAM message, const KBDLLHOOKSTRUCT& info);
  void ResetDoubleTap();
  void EmitTrigger(KeyboardModifier modifier);

  TriggerCallback callback_;
  std::uint8_t modifier_mask_ = 0;
  std::thread thread_;
  HANDLE ready_event_ = nullptr;
  DWORD thread_id_ = 0;
  HHOOK hook_ = nullptr;
  std::array<bool, 3> pressed_{false, false, false};
  int last_modifier_index_ = -1;
  DWORD last_tap_tick_ = 0;
  bool startup_succeeded_ = false;
  DWORD startup_error_ = ERROR_SUCCESS;
  mutable std::mutex state_mutex_;
};

}  // namespace ztools::native_host
