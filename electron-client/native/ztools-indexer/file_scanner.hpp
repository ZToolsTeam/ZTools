#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winioctl.h>
#ifndef IO_REPARSE_TAG_MOUNT_POINT
#define IO_REPARSE_TAG_MOUNT_POINT (0xA0000003L)
#endif
#ifndef IO_REPARSE_TAG_SYMLINK
#define IO_REPARSE_TAG_SYMLINK (0xA000000CL)
#endif
#ifndef IO_REPARSE_TAG_APPEXECLINK
#define IO_REPARSE_TAG_APPEXECLINK (0x8000001BL)
#endif
#ifndef IO_REPARSE_TAG_LX_SYMLINK
#define IO_REPARSE_TAG_LX_SYMLINK (0xA000001DL)
#endif
#else
#include <dirent.h>
#include <sys/stat.h>
#include <cstring>
#endif
#include <string>
#include <vector>
#include <queue>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <chrono>
#include <iostream>
#include <unordered_set>
#include <unordered_map>
#include <memory>
#include <cwchar>
#include <algorithm>

#include "pinyin.hpp"

namespace ztools::indexer {

inline std::string WideToUtf8(const std::wstring& wstr) {
  if (wstr.empty()) return "";
#ifdef _WIN32
  int size = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), NULL, 0, NULL, NULL);
  if (size <= 0) return "";
  std::string result(size, 0);
  WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), &result[0], size, NULL, NULL);
  return result;
#else
  std::string result;
  result.reserve(wstr.size());
  for (wchar_t wc : wstr) {
    uint32_t cp = static_cast<uint32_t>(wc);
    if (cp <= 0x7F) {
      result.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
      result.push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
      result.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
      result.push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
      result.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      result.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
      result.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      result.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }
  return result;
#endif
}

inline std::wstring Utf8ToWide(const std::string& str) {
  if (str.empty()) return L"";
#ifdef _WIN32
  int size = MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), NULL, 0);
  if (size <= 0) return L"";
  std::wstring result(size, 0);
  MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), &result[0], size);
  return result;
#else
  std::wstring result;
  result.reserve(str.size());
  size_t i = 0;
  while (i < str.size()) {
    uint32_t cp = 0;
    unsigned char c = static_cast<unsigned char>(str[i]);
    if (c < 0x80) {
      cp = c;
      i += 1;
    } else if ((c & 0xE0) == 0xC0 && i + 1 < str.size()) {
      cp = ((c & 0x1F) << 6) | (static_cast<unsigned char>(str[i + 1]) & 0x3F);
      i += 2;
    } else if ((c & 0xF0) == 0xE0 && i + 2 < str.size()) {
      cp = ((c & 0x0F) << 12) | ((static_cast<unsigned char>(str[i + 1]) & 0x3F) << 6) | (static_cast<unsigned char>(str[i + 2]) & 0x3F);
      i += 3;
    } else if ((c & 0xF8) == 0xF0 && i + 3 < str.size()) {
      cp = ((c & 0x07) << 18) | ((static_cast<unsigned char>(str[i + 1]) & 0x3F) << 12) | ((static_cast<unsigned char>(str[i + 2]) & 0x3F) << 6) | (static_cast<unsigned char>(str[i + 3]) & 0x3F);
      i += 4;
    } else {
      cp = c;
      i += 1;
    }
    result.push_back(static_cast<wchar_t>(cp));
  }
  return result;
#endif
}

struct FileEntry {
  std::string path;
  std::string name;
  std::string name_lower;
  std::string acronym;
  std::string pinyin_full;
  uint64_t size = 0;
  uint64_t mtime = 0;
  bool is_dir = false;
};

class IFileScanner {
public:
  virtual ~IFileScanner() = default;
  virtual const char* GetName() const = 0;
  virtual bool Scan(const std::wstring& target, std::vector<FileEntry>& out_entries) = 0;
};

// Abstracted NTFS MFT / USN Journal Scanner
class UsnJournalScanner : public IFileScanner {
public:
  const char* GetName() const override { return "usn_journal"; }

