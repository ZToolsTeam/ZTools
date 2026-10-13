#pragma once

#include <Windows.h>
#include <atomic>
#include <iostream>
#include <syncstream>
#include <utility>

namespace ztools::service {

inline std::atomic_bool g_console_logging{false};

template <typename... Values>
void ConsoleLog(Values&&... values) noexcept {
  if (!g_console_logging.load(std::memory_order_relaxed)) return;
  try {
    SYSTEMTIME now{};
    GetLocalTime(&now);
    std::osyncstream output(std::cerr);
    output << "[ZToolsService " << now.wHour << ':' << now.wMinute << ':'
           << now.wSecond << '.' << now.wMilliseconds << "] ";
    (output << ... << std::forward<Values>(values));
    output << std::endl;
  } catch (...) {
    // Diagnostics must never interrupt service requests.
  }
}

}  // namespace ztools::service
