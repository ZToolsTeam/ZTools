#include "../../shared/dll_cancel.hpp"

#include <cstdlib>
#include <cstring>
#include <iostream>

namespace {
int calls = 0;
int business_calls = 0;
int result_code = 0;

void Check(bool condition) {
  if (!condition) std::abort();
}

int __cdecl ModernCancel(const char* task_id) {
  ++calls;
  Check(std::strcmp(task_id, "task_abc-123") == 0);
  return result_code;
}

int __cdecl LegacyCancel(const char* params, char** result) {
  ++calls;
  Check(result != nullptr && *result == nullptr);
  *result = static_cast<char*>(CoTaskMemAlloc(3));
  Check(*result != nullptr);
  std::memcpy(*result, "{}", 3);
  if (std::strcmp(params, "task_abc-123") == 0) return -3;
  Check(std::strcmp(params, "{\"taskId\":\"task_abc-123\"}") == 0);
  ++business_calls;
  return result_code;
}
}  // namespace

int main() {
  // Actual single-argument function: extra cdecl argument must be ignored.
  const auto modern = reinterpret_cast<ztools::DllCancelFunction>(&ModernCancel);
  for (const int code : {0, -3, -4}) {
    calls = 0;
    result_code = code;
    Check(ztools::CancelDllTask(modern, "task_abc-123") == code);
    Check(calls == 1);  // Never retry modern errors.
  }
  for (const int code : {0, -3, -4}) {
    calls = business_calls = 0;
    result_code = code;
    Check(ztools::CancelDllTask(&LegacyCancel, "task_abc-123") == code);
    Check(calls == 2 && business_calls == 1);  // No duplicate cancellation.
  }
  std::cout << "DLL cancellation ABI compatibility passed\n";
}