  bool Scan(const std::wstring& target, std::vector<FileEntry>& out_entries) override {
#ifndef _WIN32
    (void)target;
    (void)out_entries;
    return false;
#else
    // Determine volume from path, e.g. "C:\\..." -> "\\\\.\\C:" and drive root "C:"
    std::wstring drive_prefix = L"C:";
    if (target.size() >= 2 && target[1] == L':') {
      drive_prefix = target.substr(0, 2);
    }
    std::wstring volume = L"\\\\.\\" + drive_prefix;
    std::string drive_root_utf8 = WideToUtf8(drive_prefix);

    HANDLE hVol = CreateFileW(
      volume.c_str(),
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      NULL,
      OPEN_EXISTING,
      0,
      NULL
    );

    if (hVol == INVALID_HANDLE_VALUE) {
      // Typically ERROR_ACCESS_DENIED without admin elevation or not an NTFS drive
      return false;
    }

    USN_JOURNAL_DATA journalData;
    DWORD bytesReturned = 0;
    if (!DeviceIoControl(hVol, FSCTL_QUERY_USN_JOURNAL, NULL, 0, &journalData, sizeof(journalData), &bytesReturned, NULL)) {
      CloseHandle(hVol);
      return false;
    }

    // USN Journal is available and accessible!
    MFT_ENUM_DATA_V0 enumData;
    enumData.StartFileReferenceNumber = 0;
    enumData.LowUsn = 0;
    enumData.HighUsn = journalData.NextUsn;

    constexpr DWORD kBufferSize = 64 * 1024;
    std::vector<BYTE> buffer(kBufferSize);

    struct RawUsnItem {
      DWORDLONG frn = 0;
      DWORDLONG parent_frn = 0;
      std::string name;
      uint64_t mtime = 0;
      bool is_dir = false;
    };
    struct DirNode {
      DWORDLONG parent_frn = 0;
      std::string name;
    };

    std::vector<RawUsnItem> raw_items;
    std::unordered_map<DWORDLONG, DirNode> dir_map;

    while (DeviceIoControl(hVol, FSCTL_ENUM_USN_DATA, &enumData, sizeof(enumData), buffer.data(), kBufferSize, &bytesReturned, NULL)) {
      if (bytesReturned <= sizeof(USN)) break;

      DWORD offset = sizeof(USN);
      while (offset < bytesReturned) {
        auto* record = reinterpret_cast<USN_RECORD_V2*>(buffer.data() + offset);
        if (record->RecordLength == 0) break;

        std::wstring wname(
          reinterpret_cast<wchar_t*>(reinterpret_cast<BYTE*>(record) + record->FileNameOffset),
          record->FileNameLength / sizeof(wchar_t)
        );
        std::string name = WideToUtf8(wname);
        const bool is_dir = (record->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;

        if (!name.empty() && name[0] != '$') {
          if (is_dir) {
            dir_map[record->FileReferenceNumber] = {record->ParentFileReferenceNumber, name};
          }
          raw_items.push_back({
            record->FileReferenceNumber,
            record->ParentFileReferenceNumber,
            std::move(name),
            static_cast<uint64_t>(record->TimeStamp.QuadPart),
            is_dir
          });
        }

        offset += record->RecordLength;
      }

      enumData.StartFileReferenceNumber = *reinterpret_cast<DWORDLONG*>(buffer.data());
    }

    CloseHandle(hVol);

    // Reconstruct real drive paths ("C:\dir\file") from ParentFileReferenceNumber chain
    std::unordered_map<DWORDLONG, std::string> resolved_dir_paths;
    resolved_dir_paths.reserve(dir_map.size());
    auto resolve_dir_path = [&](DWORDLONG frn) -> const std::string& {
      auto cached = resolved_dir_paths.find(frn);
      if (cached != resolved_dir_paths.end()) return cached->second;

      std::vector<std::string> segments;
      DWORDLONG curr = frn;
      for (int depth = 0; depth < 128; ++depth) {
        auto it_cached = resolved_dir_paths.find(curr);
        if (it_cached != resolved_dir_paths.end()) {
          std::string base = it_cached->second;
          for (auto rit = segments.rbegin(); rit != segments.rend(); ++rit) {
            base += "\\";
            base += *rit;
          }
          return resolved_dir_paths.emplace(frn, std::move(base)).first->second;
        }
        auto it = dir_map.find(curr);
        if (it == dir_map.end() || it->second.parent_frn == curr) break;
        segments.push_back(it->second.name);
        curr = it->second.parent_frn;
      }

      std::string full = drive_root_utf8;
      for (auto rit = segments.rbegin(); rit != segments.rend(); ++rit) {
        full += "\\";
        full += *rit;
      }
      return resolved_dir_paths.emplace(frn, std::move(full)).first->second;
    };

    out_entries.reserve(out_entries.size() + raw_items.size());
    for (auto& item : raw_items) {
      const std::string& parent_path = resolve_dir_path(item.parent_frn);
      FileEntry entry;
      entry.name = std::move(item.name);
      entry.path = parent_path + "\\" + entry.name;
      entry.is_dir = item.is_dir;
      entry.mtime = item.mtime;

      PinyinEngine::Convert(entry.name, entry.acronym, entry.pinyin_full, entry.name_lower);
      out_entries.push_back(std::move(entry));
    }

    return !raw_items.empty();
#endif
  }
};

// High-performance Concurrent Multi-threaded Directory Scanner
class ConcurrentDirectoryScanner : public IFileScanner {
public:
  static constexpr size_t kDefaultMaxEntries = 400000;
  static constexpr int kProgramFilesMaxSubdirDepth = 3;

  struct RootTarget {
    std::wstring path;
    size_t quota_group = 0;
    // -1 表示常规无限制目录；>= 0 表示位于 Program Files / AppData\Local\Programs 内的相对层级
    int restricted_depth = -1;
  };

  struct GroupQuotaTracker {
    std::unique_ptr<std::atomic<size_t>[]> counts;
    size_t group_count = 0;
    size_t max_per_group = 0;

    GroupQuotaTracker(size_t count, size_t max_entries)
      : counts(count > 0 ? std::make_unique<std::atomic<size_t>[]>(count) : nullptr),
        group_count(count),
        max_per_group(max_entries) {
      for (size_t i = 0; i < group_count; ++i) {
        counts[i].store(0, std::memory_order_relaxed);
      }
    }

    bool IsGroupFull(size_t group_idx) const noexcept {
      if (max_per_group == 0 || group_idx >= group_count || !counts) return false;
      return counts[group_idx].load(std::memory_order_relaxed) >= max_per_group;
    }
  };

#ifdef _WIN32
  struct DirIdentity {
    DWORD volume_serial = 0;
    uint64_t file_index = 0;

    bool operator==(const DirIdentity& other) const noexcept {
      return volume_serial == other.volume_serial && file_index == other.file_index;
    }
  };

  struct DirIdentityHash {
    size_t operator()(const DirIdentity& id) const noexcept {
      uint64_t h = static_cast<uint64_t>(id.volume_serial) * 0x9E3779B97F4A7C15ULL;
      h ^= id.file_index + 0x9E3779B97F4A7C15ULL + (h << 6) + (h >> 2);
      return static_cast<size_t>(h);
    }
  };

  struct VisitedDirTracker {
    std::mutex mutex;
    std::unordered_set<DirIdentity, DirIdentityHash> visited;

    void MarkVisited(const DirIdentity& id) {
      std::lock_guard<std::mutex> lk(mutex);
      visited.insert(id);
    }

    bool TryMarkVisited(const DirIdentity& id) {
      std::lock_guard<std::mutex> lk(mutex);
      return visited.insert(id).second;
    }
  };
#else
  struct VisitedDirTracker {};
#endif

  const char* GetName() const override { return "concurrent_directory"; }

