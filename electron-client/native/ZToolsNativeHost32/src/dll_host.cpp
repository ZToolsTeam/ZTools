#include "dll_host.hpp"

#include "protocol.hpp"
#include "../../shared/dll_cancel.hpp"

#include <Windows.h>
#include <objbase.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <utility>

namespace ztools::native_host {

enum class DllTaskMode {
  Async,
  Callback,
};

enum class DllTaskState {
  Invoking,
  Running,
  Completed,
  Cancelled,
  Error,
};

struct DllTaskContext {
  std::mutex mutex;
  bool active = true;
  bool cancelling = false;
  bool invocation_finished = false;
  bool terminal_signal_seen = false;
  bool quiesced = false;
  std::atomic_size_t active_callback_bridges{0};
  DllTaskMode mode = DllTaskMode::Async;
  DllTaskState state = DllTaskState::Invoking;
  int progress = 0;
  std::string plugin_id;
  std::string dll_id;
  std::string task_id;
  std::string function_name;
  std::string error;
  std::optional<std::string> terminal_result;
  bool result_ready = false;
  std::optional<std::string> result;
  DllHostEventSink event_sink;
};

namespace {

std::string LowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

constexpr std::size_t kMaxPluginNameBytes = 256;
constexpr std::size_t kMaxVersionBytes = 64;
constexpr std::size_t kMaxAuthorBytes = 256;
constexpr std::size_t kMaxDescriptionBytes = 4096;
constexpr std::size_t kMaxFunctionNameBytes = 128;
constexpr std::size_t kMaxFunctionCount = 1024;
constexpr std::size_t kAbiEnvelopeBytes = 5;
constexpr std::size_t kMaxTaskCount = 256;
constexpr std::size_t kMaxInvocationThreads = 64;
constexpr std::size_t kMaxCallbackBytes = 256 * 1024;
constexpr std::uint32_t kMinimumShutdownDeadlineMs = 50;
constexpr std::uint32_t kMaximumShutdownDeadlineMs = 60'000;
constexpr std::uint32_t kUnloadWaitMs = 1'000;

enum class DllPluginErrorCode : std::int32_t {
  Success = 0,
  InitFailed = -1,
  FunctionNotFound = -2,
  InvalidParams = -3,
  InternalError = -4,
  NotLoaded = -5,
  FileNotFound = -6,
  PluginNotFound = -7,
};

struct DllPluginInfo {
  const char* plugin_name;
  const char* version;
  const char* author;
  const char* description;
  const char** function_names;
};

using InitFunction = DllPluginErrorCode(__cdecl*)();
using DestroyFunction = void(__cdecl*)();
using StopManagedProcessesFunction = DllPluginErrorCode(__cdecl*)(const char*, char**);
using GetInfoFunction = const DllPluginInfo*(__cdecl*)();
using CallFunction = DllPluginErrorCode(__cdecl*)(const char*, const char*, char**);
using ProgressCallback = void(__cdecl*)(const char*, int, const char*);
using ResultCallback = void(__cdecl*)(const char*, const char*);
using CallAsyncFunction = DllPluginErrorCode(__cdecl*)(const char*, const char*, ProgressCallback, char**);
using CallWithCallbackFunction = DllPluginErrorCode(__cdecl*)(const char*, const char*, ResultCallback);
using CancelTaskFunction = ztools::DllCancelFunction;

struct PluginInfoCopy {
  std::string plugin_name;
  std::string version;
  std::string author;
  std::string description;
  std::vector<std::string> function_names;
};

std::mutex g_callback_registry_mutex;
std::unordered_map<std::string, std::weak_ptr<DllTaskContext>> g_callback_registry;

struct ShutdownContext {
  std::mutex mutex;
  std::condition_variable condition;
  bool finished = false;
  bool completed = false;
  bool timed_out = false;
  std::size_t cancel_attempted = 0;
  std::size_t cancel_failed = 0;
  std::size_t stop_attempted = 0;
  std::size_t stop_failed = 0;
  std::size_t tasks_cleared = 0;
  std::size_t sessions_unloaded = 0;
  std::size_t remaining_tasks = 0;
  std::size_t remaining_active_invocations = 0;
  std::size_t internal_failures = 0;
};

DllHostResult Failure(std::string_view code, std::string_view message) {
  return {false, std::string(code), std::string(message), {}};
}

DllHostResult Success(std::vector<std::uint8_t> payload) {
  return {true, {}, {}, std::move(payload)};
}

bool IsValidUtf8(std::string_view value) {
  if (value.empty()) return true;
  if (value.size() > static_cast<std::size_t>(INT_MAX)) return false;
  return MultiByteToWideChar(
    CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
    nullptr, 0) > 0;
}

bool IsSafeFunctionName(std::string_view value) {
  if (value.empty() || value.size() > kMaxFunctionNameBytes) return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    const bool alpha = (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z');
    const bool digit = character >= '0' && character <= '9';
    if (!(alpha || digit || character == '_' || character == '-' || character == '.') ||
        (index == 0 && !alpha && character != '_')) {
      return false;
    }
  }
  return true;
}

bool CopyRequiredUtf8(const char* value, std::size_t maximum, std::string& output) {
  if (value == nullptr) return false;
  const std::size_t length = strnlen_s(value, maximum + 1);
  if (length == 0 || length > maximum) return false;
  output.assign(value, length);
  return IsValidUtf8(output) && output.find('\0') == std::string::npos;
}

bool CopyPluginInfo(const DllPluginInfo* source, PluginInfoCopy& output) {
  if (source == nullptr ||
      !CopyRequiredUtf8(source->plugin_name, kMaxPluginNameBytes, output.plugin_name) ||
      !CopyRequiredUtf8(source->version, kMaxVersionBytes, output.version) ||
      !CopyRequiredUtf8(source->author, kMaxAuthorBytes, output.author) ||
      !CopyRequiredUtf8(source->description, kMaxDescriptionBytes, output.description)) {
    return false;
  }
  if (source->function_names == nullptr) return true;
  std::set<std::string> unique_functions;
  bool terminated = false;
  for (std::size_t index = 0; index <= kMaxFunctionCount; ++index) {
    const char* function = source->function_names[index];
    if (function == nullptr) {
      terminated = true;
      break;
    }
    if (index == kMaxFunctionCount) return false;
    std::string name;
    if (!CopyRequiredUtf8(function, kMaxFunctionNameBytes, name) ||
        !IsSafeFunctionName(name) || !unique_functions.insert(name).second) {
      return false;
    }
    output.function_names.push_back(std::move(name));
  }
  return terminated;
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

std::vector<std::uint8_t> BuildInfoPayload(
  const PluginInfoCopy& info,
  bool supports_async,
  bool supports_callback,
  bool supports_cancel,
  bool supports_stop) {
  std::string json = "{\"pluginName\":" + JsonEscape(info.plugin_name) +
    ",\"version\":" + JsonEscape(info.version) +
    ",\"author\":" + JsonEscape(info.author) +
    ",\"description\":" + JsonEscape(info.description) +
    ",\"functions\":[";
  for (std::size_t index = 0; index < info.function_names.size(); ++index) {
    if (index != 0) json.push_back(',');
    json += JsonEscape(info.function_names[index]);
  }
  json += "],\"supportsAsync\":";
  json += supports_async ? "true" : "false";
  json += ",\"supportsCallback\":";
  json += supports_callback ? "true" : "false";
  json += ",\"supportsCancel\":";
  json += supports_cancel ? "true" : "false";
  json += ",\"supportsStopManagedProcesses\":";
  json += supports_stop ? "true}" : "false}";
  return {json.begin(), json.end()};
}

std::vector<std::uint8_t> BuildCallPayload(
  DllPluginErrorCode code,
  const std::optional<std::string_view>& result) {
  std::vector<std::uint8_t> payload;
  payload.reserve(kAbiEnvelopeBytes + (result ? result->size() : 0));
  const std::uint32_t raw = static_cast<std::uint32_t>(static_cast<std::int32_t>(code));
  payload.push_back(static_cast<std::uint8_t>(raw & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw >> 8U) & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw >> 16U) & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw >> 24U) & 0xffU));
  payload.push_back(result ? 1U : 0U);
  if (result) payload.insert(payload.end(), result->begin(), result->end());
  return payload;
}

