#pragma once

#include <Windows.h>

#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace ztools::native_host {

enum class MouseButton : std::uint8_t {
  Middle = 1,
  Right = 2,
  Forward = 3,
  Backward = 4,
};

enum class MouseAction : std::uint8_t {
  Press = 1,
  LongPress = 2,
};

struct MouseHookConfig {
  MouseButton button = MouseButton::Middle;
  MouseAction action = MouseAction::LongPress;
  std::uint16_t long_press_ms = 300;
};

class MouseHook final {
 public:
  using TriggerCallback = std::function<void(const MouseHookConfig&)>;

  explicit MouseHook(TriggerCallback callback);
  ~MouseHook();

  MouseHook(const MouseHook&) = delete;
  MouseHook& operator=(const MouseHook&) = delete;

  bool Configure(const MouseHookConfig& config, std::string& error);
  void Stop();
  bool active() const;

 private:
  static LRESULT CALLBACK HookProc(int code, WPARAM message, LPARAM data);
  void Run();
  LRESULT HandleMouseMessage(WPARAM message, LPARAM data);
  bool MatchesButton(WPARAM message, const MSLLHOOKSTRUCT& info) const;
  void CancelLongPressTimer();
  void EmitTrigger();

  TriggerCallback callback_;
  MouseHookConfig config_;
  std::thread thread_;
  HANDLE ready_event_ = nullptr;
  DWORD thread_id_ = 0;
  HHOOK hook_ = nullptr;
  UINT_PTR timer_id_ = 0;
  bool pressed_ = false;
  bool long_press_triggered_ = false;
  bool startup_succeeded_ = false;
  DWORD startup_error_ = ERROR_SUCCESS;
  mutable std::mutex state_mutex_;
};

}  // namespace ztools::native_host
