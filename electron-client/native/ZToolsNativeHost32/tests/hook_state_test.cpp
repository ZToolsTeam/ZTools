#include "hook_state.hpp"

#include <cstdlib>
#include <iostream>
#include <limits>
#include <optional>

namespace {

using ztools::native_host::AbsCoordDiff;
using ztools::native_host::FullscreenDndThrottle;
using ztools::native_host::IsModifierConfigured;
using ztools::native_host::IsValidMouseHookConfig;
using ztools::native_host::KeyboardDoubleTapStateMachine;
using ztools::native_host::KeyboardModifier;
using ztools::native_host::ModifierIndexFromVirtualKey;
using ztools::native_host::MouseAction;
using ztools::native_host::MouseButton;
using ztools::native_host::MouseEventDecision;
using ztools::native_host::MouseHookConfig;
using ztools::native_host::MouseHookStateMachine;

constexpr std::uint32_t kVkShift = 0x10U;
constexpr std::uint32_t kVkControl = 0x11U;
constexpr std::uint32_t kVkMenu = 0x12U;
constexpr std::uint32_t kVkLShift = 0xA0U;
constexpr std::uint32_t kVkRShift = 0xA1U;
constexpr std::uint32_t kVkLControl = 0xA2U;
constexpr std::uint32_t kVkRControl = 0xA3U;
constexpr std::uint32_t kVkLMenu = 0xA4U;
constexpr std::uint32_t kVkRMenu = 0xA5U;
constexpr std::uint32_t kVkKeyA = 0x41U;
constexpr std::uint32_t kVkKeyC = 0x43U;

void Check(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "Assertion failed: " << message << '\n';
    std::abort();
  }
}

void TestVirtualKeyMappings() {
  Check(ModifierIndexFromVirtualKey(kVkControl) == 0, "VK_CONTROL 应映射到 0");
  Check(ModifierIndexFromVirtualKey(kVkLControl) == 0, "VK_LCONTROL 应映射到 0");
  Check(ModifierIndexFromVirtualKey(kVkRControl) == 0, "VK_RCONTROL 应映射到 0");
  Check(ModifierIndexFromVirtualKey(kVkMenu) == 1, "VK_MENU 应映射到 1");
  Check(ModifierIndexFromVirtualKey(kVkLMenu) == 1, "VK_LMENU 应映射到 1");
  Check(ModifierIndexFromVirtualKey(kVkRMenu) == 1, "VK_RMENU 应映射到 1");
  Check(ModifierIndexFromVirtualKey(kVkShift) == 2, "VK_SHIFT 应映射到 2");
  Check(ModifierIndexFromVirtualKey(kVkLShift) == 2, "VK_LSHIFT 应映射到 2");
  Check(ModifierIndexFromVirtualKey(kVkRShift) == 2, "VK_RSHIFT 应映射到 2");
  Check(ModifierIndexFromVirtualKey(kVkKeyA) == -1, "字母键应返回 -1");
  Check(IsModifierConfigured(0x01U, 0), "掩码 0x01 应启用 Control");
  Check(!IsModifierConfigured(0x01U, 1), "掩码 0x01 不应启用 Alt");
  Check(!IsModifierConfigured(0x07U, -1), "索引 -1 不应命中");
  Check(!IsModifierConfigured(0x07U, 3), "越界索引 3 不应命中");
}

void TestKeyboardDoubleTapBasicAndSecondKeyUpTrigger() {
  KeyboardDoubleTapStateMachine sm;
  Check(!sm.Configure(0x00U), "空掩码应配置失败");
  Check(!sm.Configure(0x08U), "越界掩码应配置失败");
  Check(sm.Configure(0x01U), "仅 DoubleCtrl 配置应成功");

  // 第一次按下/松开：不得触发
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1000, false, false).has_value(), "首次按下不触发");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 1080, false, false).has_value(), "首次松开不触发");

  // 第二次按下（仍在间隔内）：按新状态机必须在第二次 KeyUp 才触发，KeyDown 绝不能提前触发
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1200, false, false).has_value(), "第二次 KeyDown 不得提前触发");
  const auto result = sm.ProcessKeyEvent(kVkLControl, false, 1280, false, false);
  Check(result.has_value() && *result == KeyboardModifier::Control, "第二次 KeyUp 应确认触发 Control");

  // 触发后继续连按第 3 下不得触发，只能开启新一轮 Tap1
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1340, false, false).has_value(), "第三下按下不触发");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 1390, false, false).has_value(), "第三下松开只作为新一轮 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1460, false, false).has_value(), "第四下按下不触发");
  const auto result2 = sm.ProcessKeyEvent(kVkLControl, false, 1510, false, false);
  Check(result2.has_value() && *result2 == KeyboardModifier::Control, "第四下松开应再次触发");
}

