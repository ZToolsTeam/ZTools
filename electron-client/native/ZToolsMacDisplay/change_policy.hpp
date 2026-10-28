#pragma once
#include <cmath>
#include <functional>
#include <stdexcept>
#include <vector>

namespace display_change {
struct Change { double expected; double target; double tolerance; };
using Reader = std::function<double(size_t)>;
using Writer = std::function<void(size_t, double)>;
inline void require(bool value, const char* code) { if (!value) throw std::runtime_error(code); }
inline std::vector<double> apply(const std::vector<Change>& changes, const Reader& read, const Writer& write) {
  require(!changes.empty() && changes.size() <= 16, "DISPLAY_REQUEST_INVALID");
  std::vector<double> before, after;
  for (size_t i = 0; i < changes.size(); ++i) {
    const auto& c = changes[i];
    require(std::isfinite(c.expected) && std::isfinite(c.target) && c.target >= 0 && c.target <= 100 && c.expected >= 0 && c.expected <= 100 && std::isfinite(c.tolerance) && c.tolerance > 0 && c.tolerance <= 2, "DISPLAY_REQUEST_INVALID");
    const double value = read(i);
    require(std::isfinite(value) && std::abs(value - c.expected) <= c.tolerance, "DISPLAY_STATE_CHANGED");
    before.push_back(value);
  }
  size_t touched = 0;
  try {
    for (size_t i = 0; i < changes.size(); ++i) {
      require(std::abs(read(i) - before[i]) <= changes[i].tolerance, "DISPLAY_STATE_CHANGED");
      touched = i + 1; // 写入失败也可能已经生效，仍须尝试恢复这一台。
      write(i, changes[i].target);
      const double value = read(i);
      require(std::isfinite(value) && std::abs(value - changes[i].target) <= changes[i].tolerance, "DISPLAY_READBACK_MISMATCH");
      after.push_back(value);
    }
    return after;
  } catch (...) {
    if (!touched) throw;
    bool restored = true;
    while (touched) {
      const size_t i = --touched;
      try {
        const double current = read(i);
        if (std::isfinite(current) && std::abs(current - before[i]) <= changes[i].tolerance) continue;
        // 已被用户、自动亮度或其他程序改动时不覆盖，保留结果未知供重新读取。
        if (!std::isfinite(current) || std::abs(current - changes[i].target) > changes[i].tolerance) { restored = false; continue; }
        write(i, before[i]); const double value = read(i);
        restored = restored && std::isfinite(value) && std::abs(value - before[i]) <= changes[i].tolerance;
      }
      catch (...) { restored = false; }
    }
    throw std::runtime_error(restored ? "DISPLAY_WRITE_FAILED_RESTORED" : "DISPLAY_WRITE_OUTCOME_UNKNOWN");
  }
}
}
