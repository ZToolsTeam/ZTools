#include "ztools_service/service_secret.hpp"

#include <ShlObj.h>
#include <Sddl.h>
#include <WtsApi32.h>

#include <algorithm>
#include <array>
#include <limits>
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
    *data_root = std::wstring(roaming_app_data) + L"\\ZTools\\Data";
  } catch (...) {
    CoTaskMemFree(roaming_app_data);
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }
  CoTaskMemFree(roaming_app_data);
  return true;
}

bool LoadInstalledServiceSecret(
    const PipeIdentityMode identity_mode,
    ServiceSecret* const secret,
    std::wstring* const data_root,
    std::wstring* const resolved_path,
    std::wstring* const user_sid_string,
    DWORD* const error) noexcept {
  if (secret == nullptr || data_root == nullptr || resolved_path == nullptr ||
      user_sid_string == nullptr || error == nullptr) {
    return false;
  }
  secret->fill(0);
  data_root->clear();
  resolved_path->clear();
  user_sid_string->clear();
  *error = ERROR_SUCCESS;
  if (!ResolveServiceDataRoot(
          identity_mode, data_root, user_sid_string, error)) {
    return false;
  }
  try {
    *resolved_path = *data_root + L"\\Service\\auth-v1.key";
  } catch (...) {
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }

  UniqueHandle file(CreateFileW(
      resolved_path->c_str(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) {
    *error = GetLastError();
    return false;
  }
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (GetFileInformationByHandleEx(
          file.get(), FileAttributeTagInfo, &attributes, sizeof(attributes)) == FALSE) {
    *error = GetLastError();
    return false;
  }
  if ((attributes.FileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    *error = ERROR_REPARSE_TAG_INVALID;
    return false;
  }
  LARGE_INTEGER size{};
  if (GetFileSizeEx(file.get(), &size) == FALSE) {
    *error = GetLastError();
    return false;
  }
  if (size.QuadPart != static_cast<LONGLONG>(secret->size())) {
    *error = ERROR_INVALID_DATA;
    return false;
  }
  DWORD read = 0;
  if (ReadFile(
          file.get(),
          secret->data(),
          static_cast<DWORD>(secret->size()),
          &read,
          nullptr) == FALSE) {
    *error = GetLastError();
    SecureEraseServiceBytes(*secret);
    return false;
  }
  if (read != static_cast<DWORD>(secret->size()) ||
      !IsValidServiceSecret(*secret)) {
    *error = ERROR_INVALID_DATA;
    SecureEraseServiceBytes(*secret);
    return false;
  }
  return true;
}

}  // namespace ztools::service
