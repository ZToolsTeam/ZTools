#include "ztools_service/command_dispatcher.hpp"
#include "ztools_service/command_policy.hpp"
#include "ztools_service/privileged_dll_loader.hpp"
#include "ztools_service/privileged_dll_task_manager.hpp"
#include "ztools_service/privileged_dll_resolver.hpp"
#include "ztools_service/service_command_protocol.hpp"
#include "ztools_service/trusted_snapshot.hpp"
#include "../../shared/dll_paths.hpp"

#include <Windows.h>
#include <aclapi.h>
#include <objbase.h>
#include <sddl.h>

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

std::string JsonEscape(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('"');
  for (const unsigned char ch : value) {
    if (ch == '"') out += "\\\"";
    else if (ch == '\\') out += "\\\\";
    else out.push_back(static_cast<char>(ch));
  }
  out.push_back('"');
  return out;
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

// 支持位置参数：
// <mode> <data-root> [test-priv-pubkey-hex] [--snapshot-root <dir>] [--trust-state-file <file>] [--disable-legacy] [--test-normal-pubkey <hex>] <pluginId> <dllId> <fn>
bool ParseInputs(
    const int argument_count,
    wchar_t* arguments[],
    ztools::service::PrivilegedDllPathConfig* const config,
    std::string* const plugin_id,
    std::string* const dll_id,
    std::string* const function_name) {
  std::vector<std::wstring_view> positional;
  for (int i = 2; i < argument_count; ++i) {
    const std::wstring_view arg(arguments[i]);
    if (arg == L"--snapshot-root") {
      if (i + 1 >= argument_count) return false;
      config->snapshot_root_override = arguments[++i];
    } else if (arg == L"--trust-state-file") {
      if (i + 1 >= argument_count) return false;
      config->trust_state_file_override = arguments[++i];
    } else if (arg == L"--disable-legacy") {
      config->test_overrides.disable_legacy = true;
    } else if (arg == L"--test-normal-pubkey") {
      if (i + 1 >= argument_count) return false;
      std::array<std::uint8_t, ztools::native_trust::kP256PublicKeyBytes> pub{};
      if (!ztools::dll_paths::ParseHex(arguments[++i], pub)) return false;
      config->test_overrides.ephemeral_normal_pub = pub;
    } else {
      positional.push_back(arg);
    }
  }
  if (positional.size() != 4 && positional.size() != 5) {
    return false;
  }
  config->data_root = std::wstring(positional[0]);
  std::size_t idx = 1;
  if (positional.size() == 5) {
    std::array<std::uint8_t, ztools::native_trust::kP256PublicKeyBytes> pub{};
    if (!ztools::dll_paths::ParseHex(positional[1], pub)) return false;
    config->test_overrides.ephemeral_privileged_pub = pub;
    idx = 2;
  }
  return WideToUtf8(positional[idx], plugin_id) &&
         WideToUtf8(positional[idx + 1], dll_id) &&
         WideToUtf8(positional[idx + 2], function_name);
}

bool CheckSecurityDescriptorSddl(const wchar_t* sddl, const bool expected) {
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl, SDDL_REVISION_1, &sd, nullptr) ||
      sd == nullptr) {
    return false;
  }
  const bool actual =
      ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectorySecurityDescriptorSafe(sd);
  LocalFree(sd);
  return actual == expected;
}

bool CreateDirectoryWithSddl(const std::wstring& path, const wchar_t* sddl) {
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl, SDDL_REVISION_1, &sd, nullptr) ||
      sd == nullptr) {
    return false;
  }
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = sd;
  sa.bInheritHandle = FALSE;
  const BOOL created = CreateDirectoryW(path.c_str(), &sa);
  LocalFree(sd);
  return created != FALSE;
}

void RestoreInheritableDaclAndRemoveDir(const std::wstring& path) noexcept {
  SetNamedSecurityInfoW(
      const_cast<LPWSTR>(path.c_str()),
      SE_FILE_OBJECT,
      DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      nullptr,
      nullptr);
  RemoveDirectoryW(path.c_str());
}

