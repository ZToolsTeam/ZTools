#include "ztools_service/trust_state_store.hpp"

#include "../../shared/dll_paths.hpp"
#include "../../shared/native_semver.hpp"

#include <Windows.h>

#include <fstream>
#include <map>
#include <sstream>
#include <vector>

namespace ztools::service {
namespace {

constexpr wchar_t kHighWaterRegPath[] = L"SOFTWARE\\ZToolsService\\NativeTrust\\HighWater";
// 高水位注册表读异常或数据损坏时返回的不可解析哨兵值，强制触发 Fail-Closed（MANIFEST_ROLLBACK）
constexpr char kCorruptedHighWaterSentinel[] = "<corrupted>";

#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
bool ReadStateMapFromFile(
  const std::wstring& file_path,
  std::map<std::string, std::string>& out) {
  out.clear();
  std::ifstream ifs(file_path, std::ios::binary);
  if (!ifs) return true;  // 首次运行文件尚不存在
  std::string line;
  while (std::getline(ifs, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    const std::size_t eq = line.find('=');
    if (eq == std::string::npos || eq == 0 || eq + 1 >= line.size()) continue;
    out[dll_paths::LowerAscii(line.substr(0, eq))] = line.substr(eq + 1);
  }
  return true;
}

bool WriteStateMapToFile(
  const std::wstring& file_path,
  const std::map<std::string, std::string>& map) {
  const std::wstring temp_path = file_path + L".tmp";
  {
    std::ofstream ofs(temp_path, std::ios::binary | std::ios::trunc);
    if (!ofs) return false;
    for (const auto& [k, v] : map) {
      ofs << k << '=' << v << '\n';
    }
    ofs.flush();
    if (!ofs) return false;
  }
  return MoveFileExW(
    temp_path.c_str(), file_path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
}
#endif

}  // namespace

TrustStateStore::TrustStateStore(std::wstring test_state_file)
    : test_state_file_(std::move(test_state_file)) {}

std::optional<std::string> TrustStateStore::ReadHighWater(const std::string& plugin_id) const {
  if (!dll_paths::IsSafeIdentifier(plugin_id)) return std::nullopt;
  const std::string key_name = dll_paths::LowerAscii(plugin_id);
  std::lock_guard lock(mutex_);

#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  if (!test_state_file_.empty()) {
    std::map<std::string, std::string> state;
    if (!ReadStateMapFromFile(test_state_file_, state)) return std::nullopt;
    const auto it = state.find(key_name);
    if (it == state.end()) return std::nullopt;
    return it->second;
  }
#endif

  std::wstring wide_name;
  if (!dll_paths::Utf8ToWide(key_name, wide_name)) return std::string(kCorruptedHighWaterSentinel);

  HKEY hkey = nullptr;
  const LONG open_res = RegOpenKeyExW(
    HKEY_LOCAL_MACHINE, kHighWaterRegPath, 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &hkey);
  if (open_res == ERROR_FILE_NOT_FOUND) return std::nullopt;
  if (open_res != ERROR_SUCCESS) return std::string(kCorruptedHighWaterSentinel);

  DWORD type = 0;
  DWORD byte_size = 0;
  LONG query_res = RegQueryValueExW(hkey, wide_name.c_str(), nullptr, &type, nullptr, &byte_size);
  if (query_res == ERROR_FILE_NOT_FOUND) {
    RegCloseKey(hkey);
    return std::nullopt;
  }
  if (query_res != ERROR_SUCCESS || type != REG_SZ || byte_size == 0 || byte_size > 1024) {
    RegCloseKey(hkey);
    return std::string(kCorruptedHighWaterSentinel);
  }

  std::vector<wchar_t> buf((byte_size / sizeof(wchar_t)) + 2, L'\0');
  query_res = RegQueryValueExW(
    hkey, wide_name.c_str(), nullptr, &type, reinterpret_cast<LPBYTE>(buf.data()), &byte_size);
  RegCloseKey(hkey);
  if (query_res == ERROR_FILE_NOT_FOUND) return std::nullopt;
  if (query_res != ERROR_SUCCESS || type != REG_SZ || byte_size == 0 || byte_size > 1024) {
    return std::string(kCorruptedHighWaterSentinel);
  }

  std::wstring wide_val(buf.data());
  std::string utf8_val;
  if (wide_val.empty() || !dll_paths::WideToUtf8(wide_val, utf8_val) || utf8_val.empty()) {
    return std::string(kCorruptedHighWaterSentinel);
  }
  return utf8_val;
}

bool TrustStateStore::UpdateHighWater(const std::string& plugin_id, const std::string& version) const {
  if (!dll_paths::IsSafeIdentifier(plugin_id)) return false;
  native_trust::SemVer next_ver;
  if (!native_trust::ParseSemVer(version, next_ver)) return false;
  const std::string key_name = dll_paths::LowerAscii(plugin_id);
  std::lock_guard lock(mutex_);

#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  if (!test_state_file_.empty()) {
    std::map<std::string, std::string> state;
    if (!ReadStateMapFromFile(test_state_file_, state)) return false;
    const auto it = state.find(key_name);
    if (it != state.end()) {
      native_trust::SemVer cur_ver;
      if (!native_trust::ParseSemVer(it->second, cur_ver)) return false;
      if (native_trust::CompareSemVer(next_ver, cur_ver) <= 0) return true;
    }
    state[key_name] = version;
    return WriteStateMapToFile(test_state_file_, state);
  }
#endif

