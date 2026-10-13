#pragma once

#include "ztools_service/privileged_dll_loader.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace ztools::service {

struct PrivilegedDllTaskChanges;

struct PrivilegedDllTaskResult {
  bool success = false;
  std::string code;
  std::vector<std::uint8_t> payload;
};

class PrivilegedDllTaskManager final {
 public:
  explicit PrivilegedDllTaskManager(const PrivilegedDllLoader* loader);
  ~PrivilegedDllTaskManager();

  PrivilegedDllTaskManager(const PrivilegedDllTaskManager&) = delete;
  PrivilegedDllTaskManager& operator=(const PrivilegedDllTaskManager&) = delete;

  PrivilegedDllTaskResult Start(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& function_name,
      const std::vector<std::uint8_t>& params_json,
      bool callback_mode);
  PrivilegedDllTaskResult Query(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& task_id);
  PrivilegedDllTaskResult Cancel(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& task_id);
  PrivilegedDllTaskResult Clear(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& task_id);
  PrivilegedDllTaskResult ClearPlugin(
      const std::string& plugin_id,
      const std::string& dll_id);
  PrivilegedDllTaskResult Unload(
      const std::string& plugin_id,
      const std::string& dll_id);

  HANDLE change_event() const noexcept;
  std::vector<std::uint8_t> TakeChanges();

 private:
  struct Task;

  static void __cdecl ProgressCallbackBridge(
      const char* task_id,
      int percent,
      const char* message);
  static void __cdecl ResultCallbackBridge(
      const char* task_id,
      const char* result);

  PrivilegedDllTaskResult ClearTask(const std::shared_ptr<Task>& task);
  std::shared_ptr<Task> FindTask(
      const std::string& plugin_id,
      const std::string& dll_id,
      const std::string& task_id) const;

  const PrivilegedDllLoader* loader_ = nullptr;
  std::shared_ptr<PrivilegedDllTaskChanges> changes_;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<Task>> tasks_;
  static std::mutex callback_mutex_;
  static std::unordered_map<std::string, std::weak_ptr<Task>> callback_registry_;
};

}  // namespace ztools::service
