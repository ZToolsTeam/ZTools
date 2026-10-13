#include "ztools_service/privileged_dll_task_manager.hpp"
#include "../../shared/dll_cancel.hpp"

#include <Windows.h>
#include <objbase.h>

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <deque>
#include <optional>
#include <set>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace ztools::service {
namespace {

constexpr std::size_t kMaxTaskCount = 256;
constexpr std::size_t kMaxTaskIdBytes = 128;
constexpr std::size_t kMaxResultBytes = 256 * 1024;
constexpr std::size_t kMaxCallbackQueue = 256;

using DllCallFunction = int(__cdecl*)(const char*, const char*, char**);
using ProgressCallback = void(__cdecl*)(const char*, int, const char*);
using ResultCallback = void(__cdecl*)(const char*, const char*);
using DllCallAsyncFunction = int(__cdecl*)(
    const char*, const char*, ProgressCallback, char**);
using DllCallWithCallbackFunction = int(__cdecl*)(
    const char*, const char*, ResultCallback);
using DllCancelTaskFunction = ztools::DllCancelFunction;

enum class TaskMode {
  async,
  callback,
};

enum class TaskState {
  invoking,
  running,
  completed,
  cancelled,
  error,
};

PrivilegedDllTaskResult Failure(std::string_view code) {
  PrivilegedDllTaskResult result;
  result.code = std::string(code);
  return result;
}

PrivilegedDllTaskResult Success(std::vector<std::uint8_t> payload) {
  PrivilegedDllTaskResult result;
  result.success = true;
  result.payload = std::move(payload);
  return result;
}

std::vector<std::uint8_t> Bytes(std::string_view value) {
  return {value.begin(), value.end()};
}

bool IsValidUtf8(std::string_view value) {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX)) {
    return value.empty();
  }
  return MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0) > 0;
}

bool IsSafeTaskId(std::string_view value) {
  if (value.size() < 6 || value.size() > kMaxTaskIdBytes ||
      !value.starts_with("task_")) {
    return false;
  }
  return std::all_of(value.begin(), value.end(), [](const unsigned char character) {
    return (character >= 'a' && character <= 'z') ||
           (character >= 'A' && character <= 'Z') ||
           (character >= '0' && character <= '9') ||
           character == '_' || character == '-';
  });
}

std::string ExtractTaskId(std::string_view params) {
  constexpr std::string_view marker = "\"taskId\":\"";
  const std::size_t start = params.find(marker);
  if (start == std::string_view::npos) return {};
  const std::size_t value_start = start + marker.size();
  const std::size_t end = params.find('"', value_start);
  if (end == std::string_view::npos || end == value_start) return {};
  return std::string(params.substr(value_start, end - value_start));
}

std::string JsonEscape(std::string_view value) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string output;
  output.reserve(value.size() + 2);
  output.push_back('"');
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (character < 0x20U) {
          output += "\\u00";
          output.push_back(hex[(character >> 4U) & 0x0fU]);
          output.push_back(hex[character & 0x0fU]);
        } else {
          output.push_back(static_cast<char>(character));
        }
    }
  }
  output.push_back('"');
  return output;
}

std::string TaskModeName(TaskMode mode) {
  return mode == TaskMode::async ? "async" : "callback";
}

std::string TaskStateName(TaskState state) {
  switch (state) {
    case TaskState::invoking: return "invoking";
    case TaskState::running: return "running";
    case TaskState::completed: return "completed";
    case TaskState::cancelled: return "cancelled";
    case TaskState::error: return "error";
  }
  return "error";
}

bool IsTerminal(TaskState state) {
  return state == TaskState::completed || state == TaskState::cancelled ||
         state == TaskState::error;
}

bool TakeAbiResult(
    char* raw_result,
    std::optional<std::string>& result,
    std::string& error) {
  result.reset();
  if (raw_result == nullptr) return true;
  const std::size_t length = strnlen_s(raw_result, kMaxResultBytes + 1);
  if (length > kMaxResultBytes) {
    CoTaskMemFree(raw_result);
    error = "DLL_RESPONSE_TOO_LARGE";
    return false;
  }
  result.emplace(raw_result, length);
  CoTaskMemFree(raw_result);
  if (!IsValidUtf8(*result)) {
    result.reset();
    error = "DLL_RESPONSE_INVALID";
    return false;
  }
  return true;
}

