#pragma once

#include "ztools_service/service_command_protocol.hpp"

#include <cstddef>
#include <string>
#include <string_view>

namespace ztools::service {

struct CommandPolicyResult {
  bool allowed = false;
  std::string code;
  std::string message;
};

class CommandPolicy final {
 public:
  CommandPolicyResult Check(
      ServiceCommandType command,
      std::string_view plugin_id,
      std::string_view target_id) const;
  CommandPolicyResult CheckDll(
      ServiceCommandType command,
      std::string_view plugin_id,
      std::string_view dll_id,
      std::string_view function_name) const;
  std::size_t allowed_target_count() const noexcept;
};

}  // namespace ztools::service