void TestKeyboardTimingBoundariesAndTickWrap() {
  KeyboardDoubleTapStateMachine sm;
  Check(sm.Configure(0x02U), "配置 DoubleAlt");

  // 边界值 1：单次按住刚好 300ms 有效，301ms 无效
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 1000, false, false).has_value(), "Tap1 down");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, 1300, false, false).has_value(), "Tap1 刚好 300ms");
  Check(sm.last_tap_index() == 1, "300ms 应记为有效 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 1700, false, false).has_value(), "间隔刚好 400ms");
  const auto exact_boundary = sm.ProcessKeyEvent(kVkLMenu, false, 2000, false, false);
  Check(exact_boundary.has_value() && *exact_boundary == KeyboardModifier::Alt,
    "单次 300ms 且间隔 400ms 边界应成功触发");

  // 边界值 2：首次按住 301ms 超时 -> 不得记为 Tap1
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 3000, false, false).has_value(), "超时 Tap down");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, 3301, false, false).has_value(), "301ms 释放");
  Check(sm.last_tap_index() == -1, "301ms 按压不应记为有效 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 3350, false, false).has_value(), "下一击 down");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, 3400, false, false).has_value(), "下一击仅算新的 Tap1");

  // 边界值 3：两次 Tap 间隔 401ms 超时 -> 第二击重置为新 Tap1，第三击才能触发
  sm.Reset();
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 4000, false, false).has_value(), "Tap1 down");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, 4050, false, false).has_value(), "Tap1 up");
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 4451, false, false).has_value(), "间隔 401ms down");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, 4500, false, false).has_value(), "间隔 401ms 不得触发");
  Check(sm.last_tap_index() == 1, "超时后的第二击应刷新为新的 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, 4600, false, false).has_value(), "第三击 down");
  const auto re_triggered = sm.ProcessKeyEvent(kVkLMenu, false, 4650, false, false);
  Check(re_triggered.has_value() && *re_triggered == KeyboardModifier::Alt, "刷新 Tap1 后的下一击应触发");

  // 边界值 4：跨越 32 位 49.7 天上限的 64 位时间戳
  sm.Reset();
  const std::uint64_t wrap_base = 0xFFFFFFFFULL - 20ULL;
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, wrap_base, false, false).has_value(), "跨32位边界 down1");
  Check(!sm.ProcessKeyEvent(kVkLMenu, false, wrap_base + 50ULL, false, false).has_value(), "跨32位边界 up1");
  Check(!sm.ProcessKeyEvent(kVkLMenu, true, wrap_base + 200ULL, false, false).has_value(), "跨32位边界 down2");
  const auto wrap_trigger = sm.ProcessKeyEvent(kVkLMenu, false, wrap_base + 260ULL, false, false);
  Check(wrap_trigger.has_value() && *wrap_trigger == KeyboardModifier::Alt, "64 位时间戳跨 32 位边界应稳定触发");
}