int RunAclSelfTest() {
  // 1. 纯内存 PSECURITY_DESCRIPTOR 正反全覆盖（零权限依赖，非提权环境下 100% 稳定）
  struct SdCase {
    const char* name;
    const wchar_t* sddl;
    bool expected;
  };
  constexpr SdCase kSdCases[] = {
      {"valid_sy_owner", L"O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", true},
      {"valid_ba_owner", L"O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", true},
      {"unprotected_dacl", L"O:SYG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", false},
      {"bu_readonly_ace", L"O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)", false},
      {"inherit_only_sy", L"O:SYG:SYD:PAI(A;OICIIO;FA;;;SY)(A;OICI;FA;;;BA)", false},
      {"ba_fr_missing_sy", L"O:SYG:SYD:PAI(A;OICI;FR;;;BA)", false},
      {"missing_sy_fa", L"O:SYG:SYD:PAI(A;OICI;FA;;;BA)", false},
      {"missing_ba_fa", L"O:SYG:SYD:PAI(A;OICI;FA;;;SY)", false},
      {"deny_ace_present", L"O:SYG:SYD:PAI(D;OICI;FA;;;BU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", false},
      {"trusted_installer_owner",
       L"O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
       false},
  };
  for (const auto& item : kSdCases) {
    if (!CheckSecurityDescriptorSddl(item.sddl, item.expected)) {
      std::cerr << "ACL SD self-test failed on case: " << item.name << '\n';
      return 10;
    }
  }
  if (ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectorySecurityDescriptorSafe(nullptr)) {
    std::cerr << "ACL SD self-test failed on nullptr case\n";
    return 11;
  }

  // 2. 真实临时目录文件系统校验（验证弱 ACL 均被真断言拒绝）
  wchar_t temp_root_buf[MAX_PATH]{};
  const DWORD temp_len = GetTempPathW(MAX_PATH, temp_root_buf);
  if (temp_len == 0 || temp_len >= MAX_PATH) {
    std::cerr << "ACL self-test could not locate temp directory\n";
    return 12;
  }
  std::wstring base_dir(temp_root_buf, temp_len);
  while (!base_dir.empty() && base_dir.back() == L'\\') base_dir.pop_back();
  base_dir += L"\\ztools-acl-selftest-" + std::to_wstring(GetCurrentProcessId()) +
              L"-" + std::to_wstring(GetTickCount64());
  if (!CreateDirectoryW(base_dir.c_str(), nullptr)) {
    std::cerr << "ACL self-test could not create temp base directory\n";
    return 13;
  }

  const std::wstring dir_inherited = base_dir + L"\\inherited";
  const std::wstring dir_bu_ro = base_dir + L"\\bu_ro";
  const std::wstring dir_io_ba_fr = base_dir + L"\\io_ba_fr";
  const std::wstring dir_missing = base_dir + L"\\missing";
  const std::wstring file_plain = base_dir + L"\\plain.txt";
  const std::wstring dir_elevated_ok = base_dir + L"\\elevated_ok";

  bool fs_ok = true;
  bool elevated_live_checked = false;

  // ① 继承未受保护的默认目录（无 SE_DACL_PROTECTED）必须返回 false
  if (!CreateDirectoryW(dir_inherited.c_str(), nullptr) ||
      ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(dir_inherited)) {
    std::cerr << "ACL FS self-test failed on inherited directory\n";
    fs_ok = false;
  }

  // ② 含普通用户 BU 只读 ACE 必须返回 false
  if (fs_ok) {
    if (!CreateDirectoryWithSddl(
            dir_bu_ro, L"D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)") ||
        ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(dir_bu_ro)) {
      std::cerr << "ACL FS self-test failed on BU read-only directory\n";
      fs_ok = false;
    }
  }

  // ③ 含 INHERIT_ONLY_ACE 与仅 BA:FR（缺 SY:FA）必须返回 false
  if (fs_ok) {
    if (!CreateDirectoryWithSddl(
            dir_io_ba_fr, L"D:PAI(A;OICIIO;FA;;;SY)(A;OICI;FR;;;BA)") ||
        ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(dir_io_ba_fr)) {
      std::cerr << "ACL FS self-test failed on INHERIT_ONLY / BA:FR directory\n";
      fs_ok = false;
    }
  }

  // ④ 缺失目录与非目录普通文件必须返回 false
  if (fs_ok &&
      ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(dir_missing)) {
    std::cerr << "ACL FS self-test failed on missing directory\n";
    fs_ok = false;
  }
  if (fs_ok) {
    HANDLE file_h = CreateFileW(
        file_plain.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_h == INVALID_HANDLE_VALUE) {
      std::cerr << "ACL FS self-test could not create plain file\n";
      fs_ok = false;
    } else {
      CloseHandle(file_h);
      if (ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(file_plain)) {
        std::cerr << "ACL FS self-test failed on non-directory file\n";
        fs_ok = false;
      }
    }
  }

  // ⑤ 若当前进程已提权并允许创建 O:SY/O:BA 保护目录，额外做真实目录正例断言
  if (fs_ok &&
      CreateDirectoryWithSddl(
          dir_elevated_ok, L"O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")) {
    elevated_live_checked = true;
    if (!ztools::service::TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(dir_elevated_ok)) {
      std::cerr << "ACL FS self-test failed on elevated compliant directory\n";
      fs_ok = false;
    }
  }

  RestoreInheritableDaclAndRemoveDir(dir_elevated_ok);
  DeleteFileW(file_plain.c_str());
  RestoreInheritableDaclAndRemoveDir(dir_io_ba_fr);
  RestoreInheritableDaclAndRemoveDir(dir_bu_ro);
  RemoveDirectoryW(dir_inherited.c_str());
  RemoveDirectoryW(base_dir.c_str());

  if (!fs_ok) return 14;
  std::cout << "{\"ok\":true,\"mode\":\"acl-self-test\",\"sdCases\":11,\"fsCases\":5,\"elevatedLiveCase\":"
            << (elevated_live_checked ? "true" : "false") << "}\n";
  return 0;
}

}  // namespace

