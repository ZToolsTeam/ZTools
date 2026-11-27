#include "ztools_service/trusted_snapshot.hpp"

#include "ztools_service/console_log.hpp"
#include "../../shared/dll_paths.hpp"
#include "../../shared/native_trust_crypto.hpp"

#include <Windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <shlobj.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cwctype>
#include <utility>
#include <vector>

namespace ztools::service {
namespace {

constexpr wchar_t kGlobalParentSddl[] =
  L"O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;AC)";
constexpr wchar_t kServiceOnlySddl[] =
  L"O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

constexpr ACCESS_MASK kDangerousUserWriteMask =
  FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
  FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER |
  GENERIC_WRITE | GENERIC_ALL;

std::atomic<std::uint64_t> g_temp_seq{0};

void CloseHandles(std::vector<HANDLE>& handles) noexcept {
  for (HANDLE h : handles) {
    if (h != INVALID_HANDLE_VALUE && h != nullptr) CloseHandle(h);
  }
  handles.clear();
}

bool IsSystemOrAdminsSid(PSID sid) noexcept {
  if (sid == nullptr || !IsValidSid(sid)) return false;
  return IsWellKnownSid(sid, WinLocalSystemSid) != FALSE ||
    IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != FALSE;
}

bool IsReparseOrMissingDir(const std::wstring& path, bool& exists_out, bool& is_dir_out, bool& is_reparse_out) noexcept {
  exists_out = false;
  is_dir_out = false;
  is_reparse_out = false;
  const DWORD attr = GetFileAttributesW(path.c_str());
  if (attr == INVALID_FILE_ATTRIBUTES) return false;
  exists_out = true;
  is_dir_out = (attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
  is_reparse_out = (attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
  return true;
}

bool VolumeSupportsPersistentAcls(const std::wstring& path) noexcept {
  wchar_t volume_root[MAX_PATH]{};
  if (!GetVolumePathNameW(path.c_str(), volume_root, MAX_PATH)) return false;
  DWORD flags = 0;
  if (!GetVolumeInformationW(volume_root, nullptr, 0, nullptr, nullptr, &flags, nullptr, 0)) {
    return false;
  }
  return (flags & FILE_PERSISTENT_ACLS) != 0;
}

bool CreateProtectedDirectory(const std::wstring& path, const wchar_t* sddl) noexcept {
  if (!VolumeSupportsPersistentAcls(path)) return false;
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl, SDDL_REVISION_1, &sd, nullptr)) {
    return false;
  }
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = sd;
  sa.bInheritHandle = FALSE;
  const BOOL created = CreateDirectoryW(path.c_str(), &sa);
  const DWORD err = GetLastError();
  LocalFree(sd);
  return created != FALSE || err == ERROR_ALREADY_EXISTS;
}

// 使用原生 Win32 API 安全递归删除目录，遇到联接点/符号链接直接移除链接而不进入递归
bool SafeDeleteDirectoryTree(const std::wstring& dir_path) noexcept {
  const DWORD root_attr = GetFileAttributesW(dir_path.c_str());
  if (root_attr == INVALID_FILE_ATTRIBUTES) return true;
  if ((root_attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return RemoveDirectoryW(dir_path.c_str()) != FALSE;
  }
  if ((root_attr & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    SetFileAttributesW(dir_path.c_str(), FILE_ATTRIBUTE_NORMAL);
    return DeleteFileW(dir_path.c_str()) != FALSE;
  }

  WIN32_FIND_DATAW fd{};
  const std::wstring pattern = dir_path + L"\\*";
  HANDLE find = FindFirstFileW(pattern.c_str(), &fd);
  if (find != INVALID_HANDLE_VALUE) {
    do {
      const std::wstring_view name(fd.cFileName);
      if (name == L"." || name == L"..") continue;
      const std::wstring child = dir_path + L"\\" + std::wstring(name);
      if ((fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
          RemoveDirectoryW(child.c_str());
        } else {
          DeleteFileW(child.c_str());
        }
      } else if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
        SafeDeleteDirectoryTree(child);
      } else {
        SetFileAttributesW(child.c_str(), FILE_ATTRIBUTE_NORMAL);
        DeleteFileW(child.c_str());
      }
    } while (FindNextFileW(find, &fd) != FALSE);
    FindClose(find);
  }
  SetFileAttributesW(dir_path.c_str(), FILE_ATTRIBUTE_NORMAL);
  return RemoveDirectoryW(dir_path.c_str()) != FALSE;
}

bool EnsureDirectoryHierarchy(const std::wstring& base_root, const std::wstring& full_file_path) {
  const std::size_t last_slash = full_file_path.find_last_of(L'\\');
  if (last_slash == std::wstring::npos || last_slash <= base_root.size()) return true;
  const std::wstring target_dir = full_file_path.substr(0, last_slash);
  std::wstring current = base_root;
  std::size_t offset = base_root.size() + 1;
  while (offset <= target_dir.size()) {
    const std::size_t slash = target_dir.find(L'\\', offset);
    current += L"\\" + target_dir.substr(
      offset, slash == std::wstring::npos ? std::wstring::npos : slash - offset);
    const DWORD attr = GetFileAttributesW(current.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES) {
      if (!CreateDirectoryW(current.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
        return false;
      }
    } else if ((attr & FILE_ATTRIBUTE_DIRECTORY) == 0 || (attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      return false;
    }
    if (slash == std::wstring::npos) break;
    offset = slash + 1;
  }
  return true;
}

bool ResolveProgramDataPath(std::wstring& out) {
  PWSTR raw = nullptr;
  const HRESULT hr = SHGetKnownFolderPath(FOLDERID_ProgramData, KF_FLAG_DONT_VERIFY, nullptr, &raw);
  if (FAILED(hr) || raw == nullptr) return false;
  std::wstring raw_path(raw);
  CoTaskMemFree(raw);
  return dll_paths::NormalizeLocalRoot(std::move(raw_path), out);
}

bool VerifyExistingSnapshotFiles(
  const std::wstring& snapshot_dir,
  const native_trust::VerifyResult& verified,
  std::wstring& main_snapshot_path,
  std::vector<HANDLE>& locked_handles) {
  locked_handles.clear();
  main_snapshot_path.clear();

  for (const auto& entry : verified.files) {
    std::wstring rel_wide;
    if (!dll_paths::Utf8ToWide(entry.relative_path, rel_wide)) {
      CloseHandles(locked_handles);
      return false;
    }
    std::replace(rel_wide.begin(), rel_wide.end(), L'/', L'\\');
    const std::wstring snap_file = snapshot_dir + L"\\" + rel_wide;
    if (!dll_paths::IsOrdinaryTreePath(snapshot_dir, snap_file)) {
      CloseHandles(locked_handles);
      return false;
    }
    dll_paths::UniqueHandle h;
    std::uint64_t sz = 0;
    if (!dll_paths::OpenOrdinaryFile(snap_file, native_trust::kMaxNativeBinaryBytes, h, sz) ||
        !dll_paths::FinalHandleIsWithinRoot(h.Get(), snapshot_dir) ||
        sz != entry.size) {
      CloseHandles(locked_handles);
      return false;
    }
    std::array<std::uint8_t, native_trust::kSha256Bytes> actual_sha{};
    if (!native_trust::Sha256File(h.Get(), actual_sha) ||
        !native_trust::ConstantTimeEqualBytes(actual_sha, entry.sha256)) {
      native_trust::SecureEraseBytes(actual_sha);
      CloseHandles(locked_handles);
      return false;
    }
    native_trust::SecureEraseBytes(actual_sha);

    if (dll_paths::SamePathOrdinal(entry.full_path, verified.main_path)) {
      main_snapshot_path = snap_file;
    }
    locked_handles.push_back(h.Release());
  }
  if (main_snapshot_path.empty()) {
    CloseHandles(locked_handles);
    return false;
  }
  return true;
}

bool WriteAuditManifest(
  const std::wstring& snapshot_dir,
  const std::vector<std::uint8_t>& raw_manifest_bytes) {
  if (raw_manifest_bytes.empty()) return true;
  const std::wstring target = snapshot_dir + L"\\native-trust.json";
  const std::wstring temp = target + L".tmp." + std::to_wstring(GetCurrentProcessId()) +
    L"." + std::to_wstring(++g_temp_seq);
  dll_paths::UniqueHandle h(CreateFileW(
    temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!h.Valid()) return false;
  DWORD offset = 0;
  const DWORD total = static_cast<DWORD>(raw_manifest_bytes.size());
  while (offset < total) {
    DWORD written = 0;
    if (!WriteFile(h.Get(), raw_manifest_bytes.data() + offset, total - offset, &written, nullptr) || written == 0) {
      h.Reset();
      DeleteFileW(temp.c_str());
      return false;
    }
    offset += written;
  }
  h.Reset();
  if (!MoveFileExW(temp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(temp.c_str());
    return false;
  }
  return true;
}

}  // namespace

bool IsGlobalProtectedParentAclSafe(const std::wstring& path) noexcept {
  bool exists = false;
  bool is_dir = false;
  bool is_reparse = false;
  if (!IsReparseOrMissingDir(path, exists, is_dir, is_reparse) || !exists || !is_dir || is_reparse) {
    return false;
  }
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR sd = nullptr;
  const DWORD res = GetNamedSecurityInfoW(
    path.c_str(), SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, nullptr, &dacl, nullptr, &sd);
  if (res != ERROR_SUCCESS || sd == nullptr) return false;

  bool safe = false;
  do {
    if (!IsSystemOrAdminsSid(owner)) break;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    if (!GetSecurityDescriptorControl(sd, &control, &revision)) break;
    if ((control & SE_DACL_PROTECTED) == 0 || (control & SE_DACL_PRESENT) == 0 || dacl == nullptr) {
      break;
    }
    ACL_SIZE_INFORMATION info{};
    if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) break;
    bool aces_ok = true;
    for (DWORD i = 0; i < info.AceCount; ++i) {
      void* raw_ace = nullptr;
      if (!GetAce(dacl, i, &raw_ace) || raw_ace == nullptr) {
        aces_ok = false;
        break;
      }
      const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        const auto* allowed = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
        PSID ace_sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&allowed->SidStart));
        if (!IsSystemOrAdminsSid(ace_sid) && (allowed->Mask & kDangerousUserWriteMask) != 0) {
          aces_ok = false;
          break;
        }
      } else if (header->AceType != ACCESS_DENIED_ACE_TYPE) {
        aces_ok = false;
        break;
      }
    }
    safe = aces_ok;
  } while (false);

  LocalFree(sd);
  return safe;
}

bool IsServiceOnlyDirectorySecurityDescriptorSafe(PSECURITY_DESCRIPTOR sd) noexcept {
  if (sd == nullptr) return false;
  PSID owner = nullptr;
  BOOL owner_defaulted = FALSE;
  if (!GetSecurityDescriptorOwner(sd, &owner, &owner_defaulted) || !IsSystemOrAdminsSid(owner)) {
    return false;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(sd, &control, &revision)) {
    return false;
  }
  if ((control & SE_DACL_PROTECTED) == 0 || (control & SE_DACL_PRESENT) == 0) {
    return false;
  }
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL dacl = nullptr;
  if (!GetSecurityDescriptorDacl(sd, &dacl_present, &dacl, &dacl_defaulted) ||
      !dacl_present || dacl == nullptr) {
    return false;
  }
  ACL_SIZE_INFORMATION info{};
  if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation) || info.AceCount == 0) {
    return false;
  }
  bool has_system_fa = false;
  bool has_admins_fa = false;
  for (DWORD i = 0; i < info.AceCount; ++i) {
    void* raw_ace = nullptr;
    if (!GetAce(dacl, i, &raw_ace) || raw_ace == nullptr) {
      return false;
    }
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    // 严禁任何 DENY ACE 或未知 ACE 类型
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) {
      return false;
    }
    // 严禁仅继承（INHERIT_ONLY_ACE）条目
    if ((header->AceFlags & INHERIT_ONLY_ACE) != 0) {
      return false;
    }
    const auto* allowed = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    PSID ace_sid = reinterpret_cast<PSID>(const_cast<DWORD*>(&allowed->SidStart));
    if (ace_sid == nullptr || !IsValidSid(ace_sid)) {
      return false;
    }
    // 权限掩码必须精确匹配 FILE_ALL_ACCESS（禁止降权或多余未知权限位）
    if (allowed->Mask != FILE_ALL_ACCESS) {
      return false;
    }
    // 所有 ALLOWED ACE 仅允许属于 SY 或 BA，且必须同时覆盖 SY:FA 与 BA:FA
    if (IsWellKnownSid(ace_sid, WinLocalSystemSid) != FALSE) {
      has_system_fa = true;
    } else if (IsWellKnownSid(ace_sid, WinBuiltinAdministratorsSid) != FALSE) {
      has_admins_fa = true;
    } else {
      return false;
    }
  }
  return has_system_fa && has_admins_fa;
}