std::vector<std::uint8_t> CodePayload(int code) {
  const std::string json = "{\"code\":" + std::to_string(code) + "}";
  return Bytes(json);
}

}  // namespace

struct PrivilegedDllTaskChanges {
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  std::mutex mutex;
  std::set<std::string> pending;
  PrivilegedDllTaskChanges() {
    if (!event) throw std::runtime_error("failed to create DLL change event");
  }
  ~PrivilegedDllTaskChanges() { CloseHandle(event); }
  void Notify(const std::string& task_id) noexcept {
    try {
      std::lock_guard lock(mutex);
      // Coalesce notifications. Overflow is represented by an all-tasks marker.
      if (pending.size() >= kMaxTaskCount) {
        pending.clear();
        pending.insert("*");
      }
      pending.insert(task_id);
      SetEvent(event);
    } catch (...) {}
  }
};

struct PrivilegedDllTaskManager::Task {
  std::shared_ptr<PrivilegedDllTaskChanges> changes;
  void Notify() const noexcept { changes->Notify(task_id); }
  struct Notification {
    Task& task;
    ~Notification() { task.Notify(); }
  };
  std::mutex mutex;
  bool active = true;
  bool cancelling = false;
  TaskMode mode = TaskMode::async;
  TaskState state = TaskState::invoking;
  int progress = 0;
  std::string plugin_id;
  std::string dll_id;
  std::string task_id;
  std::string function_name;
  std::string error;
  bool result_ready = false;
  std::optional<std::string> result;
  std::deque<std::string> callback_results;
  std::unique_ptr<PrivilegedDllLoadResult> loaded;
  DllCallFunction call = nullptr;
  DllCallAsyncFunction call_async = nullptr;
  DllCallWithCallbackFunction call_with_callback = nullptr;
  DllCancelTaskFunction cancel_task = nullptr;
  std::thread worker;

  ~Task() {
    if (worker.joinable()) worker.join();
  }
};

std::mutex PrivilegedDllTaskManager::callback_mutex_;
std::unordered_map<
    std::string,
    std::weak_ptr<PrivilegedDllTaskManager::Task>>
    PrivilegedDllTaskManager::callback_registry_;

PrivilegedDllTaskManager::PrivilegedDllTaskManager(
    const PrivilegedDllLoader* const loader)
    : loader_(loader), changes_(std::make_shared<PrivilegedDllTaskChanges>()) {}

HANDLE PrivilegedDllTaskManager::change_event() const noexcept { return changes_->event; }

std::vector<std::uint8_t> PrivilegedDllTaskManager::TakeChanges() {
  std::lock_guard lock(changes_->mutex);
  std::string json = "[";
  for (const auto& task_id : changes_->pending) {
    if (json.size() > 1) json += ',';
    json += JsonEscape(task_id);
  }
  json += ']';
  changes_->pending.clear();
  return Bytes(json);
}

