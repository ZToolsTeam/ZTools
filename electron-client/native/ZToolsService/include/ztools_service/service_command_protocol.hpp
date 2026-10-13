#pragma once

#include "pipe_protocol.hpp"
#include "service_auth.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>

namespace ztools::service {

inline constexpr std::uint32_t kServiceCommandMagic = 0x31434D53;
inline constexpr std::uint16_t kServiceCommandVersion = 1;
inline constexpr std::size_t kServiceCommandHeaderSize = 24;
inline constexpr std::size_t kServiceCommandMaxIdentifierBytes = 128;
inline constexpr std::size_t kServiceCommandMaxDllPayloadBytes = 256 * 1024;
// Responses have no command envelope, but must leave room for the frame proof.
inline constexpr std::size_t kServiceMaxDllResponseBytes =
    kServiceMaxPayloadSize - kServiceProofSize;
inline constexpr std::size_t kServiceCommandMaxBuiltinPayloadBytes = 64 * 1024;

enum class ServiceCommandType : std::uint16_t {
  policy_check = 1,
  dll_call = 0x100,
  dll_unload = 0x101,
  dll_call_with_callback = 0x102,
  dll_cancel_task = 0x103,
  dll_clear_callback_task = 0x104,
  dll_clear_plugin_session = 0x105,
  dll_call_async = 0x106,
  dll_query_task = 0x107,
  dll_subscribe_events = 0x108,
  registry_write = 0x200,
  registry_delete = 0x201,
  file_write = 0x300,
  file_delete = 0x301,
  file_copy = 0x302,
  file_move = 0x303,
  process_kill = 0x400,
  restart_explorer = 0x500,
  system_action = 0x501,
  scheduled_task_set_enabled = 0x502,
};

enum class ServiceCommandParseResult {
  success,
  invalid,
  too_large,
  not_allowed,
};

struct ServiceCommandView {
  ServiceCommandType type = ServiceCommandType::policy_check;
  std::string_view plugin_id;
  std::string_view target_id;
  std::string_view dll_id;
  std::string_view function_name;
  std::span<const std::uint8_t> payload;
};

ServiceCommandParseResult ParseServiceCommand(
    std::span<const std::uint8_t> bytes,
    ServiceCommandView* command) noexcept;

bool IsBuiltinServiceCommand(ServiceCommandType type) noexcept;

}  // namespace ztools::service
