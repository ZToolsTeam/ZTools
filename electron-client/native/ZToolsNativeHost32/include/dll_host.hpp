#pragma once

#include "dll_resolver.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace ztools::native_host {

struct DllHostResult {
  bool success = false;
  std::string code;
  std::string message;
  std::vector<std::uint8_t> payload;
};

struct DllHostEvent {
  std::string plugin_id;
  std::string dll_id;
  std::string task_id;
  std::string method;
  std::vector<std::uint8_t> payload;
};

struct DllHostShutdownResult {
  bool timed_out = false;
  std::vector<std::uint8_t> payload;
};

using DllHostEventSink = std::function<void(DllHostEvent)>;

struct DllTaskContext;

class DllHost {
 public:
  DllHost(const DllResolver& manifest, DllHostEventSink event_sink);
  ~DllHost();
  DllHost(const DllHost&) = delete;
  DllHost& operator=(const DllHost&) = delete;

  DllHostResult GetInfo(const std::string& plugin_id, const std::string& dll_id);
  DllHostResult Call(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name,
    const std::vector<std::uint8_t>& params_json);
  DllHostResult CallAsync(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id,
    const std::string& function_name,
    const std::vector<std::uint8_t>& params_json);
  DllHostResult CallWithCallback(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id,
    const std::string& function_name,
    const std::vector<std::uint8_t>& params_json);
  DllHostResult QueryTask(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id);
  DllHostResult CancelTask(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id);
  DllHostResult ClearTask(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id);
  DllHostResult Unload(const std::string& plugin_id, const std::string& dll_id);
  DllHostShutdownResult Shutdown(std::uint32_t deadline_ms);

 private:
  struct Session;
  struct InvocationThread;
  struct ShutdownThread;

  DllHostResult ResolveSession(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name,
    Session*& session);
  DllHostResult StartTask(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id,
    const std::string& function_name,
    const std::vector<std::uint8_t>& params_json,
    bool callback_mode);
  void CleanupFinishedThreads();
  bool ClearTaskRegistry() noexcept;
  void UnloadAll() noexcept;

  const DllResolver& manifest_;
  DllHostEventSink event_sink_;
  std::unordered_map<std::string, std::shared_ptr<Session>> sessions_;
  std::unordered_map<std::string, std::shared_ptr<DllTaskContext>> tasks_;
  std::vector<std::unique_ptr<InvocationThread>> invocation_threads_;
  std::unique_ptr<ShutdownThread> shutdown_thread_;
  std::atomic_bool stopping_{false};
};

}  // namespace ztools::native_host