int wmain(const int argument_count, wchar_t* arguments[]) {
  if (argument_count >= 2 && std::wstring_view(arguments[1]) == L"--acl-self-test") {
    if (argument_count != 2) return 2;
    return RunAclSelfTest();
  }
  if (argument_count < 6) {
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
          argument_count, arguments, &config, &plugin_id, &dll_id,
          &function_name)) {
    return 3;
  }
  ztools::service::PrivilegedDllResolver resolver(std::move(config));
  if (mode == L"--load") {
    ztools::service::PrivilegedDllLoader loader(&resolver);
    ztools::service::PrivilegedDllLoadResult result =
        loader.Load(plugin_id, dll_id, function_name);
    std::string snap_utf8;
    if (!result.validation.path.empty()) {
      WideToUtf8(result.validation.path, &snap_utf8);
    }
    std::cout << "{\"success\":" << (result.success ? "true" : "false")
              << ",\"code\":\"" << result.code << "\",\"module\":"
              << (result.module != nullptr ? "true" : "false")
              << ",\"snapshotPolicyReady\":"
              << (loader.system_only_ready() ? "true" : "false")
              << ",\"systemOnly\":"
              << (loader.system_only_ready() ? "true" : "false")
              << ",\"snapshotPath\":" << JsonEscape(snap_utf8) << "}" << '\n';
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
    HMODULE retained = nullptr;
    const auto probe = GetProcAddress(first.module, "DllPlugin_Call");
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        reinterpret_cast<LPCWSTR>(probe), &retained)) return 11;
    first = {};
    second = {};
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
            (ztools::service::kServicePolicyFlagManifestTrusted |
             ztools::service::kServicePolicyFlagSystemOnlyDependencies) &&
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
        IsFailure(
            dispatcher.Dispatch(
                MakeCommand(
                    ztools::service::ServiceCommandType::dll_call,
                    plugin_id,
                    {},
                    dll_id,
                    "notInManifest",
                    "{}"),
                client_session_id),
            "FUNCTION_NOT_ALLOWED") &&
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
              << ",\"cases\":14,\"allowedTargets\":"
              << policy.allowed_target_count() << "}" << '\n';
    return passed ? 0 : 5;
  }
  ztools::service::PrivilegedDllResolveResult result =
      resolver.Resolve(plugin_id, dll_id, function_name);
  const bool has_handle = !result.locked_handles.empty();
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
  std::string snap_utf8;
  if (!result.path.empty()) WideToUtf8(result.path, &snap_utf8);
  std::cout << "{\"success\":" << (result.success ? "true" : "false")
            << ",\"code\":\"" << result.code << "\",\"handle\":"
            << (has_handle ? "true" : "false") << ",\"locked\":"
            << (locked ? "true" : "false")
            << ",\"snapshotPath\":" << JsonEscape(snap_utf8) << "}" << '\n';
  return 0;
}
