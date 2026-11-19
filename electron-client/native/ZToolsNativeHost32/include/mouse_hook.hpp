#pragma once

#include "hook_state.hpp"

#include <Windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace ztools::native_host {

class MouseHook final {
 public:
  using TriggerCallback = std::function<void(const MouseHookConfig&)>;
  using ActivityCallback = std::function<void()>;

  explicit MouseHook(TriggerCallback callback);
  ~MouseHook();

  MouseHook(const MouseHook&) = delete;
  MouseHook& operator=(const MouseHook&) = delete;

  // 在启动钩子前设置任意真实鼠标按下通知回调（用于打断键盘双击修饰键）
  void SetActivityCallback(ActivityCallback callback);

  // 配置鼠标钩子参数；Right + Press 将直接被拒绝
  bool Configure(const MouseHookConfig& config, std::string& error);

  // 跨组件原子通知：外部键盘按下打断并取消未决的长按/拦截状态
  void NotifyExternalActivity();

  void Stop();
  bool active() const;

 private:
  static LRESULT CALLBACK HookProc(int code, WPARAM message, LPARAM data);
  void Run();
  LRESULT HandleMouseMessage(WPARAM message, LPARAM data);
  void SyncExternalActivity();
  void ApplyDecision(const MouseEventDecision& decision);
  bool MatchesButton(WPARAM message, const MSLLHOOKSTRUCT& info) const;
  void CancelLongPressTimer();
  void EmitTrigger();

  TriggerCallback callback_;
  ActivityCallback activity_callback_;
  FullscreenDndThrottle dnd_throttle_{};
  MouseHookStateMachine state_machine_{};
  std::thread thread_;
  HANDLE ready_event_ = nullptr;
  std::atomic<DWORD> thread_id_{0};
  HHOOK hook_ = nullptr;
  UINT_PTR timer_id_ = 0;
  std::atomic<std::uint64_t> external_activity_seq_{0};
  std::uint64_t consumed_external_seq_ = 0;
  bool startup_succeeded_ = false;
  DWORD startup_error_ = ERROR_SUCCESS;
  mutable std::mutex state_mutex_;
};

}  // namespace ztools::native_host
