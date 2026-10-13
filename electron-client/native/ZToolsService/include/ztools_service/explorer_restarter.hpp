#pragma once

#include <Windows.h>

#include <mutex>
#include <string>

namespace ztools::service {

struct ExplorerRestartResult {
  bool success = false;
  std::string code;
  std::string message;
};

class ExplorerRestartExecutor {
 public:
  virtual ~ExplorerRestartExecutor() = default;
  virtual ExplorerRestartResult Restart(DWORD client_session_id) = 0;
};

class WindowsExplorerRestarter final : public ExplorerRestartExecutor {
 public:
  ExplorerRestartResult Restart(DWORD client_session_id) override;

 private:
  std::mutex mutex_;
};

}  // namespace ztools::service
