#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ztools::native_host {

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

}  // namespace ztools::native_host