bool IsServiceOnlyDirectoryAclSafe(const std::wstring& path) noexcept {
  bool exists = false;
  bool is_dir = false;
  bool is_reparse = false;
  if (!IsReparseOrMissingDir(path, exists, is_dir, is_reparse) || !exists || !is_dir || is_reparse) {
    return false;
  }
  PSECURITY_DESCRIPTOR sd = nullptr;
  const DWORD res = GetNamedSecurityInfoW(
    path.c_str(), SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    nullptr, nullptr, nullptr, nullptr, &sd);
  if (res != ERROR_SUCCESS || sd == nullptr) return false;

  const bool safe = IsServiceOnlyDirectorySecurityDescriptorSafe(sd);
  LocalFree(sd);
  return safe;
}

bool TrustedSnapshotManager::IsServiceOnlyDirectorySecurityDescriptorSafe(PSECURITY_DESCRIPTOR sd) noexcept {
  return ztools::service::IsServiceOnlyDirectorySecurityDescriptorSafe(sd);
}

bool TrustedSnapshotManager::IsServiceOnlyDirectoryAclSafe(const std::wstring& path) noexcept {
  return ztools::service::IsServiceOnlyDirectoryAclSafe(path);
}

SnapshotMaterializeResult::~SnapshotMaterializeResult() {
  CloseHandles(locked_handles);
}

