#include <Windows.h>
#include <objbase.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

enum class PluginError : int {
  Success = 0,
  InitFailed = -1,
  FunctionNotFound = -2,
  InvalidParams = -3,
  InternalError = -4,
  NotLoaded = -5,
};

struct PluginInfo {
  const char* plugin_name;
  const char* version;
  const char* author;
  const char* description;
  const char** function_names;
};

using ProgressCallback = void(__cdecl*)(const char*, int, const char*);
using ResultCallback = void(__cdecl*)(const char*, const char*);

std::atomic_bool g_initialized{false};
std::mutex g_cancel_mutex;
std::unordered_set<std::string> g_cancelled;
std::mutex g_thread_mutex;
std::vector<std::thread> g_threads;

// Legacy plugins may dispatch functions omitted from their metadata.
const char* g_functions[]{nullptr};
PluginInfo g_info{
  "ZToolsNativeTestPlugin",
  "1.0.0",
  "ZTools",
  "NativeHost32 deterministic ABI fixture",
  g_functions,
};

std::string ExtractTaskId(const char* params) {
  if (params == nullptr) return {};
  const std::string json(params);
  constexpr std::string_view marker = "\"taskId\":\"";
  const std::size_t start = json.find(marker);
  if (start == std::string::npos) return {};
  const std::size_t value_start = start + marker.size();
  const std::size_t end = json.find('"', value_start);
  if (end == std::string::npos || end == value_start) return {};
  return json.substr(value_start, end - value_start);
}

bool IsCancelled(const std::string& task_id) {
  std::lock_guard lock(g_cancel_mutex);
  return g_cancelled.contains(task_id);
}

bool AllocateResult(std::string_view value, char** result) {
  if (result == nullptr) return false;
  *result = static_cast<char*>(CoTaskMemAlloc(value.size() + 1));
  if (*result == nullptr) return false;
  std::memcpy(*result, value.data(), value.size());
  (*result)[value.size()] = '\0';
  return true;
}

bool SpawnJobChild(DWORD& process_id) {
  std::array<wchar_t, MAX_PATH> system_directory{};
  const UINT system_directory_length = GetSystemDirectoryW(
    system_directory.data(), static_cast<UINT>(system_directory.size()));
  if (system_directory_length == 0 || system_directory_length >= system_directory.size()) {
    return false;
  }
  const std::wstring executable(
    system_directory.data(), static_cast<std::size_t>(system_directory_length));
  const std::wstring application = executable + L"\\cmd.exe";
  std::wstring command_line = L"\"" + application +
    L"\" /d /c ping 127.0.0.1 -n 60 > NUL";
  STARTUPINFOW startup{};
  startup.cb = static_cast<DWORD>(sizeof(startup));
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
        application.c_str(), command_line.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    return false;
  }
  process_id = process.dwProcessId;
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return true;
}

}  // namespace

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_Init() {
  g_initialized.store(true, std::memory_order_release);
  return PluginError::Success;
}

extern "C" __declspec(dllexport) void __cdecl DllPlugin_Destroy() {
  std::vector<std::thread> threads;
  {
    std::lock_guard lock(g_thread_mutex);
    threads.swap(g_threads);
  }
  for (auto& thread : threads) {
    if (thread.joinable()) thread.join();
  }
  {
    std::lock_guard lock(g_cancel_mutex);
    g_cancelled.clear();
  }
  g_initialized.store(false, std::memory_order_release);
}

