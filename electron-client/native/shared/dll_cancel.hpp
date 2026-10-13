#pragma once

#include <objbase.h>

#include <memory>
#include <string>

namespace ztools {

// Both published ABIs use __cdecl (caller cleans the stack). Supplying an
// extra output argument is safe for the single-argument ABI and essential for
// old DLLs, which otherwise write their JSON result through a garbage pointer.
using DllCancelFunction = int(__cdecl*)(const char*, char**);

inline int CancelDllTask(DllCancelFunction cancel, const std::string& task_id) {
  char* raw_result = nullptr;
  const int code = cancel(task_id.c_str(), &raw_result);
  std::unique_ptr<void, decltype(&CoTaskMemFree)> result(raw_result, &CoTaskMemFree);
  // Old PluginBase rejects the raw task ID as invalid JSON before dispatching
  // the business operation and allocates an error result. Modern DLLs never
  // write this argument. Do not retry modern errors or successful operations.
  if (code != -3 || raw_result == nullptr) return code;

  // Host-generated task IDs contain only these characters, requiring no JSON
  // escaping. Reject anything else rather than forwarding ambiguous input.
  if (task_id.empty() || task_id.find_first_not_of(
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos) {
    return -3;
  }
  const std::string params = "{\"taskId\":\"" + task_id + "\"}";
  result.reset();
  raw_result = nullptr;
  const int legacy_code = cancel(params.c_str(), &raw_result);
  result.reset(raw_result);
  // Preserve the published legacy ABI's return code; its JSON result buffer
  // is owned by the caller even when the call reports failure.
  return legacy_code;
}

}  // namespace ztools