bool IsSafeTaskId(std::string_view value) {
  if (value.size() < 6 || value.size() > kMaxFunctionNameBytes ||
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

bool TakeAbiResult(
  char* raw_result,
  std::optional<std::string>& result,
  std::string& error_code,
  std::string& error_message) {
  result.reset();
  if (raw_result == nullptr) return true;
  const std::size_t maximum = kMaxPayloadBytes - kAbiEnvelopeBytes;
  const std::size_t length = strnlen_s(raw_result, maximum + 1);
  if (length > maximum) {
    CoTaskMemFree(raw_result);
    error_code = "DLL_RESPONSE_TOO_LARGE";
    error_message = "dll result exceeds the native host response limit";
    return false;
  }
  result.emplace(raw_result, length);
  CoTaskMemFree(raw_result);
  if (!IsValidUtf8(*result)) {
    result.reset();
    error_code = "DLL_RESPONSE_INVALID";
    error_message = "dll result is not valid UTF-8";
    return false;
  }
  return true;
}

bool CopyCallbackText(
  const char* value,
  bool required,
  std::size_t maximum,
  std::string& output) {
  output.clear();
  if (value == nullptr) return !required;
  const std::size_t length = strnlen_s(value, maximum + 1);
  if (length > maximum || (required && length == 0)) return false;
  output.assign(value, length);
  return IsValidUtf8(output);
}

enum class CallbackEnvelopeKind {
  Unknown,
  Progress,
  Completed,
  Error,
  Cancelled,
  UnknownTyped,
};

struct CallbackEnvelope {
  CallbackEnvelopeKind kind = CallbackEnvelopeKind::Unknown;
  std::optional<int> progress;
};

void SkipJsonWhitespace(std::string_view json, std::size_t& position) {
  while (position < json.size() &&
         (json[position] == ' ' || json[position] == '\t' ||
          json[position] == '\r' || json[position] == '\n')) {
    ++position;
  }
}

bool ReadJsonString(
  std::string_view json,
  std::size_t& position,
  std::string& value) {
  if (position >= json.size() || json[position] != '"') return false;
  ++position;
  value.clear();
  while (position < json.size()) {
    const unsigned char character = static_cast<unsigned char>(json[position++]);
    if (character == '"') return true;
    if (character < 0x20) return false;
    if (character != '\\') {
      value.push_back(static_cast<char>(character));
      continue;
    }
    if (position >= json.size()) return false;
    const char escaped = json[position++];
    switch (escaped) {
      case '"': value.push_back('"'); break;
      case '\\': value.push_back('\\'); break;
      case '/': value.push_back('/'); break;
      case 'b': value.push_back('\b'); break;
      case 'f': value.push_back('\f'); break;
      case 'n': value.push_back('\n'); break;
      case 'r': value.push_back('\r'); break;
      case 't': value.push_back('\t'); break;
      case 'u': {
        if (position + 4 > json.size()) return false;
        unsigned int code_point = 0;
        for (int digit = 0; digit < 4; ++digit) {
          const char hex = json[position++];
          code_point <<= 4U;
          if (hex >= '0' && hex <= '9') code_point |= static_cast<unsigned int>(hex - '0');
          else if (hex >= 'a' && hex <= 'f') code_point |= static_cast<unsigned int>(hex - 'a' + 10);
          else if (hex >= 'A' && hex <= 'F') code_point |= static_cast<unsigned int>(hex - 'A' + 10);
          else return false;
        }
        if (code_point >= 0xd800U && code_point <= 0xdbffU) {
          if (position + 6 > json.size() || json[position] != '\\' ||
              json[position + 1] != 'u') {
            return false;
          }
          position += 2;
          unsigned int low_surrogate = 0;
          for (int digit = 0; digit < 4; ++digit) {
            const char hex = json[position++];
            low_surrogate <<= 4U;
            if (hex >= '0' && hex <= '9') low_surrogate |= static_cast<unsigned int>(hex - '0');
            else if (hex >= 'a' && hex <= 'f') low_surrogate |= static_cast<unsigned int>(hex - 'a' + 10);
            else if (hex >= 'A' && hex <= 'F') low_surrogate |= static_cast<unsigned int>(hex - 'A' + 10);
            else return false;
          }
          if (low_surrogate < 0xdc00U || low_surrogate > 0xdfffU) return false;
          code_point = 0x10000U + ((code_point - 0xd800U) << 10U) +
            (low_surrogate - 0xdc00U);
        } else if (code_point >= 0xdc00U && code_point <= 0xdfffU) {
          return false;
        }
        if (code_point <= 0x7fU) {
          value.push_back(static_cast<char>(code_point));
        } else if (code_point <= 0x7ffU) {
          value.push_back(static_cast<char>(0xc0U | (code_point >> 6U)));
          value.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
        } else if (code_point <= 0xffffU) {
          value.push_back(static_cast<char>(0xe0U | (code_point >> 12U)));
          value.push_back(static_cast<char>(0x80U | ((code_point >> 6U) & 0x3fU)));
          value.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
        } else {
          value.push_back(static_cast<char>(0xf0U | (code_point >> 18U)));
          value.push_back(static_cast<char>(0x80U | ((code_point >> 12U) & 0x3fU)));
          value.push_back(static_cast<char>(0x80U | ((code_point >> 6U) & 0x3fU)));
          value.push_back(static_cast<char>(0x80U | (code_point & 0x3fU)));
        }
        break;
      }
      default: return false;
    }
  }
  return false;
}

bool SkipJsonValue(std::string_view json, std::size_t& position, std::size_t depth) {
  if (depth > 32) return false;
  SkipJsonWhitespace(json, position);
  if (position >= json.size()) return false;
  if (json[position] == '"') {
    std::string ignored;
    return ReadJsonString(json, position, ignored);
  }
  if (json[position] == '{') {
    ++position;
    SkipJsonWhitespace(json, position);
    if (position < json.size() && json[position] == '}') {
      ++position;
      return true;
    }
    while (position < json.size()) {
      std::string key;
      if (!ReadJsonString(json, position, key)) return false;
      SkipJsonWhitespace(json, position);
      if (position >= json.size() || json[position++] != ':') return false;
      if (!SkipJsonValue(json, position, depth + 1)) return false;
      SkipJsonWhitespace(json, position);
      if (position < json.size() && json[position] == '}') {
        ++position;
        return true;
      }
      if (position >= json.size() || json[position++] != ',') return false;
      SkipJsonWhitespace(json, position);
    }
    return false;
  }
  if (json[position] == '[') {
    ++position;
    SkipJsonWhitespace(json, position);
    if (position < json.size() && json[position] == ']') {
      ++position;
      return true;
    }
    while (position < json.size()) {
      if (!SkipJsonValue(json, position, depth + 1)) return false;
      SkipJsonWhitespace(json, position);
      if (position < json.size() && json[position] == ']') {
        ++position;
        return true;
      }
      if (position >= json.size() || json[position++] != ',') return false;
      SkipJsonWhitespace(json, position);
    }
    return false;
  }
  if (json.substr(position, 4) == "true") {
    position += 4;
    return true;
  }
  if (json.substr(position, 5) == "false") {
    position += 5;
    return true;
  }
  if (json.substr(position, 4) == "null") {
    position += 4;
    return true;
  }

  const std::size_t start = position;
  if (json[position] == '-') ++position;
  if (position >= json.size()) return false;
  if (json[position] == '0') {
    ++position;
    if (position < json.size() && json[position] >= '0' && json[position] <= '9') {
      return false;
    }
  } else {
    if (json[position] < '1' || json[position] > '9') return false;
    do {
      ++position;
    } while (position < json.size() && json[position] >= '0' && json[position] <= '9');
  }
  if (position < json.size() && json[position] == '.') {
    ++position;
    const std::size_t fraction_start = position;
    while (position < json.size() && json[position] >= '0' && json[position] <= '9') {
      ++position;
    }
    if (position == fraction_start) return false;
  }
  if (position < json.size() && (json[position] == 'e' || json[position] == 'E')) {
    ++position;
    if (position < json.size() && (json[position] == '+' || json[position] == '-')) ++position;
    const std::size_t exponent_start = position;
    while (position < json.size() && json[position] >= '0' && json[position] <= '9') {
      ++position;
    }
    if (position == exponent_start) return false;
  }
  return position > start;
}

void KeepMaximumProgress(
  std::string_view json,
  std::size_t start,
  std::size_t end,
  std::optional<int>& progress) {
  int parsed_progress = 0;
  const auto parse_result = std::from_chars(
    json.data() + start, json.data() + end, parsed_progress);
  if (parse_result.ec != std::errc{} || parse_result.ptr != json.data() + end) return;
  const int bounded_progress = std::clamp(parsed_progress, 0, 100);
  progress = progress ? std::max(*progress, bounded_progress) : bounded_progress;
}

bool SkipJsonDataObject(
  std::string_view json,
  std::size_t& position,
  std::optional<int>& progress) {
  SkipJsonWhitespace(json, position);
  if (position >= json.size() || json[position] != '{') {
    return SkipJsonValue(json, position, 1);
  }
  ++position;
  SkipJsonWhitespace(json, position);
  if (position < json.size() && json[position] == '}') {
    ++position;
    return true;
  }
  while (position < json.size()) {
    std::string key;
    if (!ReadJsonString(json, position, key)) return false;
    SkipJsonWhitespace(json, position);
    if (position >= json.size() || json[position++] != ':') return false;
    SkipJsonWhitespace(json, position);
    const std::size_t value_start = position;
    if (!SkipJsonValue(json, position, 1)) return false;
    if (key == "progress" || key == "percent") {
      KeepMaximumProgress(json, value_start, position, progress);
    }
    SkipJsonWhitespace(json, position);
    if (position < json.size() && json[position] == '}') {
      ++position;
      return true;
    }
    if (position >= json.size() || json[position++] != ',') return false;
    SkipJsonWhitespace(json, position);
  }
  return false;
}

bool ParseCallbackEnvelope(
  std::string_view json,
  CallbackEnvelope& envelope,
  bool& top_level_type_seen) {
  CallbackEnvelope parsed;
  std::size_t position = 0;
  SkipJsonWhitespace(json, position);
  if (position >= json.size() || json[position++] != '{') return false;
  top_level_type_seen = false;
  SkipJsonWhitespace(json, position);
  if (position < json.size() && json[position] == '}') {
    ++position;
    SkipJsonWhitespace(json, position);
    if (position != json.size()) return false;
    envelope = parsed;
    return true;
  }
  while (position < json.size()) {
    std::string key;
    if (!ReadJsonString(json, position, key)) return false;
    SkipJsonWhitespace(json, position);
    if (position >= json.size() || json[position++] != ':') return false;
    SkipJsonWhitespace(json, position);
    const std::size_t value_start = position;
    if (key == "type") {
      if (top_level_type_seen) return false;
      top_level_type_seen = true;
      std::string type;
      if (!ReadJsonString(json, position, type)) return false;
      if (type == "progress") parsed.kind = CallbackEnvelopeKind::Progress;
      else if (type == "completed") parsed.kind = CallbackEnvelopeKind::Completed;
      else if (type == "error") parsed.kind = CallbackEnvelopeKind::Error;
      else if (type == "cancelled") parsed.kind = CallbackEnvelopeKind::Cancelled;
      else parsed.kind = CallbackEnvelopeKind::UnknownTyped;
    } else if (key == "progress" || key == "percent") {
      if (!SkipJsonValue(json, position, 0)) return false;
      KeepMaximumProgress(json, value_start, position, parsed.progress);
    } else if (key == "data") {
      if (!SkipJsonDataObject(json, position, parsed.progress)) return false;
    } else if (!SkipJsonValue(json, position, 0)) {
      return false;
    }
    SkipJsonWhitespace(json, position);
    if (position < json.size() && json[position] == '}') {
      ++position;
      SkipJsonWhitespace(json, position);
      if (position != json.size()) return false;
      envelope = parsed;
      return true;
    }
    if (position >= json.size() || json[position++] != ',') return false;
    SkipJsonWhitespace(json, position);
  }
  return false;
}

bool IsTerminalState(DllTaskState state) {
  return state == DllTaskState::Completed || state == DllTaskState::Cancelled ||
    state == DllTaskState::Error;
}

void CacheTerminalResultLocked(
  const std::shared_ptr<DllTaskContext>& task,
  std::string_view result) {
  if (!IsTerminalState(task->state) || task->terminal_result ||
      result.size() > kMaxCallbackBytes || !IsValidUtf8(result)) {
    return;
  }
  task->terminal_result.emplace(result);
}

void UpdateTaskQuiescenceLocked(const std::shared_ptr<DllTaskContext>& task) {
  if (task->invocation_finished && task->terminal_signal_seen &&
      task->active_callback_bridges.load(std::memory_order_acquire) == 0) {
    task->quiesced = true;
  }
}

struct CallbackBridgeLease {
  explicit CallbackBridgeLease(std::shared_ptr<DllTaskContext> context)
      : task(std::move(context)) {}

  ~CallbackBridgeLease() {
    task->active_callback_bridges.fetch_sub(1, std::memory_order_acq_rel);
    std::lock_guard lock(task->mutex);
    UpdateTaskQuiescenceLocked(task);
  }

  std::shared_ptr<DllTaskContext> task;
};

bool DisableCallbackTask(const std::shared_ptr<DllTaskContext>& task) {
  std::lock_guard registry_lock(g_callback_registry_mutex);
  std::lock_guard task_lock(task->mutex);
  if (!task->quiesced ||
      task->active_callback_bridges.load(std::memory_order_acquire) != 0) {
    return false;
  }
  task->active = false;
  const auto found = g_callback_registry.find(task->task_id);
  if (found != g_callback_registry.end() && found->second.lock() == task) {
    g_callback_registry.erase(found);
  }
  return true;
}

std::shared_ptr<DllTaskContext> FindCallbackTask(const char* raw_task_id) {
  std::string task_id;
  if (!CopyCallbackText(raw_task_id, true, kMaxFunctionNameBytes, task_id) ||
      !IsSafeTaskId(task_id)) {
    return {};
  }
  std::lock_guard lock(g_callback_registry_mutex);
  const auto found = g_callback_registry.find(task_id);
  if (found == g_callback_registry.end()) return {};
  auto task = found->second.lock();
  if (task) task->active_callback_bridges.fetch_add(1, std::memory_order_acq_rel);
  return task;
}

void EmitTaskEventLocked(
  const std::shared_ptr<DllTaskContext>& task,
  std::string_view method,
  std::vector<std::uint8_t> payload) {
  if (!task->active || !task->event_sink) return;
  try {
    task->event_sink({
      task->plugin_id,
      task->dll_id,
      task->task_id,
      std::string(method),
      std::move(payload),
    });
  } catch (...) {
    task->active = false;
    if (!IsTerminalState(task->state)) {
      task->state = DllTaskState::Error;
      task->error = "native host event sink failed";
    }
    task->cancelling = false;
    task->terminal_signal_seen = true;
  }
}

void EmitTaskErrorLocked(
  const std::shared_ptr<DllTaskContext>& task,
  std::string_view message) {
  if (task->state == DllTaskState::Completed ||
      task->state == DllTaskState::Cancelled || task->state == DllTaskState::Error) {
    return;
  }
  task->state = DllTaskState::Error;
  task->progress = 100;
  task->error = std::string(message);
  task->terminal_signal_seen = true;
  if (task->invocation_finished) task->quiesced = true;
  EmitTaskEventLocked(task, "dll_task_error", Bytes(message));
}

void __cdecl ProgressCallbackBridge(const char* raw_task_id, int percent, const char* raw_message) {
  const auto task = FindCallbackTask(raw_task_id);
  if (!task) return;
  CallbackBridgeLease callback_lease(task);
  if (task->mode != DllTaskMode::Async || percent < -1 || percent > 100) return;
  std::string message;
  if (!CopyCallbackText(raw_message, false, kMaxCallbackBytes, message)) return;

  std::lock_guard lock(task->mutex);
  if (!task->active || IsTerminalState(task->state)) return;
  task->progress = percent < 0 ? 100 : std::max(task->progress, percent);
  const bool cancelled = percent < 0 && (message == "cancelled" || message == "canceled");
  if (percent < 0) {
    task->state = cancelled ? DllTaskState::Cancelled : DllTaskState::Error;
    task->cancelling = false;
    if (task->state == DllTaskState::Error) task->error = message;
    task->terminal_signal_seen = true;
  } else if (percent >= 100) {
    // A progress callback is not the ABI call's final result.
    task->state = DllTaskState::Running;
  } else {
    task->state = DllTaskState::Running;
  }
  std::vector<std::uint8_t> payload;
  payload.reserve(4 + message.size());
  const std::uint32_t raw_percent = static_cast<std::uint32_t>(percent);
  payload.push_back(static_cast<std::uint8_t>(raw_percent & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw_percent >> 8U) & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw_percent >> 16U) & 0xffU));
  payload.push_back(static_cast<std::uint8_t>((raw_percent >> 24U) & 0xffU));
  payload.insert(payload.end(), message.begin(), message.end());
  if (cancelled) {
    EmitTaskEventLocked(task, "dll_cancelled", BuildCallPayload(
      DllPluginErrorCode::Success, std::nullopt));
  } else {
    EmitTaskEventLocked(task, "dll_progress", std::move(payload));
  }
  UpdateTaskQuiescenceLocked(task);
}

