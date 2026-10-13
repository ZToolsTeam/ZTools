#include "ztools_service/service_command_protocol.hpp"

#include <limits>

namespace ztools::service {
namespace {

std::uint16_t ReadUint16(const std::uint8_t* const input) noexcept {
  return static_cast<std::uint16_t>(input[0]) |
         static_cast<std::uint16_t>(
             static_cast<std::uint16_t>(input[1]) << 8U);
}

std::uint32_t ReadUint32(const std::uint8_t* const input) noexcept {
  return static_cast<std::uint32_t>(input[0]) |
         (static_cast<std::uint32_t>(input[1]) << 8U) |
         (static_cast<std::uint32_t>(input[2]) << 16U) |
         (static_cast<std::uint32_t>(input[3]) << 24U);
}

bool IsKnownCommand(const ServiceCommandType type) noexcept {
  switch (type) {
    case ServiceCommandType::policy_check:
    case ServiceCommandType::dll_subscribe_events:
    case ServiceCommandType::dll_call:
    case ServiceCommandType::dll_unload:
    case ServiceCommandType::dll_call_with_callback:
    case ServiceCommandType::dll_cancel_task:
    case ServiceCommandType::dll_clear_callback_task:
    case ServiceCommandType::dll_clear_plugin_session:
    case ServiceCommandType::dll_call_async:
    case ServiceCommandType::dll_query_task:
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
      return true;
    default:
      return false;
  }
}

bool IsSafeIdentifier(
    const std::string_view value,
    const bool function_name = false) noexcept {
  if (value.empty() || value.size() > kServiceCommandMaxIdentifierBytes) {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    const bool alpha = (character >= 'a' && character <= 'z') ||
                       (character >= 'A' && character <= 'Z');
    const bool digit = character >= '0' && character <= '9';
    const bool punctuation =
        character == '_' || character == '-' || character == '.';
    const bool valid_first = function_name ? (alpha || character == '_')
                                           : (alpha || digit);
    if (!(alpha || digit || punctuation) || (index == 0 && !valid_first)) {
      return false;
    }
  }
  return value.back() != '.';
}

bool IsValidUtf8(const std::span<const std::uint8_t> bytes) noexcept {
  std::size_t index = 0;
  while (index < bytes.size()) {
    const std::uint8_t first = bytes[index];
    if (first == 0) {
      return false;
    }
    if (first <= 0x7f) {
      ++index;
      continue;
    }
    std::size_t continuation_count = 0;
    std::uint32_t code_point = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      continuation_count = 1;
      code_point = first & 0x1fU;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuation_count = 2;
      code_point = first & 0x0fU;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuation_count = 3;
      code_point = first & 0x07U;
    } else {
      return false;
    }
    if (index + continuation_count >= bytes.size()) {
      return false;
    }
    for (std::size_t offset = 1; offset <= continuation_count; ++offset) {
      const std::uint8_t continuation = bytes[index + offset];
      if ((continuation & 0xc0U) != 0x80U) {
        return false;
      }
      code_point = (code_point << 6U) | (continuation & 0x3fU);
    }
    if ((continuation_count == 2 && code_point < 0x800U) ||
        (continuation_count == 3 && code_point < 0x10000U) ||
        code_point > 0x10ffffU ||
        (code_point >= 0xd800U && code_point <= 0xdfffU)) {
      return false;
    }
    index += continuation_count + 1;
  }
  return true;
}

bool HasOnly(
    const ServiceCommandView& command,
    const bool plugin,
    const bool target,
    const bool dll,
    const bool function,
    const bool payload) noexcept {
  return (plugin ? !command.plugin_id.empty() : command.plugin_id.empty()) &&
         (target ? !command.target_id.empty() : command.target_id.empty()) &&
         (dll ? !command.dll_id.empty() : command.dll_id.empty()) &&
         (function ? !command.function_name.empty()
                   : command.function_name.empty()) &&
         (payload ? !command.payload.empty() : command.payload.empty());
}

ServiceCommandParseResult ValidateShape(
    const ServiceCommandView& command) noexcept {
  switch (command.type) {
    case ServiceCommandType::policy_check:
    case ServiceCommandType::dll_subscribe_events:
      return HasOnly(command, false, false, false, false, false)
                 ? ServiceCommandParseResult::success
                 : ServiceCommandParseResult::invalid;
    case ServiceCommandType::dll_call:
    case ServiceCommandType::dll_call_async:
    case ServiceCommandType::dll_call_with_callback:
      if (!HasOnly(command, true, false, true, true, true)) {
        return ServiceCommandParseResult::invalid;
      }
      if (command.payload.size() > kServiceCommandMaxDllPayloadBytes) {
        return ServiceCommandParseResult::too_large;
      }
      return IsValidUtf8(command.payload) ? ServiceCommandParseResult::success
                                          : ServiceCommandParseResult::invalid;
    case ServiceCommandType::dll_unload:
    case ServiceCommandType::dll_clear_plugin_session:
      return HasOnly(command, true, false, true, false, false)
                 ? ServiceCommandParseResult::success
                 : ServiceCommandParseResult::invalid;
    case ServiceCommandType::dll_cancel_task:
    case ServiceCommandType::dll_query_task:
    case ServiceCommandType::dll_clear_callback_task: {
      if (!HasOnly(command, true, false, true, false, true) ||
          command.payload.size() > kServiceCommandMaxIdentifierBytes) {
        return ServiceCommandParseResult::invalid;
      }
      const std::string_view task_id(
          reinterpret_cast<const char*>(command.payload.data()),
          command.payload.size());
      return IsSafeIdentifier(task_id) ? ServiceCommandParseResult::success
                                       : ServiceCommandParseResult::invalid;
    }
    case ServiceCommandType::registry_write:
    case ServiceCommandType::file_write:
      if (!HasOnly(command, true, true, false, false, true)) {
        return ServiceCommandParseResult::invalid;
      }
      return command.payload.size() <= kServiceCommandMaxBuiltinPayloadBytes
                 ? ServiceCommandParseResult::success
                 : ServiceCommandParseResult::too_large;
    case ServiceCommandType::registry_delete:
    case ServiceCommandType::file_delete:
    case ServiceCommandType::file_copy:
    case ServiceCommandType::file_move:
    case ServiceCommandType::process_kill:
    case ServiceCommandType::system_action:
    case ServiceCommandType::scheduled_task_set_enabled:
      if (!HasOnly(command, true, true, false, false, true)) {
        return ServiceCommandParseResult::invalid;
      }
      return command.payload.size() <= kServiceCommandMaxBuiltinPayloadBytes
                 ? ServiceCommandParseResult::success
                 : ServiceCommandParseResult::too_large;
    case ServiceCommandType::restart_explorer:
      return HasOnly(command, true, true, false, false, false)
                 ? ServiceCommandParseResult::success
                 : ServiceCommandParseResult::invalid;
    default:
      return ServiceCommandParseResult::not_allowed;
  }
}

}  // namespace