  std::wstring wide_name;
  std::wstring wide_ver;
  if (!dll_paths::Utf8ToWide(key_name, wide_name) || !dll_paths::Utf8ToWide(version, wide_ver)) {
    return false;
  }

  HKEY hkey = nullptr;
  const LONG create_res = RegCreateKeyExW(
    HKEY_LOCAL_MACHINE,
    kHighWaterRegPath,
    0,
    nullptr,
    REG_OPTION_NON_VOLATILE,
    KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY,
    nullptr,
    &hkey,
    nullptr);
  if (create_res != ERROR_SUCCESS) return false;

  DWORD type = 0;
  DWORD byte_size = 0;
  LONG query_res = RegQueryValueExW(hkey, wide_name.c_str(), nullptr, &type, nullptr, &byte_size);
  if (query_res != ERROR_FILE_NOT_FOUND) {
    // 已有高水位读取失败或格式损坏时一律 Fail-Closed，拒绝覆盖
    if (query_res != ERROR_SUCCESS || type != REG_SZ || byte_size == 0 || byte_size > 1024) {
      RegCloseKey(hkey);
      return false;
    }
    std::vector<wchar_t> buf((byte_size / sizeof(wchar_t)) + 2, L'\0');
    query_res = RegQueryValueExW(
      hkey, wide_name.c_str(), nullptr, &type, reinterpret_cast<LPBYTE>(buf.data()), &byte_size);
    if (query_res != ERROR_SUCCESS || type != REG_SZ || byte_size == 0 || byte_size > 1024) {
      RegCloseKey(hkey);
      return false;
    }
    std::string existing_utf8;
    native_trust::SemVer cur_ver;
    if (!dll_paths::WideToUtf8(std::wstring(buf.data()), existing_utf8) ||
        !native_trust::ParseSemVer(existing_utf8, cur_ver)) {
      RegCloseKey(hkey);
      return false;
    }
    if (native_trust::CompareSemVer(next_ver, cur_ver) <= 0) {
      RegCloseKey(hkey);
      return true;
    }
  }

  const DWORD write_bytes = static_cast<DWORD>((wide_ver.size() + 1) * sizeof(wchar_t));
  const LONG set_res = RegSetValueExW(
    hkey, wide_name.c_str(), 0, REG_SZ,
    reinterpret_cast<const BYTE*>(wide_ver.c_str()), write_bytes);
  RegCloseKey(hkey);
  return set_res == ERROR_SUCCESS;
}

}  // namespace ztools::service
