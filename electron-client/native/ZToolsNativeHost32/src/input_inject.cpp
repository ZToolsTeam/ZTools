#include "input_inject.hpp"

#include <Windows.h>

#include <algorithm>
#include <climits>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace ztools::native_host {
namespace {

std::string LastErrorMessage(std::string_view operation) {
  return std::string(operation) + " failed: " + std::to_string(GetLastError());
}

bool SendInputs(const std::vector<INPUT>& inputs, std::string& error) {
  if (inputs.empty() || inputs.size() > UINT_MAX) {
    error = "input sequence is invalid";
    return false;
  }
  const UINT sent = SendInput(static_cast<UINT>(inputs.size()),
    const_cast<LPINPUT>(inputs.data()), sizeof(INPUT));
  if (sent != inputs.size()) {
    error = LastErrorMessage("SendInput");
    return false;
  }
  return true;
}

INPUT KeyboardInput(WORD virtual_key, DWORD flags = 0) {
  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = virtual_key;
  input.ki.dwFlags = flags;
  return input;
}

LONG AbsoluteCoordinate(std::int32_t value, int origin, int size) {
  if (size <= 1) return 0;
  const auto relative = static_cast<double>(value - origin);
  const auto maximum = static_cast<double>(size - 1);
  const auto normalized = std::clamp(relative * 65535.0 / maximum, 0.0, 65535.0);
  return static_cast<LONG>(normalized + 0.5);
}

INPUT MouseMoveInput(std::int32_t x, std::int32_t y) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = AbsoluteCoordinate(x, GetSystemMetrics(SM_XVIRTUALSCREEN),
    GetSystemMetrics(SM_CXVIRTUALSCREEN));
  input.mi.dy = AbsoluteCoordinate(y, GetSystemMetrics(SM_YVIRTUALSCREEN),
    GetSystemMetrics(SM_CYVIRTUALSCREEN));
  input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return input;
}

}  // namespace

bool GetForegroundWindowHandle(std::uint64_t& handle, std::string& error) {
  const HWND window = GetForegroundWindow();
  if (window == nullptr) {
    error = "no foreground window is available";
    return false;
  }
  handle = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(window));
  return true;
}

bool RestoreForegroundWindow(std::uint64_t handle, std::string& error) {
  const HWND window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(handle));
  if (handle == 0 || window == nullptr || !IsWindow(window)) {
    error = "foreground window handle is invalid";
    return false;
  }
  if (!SetForegroundWindow(window)) {
    error = LastErrorMessage("SetForegroundWindow");
    return false;
  }
  return true;
}

bool InjectKeyPress(std::uint16_t virtual_key, std::string& error) {
  if (virtual_key == 0) {
    error = "virtual key is invalid";
    return false;
  }
  return SendInputs({KeyboardInput(virtual_key), KeyboardInput(virtual_key, KEYEVENTF_KEYUP)}, error);
}

bool InjectKeyCombo(const std::vector<std::uint16_t>& virtual_keys, std::string& error) {
  if (virtual_keys.empty() || virtual_keys.size() > 32) {
    error = "virtual key combination is invalid";
    return false;
  }
  std::vector<INPUT> inputs;
  inputs.reserve(virtual_keys.size() * 2);
  for (const std::uint16_t virtual_key : virtual_keys) {
    if (virtual_key == 0) {
      error = "virtual key combination contains an invalid key";
      return false;
    }
    inputs.push_back(KeyboardInput(virtual_key));
  }
  for (auto key = virtual_keys.rbegin(); key != virtual_keys.rend(); ++key) {
    inputs.push_back(KeyboardInput(*key, KEYEVENTF_KEYUP));
  }
  return SendInputs(inputs, error);
}

bool InjectText(const std::vector<std::uint8_t>& utf8, std::string& error) {
  if (utf8.empty() || utf8.size() > 256U * 1024U || utf8.size() > INT_MAX) {
    error = "text payload is invalid";
    return false;
  }
  const int required = MultiByteToWideChar(
    CP_UTF8,
    MB_ERR_INVALID_CHARS,
    reinterpret_cast<LPCCH>(utf8.data()),
    static_cast<int>(utf8.size()),
    nullptr,
    0);
  if (required <= 0) {
    error = LastErrorMessage("MultiByteToWideChar");
    return false;
  }
  std::wstring text(static_cast<std::size_t>(required), L'\0');
  if (MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        reinterpret_cast<LPCCH>(utf8.data()),
        static_cast<int>(utf8.size()),
        text.data(),
        required) != required) {
    error = LastErrorMessage("MultiByteToWideChar");
    return false;
  }
  if (text.size() > std::numeric_limits<std::size_t>::max() / 2) {
    error = "text payload is too large";
    return false;
  }
  std::vector<INPUT> inputs;
  inputs.reserve(text.size() * 2);
  for (const wchar_t character : text) {
    INPUT down{};
    down.type = INPUT_KEYBOARD;
    down.ki.wScan = static_cast<WORD>(character);
    down.ki.dwFlags = KEYEVENTF_UNICODE;
    INPUT up = down;
    up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    inputs.push_back(down);
    inputs.push_back(up);
  }
  return SendInputs(inputs, error);
}

bool InjectMouseMove(std::int32_t x, std::int32_t y, std::string& error) {
  return SendInputs({MouseMoveInput(x, y)}, error);
}

bool InjectMouseClick(
  std::uint8_t button,
  bool has_position,
  std::int32_t x,
  std::int32_t y,
  std::string& error) {
  DWORD down = 0;
  DWORD up = 0;
  if (button == 1) {
    down = MOUSEEVENTF_LEFTDOWN;
    up = MOUSEEVENTF_LEFTUP;
  } else if (button == 2) {
    down = MOUSEEVENTF_RIGHTDOWN;
    up = MOUSEEVENTF_RIGHTUP;
  } else if (button == 3) {
    down = MOUSEEVENTF_MIDDLEDOWN;
    up = MOUSEEVENTF_MIDDLEUP;
  } else {
    error = "mouse button is invalid";
    return false;
  }
  INPUT press{};
  press.type = INPUT_MOUSE;
  press.mi.dwFlags = down;
  INPUT release = press;
  release.mi.dwFlags = up;
  if (has_position) {
    std::vector<INPUT> inputs{MouseMoveInput(x, y), press, release};
    return SendInputs(inputs, error);
  }
  return SendInputs({press, release}, error);
}

bool InjectMouseWheel(std::int32_t delta, std::string& error) {
  if (delta == 0) {
    error = "mouse wheel delta is zero";
    return false;
  }
  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.mouseData = static_cast<DWORD>(delta);
  input.mi.dwFlags = MOUSEEVENTF_WHEEL;
  return SendInputs({input}, error);
}

}  // namespace ztools::native_host