SnapshotMaterializeResult::SnapshotMaterializeResult(SnapshotMaterializeResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      snapshot_dir(std::move(other.snapshot_dir)),
      main_snapshot_path(std::move(other.main_snapshot_path)),
      locked_handles(std::move(other.locked_handles)) {
  other.locked_handles.clear();
}

SnapshotMaterializeResult& SnapshotMaterializeResult::operator=(SnapshotMaterializeResult&& other) noexcept {
  if (this == &other) return *this;
  CloseHandles(locked_handles);
  success = other.success;
  code = std::move(other.code);
  message = std::move(other.message);
  snapshot_dir = std::move(other.snapshot_dir);
  main_snapshot_path = std::move(other.main_snapshot_path);
  locked_handles = std::move(other.locked_handles);
  other.locked_handles.clear();
  return *this;
}

TrustedSnapshotManager::TrustedSnapshotManager(std::wstring test_snapshot_root, bool eager_init)
    : test_snapshot_root_(std::move(test_snapshot_root)) {
  if (eager_init) {
    std::lock_guard lock(mutex_);
    root_ready_ = ResolveAndVerifyRootLocked();
  }
}

bool TrustedSnapshotManager::EnsureRootReady() const {
  std::lock_guard lock(mutex_);
  root_ready_ = ResolveAndVerifyRootLocked();
  return root_ready_;
}

bool TrustedSnapshotManager::root_ready() const noexcept {
  std::lock_guard lock(mutex_);
  return root_ready_;
}

bool TrustedSnapshotManager::ResolveAndVerifyRootLocked() const {
#if defined(ZTOOLS_ENABLE_TEST_TRUST_KEY)
  if (!test_snapshot_root_.empty()) {
    std::wstring normalized;
    if (!dll_paths::NormalizeLocalRoot(test_snapshot_root_, normalized)) {
      snapshot_root_.clear();
      return false;
    }
    bool exists = false;
    bool is_dir = false;
    bool is_reparse = false;
    IsReparseOrMissingDir(normalized, exists, is_dir, is_reparse);
    if (!exists) {
      if (!CreateDirectoryW(normalized.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
        snapshot_root_.clear();
        return false;
      }
      IsReparseOrMissingDir(normalized, exists, is_dir, is_reparse);
    }
    if (!exists || !is_dir || is_reparse) {
      snapshot_root_.clear();
      return false;
    }
    snapshot_root_ = std::move(normalized);
    return true;
  }
#endif

  std::wstring program_data;
  if (!ResolveProgramDataPath(program_data)) {
    snapshot_root_.clear();
    return false;
  }
  // 立即核验 ProgramData 入口本身为普通目录且所在卷支持持久 ACL（非持久 ACL 卷 Fail-Closed）
  {
    bool pd_exists = false;
    bool pd_is_dir = false;
    bool pd_is_reparse = false;
    if (!IsReparseOrMissingDir(program_data, pd_exists, pd_is_dir, pd_is_reparse) ||
        !pd_exists || !pd_is_dir || pd_is_reparse) {
      ConsoleLog("TrustedSnapshots ProgramData root is missing or unsafe");
      snapshot_root_.clear();
      return false;
    }
    if (!VolumeSupportsPersistentAcls(program_data)) {
      ConsoleLog("TrustedSnapshots ProgramData volume does not support persistent ACLs");
      snapshot_root_.clear();
      return false;
    }
  }
  const std::wstring dir_ztools = program_data + L"\\ZTools";
  const std::wstring dir_service = dir_ztools + L"\\Service";
  const std::wstring dir_snapshots = dir_service + L"\\TrustedSnapshots";

  // 逐级检查：不存在则以受保护 ACL 创建并复核；已存在但复核失败时立即 Fail-Closed，不做隔离修复
  const auto check_or_create = [](const std::wstring& dir, const wchar_t* sddl, bool service_only) -> bool {
    bool exists = false;
    bool is_dir = false;
    bool is_reparse = false;
    IsReparseOrMissingDir(dir, exists, is_dir, is_reparse);
    if (!exists) {
      if (!CreateProtectedDirectory(dir, sddl)) {
        std::string dir_utf8;
        dll_paths::WideToUtf8(dir, dir_utf8);
        ConsoleLog("TrustedSnapshots creation failed: ", dir_utf8);
        return false;
      }
    } else if (!is_dir || is_reparse) {
      ConsoleLog("TrustedSnapshots path is not an ordinary directory");
      return false;
    }
    const bool ok = service_only
      ? IsServiceOnlyDirectoryAclSafe(dir)
      : IsGlobalProtectedParentAclSafe(dir);
    if (!ok) {
      ConsoleLog("TrustedSnapshots ACL verification failed (fail-closed)");
    }
    return ok;
  };

  if (!check_or_create(dir_ztools, kGlobalParentSddl, false) ||
      !check_or_create(dir_service, kGlobalParentSddl, false) ||
      !check_or_create(dir_snapshots, kServiceOnlySddl, true)) {
    snapshot_root_.clear();
    return false;
  }
  snapshot_root_ = dir_snapshots;
  return true;
}

SnapshotMaterializeResult TrustedSnapshotManager::PrepareSnapshot(
  const native_trust::VerifyResult& verified) const {
  auto fail = [](const char* code, const char* message) {
    SnapshotMaterializeResult r;
    r.code = code;
    r.message = message;
    return r;
  };

  std::lock_guard lock(mutex_);
  if (!ResolveAndVerifyRootLocked()) {
    root_ready_ = false;
    return fail("DLL_PATH_INVALID", "trusted snapshot root directory is unavailable or unsafe");
  }
  root_ready_ = true;
  if (!verified.success || verified.manifest_sha256_hex.size() < 16 || verified.files.empty()) {
    return fail("MANIFEST_INVALID", "verified manifest result is incomplete");
  }

  std::wstring plugin_wide;
  std::wstring hash_prefix_wide;
  if (!dll_paths::Utf8ToWide(dll_paths::LowerAscii(verified.plugin_id), plugin_wide) ||
      !dll_paths::Utf8ToWide(verified.manifest_sha256_hex.substr(0, 16), hash_prefix_wide)) {
    return fail("DLL_PATH_INVALID", "snapshot directory name is invalid");
  }

  const std::wstring plugin_snap_parent = snapshot_root_ + L"\\" + plugin_wide;
  const DWORD parent_attr = GetFileAttributesW(plugin_snap_parent.c_str());
  if (parent_attr == INVALID_FILE_ATTRIBUTES) {
    if (!CreateDirectoryW(plugin_snap_parent.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
      return fail("DLL_PATH_INVALID", "failed to create plugin snapshot parent directory");
    }
  } else if ((parent_attr & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
             (parent_attr & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return fail("DLL_PATH_INVALID", "plugin snapshot parent directory is unsafe");
  }

  const std::wstring snapshot_dir = plugin_snap_parent + L"\\" + hash_prefix_wide;
  const DWORD snap_attr = GetFileAttributesW(snapshot_dir.c_str());
  if (snap_attr != INVALID_FILE_ATTRIBUTES) {
    if ((snap_attr & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
        (snap_attr & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
      std::wstring main_path;
      std::vector<HANDLE> locked;
      if (VerifyExistingSnapshotFiles(snapshot_dir, verified, main_path, locked)) {
        SnapshotMaterializeResult ok;
        ok.success = true;
        ok.snapshot_dir = snapshot_dir;
        ok.main_snapshot_path = std::move(main_path);
        ok.locked_handles = std::move(locked);
        return ok;
      }
    }
    // 已有快照不完整、损坏或异常，安全删除后重建
    if (!SafeDeleteDirectoryTree(snapshot_dir)) {
      return fail("DLL_UNAVAILABLE", "failed to clean corrupted snapshot directory");
    }
  }

  if (!CreateDirectoryW(snapshot_dir.c_str(), nullptr)) {
    return fail("DLL_UNAVAILABLE", "failed to create snapshot directory");
  }

  for (const auto& entry : verified.files) {
    std::wstring rel_wide;
    if (!dll_paths::Utf8ToWide(entry.relative_path, rel_wide)) {
      SafeDeleteDirectoryTree(snapshot_dir);
      return fail("DLL_PATH_INVALID", "snapshot relative file path is invalid");
    }
    std::replace(rel_wide.begin(), rel_wide.end(), L'/', L'\\');
    const std::wstring target_path = snapshot_dir + L"\\" + rel_wide;
    if (!dll_paths::IsWithinRoot(snapshot_dir, target_path) ||
        !EnsureDirectoryHierarchy(snapshot_dir, target_path)) {
      SafeDeleteDirectoryTree(snapshot_dir);
      return fail("DLL_PATH_INVALID", "failed to create snapshot subdirectory");
    }
    const std::wstring temp_path = target_path + L".tmp." +
      std::to_wstring(GetCurrentProcessId()) + L"." +
      std::to_wstring(GetCurrentThreadId()) + L"." +
      std::to_wstring(++g_temp_seq);

    dll_paths::UniqueHandle dst(CreateFileW(
      temp_path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!dst.Valid()) {
      SafeDeleteDirectoryTree(snapshot_dir);
      return fail("DLL_UNAVAILABLE", "failed to create temporary snapshot file");
    }

    std::uint64_t copied_bytes = 0;
    std::array<std::uint8_t, native_trust::kSha256Bytes> copied_sha{};
    const bool copied_ok = native_trust::CopyAndHashFile(
      entry.handle.Get(), dst.Get(), copied_bytes, copied_sha);
    dst.Reset();
    if (!copied_ok || copied_bytes != entry.size ||
        !native_trust::ConstantTimeEqualBytes(copied_sha, entry.sha256)) {
      native_trust::SecureEraseBytes(copied_sha);
      DeleteFileW(temp_path.c_str());
      SafeDeleteDirectoryTree(snapshot_dir);
      return fail("DLL_INTEGRITY", "snapshot copy digest mismatch");
    }
    native_trust::SecureEraseBytes(copied_sha);

    if (!MoveFileExW(temp_path.c_str(), target_path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      DeleteFileW(temp_path.c_str());
      SafeDeleteDirectoryTree(snapshot_dir);
      return fail("DLL_UNAVAILABLE", "failed to finalize snapshot file");
    }
  }

  // 写入审计用 native-trust.json（失败时输出诊断日志，不静默忽略）
  if (!WriteAuditManifest(snapshot_dir, verified.raw_manifest_bytes)) {
    std::string snap_utf8;
    dll_paths::WideToUtf8(snapshot_dir, snap_utf8);
    ConsoleLog("TrustedSnapshots audit manifest write failed: ", snap_utf8);
  }

  // 重新以 FILE_SHARE_READ 锁定全部快照文件并返回句柄
  std::wstring main_path;
  std::vector<HANDLE> locked;
  if (!VerifyExistingSnapshotFiles(snapshot_dir, verified, main_path, locked)) {
    SafeDeleteDirectoryTree(snapshot_dir);
    return fail("DLL_INTEGRITY", "snapshot post-write verification failed");
  }

  SnapshotMaterializeResult ok;
  ok.success = true;
  ok.snapshot_dir = snapshot_dir;
  ok.main_snapshot_path = std::move(main_path);
  ok.locked_handles = std::move(locked);
  return ok;
}

void TrustedSnapshotManager::GarbageCollect(
  const std::string& plugin_id,
  const std::wstring& current_snapshot_dir,
  const std::set<std::wstring>& active_snapshot_dirs) const {
  std::lock_guard lock(mutex_);
  if (!root_ready_ || snapshot_root_.empty()) return;
  std::wstring plugin_wide;
  if (!dll_paths::Utf8ToWide(dll_paths::LowerAscii(plugin_id), plugin_wide)) return;
  const std::wstring plugin_snap_parent = snapshot_root_ + L"\\" + plugin_wide;

  struct Candidate {
    std::wstring path;
    ULONGLONG write_time = 0;
  };
  std::vector<Candidate> candidates;

  WIN32_FIND_DATAW fd{};
  const std::wstring pattern = plugin_snap_parent + L"\\*";
  HANDLE find = FindFirstFileW(pattern.c_str(), &fd);
  if (find == INVALID_HANDLE_VALUE) return;
  do {
    const std::wstring_view name(fd.cFileName);
    if (name == L"." || name == L"..") continue;
    if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
    const std::wstring full = plugin_snap_parent + L"\\" + std::wstring(name);
    ULARGE_INTEGER wt{};
    wt.LowPart = fd.ftLastWriteTime.dwLowDateTime;
    wt.HighPart = fd.ftLastWriteTime.dwHighDateTime;
    candidates.push_back({full, wt.QuadPart});
  } while (FindNextFileW(find, &fd) != FALSE);
  FindClose(find);

  // 按最后修改时间降序排列，保留 current + 最近 1 个历史快照 + 所有活跃会话引用的快照
  std::sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
    return a.write_time > b.write_time;
  });

  auto is_protected = [&](const std::wstring& dir) {
    if (!current_snapshot_dir.empty() && dll_paths::SamePathOrdinal(dir, current_snapshot_dir)) {
      return true;
    }
    for (const auto& active : active_snapshot_dirs) {
      if (dll_paths::SamePathOrdinal(dir, active)) return true;
    }
    return false;
  };

  bool kept_previous = false;
  for (const auto& cand : candidates) {
    if (is_protected(cand.path)) continue;
    if (!kept_previous) {
      kept_previous = true;
      continue;
    }
    SafeDeleteDirectoryTree(cand.path);
  }
}

void TrustedSnapshotManager::GarbageCollectAllOnStartup() const {
  std::lock_guard lock(mutex_);
  if (!root_ready_ || snapshot_root_.empty()) return;

  WIN32_FIND_DATAW plugin_fd{};
  const std::wstring root_pattern = snapshot_root_ + L"\\*";
  HANDLE plugin_find = FindFirstFileW(root_pattern.c_str(), &plugin_fd);
  if (plugin_find == INVALID_HANDLE_VALUE) return;

  std::vector<std::wstring> plugin_dirs;
  do {
    const std::wstring_view name(plugin_fd.cFileName);
    if (name == L"." || name == L"..") continue;
    if ((plugin_fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
    if ((plugin_fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
    plugin_dirs.push_back(snapshot_root_ + L"\\" + std::wstring(name));
  } while (FindNextFileW(plugin_find, &plugin_fd) != FALSE);
  FindClose(plugin_find);

  struct Candidate {
    std::wstring path;
    ULONGLONG write_time = 0;
  };

  for (const auto& plugin_dir : plugin_dirs) {
    std::vector<Candidate> candidates;
    WIN32_FIND_DATAW snap_fd{};
    const std::wstring snap_pattern = plugin_dir + L"\\*";
    HANDLE snap_find = FindFirstFileW(snap_pattern.c_str(), &snap_fd);
    if (snap_find == INVALID_HANDLE_VALUE) continue;
    do {
      const std::wstring_view name(snap_fd.cFileName);
      if (name == L"." || name == L"..") continue;
      if ((snap_fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;
      if ((snap_fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) continue;
      ULARGE_INTEGER wt{};
      wt.LowPart = snap_fd.ftLastWriteTime.dwLowDateTime;
      wt.HighPart = snap_fd.ftLastWriteTime.dwHighDateTime;
      candidates.push_back({plugin_dir + L"\\" + std::wstring(name), wt.QuadPart});
    } while (FindNextFileW(snap_find, &snap_fd) != FALSE);
    FindClose(snap_find);

    if (candidates.size() <= 2) continue;
    std::sort(candidates.begin(), candidates.end(), [](const Candidate& a, const Candidate& b) {
      return a.write_time > b.write_time;
    });
    for (std::size_t i = 2; i < candidates.size(); ++i) {
      SafeDeleteDirectoryTree(candidates[i].path);
    }
  }
}

}  // namespace ztools::service
