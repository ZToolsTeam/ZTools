#pragma once

#include "ztools_service/command_policy.hpp"
#include "ztools_service/explorer_restarter.hpp"
#include "ztools_service/privileged_dll_loader.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <vector>
#include <unordered_map>

namespace ztools::service {

class PrivilegedDllTaskManager;

inline constexpr std::uint32_t kServicePolicyStatusMagic = 0x3150535A;
inline constexpr std::uint16_t kServicePolicyStatusVersion = 1;
inline constexpr std::uint16_t kServicePolicyFlagManifestTrusted = 1;
inline constexpr std::uint16_t kServicePolicyFlagSystemOnlyDependencies = 2;

struct CommandDispatchResult {
  bool success = false;
  std::string code;
  std::vector<std::uint8_t> payload;
};

class CommandDispatcher final {
 public:
  CommandDispatcher(
      const PrivilegedDllResolver* manifest,
      const PrivilegedDllLoader* dll_loader,
      const CommandPolicy* policy,
      ExplorerRestartExecutor* explorer_restarter);
  ~CommandDispatcher();

  CommandDispatchResult Dispatch(
      std::span<const std::uint8_t> bytes,
      DWORD client_session_id) const;

  HANDLE TaskChangedEvent() const noexcept;
  std::vector<std::uint8_t> TakeTaskChanges() const;

 private:
  CommandDispatchResult ExecuteDllCall(const ServiceCommandView& command) const;

  const PrivilegedDllResolver* manifest_ = nullptr;
  const PrivilegedDllLoader* dll_loader_ = nullptr;
  const CommandPolicy* policy_ = nullptr;
  ExplorerRestartExecutor* explorer_restarter_ = nullptr;
  // Synchronous APIs can start persistent work (e.g. traffic monitoring).
  // Keep their instances alive until explicit unload/session clear or shutdown.
  mutable std::mutex dll_sessions_mutex_;
  mutable std::unordered_map<std::string, std::shared_ptr<PrivilegedDllSessionLease>> dll_sessions_;
  std::unique_ptr<PrivilegedDllTaskManager> dll_tasks_;
};

}  // namespace ztools::service