void __cdecl ResultCallbackBridge(const char* raw_task_id, const char* raw_result) {
  const auto task = FindCallbackTask(raw_task_id);
  if (!task) return;
  CallbackBridgeLease callback_lease(task);
  if (task->mode != DllTaskMode::Callback) return;
  std::string result;
  if (!CopyCallbackText(raw_result, true, kMaxCallbackBytes, result)) return;
  CallbackEnvelope envelope;
  bool top_level_type_seen = false;
  if (!ParseCallbackEnvelope(result, envelope, top_level_type_seen) &&
      top_level_type_seen) {
    // A malformed typed envelope cannot prove that the callback has finished.
    envelope.kind = CallbackEnvelopeKind::UnknownTyped;
  }

  std::lock_guard lock(task->mutex);
  if (!task->active) return;
  if (IsTerminalState(task->state)) {
    if (envelope.kind != CallbackEnvelopeKind::Progress) {
      task->terminal_signal_seen = true;
      UpdateTaskQuiescenceLocked(task);
    }
    return;
  }

  switch (envelope.kind) {
    case CallbackEnvelopeKind::Progress:
      task->state = DllTaskState::Running;
      if (envelope.progress) task->progress = std::max(task->progress, *envelope.progress);
      break;
    case CallbackEnvelopeKind::Completed:
      task->state = DllTaskState::Completed;
      task->progress = 100;
      task->cancelling = false;
      task->terminal_signal_seen = true;
      break;
    case CallbackEnvelopeKind::Error:
      task->state = DllTaskState::Error;
      task->progress = 100;
      task->cancelling = false;
      task->error = result;
      task->terminal_signal_seen = true;
      break;
    case CallbackEnvelopeKind::Cancelled:
      task->state = DllTaskState::Cancelled;
      task->progress = 100;
      task->cancelling = false;
      task->terminal_signal_seen = true;
      break;
    case CallbackEnvelopeKind::Unknown:
      task->state = DllTaskState::Completed;
      task->progress = 100;
      task->cancelling = false;
      task->terminal_signal_seen = true;
      break;
    case CallbackEnvelopeKind::UnknownTyped:
      task->state = DllTaskState::Running;
      break;
  }
  if (IsTerminalState(task->state)) CacheTerminalResultLocked(task, result);
  EmitTaskEventLocked(task, "dll_callback_result", Bytes(result));
  UpdateTaskQuiescenceLocked(task);
}