ServiceCommandParseResult ParseServiceCommand(
    const std::span<const std::uint8_t> bytes,
    ServiceCommandView* const command) noexcept {
  if (command == nullptr || bytes.size() < kServiceCommandHeaderSize) {
    return ServiceCommandParseResult::invalid;
  }
  const std::uint8_t* const data = bytes.data();
  const auto type = static_cast<ServiceCommandType>(ReadUint16(data + 6));
  if (ReadUint32(data) != kServiceCommandMagic ||
      ReadUint16(data + 4) != kServiceCommandVersion ||
      ReadUint32(data + 8) != 0) {
    return ServiceCommandParseResult::invalid;
  }
  if (!IsKnownCommand(type)) {
    return ServiceCommandParseResult::not_allowed;
  }
  const std::size_t plugin_size = ReadUint16(data + 12);
  const std::size_t target_size = ReadUint16(data + 14);
  const std::size_t dll_size = ReadUint16(data + 16);
  const std::size_t function_size = ReadUint16(data + 18);
  const std::size_t payload_size = ReadUint32(data + 20);
  if (plugin_size > kServiceCommandMaxIdentifierBytes ||
      target_size > kServiceCommandMaxIdentifierBytes ||
      dll_size > kServiceCommandMaxIdentifierBytes ||
      function_size > kServiceCommandMaxIdentifierBytes ||
      payload_size > kServiceCommandMaxDllPayloadBytes) {
    return ServiceCommandParseResult::too_large;
  }
  const std::size_t fields_size =
      plugin_size + target_size + dll_size + function_size;
  if (fields_size > std::numeric_limits<std::size_t>::max() -
                        kServiceCommandHeaderSize ||
      payload_size > std::numeric_limits<std::size_t>::max() -
                         kServiceCommandHeaderSize - fields_size ||
      bytes.size() != kServiceCommandHeaderSize + fields_size + payload_size) {
    return ServiceCommandParseResult::invalid;
  }
  std::size_t offset = kServiceCommandHeaderSize;
  const auto field = [&bytes, &offset](const std::size_t size) {
    const std::string_view value(
        reinterpret_cast<const char*>(bytes.data() + offset), size);
    offset += size;
    return value;
  };
  command->type = type;
  command->plugin_id = field(plugin_size);
  command->target_id = field(target_size);
  command->dll_id = field(dll_size);
  command->function_name = field(function_size);
  command->payload = bytes.subspan(offset, payload_size);
  if ((!command->plugin_id.empty() &&
       !IsSafeIdentifier(command->plugin_id)) ||
      (!command->target_id.empty() &&
       !IsSafeIdentifier(command->target_id)) ||
      (!command->dll_id.empty() && !IsSafeIdentifier(command->dll_id)) ||
      (!command->function_name.empty() &&
       !IsSafeIdentifier(command->function_name, true))) {
    return ServiceCommandParseResult::invalid;
  }
  return ValidateShape(*command);
}

bool IsBuiltinServiceCommand(const ServiceCommandType type) noexcept {
  switch (type) {
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
      return true;
    case ServiceCommandType::policy_check:
    case ServiceCommandType::dll_subscribe_events:
    case ServiceCommandType::dll_call:
    case ServiceCommandType::dll_unload:
    case ServiceCommandType::dll_call_with_callback:
    case ServiceCommandType::dll_cancel_task:
    case ServiceCommandType::dll_clear_callback_task:
    case ServiceCommandType::dll_clear_plugin_session:
    case ServiceCommandType::dll_call_async:
    case ServiceCommandType::dll_query_task:
      return false;
    default:
      return false;
  }
}

}  // namespace ztools::service
