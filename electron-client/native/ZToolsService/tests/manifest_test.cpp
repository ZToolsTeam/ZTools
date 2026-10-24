#include "ztools_service/command_dispatcher.hpp"
#include "ztools_service/command_policy.hpp"
#include "ztools_service/privileged_dll_loader.hpp"
#include "ztools_service/privileged_dll_task_manager.hpp"
#include "ztools_service/privileged_dll_resolver.hpp"
#include "ztools_service/service_command_protocol.hpp"

#include <Windows.h>
#include <objbase.h>

#include <iostream>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

bool WideToUtf8(const std::wstring_view value, std::string* const output) {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  const int length = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0,
      nullptr,
      nullptr);
  if (length <= 0) {
    return false;
  }
  output->resize(static_cast<std::size_t>(length));
  return WideCharToMultiByte(
             CP_UTF8,
             WC_ERR_INVALID_CHARS,
             value.data(),
             static_cast<int>(value.size()),
             output->data(),
             length,
             nullptr,
             nullptr) == length;
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

std::vector<std::uint8_t> MakeCommand(
    const ztools::service::ServiceCommandType type,
    const std::string_view plugin_id = {},
    const std::string_view target_id = {},
    const std::string_view dll_id = {},
    const std::string_view function_name = {},
    const std::string_view payload = {}) {
  std::vector<std::uint8_t> command;
  command.reserve(
      ztools::service::kServiceCommandHeaderSize + plugin_id.size() +
      target_id.size() + dll_id.size() + function_name.size() + payload.size());
  AppendUint32(&command, ztools::service::kServiceCommandMagic);
  AppendUint16(&command, ztools::service::kServiceCommandVersion);
  AppendUint16(&command, static_cast<std::uint16_t>(type));
  AppendUint32(&command, 0);
  AppendUint16(&command, static_cast<std::uint16_t>(plugin_id.size()));
  AppendUint16(&command, static_cast<std::uint16_t>(target_id.size()));
  AppendUint16(&command, static_cast<std::uint16_t>(dll_id.size()));
  AppendUint16(&command, static_cast<std::uint16_t>(function_name.size()));
  AppendUint32(&command, static_cast<std::uint32_t>(payload.size()));
  for (const std::string_view field :
       {plugin_id, target_id, dll_id, function_name, payload}) {
    command.insert(command.end(), field.begin(), field.end());
  }
  return command;
}

bool IsFailure(
    const ztools::service::CommandDispatchResult& result,
    const std::string_view code) {
  return !result.success && result.code == code && result.payload.empty();
}

class FakeExplorerRestarter final
    : public ztools::service::ExplorerRestartExecutor {
 public:
  ztools::service::ExplorerRestartResult Restart(
      const DWORD client_session_id) override {
    ++calls;
    last_client_session_id = client_session_id;
    return next_result;
  }

  ztools::service::ExplorerRestartResult next_result{true, {}, {}};
  std::size_t calls = 0;
  DWORD last_client_session_id = 0;
};

bool ParseInputs(
    wchar_t* arguments[],
    ztools::service::PrivilegedDllPathConfig* const config,
    std::string* const plugin_id,
    std::string* const dll_id,
    std::string* const function_name) {
  config->data_root = arguments[2];
  return WideToUtf8(arguments[3], plugin_id) &&
         WideToUtf8(arguments[4], dll_id) &&
         WideToUtf8(arguments[5], function_name);
}

}  // namespace