std::string_view TaskModeName(DllTaskMode mode) {
  return mode == DllTaskMode::Async ? "async" : "callback";
}

std::string_view TaskStateName(DllTaskState state) {
  switch (state) {
    case DllTaskState::Invoking: return "invoking";
    case DllTaskState::Running: return "running";
    case DllTaskState::Completed: return "completed";
    case DllTaskState::Cancelled: return "cancelled";
    case DllTaskState::Error: return "error";
  }
  return "error";
}

std::vector<std::uint8_t> BuildShutdownPayload(const ShutdownContext& context) {
  std::string json = "{\"completed\":";
  json += context.completed ? "true" : "false";
  json += ",\"timedOut\":";
  json += context.timed_out ? "true" : "false";
  json += ",\"cancelAttempted\":" + std::to_string(context.cancel_attempted) +
    ",\"cancelFailed\":" + std::to_string(context.cancel_failed) +
    ",\"stopAttempted\":" + std::to_string(context.stop_attempted) +
    ",\"stopFailed\":" + std::to_string(context.stop_failed) +
    ",\"tasksCleared\":" + std::to_string(context.tasks_cleared) +
    ",\"sessionsUnloaded\":" + std::to_string(context.sessions_unloaded) +
    ",\"remainingTasks\":" + std::to_string(context.remaining_tasks) +
    ",\"remainingActiveInvocations\":" +
      std::to_string(context.remaining_active_invocations) +
    ",\"internalFailures\":" + std::to_string(context.internal_failures) + "}";
  return {json.begin(), json.end()};
}

std::string SessionKey(std::string_view plugin_id, std::string_view dll_id) {
  std::string key = LowerAscii(std::string(plugin_id));
  key.push_back('\0');
  key.append(LowerAscii(std::string(dll_id)));
  return key;
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return left.size() == right.size() && CompareStringOrdinal(
    left.data(), static_cast<int>(left.size()),
    right.data(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

}  // namespace

enum class SessionUnloadState {
  Loaded,
  Stopping,
  Destroying,
  FailedRetryable,
  FailedPermanent,
  Unloaded,
};

struct DllHost::Session : std::enable_shared_from_this<DllHost::Session> {
  std::string plugin_id;
  std::string dll_id;
  std::wstring path;
  HANDLE validation_handle = INVALID_HANDLE_VALUE;
  HMODULE module = nullptr;
  bool initialized = false;
  InitFunction init = nullptr;
  DestroyFunction destroy = nullptr;
  StopManagedProcessesFunction stop_managed_processes = nullptr;
  GetInfoFunction get_info = nullptr;
  CallFunction call = nullptr;
  CallAsyncFunction call_async = nullptr;
  CallWithCallbackFunction call_with_callback = nullptr;
  CancelTaskFunction cancel_task = nullptr;
  PluginInfoCopy info;
  std::atomic_size_t active_invocations{0};
  mutable std::mutex lifecycle_mutex;
  std::condition_variable lifecycle_condition;
  SessionUnloadState unload_state = SessionUnloadState::Loaded;
  std::string unload_error;

  ~Session() { Reset(); }

  void Reset() noexcept {
    {
      std::lock_guard lock(lifecycle_mutex);
      if (unload_state != SessionUnloadState::Loaded &&
          unload_state != SessionUnloadState::Unloaded) {
        // Keep a failed or unfinished plugin mapped until process teardown.
        initialized = false;
        module = nullptr;
        if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
          CloseHandle(validation_handle);
          validation_handle = INVALID_HANDLE_VALUE;
        }
        return;
      }
    }
    if (initialized && destroy != nullptr) {
      try {
        destroy();
      } catch (...) {
        // A plugin exception cannot skip module and handle cleanup.
      }
    }
    initialized = false;
    if (module != nullptr) {
      FreeLibrary(module);
      module = nullptr;
    }
    if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
      CloseHandle(validation_handle);
      validation_handle = INVALID_HANDLE_VALUE;
    }
  }

  SessionUnloadState State() const {
    std::lock_guard lock(lifecycle_mutex);
    return unload_state;
  }

  void AbandonUnsafe() noexcept {
    std::lock_guard lock(lifecycle_mutex);
    if (unload_state == SessionUnloadState::Unloaded) return;
    unload_state = SessionUnloadState::FailedPermanent;
    initialized = false;
    module = nullptr;
    if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
      CloseHandle(validation_handle);
      validation_handle = INVALID_HANDLE_VALUE;
    }
  }

  SessionUnloadState WaitUntil(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(lifecycle_mutex);
    lifecycle_condition.wait_until(lock, deadline, [&]() {
      return unload_state != SessionUnloadState::Stopping &&
        unload_state != SessionUnloadState::Destroying;
    });
    return unload_state;
  }

  bool StartUnload(bool request_managed_process_stop, std::string reason, std::uint32_t deadline_ms) {
    {
      std::lock_guard lock(lifecycle_mutex);
      if (unload_state == SessionUnloadState::Unloaded ||
          unload_state == SessionUnloadState::Stopping ||
          unload_state == SessionUnloadState::Destroying ||
          unload_state == SessionUnloadState::FailedPermanent) {
        return false;
      }
      unload_state = request_managed_process_stop && this->stop_managed_processes != nullptr
        ? SessionUnloadState::Stopping
        : SessionUnloadState::Destroying;
      unload_error.clear();
    }

    const auto session = shared_from_this();
    try {
      std::thread([session, request_managed_process_stop, reason = std::move(reason), deadline_ms]() {
        const auto finish = [&](SessionUnloadState state, std::string error = {}) {
          {
            std::lock_guard lock(session->lifecycle_mutex);
            session->unload_state = state;
            session->unload_error = std::move(error);
          }
          session->lifecycle_condition.notify_all();
        };

        if (request_managed_process_stop && session->stop_managed_processes != nullptr) {
          const std::string params = "{\"reason\":" + JsonEscape(reason) +
            ",\"deadlineMs\":" + std::to_string(deadline_ms) + "}";
          char* raw_result = nullptr;
          const DllPluginErrorCode code = session->stop_managed_processes(
            params.c_str(), &raw_result);
          std::optional<std::string> result;
          std::string error_code;
          std::string error_message;
          const bool result_valid = TakeAbiResult(
            raw_result, result, error_code, error_message);
          if (code != DllPluginErrorCode::Success || !result_valid) {
            finish(
              SessionUnloadState::FailedRetryable,
              code != DllPluginErrorCode::Success
                ? "managed process stop returned error " +
                    std::to_string(static_cast<std::int32_t>(code))
                : error_code + ": " + error_message);
            return;
          }
        }

        {
          std::lock_guard lock(session->lifecycle_mutex);
          session->unload_state = SessionUnloadState::Destroying;
        }
        session->lifecycle_condition.notify_all();
        if (session->initialized && session->destroy != nullptr) {
          try {
            session->destroy();
          } catch (...) {
            finish(SessionUnloadState::FailedPermanent, "dll destroy raised an exception");
            return;
          }
        }
        session->initialized = false;
        if (session->module != nullptr) {
          if (!FreeLibrary(session->module)) {
            finish(SessionUnloadState::FailedPermanent, "FreeLibrary failed after dll destroy");
            return;
          }
          session->module = nullptr;
        }
        if (session->validation_handle != INVALID_HANDLE_VALUE &&
            session->validation_handle != nullptr) {
          CloseHandle(session->validation_handle);
          session->validation_handle = INVALID_HANDLE_VALUE;
        }
        finish(SessionUnloadState::Unloaded);
      }).detach();
    } catch (...) {
      std::lock_guard lock(lifecycle_mutex);
      unload_state = SessionUnloadState::FailedRetryable;
      unload_error = "native host could not start bounded dll cleanup";
      lifecycle_condition.notify_all();
      return false;
    }
    return true;
  }
};

