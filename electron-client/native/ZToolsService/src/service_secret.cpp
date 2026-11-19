#include "ztools_service/service_secret.hpp"

#include <ShlObj.h>
#include <Sddl.h>
#include <WtsApi32.h>

#include <vector>

namespace ztools::service {
namespace {

class UniqueHandle final {
 public:
  explicit UniqueHandle(const HANDLE value = nullptr) noexcept : value_(value) {}
  ~UniqueHandle() {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) {
      CloseHandle(value_);
    }
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  HANDLE get() const noexcept { return value_; }

 private:
  HANDLE value_;
};

DWORD HResultError(const HRESULT result) noexcept {
  return HRESULT_FACILITY(result) == FACILITY_WIN32
             ? HRESULT_CODE(result)
             : ERROR_PATH_NOT_FOUND;
}

UniqueHandle OpenIdentityToken(
    const PipeIdentityMode identity_mode,
    DWORD* const error) noexcept {
  HANDLE token = nullptr;
  if (identity_mode == PipeIdentityMode::service) {
    const DWORD session_id = WTSGetActiveConsoleSessionId();
    if (session_id == 0xffffffff) {
      *error = ERROR_NO_SUCH_LOGON_SESSION;
      return UniqueHandle();
    }
    if (WTSQueryUserToken(session_id, &token) == FALSE) {
      *error = GetLastError();
      return UniqueHandle();
    }
  } else if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == FALSE) {
    *error = GetLastError();
    return UniqueHandle();
  }
  return UniqueHandle(token);
}

bool ReadTokenUserSidString(
    const HANDLE token,
    std::wstring* const user_sid_string,
    DWORD* const error) noexcept {
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) {
    *error = GetLastError();
    return false;
  }
  std::vector<std::uint8_t> buffer;
  try {
    buffer.resize(size);
  } catch (...) {
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
  if (GetTokenInformation(token, TokenUser, buffer.data(), size, &size) == FALSE) {
    *error = GetLastError();
    return false;
  }
  const auto* const token_user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
  wchar_t* value = nullptr;
  if (ConvertSidToStringSidW(token_user->User.Sid, &value) == FALSE) {
    *error = GetLastError();
    return false;
  }
  try {
    *user_sid_string = value;
  } catch (...) {
    LocalFree(value);
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
  LocalFree(value);
  return true;
}

}  // namespace

bool ResolveServiceDataRoot(
    const PipeIdentityMode identity_mode,
    std::wstring* const data_root,
    std::wstring* const user_sid_string,
    DWORD* const error) noexcept {
  if (data_root == nullptr || user_sid_string == nullptr || error == nullptr) {
    return false;
  }
  data_root->clear();
  user_sid_string->clear();
  *error = ERROR_SUCCESS;
  UniqueHandle token = OpenIdentityToken(identity_mode, error);
  if (token.get() == nullptr) {
    return false;
  }
  if (!ReadTokenUserSidString(token.get(), user_sid_string, error)) {
    return false;
  }
  PWSTR roaming_app_data = nullptr;
  const HRESULT folder_result = SHGetKnownFolderPath(
      FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, token.get(), &roaming_app_data);
  if (FAILED(folder_result) || roaming_app_data == nullptr) {
    *error = HResultError(folder_result);
    return false;
  }
  try {
    // 生产默认业务数据目录与客户端及安装器保持一致，统一指向 DataV2
    *data_root = std::wstring(roaming_app_data) + L"\\ZTools\\DataV2";
  } catch (...) {
    CoTaskMemFree(roaming_app_data);
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
  CoTaskMemFree(roaming_app_data);
  return true;
}

}  // namespace ztools::service
