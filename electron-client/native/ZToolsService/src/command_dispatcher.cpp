#include "ztools_service/command_dispatcher.hpp"
#include "ztools_service/console_log.hpp"

#include "ztools_service/privileged_dll_task_manager.hpp"
#include "ztools_service/service_command_protocol.hpp"

#include <Windows.h>
#include <objbase.h>

#include <cstring>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace ztools::service {
namespace {

CommandDispatchResult Failure(const std::string& code) {
  CommandDispatchResult result;
  result.code = code;
  return result;
}

void AppendUint16(
    std::vector<std::uint8_t>* const output,
    const std::uint16_t value) {
  output->push_back(static_cast<std::uint8_t>(value & 0xffU));
  output->push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
}

void AppendUint32(
    std::vector<std::uint8_t>* const output,
    const std::uint32_t value) {
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    output->push_back(static_cast<std::uint8_t>((value >> shift) & 0xffU));
  }
}

bool IsDllCommand(const ServiceCommandType type) noexcept {
  switch (type) {
    case ServiceCommandType::dll_call:
    case ServiceCommandType::dll_unload:
    case ServiceCommandType::dll_call_with_callback:
    case ServiceCommandType::dll_cancel_task:
    case ServiceCommandType::dll_clear_callback_task:
    case ServiceCommandType::dll_clear_plugin_session:
    case ServiceCommandType::dll_call_async:
    case ServiceCommandType::dll_query_task:
      return true;
    case ServiceCommandType::policy_check:
    case ServiceCommandType::registry_write:
    case ServiceCommandType::registry_delete:
    case ServiceCommandType::file_write:
    case ServiceCommandType::file_delete:
    case ServiceCommandType::file_copy:
    case ServiceCommandType::file_move:
    case ServiceCommandType::process_kill:
    case ServiceCommandType::restart_explorer:
    case ServiceCommandType::system_action:
    case ServiceCommandType::scheduled_task_set_enabled:
      return false;
    default:
      return false;
  }
}

bool IsValidUtf8(const std::string_view value) noexcept {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX) ||
      value.find('\0') != std::string_view::npos) {
    return false;
  }
  return MultiByteToWideChar(
             CP_UTF8,
             MB_ERR_INVALID_CHARS,
             value.data(),
             static_cast<int>(value.size()),
             nullptr,
             0) > 0;
}

using DllCallFunction = int(__cdecl*)(const char*, const char*, char**);

std::string SessionKey(std::string_view plugin_id, std::string_view dll_id) {
  std::string key = std::string(plugin_id) + "/" + std::string(dll_id);
  for (char& character : key) {
    if (character >= 'A' && character <= 'Z') character += 'a' - 'A';
  }
  return key;
}

}  // namespace

CommandDispatchResult CommandDispatcher::ExecuteDllCall(
    const ServiceCommandView& command) const {
  if (dll_loader_ == nullptr) {
    return Failure("DEPENDENCY_POLICY_UNAVAILABLE");
  }
  PrivilegedDllLoadResult loaded = dll_loader_->Load(
      std::string(command.plugin_id),
      std::string(command.dll_id),
      std::string(command.function_name));
  if (!loaded.success || loaded.module == nullptr) {
    return Failure(
        loaded.code.empty() ? "DLL_LOAD_FAILED" : loaded.code);
  }
  {
    std::lock_guard lock(dll_sessions_mutex_);
    dll_sessions_.try_emplace(SessionKey(command.plugin_id, command.dll_id), loaded.session);
  }
  const auto call = reinterpret_cast<DllCallFunction>(
      GetProcAddress(loaded.module, "DllPlugin_Call"));

  const std::string function_name(command.function_name);
  const std::string params(
      reinterpret_cast<const char*>(command.payload.data()),
      command.payload.size());
  char* raw_result = nullptr;
  const int call_result =
      call(function_name.c_str(), params.c_str(), &raw_result);
  const auto release_result = [&raw_result]() noexcept {
    if (raw_result != nullptr) {
      CoTaskMemFree(raw_result);
      raw_result = nullptr;
    }
  };
  if (call_result != 0) {
    release_result();
    return Failure("DLL_CALL_FAILED");
  }
  if (raw_result == nullptr) {
    return Failure("DLL_RESPONSE_INVALID");
  }
  const std::size_t length = strnlen_s(
      raw_result, kServiceMaxDllResponseBytes + 1);
  if (length > kServiceMaxDllResponseBytes) {
    ConsoleLog("DLL response exceeds limit: plugin=", command.plugin_id,
        " dll=", command.dll_id, " function=", command.function_name,
        " bytes>=", length, " limit=", kServiceMaxDllResponseBytes);
    release_result();
    return Failure("DLL_RESPONSE_TOO_LARGE");
  }
  const std::string_view result_view(raw_result, length);
  if (!IsValidUtf8(result_view)) {
    release_result();
    return Failure("DLL_RESPONSE_INVALID");
  }
  CommandDispatchResult result;
  result.success = true;
  try {
    result.payload.assign(result_view.begin(), result_view.end());
  } catch (...) {
    release_result();
    throw;
  }
  release_result();
  return result;
}

CommandDispatcher::CommandDispatcher(
    const PrivilegedDllResolver* const manifest,
    const PrivilegedDllLoader* const dll_loader,
    const CommandPolicy* const policy,
    ExplorerRestartExecutor* const explorer_restarter)
    : manifest_(manifest),
      dll_loader_(dll_loader),
      policy_(policy),
      explorer_restarter_(explorer_restarter),
      dll_tasks_(std::make_unique<PrivilegedDllTaskManager>(dll_loader)) {}

CommandDispatcher::~CommandDispatcher() = default;