void TestKeyboardAutoRepeatAndInterruptions() {
  KeyboardDoubleTapStateMachine sm;
  Check(sm.Configure(0x01U), "仅配置 DoubleCtrl");

  // OS 长按重复按键：总时长 250ms <= 300ms 应有效
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1000, false, false).has_value(), "down");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1100, false, false).has_value(), "repeat1");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1200, false, false).has_value(), "repeat2");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 1250, false, false).has_value(), "up");
  Check(sm.last_tap_index() == 0, "不超过 300ms 的 repeat 应记为有效 Tap1");

  // 未配置的修饰键打断（Ctrl -> Shift -> Ctrl）
  Check(!sm.ProcessKeyEvent(kVkLShift, true, 1300, false, false).has_value(), "按未配置的 Shift");
  Check(sm.last_tap_index() == -1, "未配置的 Shift 必须立即打断重置双击序列");
  Check(!sm.ProcessKeyEvent(kVkLShift, false, 1340, false, false).has_value(), "松开 Shift");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 1380, false, false).has_value(), "Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 1420, false, false).has_value(), "被打断后不得触发");

  // 字母键打断与组合键污染（Ctrl + C 后立即单按 Ctrl）
  sm.Reset();
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 2000, false, false).has_value(), "Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkKeyC, true, 2040, false, false).has_value(), "按下 C 键污染当前按压");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 2060, false, false).has_value(), "污染后的 Ctrl repeat 也不应复活");
  Check(!sm.ProcessKeyEvent(kVkKeyC, false, 2080, false, false).has_value(), "松开 C 键");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 2100, false, false).has_value(), "松开污染的 Ctrl");
  Check(sm.last_tap_index() == -1, "Ctrl+C 不得算作有效 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 2160, false, false).has_value(), "随后单按 Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 2210, false, false).has_value(), "Ctrl+C 后再单按 Ctrl 不得误触");

  // 跨组件鼠标点击打断（Ctrl -> 鼠标点击 -> Ctrl 及 Ctrl+左键多选）
  sm.Reset();
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 3000, false, false).has_value(), "Tap1 down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 3040, false, false).has_value(), "Tap1 up");
  Check(sm.last_tap_index() == 0, "记下 Tap1");
  sm.NotifyExternalActivity();
  Check(sm.last_tap_index() == -1, "鼠标点击通知必须立即重置 Tap1");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 3120, false, false).has_value(), "再次 Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 3160, false, false).has_value(), "鼠标点击后不得触发");

  // 按住 Ctrl 期间发生鼠标按住或跨组件通知
  sm.Reset();
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 4000, false, false).has_value(), "Ctrl down");
  sm.NotifyExternalActivity();
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 4050, false, false).has_value(), "Ctrl up");
  Check(sm.last_tap_index() == -1, "按住期间收到鼠标通知应污染本次 Tap");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 4120, true, false).has_value(), "按下时鼠标正按住");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 4160, false, false).has_value(), "按下时鼠标正按住不应形成 Tap");
  Check(sm.last_tap_index() == -1, "鼠标按住态下不得形成 Tap");

  // 多修饰键交叉按压不得触发，且按住 Ctrl 时按 Shift（同按组合）不得形成独立 Tap
  Check(sm.Configure(0x05U), "配置 DoubleCtrl | DoubleShift");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 5000, false, false).has_value(), "Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 5040, false, false).has_value(), "Ctrl up");
  Check(!sm.ProcessKeyEvent(kVkLShift, true, 5100, false, false).has_value(), "Shift down");
  Check(!sm.ProcessKeyEvent(kVkLShift, false, 5140, false, false).has_value(), "Shift up");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 5200, false, false).has_value(), "Ctrl down");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 5240, false, false).has_value(), "Ctrl->Shift->Ctrl 不得触发");

  // 全屏免打扰开启时禁止触发
  sm.Reset();
  Check(sm.ShouldCheckFullscreenDndOnKeyDown(kVkLControl), "新敲击应当探测全屏 DND");
  Check(!sm.ProcessKeyEvent(kVkLControl, true, 6000, false, true).has_value(), "DND 激活 down");
  Check(!sm.ShouldCheckFullscreenDndOnKeyDown(kVkLControl), "按住 repeat 不再探测全屏 DND");
  Check(!sm.ProcessKeyEvent(kVkLControl, false, 6050, false, false).has_value(), "DND 期间按下的按键松开不得计 Tap");
  Check(sm.last_tap_index() == -1, "DND 期间不记录 Tap");
}

