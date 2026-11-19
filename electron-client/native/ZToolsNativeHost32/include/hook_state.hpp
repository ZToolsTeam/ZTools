#pragma once

#include <array>
#include <cstdint>
#include <optional>

namespace ztools::native_host {

// 修饰键枚举（与协议字节值一一对应）
enum class KeyboardModifier : std::uint8_t {
  Control = 1,
  Alt = 2,
  Shift = 3,
};

// 鼠标按键枚举（与协议字节值一一对应）
enum class MouseButton : std::uint8_t {
  Middle = 1,
  Right = 2,
  Forward = 3,
  Backward = 4,
};

// 鼠标触发动作枚举（与协议字节值一一对应）
enum class MouseAction : std::uint8_t {
  Press = 1,
  LongPress = 2,
};

// 鼠标钩子配置结构体
struct MouseHookConfig {
  MouseButton button = MouseButton::Middle;
  MouseAction action = MouseAction::LongPress;
  std::uint16_t long_press_ms = 300;
  bool fullscreen_dnd = true;
};

// 200ms 节流缓存状态（用于全屏免打扰检测，纯时间戳判定便于单元测试）
struct FullscreenDndThrottle {
  static constexpr std::uint64_t kThrottleIntervalMs = 200;

  bool has_cache = false;
  bool cached_active = false;
  std::uint64_t last_check_tick_ms = 0;

  // 判断在 now_ms 时刻是否可以命中节流缓存；未命中则需外部重新查询系统状态
  bool TryGetCached(std::uint64_t now_ms, bool& active_out) const noexcept {
    if (!has_cache || now_ms < last_check_tick_ms) {
      return false;
    }
    if ((now_ms - last_check_tick_ms) < kThrottleIntervalMs) {
      active_out = cached_active;
      return true;
    }
    return false;
  }

  // 更新节流缓存结果
  void Update(std::uint64_t now_ms, bool active) noexcept {
    has_cache = true;
    cached_active = active;
    last_check_tick_ms = now_ms;
  }