struct DllHost::InvocationThread {
  std::atomic_bool finished{false};
  std::thread thread;

  ~InvocationThread() {
    if (thread.joinable()) thread.join();
  }
};

struct DllHost::ShutdownThread {
  std::shared_ptr<ShutdownContext> context;
  std::thread thread;

  ~ShutdownThread() {
    if (thread.joinable()) thread.join();
  }
};

DllHost::DllHost(const DllResolver& manifest, DllHostEventSink event_sink)
    : manifest_(manifest), event_sink_(std::move(event_sink)) {}

DllHost::~DllHost() {
  stopping_.store(true, std::memory_order_release);
  if (shutdown_thread_ && shutdown_thread_->thread.joinable()) {
    shutdown_thread_->thread.join();
  }
  shutdown_thread_.reset();
  const bool tasks_cleared = ClearTaskRegistry();
  const bool no_active_invocations = std::all_of(
    sessions_.begin(), sessions_.end(), [](const auto& session) {
      return session.second->active_invocations.load(std::memory_order_acquire) == 0;
    });
  if (!tasks_cleared || !no_active_invocations || !sessions_.empty()) {
    for (auto& session : sessions_) session.second->AbandonUnsafe();
    for (auto& invocation : invocation_threads_) {
      if (!invocation->thread.joinable()) continue;
      if (invocation->finished.load(std::memory_order_acquire)) {
        invocation->thread.join();
      } else {
        invocation->thread.detach();
        invocation.release();
      }
    }
    invocation_threads_.clear();
    tasks_.clear();
    sessions_.clear();
    return;
  }
  for (auto& invocation : invocation_threads_) {
    if (invocation->thread.joinable()) invocation->thread.join();
  }
  invocation_threads_.clear();
}