  explicit ConcurrentDirectoryScanner(
    size_t thread_count = 0,
    size_t max_entries = kDefaultMaxEntries,
    const std::atomic<bool>* cancel_flag = nullptr,
    size_t max_depth = 0
  ) : max_entries_(max_entries), cancel_flag_(cancel_flag), max_depth_(max_depth) {
    if (thread_count == 0) {
      size_t hw = std::thread::hardware_concurrency();
      thread_count_ = (hw > 0) ? hw : 4;
    } else {
      thread_count_ = thread_count;
    }
  }

  struct DriveVolumeInfo {
    std::wstring root;
    std::string root_utf8;
    std::string drive_type; // "fixed" | "removable" | "directory"
    uint32_t volume_serial = 0;

    bool operator==(const DriveVolumeInfo& other) const noexcept {
      return root_utf8 == other.root_utf8 &&
             drive_type == other.drive_type &&
             volume_serial == other.volume_serial;
    }
  };

  // 纯内核位掩码查询（零磁盘 I/O，绝不唤醒休眠机械硬盘）
  static uint32_t GetLogicalDriveMask() {
#ifdef _WIN32
    return static_cast<uint32_t>(GetLogicalDrives());
#else
    return 0;
#endif
  }

  // 检查当前位掩码中是否存在任何可移动驱动器盘符（GetDriveTypeW 不访问介质，不唤醒磁盘）
  static bool HasRemovableDriveLetter(uint32_t mask) {
#ifdef _WIN32
    for (int i = 0; i < 26; ++i) {
      if ((mask & (1u << i)) == 0) continue;
      wchar_t root[4] = {static_cast<wchar_t>(L'A' + i), L':', L'\\', L'\0'};
      if (GetDriveTypeW(root) == DRIVE_REMOVABLE) {
        return true;
      }
    }
    return false;
#else
    (void)mask;
    return false;
#endif
  }

  // 仅探测就绪的 DRIVE_REMOVABLE 卷（供盘符未变时的读卡器换卡检查，不触碰休眠中的 DRIVE_FIXED 硬盘）
  static std::vector<DriveVolumeInfo> EnumerateReadyRemovableDrives() {
    std::vector<DriveVolumeInfo> volumes;
#ifdef _WIN32
    DWORD prev_error_mode = 0;
    const BOOL mode_changed = SetThreadErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX, &prev_error_mode);

    wchar_t buf[512] = {0};
    DWORD len = GetLogicalDriveStringsW(static_cast<DWORD>(sizeof(buf) / sizeof(wchar_t) - 1), buf);
    if (len > 0 && len < sizeof(buf) / sizeof(wchar_t)) {
      const wchar_t* curr = buf;
      while (*curr != L'\0') {
        std::wstring drive(curr);
        curr += drive.size() + 1;
        if (GetDriveTypeW(drive.c_str()) != DRIVE_REMOVABLE) continue;

        DWORD serial = 0;
        if (!GetVolumeInformationW(drive.c_str(), NULL, 0, &serial, NULL, NULL, NULL, 0)) continue;
        DWORD attrs = GetFileAttributesW(drive.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) continue;

        volumes.push_back({drive, WideToUtf8(drive), "removable", static_cast<uint32_t>(serial)});
      }
    }

    if (mode_changed) {
      SetThreadErrorMode(prev_error_mode, NULL);
    }
#endif
    return volumes;
  }

  // 枚举所有本机就绪的可索引卷：涵盖本地硬盘、外接移动硬盘（DRIVE_FIXED）以及 U 盘/存储卡（就绪的 DRIVE_REMOVABLE）
  static std::vector<DriveVolumeInfo> EnumerateIndexableDrives() {
    std::vector<DriveVolumeInfo> volumes;
#ifdef _WIN32
    // 屏蔽空读卡器/未就绪可移动驱动器触发的系统弹窗
    DWORD prev_error_mode = 0;
    const BOOL mode_changed = SetThreadErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX, &prev_error_mode);

    wchar_t buf[512] = {0};
    DWORD len = GetLogicalDriveStringsW(static_cast<DWORD>(sizeof(buf) / sizeof(wchar_t) - 1), buf);
    if (len > 0 && len < sizeof(buf) / sizeof(wchar_t)) {
      const wchar_t* curr = buf;
      while (*curr != L'\0') {
        std::wstring drive(curr);
        curr += drive.size() + 1;

        UINT dtype = GetDriveTypeW(drive.c_str());
        if (dtype != DRIVE_FIXED && dtype != DRIVE_REMOVABLE) {
          continue;
        }

        DWORD serial = 0;
        // 通过 GetVolumeInformationW 校验卷已就绪（有介质且已挂载文件系统），跳过空卡槽/未解锁卷
        if (!GetVolumeInformationW(drive.c_str(), NULL, 0, &serial, NULL, NULL, NULL, 0)) {
          continue;
        }

        DWORD attrs = GetFileAttributesW(drive.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
          continue;
        }

        DriveVolumeInfo info;
        info.root = drive;
        info.root_utf8 = WideToUtf8(drive);
        info.drive_type = (dtype == DRIVE_REMOVABLE) ? "removable" : "fixed";
        info.volume_serial = static_cast<uint32_t>(serial);
        volumes.push_back(std::move(info));
      }
    }

    if (mode_changed) {
      SetThreadErrorMode(prev_error_mode, NULL);
    }

