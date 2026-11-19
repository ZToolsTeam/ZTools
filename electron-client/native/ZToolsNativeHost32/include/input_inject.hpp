#pragma once

#include "hook_state.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace ztools::native_host {

// 标识由 ZTools 注入或重放的输入事件魔数（兼容 32/64 位 ULONG_PTR），用于防止钩子自回放死循环
inline constexpr std::uintptr_t kZToolsInjectedExtraInfo = 0x5A544F4FU;

bool GetForegroundWindowHandle(std::uint64_t& handle, std::string& error);
bool RestoreForegroundWindow(std::uint64_t handle, std::string& error);
bool InjectKeyPress(std::uint16_t virtual_key, std::string& error);
bool InjectKeyCombo(const std::vector<std::uint16_t>& virtual_keys, std::string& error);
bool InjectText(const std::vector<std::uint8_t>& utf8, std::string& error);
bool InjectMouseMove(std::int32_t x, std::int32_t y, std::string& error);
bool InjectMouseClick(
  std::uint8_t button,
  bool has_position,
  std::int32_t x,
  std::int32_t y,
  std::string& error);
bool InjectMouseWheel(std::int32_t delta, std::string& error);

// 使用 kZToolsInjectedExtraInfo 签名补发鼠标按下事件或原子点击序列（供鼠标钩子延迟放行使用）
bool ReplayMouseButtonDown(MouseButton button);
bool ReplayMouseButtonClick(MouseButton button);

// 200ms 节流检查 Windows 全屏免打扰状态（QUNS_BUSY / D3D 全屏 / 演示模式）
bool IsFullscreenDndActive(FullscreenDndThrottle& throttle, std::uint64_t now_ms);

// 检查当前是否任意鼠标物理按键正处于按住状态（O(1) 无阻塞检测）
bool IsAnyMouseButtonPressed();

}  // namespace ztools::native_host