  // 重置节流缓存
  void Reset() noexcept {
    has_cache = false;
    cached_active = false;
    last_check_tick_ms = 0;
  }
};

// 根据虚拟键码映射修饰键索引（0=Ctrl, 1=Alt, 2=Shift，非修饰键返回 -1）
constexpr int ModifierIndexFromVirtualKey(std::uint32_t vk_code) noexcept {
  switch (vk_code) {
    case 0x11U:  // VK_CONTROL
    case 0xA2U:  // VK_LCONTROL
    case 0xA3U:  // VK_RCONTROL
      return 0;
    case 0x12U:  // VK_MENU (Alt)
    case 0xA4U:  // VK_LMENU
    case 0xA5U:  // VK_RMENU
      return 1;
    case 0x10U:  // VK_SHIFT
    case 0xA0U:  // VK_LSHIFT
    case 0xA1U:  // VK_RSHIFT
      return 2;
    default:
      return -1;
  }
}

// 由修饰键索引转换为协议枚举值
constexpr KeyboardModifier ModifierFromIndex(int index) noexcept {
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

// 判断给定修饰键索引是否在配置掩码中启用
constexpr bool IsModifierConfigured(std::uint8_t modifier_mask, int index) noexcept {
  return index >= 0 && index < 3 && (modifier_mask & (1U << index)) != 0U;
}

// 校验鼠标钩子配置合法性（显式拒绝 Right + Press 安全禁区）
constexpr bool IsValidMouseHookConfig(const MouseHookConfig& config) noexcept {
  if (config.button < MouseButton::Middle || config.button > MouseButton::Backward) {
    return false;
  }
  if (config.action != MouseAction::Press && config.action != MouseAction::LongPress) {
    return false;
  }
  if (config.button == MouseButton::Right && config.action == MouseAction::Press) {
    return false;
  }
  if (config.long_press_ms < 200 || config.long_press_ms > 500) {
    return false;
  }
  return true;
}

// 计算两坐标分量之差的绝对值（避免 32 位有符号整数溢出）
constexpr std::uint64_t AbsCoordDiff(std::int32_t lhs, std::int32_t rhs) noexcept {
  const std::int64_t diff = static_cast<std::int64_t>(lhs) - static_cast<std::int64_t>(rhs);
  return static_cast<std::uint64_t>(diff < 0 ? -diff : diff);
}

// 键盘双击修饰键纯状态机（无 Win32 句柄依赖，支持独立单元测试）
class KeyboardDoubleTapStateMachine final {
 public:
  static constexpr std::uint64_t kMaxTapDurationMs = 300;
  static constexpr std::uint64_t kDoubleTapIntervalMs = 400;

  // 配置允许的修饰键掩码并重置全部状态
  bool Configure(std::uint8_t modifier_mask) noexcept {
    if (modifier_mask == 0 || modifier_mask > 0x07U) {
      return false;
    }
    modifier_mask_ = modifier_mask;
    Reset();
    return true;
  }

  // 清空所有未决按键按压和历史 Tap 记录
  void Reset() noexcept {
    ClearActivePress();
    ResetDoubleTap();
  }

  // 仅清空历史 Tap 记录，保留当前正在按住的键追踪（供污染时防止 repeat 复活）
  void ResetDoubleTap() noexcept {
    last_tap_index_ = -1;
    last_tap_release_tick_ = 0;
  }

  // 通知外部活动（例如鼠标按下事件）：立即重置双击序列，并污染当前按压中的修饰键
  void NotifyExternalActivity() noexcept {
    ResetDoubleTap();
    if (active_press_index_ >= 0) {
      current_press_tainted_ = true;
    }
  }

  // 判断当前 KeyDown 是否属于“准备开启新敲击”的候选目标键（非系统自动重复按下）
  // 仅在该函数返回 true 时才需外部按需探测全屏免打扰状态，避免普通打字触发查询
  bool ShouldCheckFullscreenDndOnKeyDown(std::uint32_t vk_code) const noexcept {
    const int index = ModifierIndexFromVirtualKey(vk_code);
    if (!IsModifierConfigured(modifier_mask_, index)) {
      return false;
    }
    if (active_press_index_ >= 0) {
      return false;
    }
    return true;
  }

  // 处理一次键盘按下或松开事件；若在第二次 KeyUp 确认完成有效双击，返回对应的修饰键
  std::optional<KeyboardModifier> ProcessKeyEvent(
    std::uint32_t vk_code,
    bool is_down,
    std::uint64_t now_ms,
    bool external_mouse_held,
    bool fullscreen_dnd_active) noexcept {
    const int index = ModifierIndexFromVirtualKey(vk_code);
    const bool is_configured_modifier = IsModifierConfigured(modifier_mask_, index);

    if (is_down) {
      // 正在跟踪某个修饰键按压时，遇到同键码的 KeyDown 属于操作系统自动连发（auto-repeat）
      if (active_press_index_ >= 0 && vk_code == active_press_vk_) {
        if (external_mouse_held) {
          ResetDoubleTap();
          current_press_tainted_ = true;
        }
        return std::nullopt;
      }

      // 只要按下了非目标键（包括未配置的修饰键、字母键，或按住一侧修饰键时又按了另一侧键），一律立即打断
      if (!is_configured_modifier || active_press_index_ >= 0) {
        ResetDoubleTap();
        if (active_press_index_ >= 0) {
          current_press_tainted_ = true;
        }
        return std::nullopt;
      }

      // 开启新一轮目标修饰键按压前，若处于全屏免打扰或有鼠标键正按住，标记污染以屏蔽本轮按压
      if (fullscreen_dnd_active || external_mouse_held) {
        ResetDoubleTap();
        active_press_index_ = index;
        active_press_vk_ = vk_code;
        active_press_tick_ = now_ms;
        current_press_tainted_ = true;
        return std::nullopt;
      }

      active_press_index_ = index;
      active_press_vk_ = vk_code;
      active_press_tick_ = now_ms;
      current_press_tainted_ = false;
      return std::nullopt;
    }

    // KeyUp 分支：仅处理与当前跟踪按压键码匹配的松开事件
    if (active_press_index_ < 0 || vk_code != active_press_vk_) {
      return std::nullopt;
    }

    const int press_index = active_press_index_;
    const std::uint64_t press_tick = active_press_tick_;
    const bool tainted = current_press_tainted_;
    ClearActivePress();

    // 校验本次按键释放是否构成一次有效 Tap：无污染、无鼠标按住、持续时间 <= 300ms
    if (tainted || external_mouse_held || now_ms < press_tick ||
        (now_ms - press_tick) > kMaxTapDurationMs) {
      ResetDoubleTap();
      return std::nullopt;
    }

    // 检查是否与上一次有效 Tap 匹配同一个修饰键，且两次 Tap 间隔（首次释放至第二次按下）<= 400ms
    if (last_tap_index_ == press_index &&
        press_tick >= last_tap_release_tick_ &&
        (press_tick - last_tap_release_tick_) <= kDoubleTapIntervalMs) {
      ResetDoubleTap();
      return ModifierFromIndex(press_index);
    }

    // 记为新一轮的首次有效 Tap
    last_tap_index_ = press_index;
    last_tap_release_tick_ = now_ms;
    return std::nullopt;
  }

  std::uint8_t modifier_mask() const noexcept { return modifier_mask_; }
  int active_press_index() const noexcept { return active_press_index_; }
  int last_tap_index() const noexcept { return last_tap_index_; }

 private:
  void ClearActivePress() noexcept {
    active_press_index_ = -1;
    active_press_vk_ = 0;
    active_press_tick_ = 0;
    current_press_tainted_ = false;
  }

  std::uint8_t modifier_mask_ = 0;
  int active_press_index_ = -1;
  std::uint32_t active_press_vk_ = 0;
  std::uint64_t active_press_tick_ = 0;
  bool current_press_tainted_ = false;
  int last_tap_index_ = -1;
  std::uint64_t last_tap_release_tick_ = 0;
};

// 鼠标钩子单次事件决策结果
struct MouseEventDecision {
  bool suppress_original = false;  // 是否拦截原物理鼠标消息（返回 1）
  bool start_timer = false;        // 是否启动长按定时器
  bool cancel_timer = false;       // 是否取消长按定时器
  bool replay_down = false;        // 是否同步补发带魔数签名的 Down 事件
  bool replay_down_up = false;     // 是否同步原子补发带魔数签名的 [Down, Up] 点击序列
  bool emit_trigger = false;       // 是否触发 ZTools 鼠标事件
};

// 鼠标拦截与延迟放行状态机（无 Win32 句柄依赖，支持独立单元测试）
class MouseHookStateMachine final {
 public:
  enum class PendingState : std::uint8_t {
    Idle = 0,              // 空闲或透传
    PendingIntercept = 1,  // 已拦截 Down，等待松开 / 超时 / 拖拽取消
    PassedThrough = 2,     // 已补发 Down 转入直通态，等待物理 Up 透传配对
    Triggered = 3,         // 长按已触发，等待物理 Up 到来并吞掉（防止右键菜单泄漏）
  };

  bool Configure(const MouseHookConfig& config) noexcept {
    if (!IsValidMouseHookConfig(config)) {
      return false;
    }
    config_ = config;
    Reset();
    return true;
  }

  void Reset() noexcept {
    state_ = PendingState::Idle;
    down_x_ = 0;
    down_y_ = 0;
  }

  PendingState state() const noexcept { return state_; }
  bool is_pending() const noexcept { return state_ == PendingState::PendingIntercept; }
  const MouseHookConfig& config() const noexcept { return config_; }

  // 处理匹配目标按钮的按下事件
  MouseEventDecision OnTargetButtonDown(
    std::int32_t x,
    std::int32_t y,
    bool fullscreen_dnd_active) noexcept {
    MouseEventDecision decision{};
    if (state_ != PendingState::Idle) {
      return decision;
    }
    if (fullscreen_dnd_active) {
      return decision;
    }
    state_ = PendingState::PendingIntercept;
    down_x_ = x;
    down_y_ = y;
    decision.suppress_original = true;
    decision.start_timer = (config_.action == MouseAction::LongPress);
    return decision;
  }

  // 处理鼠标移动事件：未决期间超过系统拖拽阈值则取消触发并补发 Down 进入直通态
  MouseEventDecision OnMouseMove(
    std::int32_t x,
    std::int32_t y,
    std::int32_t drag_threshold_x,
    std::int32_t drag_threshold_y) noexcept {
    MouseEventDecision decision{};
    if (state_ != PendingState::PendingIntercept) {
      return decision;
    }
    const std::uint64_t limit_x = drag_threshold_x > 0
      ? static_cast<std::uint64_t>(drag_threshold_x)
      : 0ULL;
    const std::uint64_t limit_y = drag_threshold_y > 0
      ? static_cast<std::uint64_t>(drag_threshold_y)
      : 0ULL;
    if (AbsCoordDiff(x, down_x_) > limit_x || AbsCoordDiff(y, down_y_) > limit_y) {
      state_ = PendingState::PassedThrough;
      decision.cancel_timer = (config_.action == MouseAction::LongPress);
      decision.replay_down = true;
    }
    return decision;
  }

  // 处理长按定时器到期事件
  MouseEventDecision OnLongPressTimerFired() noexcept {
    MouseEventDecision decision{};
    if (state_ != PendingState::PendingIntercept ||
        config_.action != MouseAction::LongPress) {
      return decision;
    }
    state_ = PendingState::Triggered;
    decision.cancel_timer = true;
    decision.emit_trigger = true;
    return decision;
  }

  // 处理外部键盘或非目标鼠标按下打断：若仍处于未决态，立刻补发 Down 并转入直通态
  MouseEventDecision OnExternalInterrupt() noexcept {
    MouseEventDecision decision{};
    if (state_ != PendingState::PendingIntercept) {
      return decision;
    }
    state_ = PendingState::PassedThrough;
    decision.cancel_timer = (config_.action == MouseAction::LongPress);
    decision.replay_down = true;
    return decision;
  }

  // 处理匹配目标按钮的松开事件
  MouseEventDecision OnTargetButtonUp() noexcept {
    MouseEventDecision decision{};
    switch (state_) {
      case PendingState::Idle:
        return decision;
      case PendingState::PassedThrough:
        // Down 已补发给目标窗口，原物理 Up 直接放行配对
        state_ = PendingState::Idle;
        return decision;
      case PendingState::Triggered:
        // 长按触发时未曾向目标窗口发送 Down，此处同步吞掉 Up 防止菜单泄漏
        state_ = PendingState::Idle;
        decision.suppress_original = true;
        return decision;
      case PendingState::PendingIntercept:
        state_ = PendingState::Idle;
        decision.suppress_original = true;
        if (config_.action == MouseAction::LongPress) {
          // 长按模式在到期前松开：取消定时器并原子补发完整点击序列 [Down, Up]
          decision.cancel_timer = true;
          decision.replay_down_up = true;
        } else {
          // 按下模式在拖拽阈值内松开：吞掉 Up 并触发动作
          decision.emit_trigger = true;
        }
        return decision;
    }
    return decision;
  }

 private:
  MouseHookConfig config_{};
  PendingState state_ = PendingState::Idle;
  std::int32_t down_x_ = 0;
  std::int32_t down_y_ = 0;
};

}  // namespace ztools::native_host