extern "C" __declspec(dllexport) const PluginInfo* __cdecl DllPlugin_GetInfo() {
  return g_initialized.load(std::memory_order_acquire) ? &g_info : nullptr;
}

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_Call(
  const char* function_name,
  const char*,
  char** result) {
  if (!g_initialized.load(std::memory_order_acquire)) return PluginError::NotLoaded;
  if (function_name == nullptr || result == nullptr) return PluginError::InvalidParams;
  if (std::strcmp(function_name, "spawnJobChild") == 0) {
    DWORD process_id = 0;
    if (!SpawnJobChild(process_id)) return PluginError::InternalError;
    const std::string response = "{\"pid\":" + std::to_string(process_id) + "}";
    return AllocateResult(response, result) ? PluginError::Success : PluginError::InternalError;
  }
  if (std::strcmp(function_name, "blockHostDispatch") == 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(7'500));
    return AllocateResult("{}", result) ? PluginError::Success : PluginError::InternalError;
  }
  if (std::strcmp(function_name, "blockingTask") != 0 &&
      std::strcmp(function_name, "progressTask") != 0 &&
      std::strcmp(function_name, "callbackTask") != 0) {
    return PluginError::FunctionNotFound;
  }
  if (std::strcmp(function_name, "blockingTask") == 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(3'000));
  }
  return AllocateResult("{}", result) ? PluginError::Success : PluginError::InternalError;
}

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_Call_Async(
  const char* function_name,
  const char* params,
  ProgressCallback callback,
  char** result) {
  if (!g_initialized.load(std::memory_order_acquire)) return PluginError::NotLoaded;
  if (function_name == nullptr ||
      (std::strcmp(function_name, "blockingTask") != 0 &&
       std::strcmp(function_name, "progressTask") != 0)) {
    return PluginError::FunctionNotFound;
  }
  const std::string task_id = ExtractTaskId(params);
  if (task_id.empty() || callback == nullptr || result == nullptr) return PluginError::InvalidParams;

  const bool silent = params != nullptr && std::strstr(params, "\"silent\":true") != nullptr;
  const bool regressing_progress = params != nullptr &&
    std::strstr(params, "\"regressingProgress\":true") != nullptr;
  const bool hold_at_full_progress = params != nullptr &&
    std::strstr(params, "\"holdAtFullProgress\":true") != nullptr;
  if (!silent) callback(task_id.c_str(), regressing_progress ? 80 : 10, "started");
  const bool blocking = std::strcmp(function_name, "blockingTask") == 0;
  const bool slow = params != nullptr && std::strstr(params, "\"slow\":true") != nullptr;
  std::this_thread::sleep_for(std::chrono::milliseconds(
    blocking ? 3'000 : (slow ? 5'000 : 150)));
  if (IsCancelled(task_id)) {
    callback(task_id.c_str(), -1, "cancelled");
  } else if (!silent) {
    if (regressing_progress) {
      callback(task_id.c_str(), 12, "late lower overall progress");
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    callback(task_id.c_str(), 100, "{\"ok\":true}");
    if (hold_at_full_progress) {
      std::this_thread::sleep_for(std::chrono::milliseconds(750));
    }
  }
  const std::string response = "{\"result\":\"" + task_id + "\"}";
  return AllocateResult(response, result) ? PluginError::Success : PluginError::InternalError;
}

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_CallWithCallback(
  const char* function_name,
  const char* params,
  ResultCallback callback) {
  if (!g_initialized.load(std::memory_order_acquire)) return PluginError::NotLoaded;
  if (function_name == nullptr || std::strcmp(function_name, "callbackTask") != 0) {
    return PluginError::FunctionNotFound;
  }
  const std::string task_id = ExtractTaskId(params);
  if (task_id.empty() || callback == nullptr) return PluginError::InvalidParams;
  const bool slow = params != nullptr && std::strstr(params, "\"slow\":true") != nullptr;
  const bool progress_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"progress\"") != nullptr;
  const bool data_progress_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"data-progress\"") != nullptr;
  const bool oversized_result_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"oversized-result\"") != nullptr;
  const bool error_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"error\"") != nullptr;
  const bool cancelled_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"cancelled\"") != nullptr;
  const bool unknown_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"unknown\"") != nullptr;
  const bool malformed_typed_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"malformed-type\"") != nullptr;
  const bool late_mode = params != nullptr &&
    std::strstr(params, "\"callbackMode\":\"late\"") != nullptr;
  const bool very_slow = params != nullptr &&
    std::strstr(params, "\"verySlow\":true") != nullptr;
  {
    std::lock_guard lock(g_thread_mutex);
    g_threads.emplace_back([task_id, callback, slow, progress_mode, data_progress_mode,
                            oversized_result_mode, error_mode, cancelled_mode, unknown_mode,
                            malformed_typed_mode, late_mode, very_slow]() {
      std::this_thread::sleep_for(std::chrono::milliseconds(
        very_slow ? 7'000 : (slow ? 1'200 : 50)));
      if (IsCancelled(task_id)) {
        callback(task_id.c_str(), "{\"type\":\"cancelled\"}");
      } else if (progress_mode) {
        callback(task_id.c_str(),
          "{\"type\":\"progress\",\"progress\":80,\"data\":{\"status\":\"completed\"}}");
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        callback(task_id.c_str(),
          "{\"type\":\"progress\",\"progress\":12,\"data\":{\"progress\":20,\"currentFileProgress\":99}}");
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        callback(task_id.c_str(), "{\"type\":\"completed\",\"value\":42}");
      } else if (data_progress_mode) {
        callback(task_id.c_str(),
          "{\"type\":\"progress\",\"data\":{\"progress\":42,\"currentFileProgress\":97}}");
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        callback(task_id.c_str(), "{\"type\":\"completed\",\"value\":42}");
      } else if (oversized_result_mode) {
        const std::string oversized(200'000, '\x01');
        callback(task_id.c_str(), oversized.c_str());
      } else if (error_mode) {
        callback(task_id.c_str(), "{\"type\":\"error\",\"message\":\"fixture failure\"}");
      } else if (cancelled_mode) {
        callback(task_id.c_str(), "{\"type\":\"cancelled\"}");
      } else if (unknown_mode) {
        callback(task_id.c_str(), "{\"type\":\"future-status\",\"value\":42}");
      } else if (malformed_typed_mode) {
        callback(task_id.c_str(), "{\"type\":\"future-status\",");
      } else if (late_mode) {
        callback(task_id.c_str(), "{\"type\":\"completed\",\"value\":42}");
        callback(task_id.c_str(), "{\"type\":\"progress\",\"progress\":12}");
      } else {
        callback(task_id.c_str(), "{\"value\":42}");
      }
    });
  }
  return PluginError::Success;
}

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_StopManagedProcesses(
  const char* params,
  char** result) {
  if (!g_initialized.load(std::memory_order_acquire)) return PluginError::NotLoaded;
  if (params == nullptr ||
      (std::strstr(params, "\"reason\":\"host_shutdown\"") == nullptr &&
       std::strstr(params, "\"reason\":\"host_unload\"") == nullptr) ||
      std::strstr(params, "\"deadlineMs\":") == nullptr) {
    return PluginError::InvalidParams;
  }
  std::vector<std::thread> threads;
  {
    std::lock_guard lock(g_thread_mutex);
    threads.swap(g_threads);
  }
  for (auto& thread : threads) {
    if (thread.joinable()) thread.join();
  }
  if (std::strstr(params, "\"reason\":\"host_unload\"") != nullptr) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1'300));
  }
  return AllocateResult("{\"success\":true}", result)
    ? PluginError::Success
    : PluginError::InternalError;
}

extern "C" __declspec(dllexport) PluginError __cdecl DllPlugin_CancelTask(const char* task_id) {
  if (!g_initialized.load(std::memory_order_acquire)) return PluginError::NotLoaded;
  if (task_id == nullptr || *task_id == '\0') return PluginError::InvalidParams;
  std::lock_guard lock(g_cancel_mutex);
  g_cancelled.emplace(task_id);
  return PluginError::Success;
}

BOOL APIENTRY DllMain(HMODULE, DWORD, LPVOID) {
  return TRUE;
}