    if (volumes.empty()) {
      volumes.push_back({L"C:\\", "C:\\", "fixed", 0});
    }
#elif defined(__APPLE__)
    volumes.push_back({L"/Users", "/Users", "fixed", 0});
    volumes.push_back({L"/Applications", "/Applications", "fixed", 0});
    volumes.push_back({L"/System/Applications", "/System/Applications", "fixed", 0});
    // 同时枚举 macOS 外接硬盘 / U 盘挂载点（/Volumes 下非系统根卷的挂载目录）
    DIR* vdp = opendir("/Volumes");
    if (vdp) {
      struct stat root_st {};
      const bool has_root_st = (stat("/", &root_st) == 0);
      struct dirent* vde = nullptr;
      while ((vde = readdir(vdp)) != nullptr) {
        if (vde->d_name[0] == '.') continue;
        std::string vpath = std::string("/Volumes/") + vde->d_name;
        struct stat vst {};
        if (stat(vpath.c_str(), &vst) != 0 || !S_ISDIR(vst.st_mode)) continue;
        if (has_root_st && vst.st_dev == root_st.st_dev) continue;
        volumes.push_back({Utf8ToWide(vpath), vpath, "removable", static_cast<uint32_t>(vst.st_dev)});
      }
      closedir(vdp);
    }
#else
    volumes.push_back({L"/", "/", "fixed", 0});
#endif
    return volumes;
  }

  static std::vector<std::wstring> EnumerateFixedDrives() {
    std::vector<std::wstring> drives;
    auto volumes = EnumerateIndexableDrives();
    drives.reserve(volumes.size());
    for (auto& v : volumes) {
      drives.push_back(std::move(v.root));
    }
    return drives;
  }

  bool Scan(const std::wstring& target, std::vector<FileEntry>& out_entries) override {
    return ScanRoots({target}, out_entries);
  }

  bool ScanRoots(
    const std::vector<std::wstring>& targets,
    std::vector<FileEntry>& out_entries,
    std::vector<std::wstring>* out_boundary_dirs = nullptr
  ) {
    std::vector<RootTarget> grouped_targets;
    grouped_targets.reserve(targets.size());
    for (const auto& t : targets) {
      grouped_targets.push_back({t, 0, -1});
    }

    std::vector<RootTarget> boundary_targets;
    std::vector<RootTarget>* boundary_ptr = out_boundary_dirs ? &boundary_targets : nullptr;
    bool ok = ScanTargetsInternal(grouped_targets, out_entries, nullptr, boundary_ptr, nullptr);

    if (out_boundary_dirs && !boundary_targets.empty()) {
      out_boundary_dirs->reserve(out_boundary_dirs->size() + boundary_targets.size());
      for (auto& b : boundary_targets) {
        out_boundary_dirs->push_back(std::move(b.path));
      }
    }
    return ok;
  }

  bool ScanGroupedRoots(
    const std::vector<RootTarget>& targets,
    std::vector<FileEntry>& out_entries,
    GroupQuotaTracker& quota,
    std::vector<RootTarget>* out_boundary_dirs = nullptr,
    VisitedDirTracker* shared_visited = nullptr
  ) {
    return ScanTargetsInternal(targets, out_entries, &quota, out_boundary_dirs, shared_visited);
  }

private:
  struct DiscoveredSubdir {
    std::wstring path;
    int restricted_depth = -1;
  };