void TestMouseConfigValidationAndRightPressRejection() {
  MouseHookStateMachine sm;

  // 安全禁区：Right + Press 必须被彻底拒绝
  Check(!IsValidMouseHookConfig({MouseButton::Right, MouseAction::Press, 300, true}),
    "Right + Press 必须非法");
  Check(!sm.Configure({MouseButton::Right, MouseAction::Press, 300, true}),
    "状态机 Configure 必须拒绝 Right + Press");

  // 边界与数值 0 校验
  Check(!IsValidMouseHookConfig({MouseButton::Middle, MouseAction::LongPress, 0, true}),
    "阈值 0 必须非法");
  Check(!IsValidMouseHookConfig({MouseButton::Middle, MouseAction::LongPress, 199, true}),
    "阈值 199 必须非法");
  Check(!IsValidMouseHookConfig({MouseButton::Middle, MouseAction::LongPress, 501, true}),
    "阈值 501 必须非法");
  Check(IsValidMouseHookConfig({MouseButton::Middle, MouseAction::LongPress, 200, true}),
    "阈值 200 合法");
  Check(IsValidMouseHookConfig({MouseButton::Right, MouseAction::LongPress, 500, false}),
    "Right + LongPress 阈值 500 合法");
  Check(IsValidMouseHookConfig({MouseButton::Forward, MouseAction::Press, 300, true}),
    "Forward + Press 合法");
  Check(IsValidMouseHookConfig({MouseButton::Backward, MouseAction::Press, 300, true}),
    "Backward + Press 合法");
}

void TestMouseLongPressDelayedReleaseAndDragCancel() {
  MouseHookStateMachine sm;
  Check(sm.Configure({MouseButton::Right, MouseAction::LongPress, 300, true}),
    "配置 Right + LongPress");

  // 场景 1：长按到期触发，随后 Up 必须同步吞掉（既无右键菜单泄漏，也无按下卡死）
  MouseEventDecision d = sm.OnTargetButtonDown(500, 400, false);
  Check(d.suppress_original && d.start_timer && !d.replay_down && !d.emit_trigger,
    "长按 Down 应拦截并启定时器");
  d = sm.OnMouseMove(503, 404, 4, 4);
  Check(!d.suppress_original && !d.cancel_timer && !d.replay_down,
    "拖拽阈值内微动不得取消长按");
  d = sm.OnLongPressTimerFired();
  Check(d.cancel_timer && d.emit_trigger, "定时器到期应触发");
  Check(sm.state() == MouseHookStateMachine::PendingState::Triggered, "应进入 Triggered");
  d = sm.OnExternalInterrupt();
  Check(!d.replay_down && !d.cancel_timer, "已触发态不受外部按键回放影响");
  d = sm.OnTargetButtonUp();
  Check(d.suppress_original && !d.replay_down_up && !d.emit_trigger,
    "长按已触发后的 Up 必须静默吞掉，绝不泄漏右键菜单");
  Check(sm.state() == MouseHookStateMachine::PendingState::Idle, "Up 后应恢复 Idle");

  // 场景 2：长按未到期即松开（正常短按右键），拦截原 Up 并原子补发 [Down, Up]
  d = sm.OnTargetButtonDown(500, 400, false);
  Check(d.suppress_original && d.start_timer, "Down 拦截并启定时器");
  d = sm.OnTargetButtonUp();
  Check(d.suppress_original && d.cancel_timer && d.replay_down_up && !d.emit_trigger,
    "未到期松开必须拦截原 Up 并原子补发 [Down, Up]");
  Check(sm.state() == MouseHookStateMachine::PendingState::Idle, "状态应回到 Idle");
  // 滞后的定时器消息到达不得产生任何副作用
  d = sm.OnLongPressTimerFired();
  Check(!d.emit_trigger && !d.replay_down, "释放后的滞后定时器不得触发");

  // 场景 3：拖拽超过阈值，取消定时器并同步补发 Down 进入直通态，直至原 Up 放行
  d = sm.OnTargetButtonDown(500, 400, false);
  Check(d.suppress_original && d.start_timer, "Down 拦截");
  d = sm.OnMouseMove(505, 400, 4, 4);
  Check(!d.suppress_original && d.cancel_timer && d.replay_down && !d.emit_trigger,
    "超阈值移动应取消定时器并补发 Down");
  Check(sm.state() == MouseHookStateMachine::PendingState::PassedThrough, "应进入直通态");
  d = sm.OnLongPressTimerFired();
  Check(!d.emit_trigger, "直通态滞后定时器不得触发");
  d = sm.OnTargetButtonUp();
  Check(!d.suppress_original && !d.replay_down_up && !d.emit_trigger,
    "直通态 Up 必须直接放行与补发 Down 配对");
  Check(sm.state() == MouseHookStateMachine::PendingState::Idle, "直通态结束恢复 Idle");

  // 场景 4：全屏免打扰期间直接放行，零拦截零延迟
  d = sm.OnTargetButtonDown(500, 400, true);
  Check(!d.suppress_original && !d.start_timer, "全屏免打扰必须直接透传 Down");
  Check(sm.state() == MouseHookStateMachine::PendingState::Idle, "免打扰不进入拦截态");
  d = sm.OnTargetButtonUp();
  Check(!d.suppress_original, "免打扰 Up 直接透传");
}