PrivilegedDllTaskManager::~PrivilegedDllTaskManager() {
  std::vector<std::string> task_ids;
  {
    std::lock_guard lock(mutex_);
    task_ids.reserve(tasks_.size());
    for (const auto& entry : tasks_) task_ids.push_back(entry.first);
  }
  for (const auto& task_id : task_ids) {
    const auto task = FindTask({}, {}, task_id);
    if (!task) continue;
    Cancel(task->plugin_id, task->dll_id, task_id);
    Clear(task->plugin_id, task->dll_id, task_id);
  }
  std::lock_guard callback_lock(callback_mutex_);
  callback_registry_.clear();
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::Start(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name,
    const std::vector<std::uint8_t>& params_json,
    const bool callback_mode) {
  try {
    if (loader_ == nullptr || plugin_id.empty() || dll_id.empty() ||
        function_name.empty() || params_json.empty() ||
        params_json.size() > kMaxResultBytes ||
        std::find(params_json.begin(), params_json.end(), 0) != params_json.end()) {
      return Failure("INVALID_REQUEST");
    }
    const std::string params(params_json.begin(), params_json.end());
    const std::string task_id = ExtractTaskId(params);
    if (!IsValidUtf8(params) || !IsSafeTaskId(task_id)) {
      return Failure("INVALID_REQUEST");
    }
    {
      std::lock_guard lock(mutex_);
      if (tasks_.size() >= kMaxTaskCount) return Failure("DLL_TASK_LIMIT");
      if (tasks_.contains(task_id)) return Failure("DLL_TASK_DUPLICATE");
    }

    PrivilegedDllLoadResult loaded = loader_->Load(plugin_id, dll_id, function_name);
    if (!loaded.success || loaded.module == nullptr) {
      return Failure(loaded.code.empty() ? "DLL_LOAD_FAILED" : loaded.code);
    }
    auto task = std::make_shared<Task>();
    task->changes = changes_;
    task->plugin_id = plugin_id;
    task->dll_id = dll_id;
    task->task_id = task_id;
    task->function_name = function_name;
    task->mode = callback_mode ? TaskMode::callback : TaskMode::async;
    task->loaded = std::make_unique<PrivilegedDllLoadResult>(std::move(loaded));
    task->call = reinterpret_cast<DllCallFunction>(
        GetProcAddress(task->loaded->module, "DllPlugin_Call"));
    task->call_async = reinterpret_cast<DllCallAsyncFunction>(
        GetProcAddress(task->loaded->module, "DllPlugin_Call_Async"));
    task->call_with_callback = reinterpret_cast<DllCallWithCallbackFunction>(
        GetProcAddress(task->loaded->module, "DllPlugin_CallWithCallback"));
    task->cancel_task = reinterpret_cast<DllCancelTaskFunction>(
        GetProcAddress(task->loaded->module, "DllPlugin_CancelTask"));
    if (task->call == nullptr ||
        (callback_mode && task->call_with_callback == nullptr)) {
      return Failure(callback_mode ? "DLL_CALLBACK_UNSUPPORTED" : "DLL_EXPORTS_INVALID");
    }
    if (!callback_mode && task->call_async == nullptr && task->call == nullptr) {
      return Failure("DLL_ASYNC_UNSUPPORTED");
    }

    {
      std::lock_guard lock(mutex_);
      if (tasks_.contains(task_id)) return Failure("DLL_TASK_DUPLICATE");
      tasks_.emplace(task_id, task);
    }
    {
      std::lock_guard lock(callback_mutex_);
      callback_registry_[task_id] = task;
    }
    try {
      task->worker = std::thread([task, params, callback_mode]() {
        Task::Notification notification{*task};
        int code = -4;
        std::optional<std::string> result;
        std::string result_error;
        try {
          if (callback_mode) {
            code = task->call_with_callback(
                task->function_name.c_str(), params.c_str(),
                &PrivilegedDllTaskManager::ResultCallbackBridge);
          } else {
            char* raw_result = nullptr;
            if (task->call_async != nullptr) {
              code = task->call_async(
                  task->function_name.c_str(), params.c_str(),
                  &PrivilegedDllTaskManager::ProgressCallbackBridge, &raw_result);
            } else {
              code = task->call(
                  task->function_name.c_str(), params.c_str(), &raw_result);
            }
            if (!TakeAbiResult(raw_result, result, result_error)) {
              std::lock_guard lock(task->mutex);
              if (task->active && !IsTerminal(task->state)) {
                task->state = TaskState::error;
                task->progress = 100;
                task->error = result_error;
              }
              return;
            }
          }
          std::lock_guard lock(task->mutex);
          if (!task->active || task->state == TaskState::cancelled) return;
          if (code != 0) {
            task->state = TaskState::error;
            task->progress = 100;
            task->error = "dll task entry point returned error " + std::to_string(code);
          } else if (callback_mode) {
            if (task->state == TaskState::invoking) task->state = TaskState::running;
          } else if (task->state != TaskState::error) {
            task->state = TaskState::completed;
            task->progress = 100;
            task->result_ready = true;
            task->result = std::move(result);
          }
        } catch (...) {
          std::lock_guard lock(task->mutex);
          if (task->active && !IsTerminal(task->state)) {
            task->state = TaskState::error;
            task->progress = 100;
            task->error = "privileged dll task invocation failed";
          }
        }
      });
    } catch (...) {
      {
        std::lock_guard lock(task->mutex);
        task->active = false;
      }
      {
        std::lock_guard lock(callback_mutex_);
        const auto found = callback_registry_.find(task_id);
        if (found != callback_registry_.end() && found->second.lock() == task) {
          callback_registry_.erase(found);
        }
      }
      std::lock_guard lock(mutex_);
      tasks_.erase(task_id);
      throw;
    }
    return Success(Bytes(task_id));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL");
  }
}

std::shared_ptr<PrivilegedDllTaskManager::Task>
PrivilegedDllTaskManager::FindTask(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id) const {
  std::lock_guard lock(mutex_);
  const auto found = tasks_.find(task_id);
  if (found == tasks_.end()) return {};
  if ((!plugin_id.empty() && found->second->plugin_id != plugin_id) ||
      (!dll_id.empty() && found->second->dll_id != dll_id)) {
    return {};
  }
  return found->second;
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::Query(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id) {
  const auto task = FindTask(plugin_id, dll_id, task_id);
  if (!task) return Failure("DLL_TASK_NOT_FOUND");
  try {
    std::deque<std::string> callback_results;
    std::string json;
    {
      std::lock_guard lock(task->mutex);
      callback_results.swap(task->callback_results);
      json = "{\"taskId\":" + JsonEscape(task->task_id) +
          ",\"mode\":" + JsonEscape(TaskModeName(task->mode)) +
          ",\"status\":" + JsonEscape(TaskStateName(task->state)) +
          ",\"progress\":" + std::to_string(task->progress) +
          ",\"functionName\":" + JsonEscape(task->function_name) +
          ",\"error\":" +
          (task->error.empty() ? "null" : JsonEscape(task->error));
      json += ",\"resultReady\":";
      json += task->result_ready ? "true" : "false";
      if (task->result_ready) {
        json += ",\"result\":" +
            (task->result ? JsonEscape(*task->result) : "null");
      }
    }
    if (!callback_results.empty()) {
      json += ",\"callbackResults\":[";
      for (std::size_t index = 0; index < callback_results.size(); ++index) {
        if (index != 0) json.push_back(',');
        json += JsonEscape(callback_results[index]);
      }
      json.push_back(']');
    }
    json.push_back('}');
    return Success(Bytes(json));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL");
  }
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::Cancel(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id) {
  const auto task = FindTask(plugin_id, dll_id, task_id);
  if (!task) return Failure("DLL_TASK_NOT_FOUND");
  try {
    {
      std::lock_guard lock(task->mutex);
      if (!task->active || task->cancelling || IsTerminal(task->state)) {
        return Failure("DLL_TASK_NOT_RUNNING");
      }
      if (task->cancel_task == nullptr) return Failure("DLL_CANCEL_UNSUPPORTED");
      task->cancelling = true;
    }
    const int code = ztools::CancelDllTask(task->cancel_task, task->task_id);
    bool disable = false;
    {
      std::lock_guard lock(task->mutex);
      task->cancelling = false;
      if (code == 0) {
        task->state = TaskState::cancelled;
        task->progress = 100;
        task->active = false;
        task->callback_results.clear();
        disable = true;
      }
    }
    if (disable) {
      task->Notify();
      std::lock_guard lock(callback_mutex_);
      const auto found = callback_registry_.find(task_id);
      if (found != callback_registry_.end() && found->second.lock() == task) {
        callback_registry_.erase(found);
      }
    }
    return Success(CodePayload(code));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL");
  }
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::ClearTask(
    const std::shared_ptr<Task>& task) {
  if (!task) return Failure("DLL_TASK_NOT_FOUND");
  {
    std::lock_guard lock(task->mutex);
    task->active = false;
  }
  {
    std::lock_guard lock(callback_mutex_);
    const auto found = callback_registry_.find(task->task_id);
    if (found != callback_registry_.end() && found->second.lock() == task) {
      callback_registry_.erase(found);
    }
  }
  if (task->worker.joinable()) task->worker.join();
  {
    std::lock_guard lock(mutex_);
    const auto found = tasks_.find(task->task_id);
    if (found != tasks_.end() && found->second == task) tasks_.erase(found);
  }
  return Success(Bytes("{\"success\":true}"));
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::Clear(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& task_id) {
  const auto task = FindTask(plugin_id, dll_id, task_id);
  return ClearTask(task);
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::ClearPlugin(
    const std::string& plugin_id,
    const std::string& dll_id) {
  std::vector<std::shared_ptr<Task>> tasks;
  {
    std::lock_guard lock(mutex_);
    for (const auto& entry : tasks_) {
      if (entry.second->plugin_id == plugin_id && entry.second->dll_id == dll_id) {
        tasks.push_back(entry.second);
      }
    }
  }
  for (const auto& task : tasks) ClearTask(task);
  return Success(Bytes("{\"success\":true}"));
}

PrivilegedDllTaskResult PrivilegedDllTaskManager::Unload(
    const std::string& plugin_id,
    const std::string& dll_id) {
  std::lock_guard lock(mutex_);
  for (const auto& entry : tasks_) {
    if (entry.second->plugin_id == plugin_id && entry.second->dll_id == dll_id) {
      return Failure("DLL_BUSY");
    }
  }
  return Success(Bytes("{\"success\":true}"));
}

void __cdecl PrivilegedDllTaskManager::ProgressCallbackBridge(
    const char* raw_task_id,
    const int percent,
    const char* raw_message) {
  if (raw_task_id == nullptr || percent < -1 || percent > 100) return;
  std::shared_ptr<Task> task;
  {
    std::lock_guard lock(callback_mutex_);
    const auto found = callback_registry_.find(raw_task_id);
    if (found != callback_registry_.end()) task = found->second.lock();
  }
  if (!task || task->mode != TaskMode::async) return;
  std::string message;
  if (raw_message != nullptr) {
    const std::size_t length = strnlen_s(raw_message, kMaxResultBytes + 1);
    if (length > kMaxResultBytes) return;
    message.assign(raw_message, length);
    if (!IsValidUtf8(message)) return;
  }
  std::lock_guard lock(task->mutex);
  if (!task->active || IsTerminal(task->state)) return;
  const auto previous_state = task->state;
  const int previous_progress = task->progress;
  task->progress = percent < 0 ? 100 : percent;
  if (percent < 0) {
    task->state = TaskState::error;
    task->error = message;
  } else {
    task->state = TaskState::running;
  }
  if (task->state != previous_state || task->progress != previous_progress) task->Notify();
}

void __cdecl PrivilegedDllTaskManager::ResultCallbackBridge(
    const char* raw_task_id,
    const char* raw_result) {
  if (raw_task_id == nullptr || raw_result == nullptr) return;
  std::shared_ptr<Task> task;
  {
    std::lock_guard lock(callback_mutex_);
    const auto found = callback_registry_.find(raw_task_id);
    if (found != callback_registry_.end()) task = found->second.lock();
  }
  if (!task || task->mode != TaskMode::callback) return;
  const std::size_t length = strnlen_s(raw_result, kMaxResultBytes + 1);
  if (length == 0 || length > kMaxResultBytes) return;
  const std::string result(raw_result, length);
  if (!IsValidUtf8(result)) return;
  std::lock_guard lock(task->mutex);
  if (!task->active || IsTerminal(task->state)) return;
  if (task->callback_results.size() >= kMaxCallbackQueue) {
    task->callback_results.pop_front();
  }
  task->callback_results.push_back(result);
  task->state = TaskState::running;
  task->Notify();
}

}  // namespace ztools::service