DllHostShutdownResult DllHost::Shutdown(std::uint32_t deadline_ms) {
  deadline_ms = std::clamp(
    deadline_ms, kMinimumShutdownDeadlineMs, kMaximumShutdownDeadlineMs);
  const auto deadline = std::chrono::steady_clock::now() +
    std::chrono::milliseconds(deadline_ms);

  if (!stopping_.exchange(true, std::memory_order_acq_rel)) {
    auto shutdown = std::make_unique<ShutdownThread>();
    shutdown->context = std::make_shared<ShutdownContext>();
    {
      std::lock_guard context_lock(shutdown->context->mutex);
      shutdown->context->remaining_tasks = tasks_.size();
      for (const auto& session : sessions_) {
        shutdown->context->remaining_active_invocations +=
          session.second->active_invocations.load(std::memory_order_acquire);
      }
    }
    const auto context = shutdown->context;
    shutdown->thread = std::thread([this, context, deadline]() {
      const auto finish = [&](bool completed, bool timed_out) {
        {
          std::lock_guard context_lock(context->mutex);
          context->completed = completed;
          context->timed_out = timed_out;
          context->finished = true;
        }
        context->condition.notify_all();
      };
      const auto timed_out = [&]() {
        return std::chrono::steady_clock::now() >= deadline;
      };
      const auto active_invocations = [&]() {
        std::size_t active = 0;
        for (const auto& session : sessions_) {
          active += session.second->active_invocations.load(std::memory_order_acquire);
        }
        return active;
      };

      try {
        std::vector<std::tuple<std::string, std::string, std::string>> cancellable_tasks;
        cancellable_tasks.reserve(tasks_.size());
        for (const auto& entry : tasks_) {
          const auto& task = entry.second;
          std::lock_guard task_lock(task->mutex);
          if (task->active && !task->cancelling &&
              task->state != DllTaskState::Completed &&
              task->state != DllTaskState::Cancelled &&
              task->state != DllTaskState::Error) {
            cancellable_tasks.emplace_back(task->plugin_id, task->dll_id, task->task_id);
          }
        }

        for (const auto& [plugin_id, dll_id, task_id] : cancellable_tasks) {
          if (timed_out()) {
            finish(false, true);
            return;
          }
          {
            std::lock_guard context_lock(context->mutex);
            ++context->cancel_attempted;
          }
          const DllHostResult result = CancelTask(plugin_id, dll_id, task_id);
          bool cancelled = result.success && result.payload.size() >= kAbiEnvelopeBytes;
          if (cancelled) {
            const std::uint32_t code = static_cast<std::uint32_t>(result.payload[0]) |
              (static_cast<std::uint32_t>(result.payload[1]) << 8U) |
              (static_cast<std::uint32_t>(result.payload[2]) << 16U) |
              (static_cast<std::uint32_t>(result.payload[3]) << 24U);
            cancelled = code == 0;
          }
          if (!cancelled) {
            std::lock_guard context_lock(context->mutex);
            ++context->cancel_failed;
          }
        }

        for (;;) {
          const std::size_t active = active_invocations();
          {
            std::lock_guard context_lock(context->mutex);
            context->remaining_active_invocations = active;
          }
          if (active == 0) break;
          if (timed_out()) {
            finish(false, true);
            return;
          }
          Sleep(10);
        }

        for (const auto& entry : sessions_) {
          const auto& session = entry.second;
          auto state = session->State();
          if (state == SessionUnloadState::Stopping ||
              state == SessionUnloadState::Destroying) {
            state = session->WaitUntil(deadline);
            if (state == SessionUnloadState::Unloaded) continue;
          }
          if (timed_out() || state == SessionUnloadState::FailedPermanent) {
            finish(false, true);
            return;
          }
          if (state == SessionUnloadState::Unloaded) continue;
          if (session->stop_managed_processes == nullptr) continue;
          {
            std::lock_guard context_lock(context->mutex);
            ++context->stop_attempted;
          }
          const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now());
          const auto remaining_ms = std::max<std::int64_t>(1, remaining.count());
          const std::string params = "{\"reason\":\"host_shutdown\",\"deadlineMs\":" +
            std::to_string(remaining_ms) + "}";
          char* raw_result = nullptr;
          const DllPluginErrorCode code = session->stop_managed_processes(
            params.c_str(), &raw_result);
          std::optional<std::string> result;
          std::string error_code;
          std::string error_message;
          const bool result_valid = TakeAbiResult(
            raw_result, result, error_code, error_message);
          if (code != DllPluginErrorCode::Success || !result_valid) {
            std::lock_guard context_lock(context->mutex);
            ++context->stop_failed;
            continue;
          }
          for (const auto& task_entry : tasks_) {
            const auto& task = task_entry.second;
            if (SessionKey(task->plugin_id, task->dll_id) != entry.first) {
              continue;
            }
            std::lock_guard task_lock(task->mutex);
            if (!IsTerminalState(task->state)) {
              task->state = DllTaskState::Cancelled;
              task->progress = 100;
              task->cancelling = false;
              EmitTaskEventLocked(task, "dll_cancelled", BuildCallPayload(
                DllPluginErrorCode::Success, std::nullopt));
            }
            task->terminal_signal_seen = true;
            UpdateTaskQuiescenceLocked(task);
          }
          if (timed_out()) {
            finish(false, true);
            return;
          }
        }

        bool stop_failed = false;
        {
          std::lock_guard context_lock(context->mutex);
          stop_failed = context->stop_failed != 0;
        }
        if (stop_failed) {
          finish(false, true);
          return;
        }
        for (const auto& entry : tasks_) {
          std::lock_guard task_lock(entry.second->mutex);
          if (!entry.second->quiesced) {
            finish(false, true);
            return;
          }
        }

        const std::size_t tasks_cleared = tasks_.size();
        if (!ClearTaskRegistry()) {
          finish(false, true);
          return;
        }
        for (auto& invocation : invocation_threads_) {
          if (invocation->thread.joinable()) invocation->thread.join();
        }
        invocation_threads_.clear();
        std::size_t sessions_unloaded = 0;
        for (const auto& entry : sessions_) {
          auto state = entry.second->State();
          if (state == SessionUnloadState::Unloaded) {
            ++sessions_unloaded;
            continue;
          }
          const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now());
          const auto remaining_ms = static_cast<std::uint32_t>(
            std::max<std::int64_t>(1, remaining.count()));
          if (state == SessionUnloadState::Loaded ||
              state == SessionUnloadState::FailedRetryable) {
            entry.second->StartUnload(false, "host_shutdown", remaining_ms);
          }
          state = entry.second->WaitUntil(deadline);
          if (state != SessionUnloadState::Unloaded || timed_out()) {
            finish(false, true);
            return;
          }
          ++sessions_unloaded;
        }
        UnloadAll();
        {
          std::lock_guard context_lock(context->mutex);
          context->tasks_cleared = tasks_cleared;
          context->sessions_unloaded = sessions_unloaded;
          context->remaining_tasks = 0;
          context->remaining_active_invocations = 0;
        }
        finish(true, std::chrono::steady_clock::now() > deadline);
      } catch (...) {
        {
          std::lock_guard context_lock(context->mutex);
          ++context->internal_failures;
        }
        finish(false, true);
      }
    });
    shutdown_thread_ = std::move(shutdown);
  }

  const auto context = shutdown_thread_->context;
  std::unique_lock context_lock(context->mutex);
  if (!context->finished) {
    context->condition.wait_until(context_lock, deadline, [&]() { return context->finished; });
  }
  if (!context->finished) context->timed_out = true;
  DllHostShutdownResult result{
    context->timed_out,
    BuildShutdownPayload(*context),
  };
  const bool finished = context->finished;
  context_lock.unlock();
  if (finished && shutdown_thread_->thread.joinable()) {
    shutdown_thread_->thread.join();
  }
  return result;
}

