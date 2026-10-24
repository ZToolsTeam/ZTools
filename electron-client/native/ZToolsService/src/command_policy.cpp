#include "ztools_service/command_policy.hpp"

namespace ztools::service {

CommandPolicyResult CommandPolicy::Check(
    const ServiceCommandType command,
    const std::string_view plugin_id,
    const std::string_view target_id) const {
  if (!IsBuiltinServiceCommand(command) || plugin_id.empty() || target_id.empty()) {
    return {false, "COMMAND_INVALID", "builtin command identity is invalid"};
  }
  if (command == ServiceCommandType::restart_explorer &&
      plugin_id == "context-menu" && target_id == "restart-explorer") {
    return {true, {}, {}};
  }
  return {
      false,
      "TARGET_NOT_ALLOWED",
      "no installed owner policy allows this privileged target",
  };
}

CommandPolicyResult CommandPolicy::CheckDll(
    const ServiceCommandType command,
    const std::string_view plugin_id,
    const std::string_view dll_id,
    const std::string_view function_name) const {
  const bool call_command =
      command == ServiceCommandType::dll_call ||
      command == ServiceCommandType::dll_call_async ||
      command == ServiceCommandType::dll_call_with_callback;
  const bool task_command =
      command == ServiceCommandType::dll_query_task ||
      command == ServiceCommandType::dll_cancel_task ||
      command == ServiceCommandType::dll_clear_callback_task ||
      command == ServiceCommandType::dll_clear_plugin_session ||
      command == ServiceCommandType::dll_unload;
  if (call_command && !plugin_id.empty() &&
      !dll_id.empty() && !function_name.empty()) {
    return {true, {}, {}};
  }
  if (task_command && !plugin_id.empty() && !dll_id.empty() && function_name.empty()) {
    return {true, {}, {}};
  }
  return {
      false,
      "DLL_COMMAND_NOT_ALLOWED",
      "no installed owner policy allows this privileged DLL function",
  };
}

std::size_t CommandPolicy::allowed_target_count() const noexcept {
  return 1;
}

}  // namespace ztools::service