int wmain(const int argument_count, wchar_t* arguments[]) {
  if (argument_count != 6) {
    return 2;
  }
  const std::wstring_view mode(arguments[1]);
  if (mode != L"--resolve" && mode != L"--load" &&
      mode != L"--command-self-test" && mode != L"--session-self-test") {
    return 2;
  }
  ztools::service::PrivilegedDllPathConfig config;
  std::string plugin_id;
  std::string dll_id;
  std::string function_name;
  if (!ParseInputs(
          arguments, &config, &plugin_id, &dll_id, &function_name)) {
    return 3;
  }
  ztools::service::PrivilegedDllResolver resolver(std::move(config));
  if (mode == L"--load") {
    ztools::service::PrivilegedDllLoader loader(&resolver);
    ztools::service::PrivilegedDllLoadResult result =
        loader.Load(plugin_id, dll_id, function_name);
    std::cout << "{\"success\":" << (result.success ? "true" : "false")
              << ",\"code\":\"" << result.code << "\",\"module\":"
              << (result.module != nullptr ? "true" : "false")
              << ",\"systemOnly\":"
              << (loader.system_only_ready() ? "true" : "false") << "}" << '\n';
    return 0;
  }
  if (mode == L"--session-self-test") {
    ztools::service::PrivilegedDllLoader loader(&resolver);
    ztools::service::CommandPolicy policy;
    FakeExplorerRestarter restarter;
    auto dispatcher = std::make_unique<ztools::service::CommandDispatcher>(
        &resolver, &loader, &policy, &restarter);
    ztools::service::PrivilegedDllTaskManager tasks(&loader);
    auto first = loader.Load(plugin_id, dll_id, function_name);
    auto second = loader.Load(plugin_id, dll_id, function_name);
    if (!first.success || !second.success || first.module != second.module ||
        first.validation.path.empty() || first.validation.path != second.validation.path) return 6;
    auto collision = loader.Load("other-plugin", dll_id, function_name);
    if (collision.success || collision.code != "DLL_NAME_COLLISION") return 7;
    const std::string params = "{\"taskId\":\"task_session_search\"}";
    auto started = tasks.Start(plugin_id, dll_id, "SearchAsync",
        std::vector<std::uint8_t>(params.begin(), params.end()), true);
    if (!started.success) return 8;
    auto call = dispatcher->Dispatch(MakeCommand(
        ztools::service::ServiceCommandType::dll_call, plugin_id, {}, dll_id,
        "GetSearchResults", "{}"), 42);
    const std::string result(call.payload.begin(), call.payload.end());
    if (!call.success || result != "{\"initialized\":1,\"destroyed\":0}") return 9;
    if (!tasks.Clear(plugin_id, dll_id, "task_session_search").success) return 10;
    // Keep a Windows reference only to inspect Destroy after all managed leases
    // are released. It must not be treated as a reusable managed session.
    HMODULE retained = nullptr;
    const auto probe = GetProcAddress(first.module, "DllPlugin_Call");
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        reinterpret_cast<LPCWSTR>(probe), &retained)) return 11;
    first = {};
    second = {};
    // No task or temporary Load result owns the DLL now. Sync requests must
    // still share the same initialized instance, including its background state.
    auto start = dispatcher->Dispatch(MakeCommand(
        ztools::service::ServiceCommandType::dll_call, plugin_id, {}, dll_id,
        "StartMonitoring", "{}"), 42);
    auto stats = dispatcher->Dispatch(MakeCommand(
        ztools::service::ServiceCommandType::dll_call, plugin_id, {}, dll_id,
        "GetTrafficStats", "{}"), 42);
    if (!start.success || !stats.success ||
        std::string(stats.payload.begin(), stats.payload.end()) != "{\"isMonitoring\":true}") return 16;
    dispatcher.reset();
    auto unmanaged = loader.Load(plugin_id, dll_id, function_name);
    if (unmanaged.success || unmanaged.code != "DLL_NAME_COLLISION") return 12;
    char* raw = nullptr;
    const auto inspect = reinterpret_cast<int(__cdecl*)(const char*, const char*, char**)>(probe);
    if (inspect("Counters", "{}", &raw) != 0) return 13;
    const bool destroyed_once = raw && std::string(raw) == "{\"initialized\":1,\"destroyed\":1}";
    CoTaskMemFree(raw);
    FreeLibrary(retained);
    if (!destroyed_once) return 14;
    auto reloaded = loader.Load(plugin_id, dll_id, function_name);
    if (!reloaded.success) return 15;
    reloaded = {};
    for (const auto release : {ztools::service::ServiceCommandType::dll_unload,
                              ztools::service::ServiceCommandType::dll_clear_plugin_session}) {
      ztools::service::CommandDispatcher scoped(&resolver, &loader, &policy, &restarter);
      if (!scoped.Dispatch(MakeCommand(ztools::service::ServiceCommandType::dll_call,
          plugin_id, {}, dll_id, "StartMonitoring", "{}"), 42).success) return 17;
      if (!scoped.Dispatch(MakeCommand(release, plugin_id, {}, dll_id), 42).success) return 18;
      auto stopped = scoped.Dispatch(MakeCommand(ztools::service::ServiceCommandType::dll_call,
          plugin_id, {}, dll_id, "GetTrafficStats", "{}"), 42);
      if (!stopped.success || std::string(stopped.payload.begin(), stopped.payload.end()) !=
          "{\"isMonitoring\":false}") return 19;
    }
    std::cout << "{\"success\":true,\"cases\":8}" << '\n';
    return 0;
  }
  if (mode == L"--command-self-test") {
    ztools::service::PrivilegedDllLoader loader(&resolver);
    ztools::service::CommandPolicy policy;
    FakeExplorerRestarter explorer_restarter;
    ztools::service::CommandDispatcher dispatcher(
        &resolver, &loader, &policy, &explorer_restarter);
    constexpr DWORD client_session_id = 42;
    const ztools::service::CommandDispatchResult status =
        dispatcher.Dispatch(MakeCommand(
            ztools::service::ServiceCommandType::policy_check),
            client_session_id);
    const bool status_valid =
        status.success && status.payload.size() == 12 &&
        ReadUint32(status.payload.data()) ==
            ztools::service::kServicePolicyStatusMagic &&
        ReadUint16(status.payload.data() + 4) ==
            ztools::service::kServicePolicyStatusVersion &&
        ReadUint16(status.payload.data() + 6) ==
            ztools::service::kServicePolicyFlagSystemOnlyDependencies &&
        ReadUint32(status.payload.data() + 8) == 1;
    std::vector<std::uint8_t> unknown = MakeCommand(
        static_cast<ztools::service::ServiceCommandType>(0xffff));
    std::vector<std::uint8_t> flags = MakeCommand(
        ztools::service::ServiceCommandType::policy_check);
    flags[8] = 1;
    std::vector<std::uint8_t> oversized = MakeCommand(
        ztools::service::ServiceCommandType::policy_check);
    const std::uint32_t oversized_size =
        static_cast<std::uint32_t>(
            ztools::service::kServiceCommandMaxDllPayloadBytes + 1);
    oversized[20] = static_cast<std::uint8_t>(oversized_size & 0xffU);
    oversized[21] = static_cast<std::uint8_t>((oversized_size >> 8U) & 0xffU);
    oversized[22] = static_cast<std::uint8_t>((oversized_size >> 16U) & 0xffU);
    oversized[23] = static_cast<std::uint8_t>((oversized_size >> 24U) & 0xffU);
    const ztools::service::CommandDispatchResult dll_call =
        dispatcher.Dispatch(
            MakeCommand(
                ztools::service::ServiceCommandType::dll_call,
                plugin_id,
                {},
                dll_id,
                function_name,
                "{}"),
            client_session_id);
    const bool dll_call_valid =
        dll_call.success && dll_call.code.empty() &&
        std::string_view(
            reinterpret_cast<const char*>(dll_call.payload.data()),
            dll_call.payload.size()).find("\"isAdmin\":") !=
            std::string_view::npos;
    const ztools::service::CommandDispatchResult dll_call_with_params =
        dispatcher.Dispatch(
            MakeCommand(
                ztools::service::ServiceCommandType::dll_call,
                plugin_id,
                {},
                dll_id,
                function_name,
                "{\"scope\":\"file\"}"),
            client_session_id);
    const bool dll_call_with_params_valid =
        dll_call_with_params.success && dll_call_with_params.code.empty();
    const ztools::service::CommandDispatchResult restart =
        dispatcher.Dispatch(
            MakeCommand(
                ztools::service::ServiceCommandType::restart_explorer,
                plugin_id,
                "restart-explorer"),
            client_session_id);
    explorer_restarter.next_result = {
        false, "EXPLORER_STOP_TIMEOUT", "injected failure"};
    const ztools::service::CommandDispatchResult restart_failure =
        dispatcher.Dispatch(
            MakeCommand(
                ztools::service::ServiceCommandType::restart_explorer,
                plugin_id,
                "restart-explorer"),
            client_session_id);
    const bool passed =
        status_valid &&
        IsFailure(
            dispatcher.Dispatch({}, client_session_id), "COMMAND_INVALID") &&
        IsFailure(
            dispatcher.Dispatch(unknown, client_session_id),
            "COMMAND_NOT_ALLOWED") &&
        IsFailure(
            dispatcher.Dispatch(flags, client_session_id), "COMMAND_INVALID") &&
        IsFailure(
            dispatcher.Dispatch(oversized, client_session_id),
            "COMMAND_TOO_LARGE") &&
        dll_call_valid &&
        dll_call_with_params_valid &&
        IsFailure(
            dispatcher.Dispatch(
                MakeCommand(
                    ztools::service::ServiceCommandType::dll_call,
                    plugin_id,
                    {},
                    dll_id,
                    "deleteEverything",
                    "{}"),
                client_session_id),
            "DLL_CALL_FAILED") &&
        restart.success &&
        std::string_view(
            reinterpret_cast<const char*>(restart.payload.data()),
            restart.payload.size()) == "{\"success\":true}" &&
        explorer_restarter.calls == 2 &&
        explorer_restarter.last_client_session_id == client_session_id &&
        IsFailure(restart_failure, "EXPLORER_STOP_TIMEOUT") &&
        IsFailure(
            dispatcher.Dispatch(
                MakeCommand(
                    ztools::service::ServiceCommandType::restart_explorer,
                    "other-plugin",
                    "restart-explorer"),
                client_session_id),
            "TARGET_NOT_ALLOWED") &&
        IsFailure(
            dispatcher.Dispatch(
                MakeCommand(
                    ztools::service::ServiceCommandType::restart_explorer,
                    plugin_id,
                    "C:\\Windows"),
                client_session_id),
            "COMMAND_INVALID") &&
        IsFailure(
            dispatcher.Dispatch(
                MakeCommand(
                    ztools::service::ServiceCommandType::dll_call,
                    plugin_id,
                    {},
                    "..\\ContextMenuPlugin.dll",
                    function_name,
                    "{}"),
                client_session_id),
            "COMMAND_INVALID");
    std::cout << "{\"success\":" << (passed ? "true" : "false")
              << ",\"cases\":13,\"allowedTargets\":"
              << policy.allowed_target_count() << "}" << '\n';
    return passed ? 0 : 5;
  }
  ztools::service::PrivilegedDllResolveResult result =
      resolver.Resolve(plugin_id, dll_id, function_name);
  const bool has_handle =
      result.validation_handle != INVALID_HANDLE_VALUE &&
      result.validation_handle != nullptr;
  bool locked = false;
  if (result.success && has_handle) {
    const HANDLE conflicting = CreateFileW(
        result.path.c_str(),
        GENERIC_WRITE | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (conflicting != INVALID_HANDLE_VALUE) {
      CloseHandle(conflicting);
    } else {
      locked = GetLastError() == ERROR_SHARING_VIOLATION;
    }
  }
  std::cout << "{\"success\":" << (result.success ? "true" : "false")
            << ",\"code\":\"" << result.code << "\",\"handle\":"
            << (has_handle ? "true" : "false") << ",\"locked\":"
            << (locked ? "true" : "false") << "}" << '\n';
  return 0;
}