DllHostResult DllHost::ResolveSession(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::optional<std::string>& function_name,
  Session*& session) {
  session = nullptr;
  if (stopping_.load(std::memory_order_acquire)) {
    return Failure("HOST_STOPPING", "native dll host is stopping");
  }
  DllResolveResult resolution = manifest_.Resolve(plugin_id, dll_id, function_name);
  if (!resolution.success) return Failure(resolution.code, resolution.message);

  const std::string key = SessionKey(plugin_id, dll_id);
  const auto existing = sessions_.find(key);
  if (existing != sessions_.end()) {
    if (!SamePath(existing->second->path, resolution.path)) {
      return Failure("DLL_IDENTITY_CHANGED", "loaded dll path no longer matches the trusted manifest");
    }
    if (existing->second->State() != SessionUnloadState::Loaded) {
      return Failure("DLL_BUSY", "dll is stopping or unloading");
    }
    session = existing->second.get();
    return Success({});
  }

  auto candidate = std::make_shared<Session>();
  candidate->plugin_id = plugin_id;
  candidate->dll_id = dll_id;
  candidate->path = std::move(resolution.path);
  candidate->validation_handle = resolution.validation_handle;
  resolution.validation_handle = INVALID_HANDLE_VALUE;
  candidate->module = LoadLibraryExW(
    candidate->path.c_str(), nullptr,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  if (candidate->module == nullptr) {
    return Failure("DLL_LOAD_FAILED", "trusted dll could not be loaded");
  }

  candidate->init = reinterpret_cast<InitFunction>(
    GetProcAddress(candidate->module, "DllPlugin_Init"));
  candidate->destroy = reinterpret_cast<DestroyFunction>(
    GetProcAddress(candidate->module, "DllPlugin_Destroy"));
  candidate->stop_managed_processes = reinterpret_cast<StopManagedProcessesFunction>(
    GetProcAddress(candidate->module, "DllPlugin_StopManagedProcesses"));
  candidate->get_info = reinterpret_cast<GetInfoFunction>(
    GetProcAddress(candidate->module, "DllPlugin_GetInfo"));
  candidate->call = reinterpret_cast<CallFunction>(
    GetProcAddress(candidate->module, "DllPlugin_Call"));
  candidate->call_async = reinterpret_cast<CallAsyncFunction>(
    GetProcAddress(candidate->module, "DllPlugin_Call_Async"));
  candidate->call_with_callback = reinterpret_cast<CallWithCallbackFunction>(
    GetProcAddress(candidate->module, "DllPlugin_CallWithCallback"));
  candidate->cancel_task = reinterpret_cast<CancelTaskFunction>(
    GetProcAddress(candidate->module, "DllPlugin_CancelTask"));
  if (candidate->init == nullptr || candidate->destroy == nullptr ||
      candidate->get_info == nullptr || candidate->call == nullptr) {
    return Failure("DLL_EXPORTS_INVALID", "dll is missing a required ZTools ABI export");
  }

  const DllPluginErrorCode init_code = candidate->init();
  if (init_code != DllPluginErrorCode::Success) {
    return Failure("DLL_INIT_FAILED", "DllPlugin_Init returned error " +
      std::to_string(static_cast<std::int32_t>(init_code)));
  }
  candidate->initialized = true;
  if (!CopyPluginInfo(candidate->get_info(), candidate->info) ||
      LowerAscii(candidate->info.plugin_name) != LowerAscii(dll_id)) {
    return Failure("DLL_INFO_INVALID", "DllPlugin_GetInfo returned invalid or mismatched metadata");
  }

  session = candidate.get();
  sessions_.emplace(key, std::move(candidate));
  return Success({});
}

DllHostResult DllHost::GetInfo(const std::string& plugin_id, const std::string& dll_id) {
  try {
    Session* session = nullptr;
    DllHostResult resolved = ResolveSession(plugin_id, dll_id, std::nullopt, session);
    if (!resolved.success || session == nullptr) return resolved;
    return Success(BuildInfoPayload(
      session->info,
      session->call_async != nullptr || session->call != nullptr,
      session->call_with_callback != nullptr,
      session->cancel_task != nullptr,
      session->stop_managed_processes != nullptr));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while reading plugin metadata");
  }
}

DllHostResult DllHost::Call(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& function_name,
  const std::vector<std::uint8_t>& params_json) {
  try {
    if (!IsSafeFunctionName(function_name) || params_json.empty() ||
        params_json.size() > kMaxPayloadBytes - kAbiEnvelopeBytes ||
        std::find(params_json.begin(), params_json.end(), 0) != params_json.end()) {
      return Failure("INVALID_REQUEST", "dll call function or JSON payload is invalid");
    }
    const std::string params(params_json.begin(), params_json.end());
    if (!IsValidUtf8(params)) {
      return Failure("INVALID_REQUEST", "dll call JSON payload is not valid UTF-8");
    }

    Session* session = nullptr;
    DllHostResult resolved = ResolveSession(plugin_id, dll_id, function_name, session);
    if (!resolved.success || session == nullptr) return resolved;

    char* raw_result = nullptr;
    const DllPluginErrorCode code = session->call(
      function_name.c_str(), params.c_str(), &raw_result);
    std::optional<std::string> result;
    std::string error_code;
    std::string error_message;
    if (!TakeAbiResult(raw_result, result, error_code, error_message)) {
      return Failure(error_code, error_message);
    }
    return Success(BuildCallPayload(
      code, result ? std::optional<std::string_view>(*result) : std::nullopt));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed during synchronous call");
  }
}

DllHostResult DllHost::CallAsync(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id,
  const std::string& function_name,
  const std::vector<std::uint8_t>& params_json) {
  return StartTask(plugin_id, dll_id, task_id, function_name, params_json, false);
}

DllHostResult DllHost::CallWithCallback(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id,
  const std::string& function_name,
  const std::vector<std::uint8_t>& params_json) {
  return StartTask(plugin_id, dll_id, task_id, function_name, params_json, true);
}

DllHostResult DllHost::StartTask(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id,
  const std::string& function_name,
  const std::vector<std::uint8_t>& params_json,
  bool callback_mode) {
  try {
    if (!IsSafeTaskId(task_id) || !IsSafeFunctionName(function_name) ||
        params_json.empty() || params_json.size() > kMaxPayloadBytes - kAbiEnvelopeBytes ||
        std::find(params_json.begin(), params_json.end(), 0) != params_json.end()) {
      return Failure("INVALID_REQUEST", "dll task identifier, function, or JSON payload is invalid");
    }
    const std::string params(params_json.begin(), params_json.end());
    if (!IsValidUtf8(params)) {
      return Failure("INVALID_REQUEST", "dll task JSON payload is not valid UTF-8");
    }

    CleanupFinishedThreads();
    if (tasks_.size() >= kMaxTaskCount || invocation_threads_.size() >= kMaxInvocationThreads) {
      return Failure("DLL_TASK_LIMIT", "native dll task capacity is exhausted");
    }
    if (tasks_.contains(task_id)) {
      return Failure("DLL_TASK_DUPLICATE", "native dll task identifier is already registered");
    }

    Session* resolved_session = nullptr;
    DllHostResult resolved = ResolveSession(plugin_id, dll_id, function_name, resolved_session);
    if (!resolved.success || resolved_session == nullptr) return resolved;
    const auto session_entry = sessions_.find(SessionKey(plugin_id, dll_id));
    if (session_entry == sessions_.end() || session_entry->second.get() != resolved_session) {
      return Failure("DLL_HOST_INTERNAL", "native dll session ownership is invalid");
    }
    const auto session = session_entry->second;
    if ((!callback_mode && session->call_async == nullptr && session->call == nullptr) ||
        (callback_mode && session->call_with_callback == nullptr)) {
      return Failure(
        callback_mode ? "DLL_CALLBACK_UNSUPPORTED" : "DLL_ASYNC_UNSUPPORTED",
        callback_mode ? "dll does not export callback calls" : "dll does not export asynchronous calls");
    }

    auto invocation = std::make_unique<InvocationThread>();
    auto task = std::make_shared<DllTaskContext>();
    task->mode = callback_mode ? DllTaskMode::Callback : DllTaskMode::Async;
    task->plugin_id = plugin_id;
    task->dll_id = dll_id;
    task->task_id = task_id;
    task->function_name = function_name;
    task->event_sink = event_sink_;
    tasks_.emplace(task_id, task);
    try {
      std::lock_guard registry_lock(g_callback_registry_mutex);
      const auto existing = g_callback_registry.find(task_id);
      if (existing != g_callback_registry.end() && !existing->second.expired()) {
        tasks_.erase(task_id);
        return Failure("DLL_TASK_DUPLICATE", "native dll task identifier is already registered");
      }
      if (existing != g_callback_registry.end()) g_callback_registry.erase(existing);
      g_callback_registry.emplace(task_id, task);
    } catch (...) {
      tasks_.erase(task_id);
      throw;
    }

    InvocationThread* invocation_ptr = invocation.get();
    invocation_threads_.push_back(std::move(invocation));
    session->active_invocations.fetch_add(1, std::memory_order_relaxed);
    try {
      invocation_ptr->thread = std::thread([
        session,
        task,
        invocation_ptr,
        function_name,
        params,
        callback_mode
      ]() {
        DllPluginErrorCode code = DllPluginErrorCode::InternalError;
        std::optional<std::string> result;
        std::string error_code;
        std::string error_message;
        bool result_valid = true;
        try {
          if (callback_mode) {
            code = session->call_with_callback(
              function_name.c_str(), params.c_str(), &ResultCallbackBridge);
          } else {
            char* raw_result = nullptr;
            if (session->call_async != nullptr) {
              code = session->call_async(
                function_name.c_str(), params.c_str(), &ProgressCallbackBridge, &raw_result);
            } else {
              // Legacy DLLs only expose the synchronous ABI. Keep the invocation off
              // the request thread and expose it through the same task contract.
              code = session->call(
                function_name.c_str(), params.c_str(), &raw_result);
            }
            result_valid = TakeAbiResult(raw_result, result, error_code, error_message);
          }
        } catch (...) {
          result_valid = false;
          error_message = "native dll task invocation failed";
        }

        {
          std::lock_guard lock(task->mutex);
          if (!result_valid && task->active) {
            const std::string message = error_code.empty()
              ? error_message
              : error_code + ": " + error_message;
            EmitTaskErrorLocked(task, message);
          }
          if (task->active && code != DllPluginErrorCode::Success &&
              !IsTerminalState(task->state)) {
            EmitTaskErrorLocked(
              task,
              "dll task entry point returned error " +
                std::to_string(static_cast<std::int32_t>(code)));
          } else if (task->active && task->mode == DllTaskMode::Async &&
                     code == DllPluginErrorCode::Success && result_valid &&
                     !task->cancelling && !IsTerminalState(task->state)) {
            task->state = DllTaskState::Completed;
            task->progress = 100;
            task->terminal_signal_seen = true;
          } else if (task->active && task->state == DllTaskState::Invoking) {
            task->state = DllTaskState::Running;
          }
          if (task->mode == DllTaskMode::Async && result_valid && result &&
              IsTerminalState(task->state)) {
            CacheTerminalResultLocked(task, *result);
          }
          if (task->active && !callback_mode && result_valid &&
              code == DllPluginErrorCode::Success) {
            task->result_ready = true;
            task->result = result;
          }
          if (task->active && result_valid) {
            EmitTaskEventLocked(
              task,
              callback_mode ? "dll_callback_return" : "dll_async_return",
              BuildCallPayload(
                code,
                result ? std::optional<std::string_view>(*result) : std::nullopt));
          }
        }
        session->active_invocations.fetch_sub(1, std::memory_order_relaxed);
        {
          std::lock_guard lock(task->mutex);
          task->invocation_finished = true;
          if (code != DllPluginErrorCode::Success && !IsTerminalState(task->state)) {
            task->state = DllTaskState::Error;
            task->progress = 100;
            task->error = "dll task entry point returned error " +
              std::to_string(static_cast<std::int32_t>(code));
            task->terminal_signal_seen = true;
          } else if (task->mode == DllTaskMode::Async && task->active &&
                     code == DllPluginErrorCode::Success && result_valid &&
                     !task->cancelling && !IsTerminalState(task->state)) {
            task->state = DllTaskState::Completed;
            task->progress = 100;
            task->terminal_signal_seen = true;
          }
          if (task->mode == DllTaskMode::Async && result_valid && result &&
              IsTerminalState(task->state)) {
            CacheTerminalResultLocked(task, *result);
          }
          UpdateTaskQuiescenceLocked(task);
        }
        invocation_ptr->finished.store(true, std::memory_order_release);
      });
    } catch (...) {
      session->active_invocations.fetch_sub(1, std::memory_order_relaxed);
      {
        std::lock_guard lock(task->mutex);
        task->state = DllTaskState::Error;
        task->progress = 100;
        task->error = "native host could not start the dll task thread";
        task->invocation_finished = true;
        task->terminal_signal_seen = true;
        task->quiesced = true;
      }
      DisableCallbackTask(task);
      tasks_.erase(task_id);
      invocation_threads_.pop_back();
      throw;
    }
    return Success(Bytes(task_id));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while starting a task");
  }
}

DllHostResult DllHost::QueryTask(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id) {
  try {
    const auto found = tasks_.find(task_id);
    if (found == tasks_.end() || found->second->plugin_id != plugin_id ||
        found->second->dll_id != dll_id) {
      return Failure("DLL_TASK_NOT_FOUND", "native dll task was not found for this plugin");
    }
    const auto& task = found->second;
    std::lock_guard lock(task->mutex);
    std::string json = "{\"taskId\":" + JsonEscape(task->task_id) +
      ",\"mode\":" + JsonEscape(TaskModeName(task->mode)) +
      ",\"status\":" + JsonEscape(TaskStateName(task->state)) +
      ",\"progress\":" + std::to_string(task->progress) +
      ",\"functionName\":" + JsonEscape(task->function_name) +
      ",\"error\":" + (task->error.empty() ? "null" : JsonEscape(task->error));
    const bool has_result = task->result_ready || task->terminal_result.has_value();
    json += ",\"resultReady\":";
    json += has_result ? "true" : "false";
    json += ",\"result\":";
    if (task->result_ready) {
      json += task->result ? JsonEscape(*task->result) : "null";
    } else if (task->terminal_result && IsTerminalState(task->state)) {
      json += JsonEscape(*task->terminal_result);
    } else {
      json += "null";
    }
    json += "}";
    if (json.size() > kMaxPayloadBytes && !task->error.empty()) {
      json = "{\"taskId\":" + JsonEscape(task->task_id) +
        ",\"mode\":" + JsonEscape(TaskModeName(task->mode)) +
        ",\"status\":" + JsonEscape(TaskStateName(task->state)) +
        ",\"progress\":" + std::to_string(task->progress) +
        ",\"functionName\":" + JsonEscape(task->function_name) +
        ",\"error\":null,\"resultReady\":false,\"result\":null}";
    }
    if (json.size() > kMaxPayloadBytes) {
      return Failure("DLL_TASK_RESULT_TOO_LARGE", "dll task status exceeds the host payload limit");
    }
    return Success(Bytes(json));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while querying a task");
  }
}

DllHostResult DllHost::CancelTask(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id) {
  try {
    const auto found = tasks_.find(task_id);
    if (found == tasks_.end() || found->second->plugin_id != plugin_id ||
        found->second->dll_id != dll_id) {
      return Failure("DLL_TASK_NOT_FOUND", "native dll task was not found for this plugin");
    }
    const auto task = found->second;
    bool should_disable = false;
    {
      std::lock_guard lock(task->mutex);
      if (!task->active) {
        return Failure("DLL_TASK_NOT_RUNNING", "native dll task is not running");
      }
      if (task->state == DllTaskState::Cancelled) {
        return Success(BuildCallPayload(DllPluginErrorCode::Success, std::nullopt));
      }
      if (IsTerminalState(task->state)) {
        return Failure("DLL_TASK_NOT_RUNNING", "native dll task is not running");
      }
      if (task->cancelling) {
        return Success(BuildCallPayload(DllPluginErrorCode::Success, std::nullopt));
      }
      task->cancelling = true;
    }

    const auto session = sessions_.find(SessionKey(plugin_id, dll_id));
    if (session == sessions_.end() || session->second->cancel_task == nullptr) {
      std::lock_guard lock(task->mutex);
      if (!IsTerminalState(task->state)) task->cancelling = false;
      return Failure("DLL_CANCEL_UNSUPPORTED", "dll does not export task cancellation");
    }
    const auto code = static_cast<DllPluginErrorCode>(
      ztools::CancelDllTask(session->second->cancel_task, task_id));
    {
      std::lock_guard lock(task->mutex);
      if (code != DllPluginErrorCode::Success && !IsTerminalState(task->state)) {
        task->cancelling = false;
      }
    }
    if (should_disable) DisableCallbackTask(task);
    return Success(BuildCallPayload(code, std::nullopt));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while cancelling a task");
  }
}

DllHostResult DllHost::ClearTask(
  const std::string& plugin_id,
  const std::string& dll_id,
  const std::string& task_id) {
  try {
    const auto found = tasks_.find(task_id);
    if (found == tasks_.end() || found->second->plugin_id != plugin_id ||
        found->second->dll_id != dll_id) {
      return Failure("DLL_TASK_NOT_FOUND", "native dll task was not found for this plugin");
    }
    if (!DisableCallbackTask(found->second)) {
      return Failure("DLL_BUSY", "dll task has not reached a safe callback quiescence point");
    }
    tasks_.erase(found);
    CleanupFinishedThreads();
    return Success(Bytes("{\"success\":true}"));
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while clearing a task");
  }
}

DllHostResult DllHost::Unload(const std::string& plugin_id, const std::string& dll_id) {
  try {
    CleanupFinishedThreads();
    const bool has_tasks = std::any_of(tasks_.begin(), tasks_.end(), [&](const auto& entry) {
      return entry.second->plugin_id == plugin_id && entry.second->dll_id == dll_id;
    });
    if (has_tasks) {
      return Failure("DLL_BUSY", "dll still has registered asynchronous or callback tasks");
    }
    const auto session = sessions_.find(SessionKey(plugin_id, dll_id));
    if (session == sessions_.end()) return Success(Bytes("{\"success\":true}"));
    if (session->second->active_invocations.load(std::memory_order_acquire) != 0) {
      return Failure("DLL_BUSY", "dll still has active invocations");
    }
    const auto current = session->second->State();
    if (current == SessionUnloadState::Unloaded) {
      sessions_.erase(session);
      return Success(Bytes("{\"success\":true}"));
    }
    if (current == SessionUnloadState::FailedPermanent) {
      return Failure("DLL_BUSY", "dll cleanup failed; module remains loaded");
    }
    if (current == SessionUnloadState::Loaded ||
        current == SessionUnloadState::FailedRetryable) {
      session->second->StartUnload(
        true, "host_unload", kUnloadWaitMs);
    }
    const auto deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(kUnloadWaitMs);
    const auto final_state = session->second->WaitUntil(deadline);
    if (final_state == SessionUnloadState::Unloaded) {
      sessions_.erase(session);
      return Success(Bytes("{\"success\":true}"));
    }
    return Failure("DLL_BUSY", "dll cleanup is still in progress; module remains loaded");
  } catch (...) {
    return Failure("DLL_HOST_INTERNAL", "native dll host failed while unloading a plugin");
  }
}

void DllHost::CleanupFinishedThreads() {
  for (auto current = invocation_threads_.begin(); current != invocation_threads_.end();) {
    if ((*current)->finished.load(std::memory_order_acquire)) {
      current = invocation_threads_.erase(current);
    } else {
      ++current;
    }
  }
}

bool DllHost::ClearTaskRegistry() noexcept {
  for (const auto& entry : tasks_) {
    std::lock_guard task_lock(entry.second->mutex);
    if (!entry.second->quiesced ||
        entry.second->active_callback_bridges.load(std::memory_order_acquire) != 0) {
      return false;
    }
  }
  for (auto& entry : tasks_) {
    if (!DisableCallbackTask(entry.second)) return false;
  }
  tasks_.clear();
  return true;
}

void DllHost::UnloadAll() noexcept {
  sessions_.clear();
}

}  // namespace ztools::native_host