#ifdef _WIN32
  enum class DirFilterMode {
    Normal,
    AppDataRoot,
    AppDataRoaming,
    AppDataRoamingMicrosoft,
    AppDataLocal,
    ProgramDataRoot,
    ProgramDataMicrosoft,
    MicrosoftWindowsToStartMenu
  };

  static bool EqualsIgnoreCase(const wchar_t* a, const wchar_t* b) {
    return _wcsicmp(a, b) == 0;
  }

  static bool EndsWithPathSegmentIgnoreCase(const std::wstring& path, const wchar_t* suffix) {
    size_t path_len = path.size();
    while (path_len > 0 && (path[path_len - 1] == L'\\' || path[path_len - 1] == L'/')) {
      --path_len;
    }
    const size_t suffix_len = std::wcslen(suffix);
    if (path_len < suffix_len) return false;
    if (_wcsnicmp(path.c_str() + (path_len - suffix_len), suffix, suffix_len) != 0) {
      return false;
    }
    if (path_len == suffix_len) return true;
    const wchar_t prev = path[path_len - suffix_len - 1];
    return prev == L'\\' || prev == L'/';
  }

  static DirFilterMode DetectDirFilterMode(const std::wstring& dir) {
    if (EndsWithPathSegmentIgnoreCase(dir, L"AppData\\Roaming\\Microsoft\\Windows") ||
        EndsWithPathSegmentIgnoreCase(dir, L"ProgramData\\Microsoft\\Windows")) {
      return DirFilterMode::MicrosoftWindowsToStartMenu;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"AppData\\Roaming\\Microsoft")) {
      return DirFilterMode::AppDataRoamingMicrosoft;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"ProgramData\\Microsoft")) {
      return DirFilterMode::ProgramDataMicrosoft;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"AppData\\Roaming")) {
      return DirFilterMode::AppDataRoaming;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"AppData\\Local")) {
      return DirFilterMode::AppDataLocal;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"AppData")) {
      return DirFilterMode::AppDataRoot;
    }
    if (EndsWithPathSegmentIgnoreCase(dir, L"ProgramData")) {
      return DirFilterMode::ProgramDataRoot;
    }
    return DirFilterMode::Normal;
  }

  static bool IsBlacklistedWindowsDirName(const wchar_t* name) {
    return EqualsIgnoreCase(name, L"Windows") ||
           EqualsIgnoreCase(name, L"Windows.old") ||
           EqualsIgnoreCase(name, L"WinSxS") ||
           EqualsIgnoreCase(name, L"WindowsApps") ||
           EqualsIgnoreCase(name, L"ModifiableWindowsApps") ||
           EqualsIgnoreCase(name, L"Windows Kits") ||
           EqualsIgnoreCase(name, L"Windows Defender") ||
           EqualsIgnoreCase(name, L"Windows Mail") ||
           EqualsIgnoreCase(name, L"Windows Media Player") ||
           EqualsIgnoreCase(name, L"Windows NT") ||
           EqualsIgnoreCase(name, L"Windows Photo Viewer") ||
           EqualsIgnoreCase(name, L"Windows Portable Devices") ||
           EqualsIgnoreCase(name, L"Windows Security") ||
           EqualsIgnoreCase(name, L"WindowsPowerShell") ||
           EqualsIgnoreCase(name, L"Microsoft Shared") ||
           EqualsIgnoreCase(name, L"Reference Assemblies") ||
           EqualsIgnoreCase(name, L"SymCache") ||
           EqualsIgnoreCase(name, L"symbols") ||
           EqualsIgnoreCase(name, L"PerfLogs") ||
           EqualsIgnoreCase(name, L"Recovery") ||
           EqualsIgnoreCase(name, L"Config.Msi") ||
           EqualsIgnoreCase(name, L"MSOCache") ||
           EqualsIgnoreCase(name, L"$RECYCLE.BIN") ||
           EqualsIgnoreCase(name, L"System Volume Information") ||
           EqualsIgnoreCase(name, L"node_modules") ||
           EqualsIgnoreCase(name, L"__pycache__") ||
           EqualsIgnoreCase(name, L"target") ||
           EqualsIgnoreCase(name, L"CMakeFiles") ||
           EqualsIgnoreCase(name, L"dist") ||
           EqualsIgnoreCase(name, L"build") ||
           EqualsIgnoreCase(name, L"coverage") ||
           EqualsIgnoreCase(name, L"obj") ||
           EqualsIgnoreCase(name, L"venv") ||
           EqualsIgnoreCase(name, L"bower_components") ||
           EqualsIgnoreCase(name, L"GPUCache") ||
           EqualsIgnoreCase(name, L"Code Cache") ||
           EqualsIgnoreCase(name, L"CachedData") ||
           EqualsIgnoreCase(name, L"DawnCache") ||
           EqualsIgnoreCase(name, L"Crashpad");
  }

  // 评估目录项过滤与白名单走廊放行，同时给出子目录是否触发 Program Files 等浅层深度限制
  static bool ShouldSkipWindowsEntry(
    const WIN32_FIND_DATAW& find_data,
    DirFilterMode filter_mode,
    int current_restricted_depth,
    int& out_child_restricted_depth
  ) {
    out_child_restricted_depth = -1;
    const wchar_t* name = find_data.cFileName;
    if (name[0] == L'\0' || name[0] == L'.') {
      return true;
    }

    const DWORD attrs = find_data.dwFileAttributes;
    if ((attrs & FILE_ATTRIBUTE_TEMPORARY) != 0 ||
        (attrs & FILE_ATTRIBUTE_DEVICE) != 0 ||
        (attrs & FILE_ATTRIBUTE_VIRTUAL) != 0) {
      return true;
    }

    const bool is_dir = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const bool is_reparse = (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if (is_reparse &&
        (find_data.dwReserved0 == IO_REPARSE_TAG_APPEXECLINK ||
         find_data.dwReserved0 == IO_REPARSE_TAG_LX_SYMLINK)) {
      return true;
    }

    const bool is_hidden = (attrs & FILE_ATTRIBUTE_HIDDEN) != 0;
    const bool is_system = (attrs & FILE_ATTRIBUTE_SYSTEM) != 0;

    // 处于 AppData / ProgramData 精细白名单走廊时，只放行通往 Start Menu / Programs 的必要目录链
    if (filter_mode != DirFilterMode::Normal) {
      if (!is_dir || (is_hidden && is_system)) {
        return true;
      }
      switch (filter_mode) {
        case DirFilterMode::AppDataRoot:
          return !(EqualsIgnoreCase(name, L"Roaming") || EqualsIgnoreCase(name, L"Local"));
        case DirFilterMode::AppDataRoaming:
        case DirFilterMode::ProgramDataRoot:
          return !EqualsIgnoreCase(name, L"Microsoft");
        case DirFilterMode::AppDataRoamingMicrosoft:
        case DirFilterMode::ProgramDataMicrosoft:
          return !EqualsIgnoreCase(name, L"Windows");
        case DirFilterMode::MicrosoftWindowsToStartMenu:
          return !EqualsIgnoreCase(name, L"Start Menu");
        case DirFilterMode::AppDataLocal:
          if (EqualsIgnoreCase(name, L"Programs")) {
            out_child_restricted_depth = 0;
            return false;
          }
          return true;
        case DirFilterMode::Normal:
          break;
      }
    }

    if (!is_dir) {
      // 普通隐藏或系统文件（如 desktop.ini、hiberfil.sys、~$ lock 文件）跳过；OneDrive 占位文件不带 HIDDEN/SYSTEM
      if (is_hidden || is_system) {
        return true;
      }
      return false;
    }

    // 目录仅在同时具有 HIDDEN 与 SYSTEM 时视为隐藏系统保护目录（如 $Recycle.Bin / XP 遗留兼容 Junction）跳过；
    // 单独带有 SYSTEM 的正常文件夹（如 OneDrive / 本地化桌面、文档、Start Menu）应正常放行
    if (is_hidden && is_system) {
      return true;
    }
    if (is_hidden && !EqualsIgnoreCase(name, L"AppData") && !EqualsIgnoreCase(name, L"ProgramData")) {
      return true;
    }

    if (IsBlacklistedWindowsDirName(name)) {
      return true;
    }

    if (current_restricted_depth >= 0) {
      out_child_restricted_depth = current_restricted_depth + 1;
    } else if (EqualsIgnoreCase(name, L"Program Files") || EqualsIgnoreCase(name, L"Program Files (x86)")) {
      out_child_restricted_depth = 0;
    }

    return false;
  }

  static bool GetDirectoryIdentityAndFinalPath(
    const std::wstring& path,
    DirIdentity& out_id,
    std::wstring& out_final_path
  ) {
    out_final_path.clear();
    HANDLE hDir = CreateFileW(
      path.c_str(),
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      NULL
    );
    if (hDir == INVALID_HANDLE_VALUE) {
      return false;
    }

    BY_HANDLE_FILE_INFORMATION info{};
    BOOL info_ok = GetFileInformationByHandle(hDir, &info);
    if (!info_ok || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      CloseHandle(hDir);
      return false;
    }

    out_id.volume_serial = info.dwVolumeSerialNumber;
    out_id.file_index = (static_cast<uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;

    DWORD required = GetFinalPathNameByHandleW(hDir, NULL, 0, FILE_NAME_NORMALIZED);
    if (required > 0) {
      std::wstring buf(required, L'\0');
      DWORD len = GetFinalPathNameByHandleW(hDir, &buf[0], required, FILE_NAME_NORMALIZED);
      if (len > 0 && len < required) {
        buf.resize(len);
        if (buf.rfind(L"\\\\?\\UNC\\", 0) == 0) {
          out_final_path = L"\\\\" + buf.substr(8);
        } else if (buf.rfind(L"\\\\?\\", 0) == 0) {
          out_final_path = buf.substr(4);
        } else {
          out_final_path = std::move(buf);
        }
        while (out_final_path.size() > 3 && out_final_path.back() == L'\\') {
          out_final_path.pop_back();
        }
      }
    }

    CloseHandle(hDir);
    return true;
  }

  static bool IsAncestorOrSamePath(const std::wstring& child_path, const std::wstring& ancestor_path) {
    if (child_path.empty() || ancestor_path.empty()) return false;
    std::wstring a = ancestor_path;
    std::wstring c = child_path;
    while (a.size() > 3 && a.back() == L'\\') a.pop_back();
    while (c.size() > 3 && c.back() == L'\\') c.pop_back();
    if (c.size() < a.size()) return false;
    if (_wcsnicmp(c.c_str(), a.c_str(), a.size()) != 0) return false;
    if (c.size() == a.size()) return true;
    if (a.back() == L'\\') return true;
    return c[a.size()] == L'\\';
  }

  // 防止重解析点直接跳转到系统关键目录或受控过滤黑名单目录
  static bool IsBlockedFinalTargetPath(const std::wstring& target_final_path) {
    if (target_final_path.empty()) return false;
    size_t i = 0;
    // 跳过盘符如 "C:\" 或 UNC 前缀 "\\"
    if (target_final_path.size() >= 3 && target_final_path[1] == L':') {
      i = 3;
    }
    size_t seg_idx = 0;
    while (i < target_final_path.size()) {
      while (i < target_final_path.size() && (target_final_path[i] == L'\\' || target_final_path[i] == L'/')) {
        ++i;
      }
      if (i >= target_final_path.size()) break;
      size_t start = i;
      while (i < target_final_path.size() && target_final_path[i] != L'\\' && target_final_path[i] != L'/') {
        ++i;
      }
      std::wstring seg = target_final_path.substr(start, i - start);
      if (EqualsIgnoreCase(seg.c_str(), L"WinSxS") ||
          EqualsIgnoreCase(seg.c_str(), L"Windows.old") ||
          EqualsIgnoreCase(seg.c_str(), L"WindowsApps") ||
          EqualsIgnoreCase(seg.c_str(), L"ModifiableWindowsApps") ||
          EqualsIgnoreCase(seg.c_str(), L"node_modules") ||
          EqualsIgnoreCase(seg.c_str(), L"__pycache__") ||
          EqualsIgnoreCase(seg.c_str(), L"$RECYCLE.BIN") ||
          EqualsIgnoreCase(seg.c_str(), L"System Volume Information")) {
        return true;
      }
      // 盘符根下直接名为 Windows 的目录（如 C:\Windows）禁止通过链接绕过进入
      if (seg_idx == 0 && EqualsIgnoreCase(seg.c_str(), L"Windows")) {
        return true;
      }
      ++seg_idx;
    }
    return false;
  }
#endif

  bool ScanTargetsInternal(
    const std::vector<RootTarget>& targets,
    std::vector<FileEntry>& out_entries,
    GroupQuotaTracker* quota,
    std::vector<RootTarget>* out_boundary_dirs,
    VisitedDirTracker* shared_visited
  ) {
    struct QueueItem {
      std::wstring path;
      size_t depth;
      size_t quota_group;
      int restricted_depth;
    };

    VisitedDirTracker local_visited;
    VisitedDirTracker* visited_tracker = shared_visited ? shared_visited : &local_visited;

    std::queue<QueueItem> dir_queue;
    std::mutex queue_mutex;
    std::condition_variable cv;
    std::atomic<int> active_workers(0);
    std::atomic<bool> done(false);
    std::atomic<size_t> total_collected(0);

    std::vector<std::vector<FileEntry>> thread_entries(thread_count_);

    for (const auto& t : targets) {
      if (quota && quota->IsGroupFull(t.quota_group)) {
        continue;
      }
      std::wstring root = t.path;
      if (root.empty()) root = L".";
      while (root.size() > 1 && (root.back() == L'\\' || root.back() == L'/')) {
        if (root.size() == 3 && root[1] == L':') break; // Keep "C:\" intact for FindFirstFileExW("C:\*")
        root.pop_back();
      }
      if (root.size() == 2 && root[1] == L':') {
        root.push_back(L'\\');
      }
#ifdef _WIN32
      DirIdentity root_id{};
      std::wstring unused_final;
      if (GetDirectoryIdentityAndFinalPath(root, root_id, unused_final)) {
        visited_tracker->MarkVisited(root_id);
      }
#endif
      dir_queue.push({std::move(root), 0, t.quota_group, t.restricted_depth});
    }

    if (dir_queue.empty()) return false;

    std::vector<std::thread> workers;
    workers.reserve(thread_count_);

    for (size_t t = 0; t < thread_count_; ++t) {
      workers.emplace_back([&, t]() {
        std::vector<FileEntry>& local_entries = thread_entries[t];
        local_entries.reserve(8192);

        while (true) {
          if (cancel_flag_ && cancel_flag_->load(std::memory_order_relaxed)) {
            {
              std::lock_guard<std::mutex> lock(queue_mutex);
              done.store(true);
            }
            cv.notify_all();
            break;
          }

          QueueItem current_item;
          {
            std::unique_lock<std::mutex> lock(queue_mutex);
            cv.wait(lock, [&]() {
              return !dir_queue.empty() || done.load();
            });

            if (done.load() && dir_queue.empty()) {
              break;
            }

            if (!dir_queue.empty()) {
              current_item = std::move(dir_queue.front());
              dir_queue.pop();
              active_workers++;
            } else {
              continue;
            }
          }

          std::atomic<size_t>& counter_ref =
            (quota && current_item.quota_group < quota->group_count && quota->counts)
              ? quota->counts[current_item.quota_group]
              : total_collected;
          const size_t effective_limit =
            quota ? quota->max_per_group : max_entries_;

          const bool group_already_full =
            (effective_limit > 0 && counter_ref.load(std::memory_order_relaxed) >= effective_limit);

          std::vector<DiscoveredSubdir> subdirs;
          if (!done.load(std::memory_order_relaxed) && !group_already_full) {
            ScanSingleDirectory(
              current_item.path,
              current_item.restricted_depth,
              local_entries,
              subdirs,
              counter_ref,
              effective_limit,
              cancel_flag_,
              visited_tracker
            );
          }

          {
            std::lock_guard<std::mutex> lock(queue_mutex);
            const bool cancelled = (cancel_flag_ && cancel_flag_->load(std::memory_order_relaxed));
            const bool item_limit_reached =
              (effective_limit > 0 && counter_ref.load(std::memory_order_relaxed) >= effective_limit);
            const bool global_limit_reached = (!quota && item_limit_reached);
            const bool depth_allowed = (max_depth_ == 0 || current_item.depth + 1 < max_depth_);

            if (!cancelled && !item_limit_reached) {
              if (depth_allowed) {
                for (auto& sd : subdirs) {
                  dir_queue.push({std::move(sd.path), current_item.depth + 1, current_item.quota_group, sd.restricted_depth});
                }
              } else if (out_boundary_dirs != nullptr) {
                for (auto& sd : subdirs) {
                  out_boundary_dirs->push_back({std::move(sd.path), current_item.quota_group, sd.restricted_depth});
                }
              }
            } else if (cancelled || global_limit_reached) {
              // 仅在全局取消或非分组模式达到全局配额时清空队列；多盘分组模式下单盘满配额不影响其他盘继续扫
              std::queue<QueueItem> empty;
              std::swap(dir_queue, empty);
            }

            active_workers--;
            if (active_workers.load() == 0 && dir_queue.empty()) {
              done.store(true);
            }
            cv.notify_all();
          }
        }
      });
    }

    for (auto& w : workers) {
      if (w.joinable()) w.join();
    }

    // Merge results
    size_t total = 0;
    for (const auto& te : thread_entries) total += te.size();
    out_entries.reserve(out_entries.size() + total);
    for (auto& te : thread_entries) {
      for (auto& e : te) {
        out_entries.push_back(std::move(e));
      }
    }

    return true;
  }

  static void ScanSingleDirectory(
    const std::wstring& dir,
    int current_restricted_depth,
    std::vector<FileEntry>& files,
    std::vector<DiscoveredSubdir>& subdirs,
    std::atomic<size_t>& total_collected,
    size_t max_entries,
    const std::atomic<bool>* cancel_flag,
    VisitedDirTracker* visited_tracker
  ) {
#ifdef _WIN32
    const bool has_trailing_slash = !dir.empty() && (dir.back() == L'\\' || dir.back() == L'/');
    std::wstring search_pattern = has_trailing_slash ? (dir + L"*") : (dir + L"\\*");
    WIN32_FIND_DATAW find_data;
    HANDLE hFind = FindFirstFileExW(
      search_pattern.c_str(),
      FindExInfoBasic,
      &find_data,
      FindExSearchNameMatch,
      NULL,
      FIND_FIRST_EX_LARGE_FETCH
    );

    if (hFind == INVALID_HANDLE_VALUE) return;

    const DirFilterMode filter_mode = DetectDirFilterMode(dir);
    bool current_final_path_resolved = false;
    std::wstring current_final_path;

    do {
      if (cancel_flag && cancel_flag->load(std::memory_order_relaxed)) {
        break;
      }
      if (max_entries > 0 && total_collected.load(std::memory_order_relaxed) >= max_entries) {
        break;
      }

      int child_restricted_depth = -1;
      if (ShouldSkipWindowsEntry(find_data, filter_mode, current_restricted_depth, child_restricted_depth)) {
        continue;
      }

      std::wstring filename = find_data.cFileName;
      std::wstring full_path = has_trailing_slash ? (dir + filename) : (dir + L"\\" + filename);
      const bool is_directory = (find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;

      FileEntry entry;
      entry.name = WideToUtf8(filename);
      entry.path = WideToUtf8(full_path);
      entry.is_dir = is_directory;
      entry.size = (static_cast<uint64_t>(find_data.nFileSizeHigh) << 32) | find_data.nFileSizeLow;
      entry.mtime = (static_cast<uint64_t>(find_data.ftLastWriteTime.dwHighDateTime) << 32) | find_data.ftLastWriteTime.dwLowDateTime;

      PinyinEngine::Convert(entry.name, entry.acronym, entry.pinyin_full, entry.name_lower);
      files.push_back(std::move(entry));
      total_collected.fetch_add(1, std::memory_order_relaxed);

      bool can_descend = is_directory;
      if (can_descend && filter_mode == DirFilterMode::Normal &&
          current_restricted_depth >= kProgramFilesMaxSubdirDepth) {
        can_descend = false;
      }

      if (can_descend && (find_data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        // Bit 29 (0x20000000) 为 Name Surrogate 标志，标识 Junction / Symlink 等可跳转链接；
        // 非代理类重解析点（如 OneDrive 云按需文件 IO_REPARSE_TAG_CLOUD）直接作为实体目录正常深入
        const bool is_name_surrogate = (find_data.dwReserved0 & 0x20000000UL) != 0;
        if (is_name_surrogate) {
          DirIdentity target_id{};
          std::wstring target_final_path;
          if (!GetDirectoryIdentityAndFinalPath(full_path, target_id, target_final_path)) {
            can_descend = false;
          } else if (IsBlockedFinalTargetPath(target_final_path)) {
            can_descend = false;
          } else {
            if (!current_final_path_resolved) {
              DirIdentity self_id{};
              GetDirectoryIdentityAndFinalPath(dir, self_id, current_final_path);
              current_final_path_resolved = true;
            }
            if (!current_final_path.empty() && !target_final_path.empty() &&
                IsAncestorOrSamePath(current_final_path, target_final_path)) {
              can_descend = false;
            } else if (visited_tracker != nullptr && !visited_tracker->TryMarkVisited(target_id)) {
              can_descend = false;
            }
          }
        }
      }

      if (can_descend) {
        subdirs.push_back({std::move(full_path), child_restricted_depth});
      }
    } while (FindNextFileW(hFind, &find_data));

    FindClose(hFind);
#else
    (void)current_restricted_depth;
    (void)visited_tracker;
    std::string dir_utf8 = WideToUtf8(dir);
    if (dir_utf8.empty()) return;
    DIR* dp = opendir(dir_utf8.c_str());
    if (!dp) return;

    struct dirent* de = nullptr;
    while ((de = readdir(dp)) != nullptr) {
      if (cancel_flag && cancel_flag->load(std::memory_order_relaxed)) {
        break;
      }
      if (max_entries > 0 && total_collected.load(std::memory_order_relaxed) >= max_entries) {
        break;
      }
      const char* cname = de->d_name;
      if (std::strcmp(cname, ".") == 0 || std::strcmp(cname, "..") == 0) continue;
      // Skip noisy/hidden directories on macOS/POSIX
      if (cname[0] == '.' || std::strcmp(cname, "Library") == 0 || std::strcmp(cname, "node_modules") == 0) {
        continue;
      }

      std::string name(cname);
      std::string full_utf8 = (dir_utf8 == "/") ? ("/" + name) : (dir_utf8 + "/" + name);
      if (full_utf8 == "/dev" || full_utf8 == "/System/Volumes" || full_utf8 == "/private" || full_utf8 == "/cores" || full_utf8 == "/net") {
        continue;
      }

      struct stat st {};
      if (lstat(full_utf8.c_str(), &st) != 0) continue;
      bool is_symlink = S_ISLNK(st.st_mode);
      bool is_directory = S_ISDIR(st.st_mode);

      FileEntry entry;
      entry.name = name;
      entry.path = full_utf8;
      entry.is_dir = is_directory;
      entry.size = is_directory ? 0 : static_cast<uint64_t>(st.st_size);
      entry.mtime = static_cast<uint64_t>(st.st_mtime) * 1000ULL;

      PinyinEngine::Convert(entry.name, entry.acronym, entry.pinyin_full, entry.name_lower);
      files.push_back(std::move(entry));
      total_collected.fetch_add(1, std::memory_order_relaxed);

      bool is_app_bundle = name.size() > 4 && name.compare(name.size() - 4, 4, ".app") == 0;
      if (is_directory && !is_symlink && !is_app_bundle) {
        subdirs.push_back({Utf8ToWide(full_utf8), -1});
      }
    }
    closedir(dp);
#endif
  }

  size_t thread_count_ = 4;
  size_t max_entries_ = kDefaultMaxEntries;
  const std::atomic<bool>* cancel_flag_ = nullptr;
  size_t max_depth_ = 0;
};

// Generates high-volume realistic mock datasets for stress testing & benchmarking
class MockDatasetGenerator {
public:
  static void Generate(size_t count, std::vector<FileEntry>& out_entries) {
    out_entries.clear();
    out_entries.reserve(count);

    static const char* kChineseApps[] = {
      "微信", "企业微信", "计算器", "百度网盘", "王者荣耀", "网易云音乐",
      "钉钉", "飞书", "腾讯会议", "哔哩哔哩", "阿里云盘", "金山文档",
      "有道词典", "迅雷下载", "剪映专业版", "系统设置", "任务管理器"
    };
    static const char* kEnglishApps[] = {
      "Visual Studio Code", "Google Chrome", "Microsoft Edge", "NodeJS Runtime",
      "Antigravity IDE", "Git for Windows", "Windows Terminal", "Sublime Text",
      "Postman", "Docker Desktop", "Figma", "Notion", "Slack", "Spotify"
    };
    static const char* kExtensions[] = {
      ".exe", ".dll", ".json", ".docx", ".pdf", ".png", ".jpg", ".zip", ".md", ".cpp", ".hpp", ".ts"
    };

    size_t ch_count = sizeof(kChineseApps) / sizeof(kChineseApps[0]);
    size_t en_count = sizeof(kEnglishApps) / sizeof(kEnglishApps[0]);
    size_t ext_count = sizeof(kExtensions) / sizeof(kExtensions[0]);

    for (size_t i = 0; i < count; ++i) {
      FileEntry entry;
      std::string base_name;
      if (i % 2 == 0) {
        base_name = std::string(kChineseApps[(i / 2) % ch_count]) + "_" + std::to_string(i);
      } else {
        base_name = std::string(kEnglishApps[(i / 2) % en_count]) + "_" + std::to_string(i);
      }
      entry.name = base_name + kExtensions[i % ext_count];
      entry.path = "C:\\Program Files\\ZTools\\Data\\IndexMock\\" + entry.name;
      entry.is_dir = (i % 20 == 0);
      entry.size = (i * 1024 + 512) % (100 * 1024 * 1024);
      entry.mtime = 1700000000 + i;

      PinyinEngine::Convert(entry.name, entry.acronym, entry.pinyin_full, entry.name_lower);
      out_entries.push_back(std::move(entry));
    }
  }
};

} // namespace ztools::indexer