void TestMousePressAndExternalInterruptAndExtremeCoords() {
  MouseHookStateMachine sm;
  Check(sm.Configure({MouseButton::Middle, MouseAction::Press, 300, true}),
    "配置 Middle + Press");

  // 正常阈值内 Press
  MouseEventDecision d = sm.OnTargetButtonDown(100, 100, false);
  Check(d.suppress_original && !d.start_timer, "Press 模式 Down 拦截且不启定时器");
  d = sm.OnMouseMove(104, 96, 4, 4);
  Check(!d.replay_down, "刚好等于阈值 4px 不算超阈值");
  d = sm.OnTargetButtonUp();
  Check(d.suppress_original && d.emit_trigger && !d.replay_down_up,
    "阈值内 Up 应拦截并触发 Press");

  // 外部按键（如键盘按下或其他鼠标按下）打断未决状态：补发 Down 进入直通态
  d = sm.OnTargetButtonDown(100, 100, false);
  Check(d.suppress_original, "Down 拦截");
  d = sm.OnExternalInterrupt();
  Check(d.replay_down && !d.cancel_timer, "Press 模式下外部打断应补发 Down");
  Check(sm.state() == MouseHookStateMachine::PendingState::PassedThrough, "应进入直通态");
  d = sm.OnTargetButtonUp();
  Check(!d.suppress_original && !d.emit_trigger, "被打断后的 Up 必须放行且不得触发");

  // 拖拽阈值 0 与极大坐标防溢出
  Check(AbsCoordDiff(std::numeric_limits<std::int32_t>::min(),
                     std::numeric_limits<std::int32_t>::max()) ==
        4294967295ULL,
    "极端 32 位坐标差不得溢出");
  d = sm.OnTargetButtonDown(0, 0, false);
  Check(d.suppress_original, "Down 拦截");
  d = sm.OnMouseMove(0, 0, 0, 0);
  Check(!d.replay_down, "阈值 0 时原点不动不得触发超阈值");
  d = sm.OnMouseMove(1, 0, 0, 0);
  Check(d.replay_down, "阈值 0 时移动 1px 应立即放行");
  d = sm.OnTargetButtonUp();
  Check(!d.suppress_original, "放行收尾 Up");
}

void TestFullscreenDndThrottle() {
  FullscreenDndThrottle throttle{};
  bool cached = true;
  Check(!throttle.TryGetCached(100, cached), "初始无缓存");
  throttle.Update(1000, true);
  Check(throttle.TryGetCached(1000, cached) && cached, "同毫秒命中缓存");
  Check(throttle.TryGetCached(1199, cached) && cached, "199ms 内应命中缓存");
  Check(!throttle.TryGetCached(1200, cached), "到达 200ms 节流窗口必须失效重查");
  Check(!throttle.TryGetCached(999, cached), "时间戳回退必须失效重查");
  throttle.Reset();
  Check(!throttle.TryGetCached(1050, cached), "Reset 后不得命中旧缓存");
}

}  // namespace

int main() {
  TestVirtualKeyMappings();
  TestKeyboardDoubleTapBasicAndSecondKeyUpTrigger();
  TestKeyboardTimingBoundariesAndTickWrap();
  TestKeyboardAutoRepeatAndInterruptions();
  TestMouseConfigValidationAndRightPressRejection();
  TestMouseLongPressDelayedReleaseAndDragCancel();
  TestMousePressAndExternalInterruptAndExtremeCoords();
  TestFullscreenDndThrottle();
  std::cout << "All hook state machine tests passed\n";
  return 0;
}