HANDLE CommandDispatcher::TaskChangedEvent() const noexcept { return dll_tasks_->change_event(); }
std::vector<std::uint8_t> CommandDispatcher::TakeTaskChanges() const { return dll_tasks_->TakeChanges(); }

CommandDispatchResult CommandDispatcher::Dispatch(
    const std::span<const std::uint8_t> bytes,
    const DWORD client_session_id) const {
  ServiceCommandView command;
  switch (ParseServiceCommand(bytes, &command)) {
    case ServiceCommandParseResult::success:
      break;
    case ServiceCommandParseResult::invalid:
      return Failure("COMMAND_INVALID");
    case ServiceCommandParseResult::too_large:
      return Failure("COMMAND_TOO_LARGE");
    case ServiceCommandParseResult::not_allowed:
      return Failure("COMMAND_NOT_ALLOWED");
    default:
      return Failure("COMMAND_INVALID");
  }

  if (command.type == ServiceCommandType::policy_check) {
    std::uint16_t flags = 0;
    if (manifest_ != nullptr && manifest_->trusted()) {
      flags |= kServicePolicyFlagManifestTrusted;
    }
    if (dll_loader_ != nullptr && dll_loader_->system_only_ready()) {
      flags |= kServicePolicyFlagSystemOnlyDependencies;
    }
    CommandDispatchResult result;
    result.success = true;
    result.payload.reserve(12);
    AppendUint32(&result.payload, kServicePolicyStatusMagic);
    AppendUint16(&result.payload, kServicePolicyStatusVersion);
    AppendUint16(&result.payload, flags);
    AppendUint32(
        &result.payload,
        policy_ == nullptr
            ? 0
            : static_cast<std::uint32_t>(policy_->allowed_target_count()));
    return result;
  }

  if (command.type == ServiceCommandType::dll_subscribe_events) {
    const std::string result = "{\"events\":true}";
    return {true, {}, {result.begin(), result.end()}};
  }
  if (IsDllCommand(command.type)) {
    if (policy_ == nullptr) {
      return Failure("DLL_COMMAND_NOT_ALLOWED");
    }
    CommandPolicyResult dll_policy = policy_->CheckDll(
        command.type,
        command.plugin_id,
        command.dll_id,
        command.function_name);
    if (!dll_policy.allowed) {
      return Failure(dll_policy.code);
    }
    if (command.type == ServiceCommandType::dll_call) {
      return ExecuteDllCall(command);
    }
    const std::string plugin_id(command.plugin_id);
    const std::string dll_id(command.dll_id);
    if (command.type == ServiceCommandType::dll_call_async ||
        command.type == ServiceCommandType::dll_call_with_callback) {
      const std::string function_name(command.function_name);
      const std::vector<std::uint8_t> params(
          command.payload.begin(), command.payload.end());
      const auto result = dll_tasks_->Start(
          plugin_id,
          dll_id,
          function_name,
          params,
          command.type == ServiceCommandType::dll_call_with_callback);
      return {result.success, result.code, std::move(result.payload)};
    }
    const std::string task_id(
        reinterpret_cast<const char*>(command.payload.data()),
        command.payload.size());
    if (command.type == ServiceCommandType::dll_query_task) {
      const auto result = dll_tasks_->Query(plugin_id, dll_id, task_id);
      return {result.success, result.code, std::move(result.payload)};
    }
    if (command.type == ServiceCommandType::dll_cancel_task) {
      const auto result = dll_tasks_->Cancel(plugin_id, dll_id, task_id);
      return {result.success, result.code, std::move(result.payload)};
    }
    if (command.type == ServiceCommandType::dll_clear_callback_task) {
      const auto result = dll_tasks_->Clear(plugin_id, dll_id, task_id);
      return {result.success, result.code, std::move(result.payload)};
    }
    if (command.type == ServiceCommandType::dll_clear_plugin_session) {
      const auto result = dll_tasks_->ClearPlugin(plugin_id, dll_id);
      if (result.success) {
        std::lock_guard lock(dll_sessions_mutex_);
        dll_sessions_.erase(SessionKey(plugin_id, dll_id));
      }
      return {result.success, result.code, std::move(result.payload)};
    }
    if (command.type == ServiceCommandType::dll_unload) {
      const auto result = dll_tasks_->Unload(plugin_id, dll_id);
      if (result.success) {
        std::lock_guard lock(dll_sessions_mutex_);
        dll_sessions_.erase(SessionKey(plugin_id, dll_id));
      }
      return {result.success, result.code, std::move(result.payload)};
    }
    return Failure("DLL_COMMAND_NOT_ALLOWED");
  }

  if (IsBuiltinServiceCommand(command.type)) {
    if (policy_ == nullptr) {
      return Failure("TARGET_NOT_ALLOWED");
    }
    CommandPolicyResult policy = policy_->Check(
        command.type, command.plugin_id, command.target_id);
    if (!policy.allowed) {
      return Failure(policy.code);
    }
    if (command.type == ServiceCommandType::restart_explorer) {
      if (explorer_restarter_ == nullptr) {
        return Failure("EXPLORER_RESTART_UNAVAILABLE");
      }
      ExplorerRestartResult restarted =
          explorer_restarter_->Restart(client_session_id);
      if (!restarted.success) {
        return Failure(restarted.code);
      }
      constexpr std::string_view response = "{\"success\":true}";
      CommandDispatchResult result;
      result.success = true;
      result.payload.assign(response.begin(), response.end());
      return result;
    }
    return Failure("TARGET_NOT_ALLOWED");
  }
  return Failure("COMMAND_NOT_ALLOWED");
}

}  // namespace ztools::service
