#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <winioctl.h>
#include <string>
#include <vector>
#include <queue>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <chrono>
#include <iostream>

#include "pinyin.hpp"

namespace ztools::indexer {

inline std::string WideToUtf8(const std::wstring& wstr) {
  if (wstr.empty()) return "";
  int size = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), NULL, 0, NULL, NULL);
  if (size <= 0) return "";
  std::string result(size, 0);
  WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), &result[0], size, NULL, NULL);
  return result;
}

inline std::wstring Utf8ToWide(const std::string& str) {
  if (str.empty()) return L"";
  int size = MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), NULL, 0);
  if (size <= 0) return L"";
  std::wstring result(size, 0);
  MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), &result[0], size);
  return result;
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
    // Determine volume from path, e.g. "C:\\..." -> "\\\\.\\C:"
    std::wstring volume = L"\\\\.\\";
    if (target.size() >= 2 && target[1] == L':') {
      volume += target.substr(0, 2);
    } else {
      volume += L"C:";
    }

    HANDLE hVol = CreateFileW(
      volume.c_str(),
      GENERIC_READ | GENERIC_WRITE,
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

    size_t count = 0;
    while (DeviceIoControl(hVol, FSCTL_ENUM_USN_DATA, &enumData, sizeof(enumData), buffer.data(), kBufferSize, &bytesReturned, NULL)) {
      if (bytesReturned <= sizeof(USN)) break;

      DWORD offset = sizeof(USN);
      while (offset < bytesReturned) {
        auto* record = reinterpret_cast<USN_RECORD_V2*>(buffer.data() + offset);
        if (record->RecordLength == 0) break;

        std::wstring wname(reinterpret_cast<wchar_t*>(reinterpret_cast<BYTE*>(record) + record->FileNameOffset), record->FileNameLength / sizeof(wchar_t));
        std::string name = WideToUtf8(wname);
        
        FileEntry entry;
        entry.name = name;
        entry.path = WideToUtf8(volume) + "\\" + name;
        entry.is_dir = (record->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        entry.mtime = record->TimeStamp.QuadPart;

        PinyinEngine::Convert(name, entry.acronym, entry.pinyin_full, entry.name_lower);
        out_entries.push_back(std::move(entry));

        ++count;
        offset += record->RecordLength;
      }

      enumData.StartFileReferenceNumber = *reinterpret_cast<DWORDLONG*>(buffer.data());
    }

    CloseHandle(hVol);
    return count > 0;
  }
};

// High-performance Concurrent Multi-threaded Directory Scanner
class ConcurrentDirectoryScanner : public IFileScanner {
public:
  const char* GetName() const override { return "concurrent_directory"; }

  explicit ConcurrentDirectoryScanner(size_t thread_count = 0) {
    if (thread_count == 0) {
      size_t hw = std::thread::hardware_concurrency();
      thread_count_ = (hw > 0) ? hw : 4;
    } else {
      thread_count_ = thread_count;
    }
  }

  bool Scan(const std::wstring& target, std::vector<FileEntry>& out_entries) override {
    std::wstring root = target;
    if (root.empty()) root = L".";
    while (root.size() > 1 && (root.back() == L'\\' || root.back() == L'/')) {
      root.pop_back();
    }

    std::queue<std::wstring> dir_queue;
    std::mutex queue_mutex;
    std::condition_variable cv;
    std::atomic<int> active_workers(0);
    std::atomic<bool> done(false);

    std::vector<std::vector<FileEntry>> thread_entries(thread_count_);

    dir_queue.push(root);

    std::vector<std::thread> workers;
    workers.reserve(thread_count_);

    for (size_t t = 0; t < thread_count_; ++t) {
      workers.emplace_back([&, t]() {
        std::vector<FileEntry>& local_entries = thread_entries[t];
        local_entries.reserve(4096);

        while (true) {
          std::wstring current_dir;
          {
            std::unique_lock<std::mutex> lock(queue_mutex);
            cv.wait(lock, [&]() {
              return !dir_queue.empty() || done.load();
            });

            if (done.load() && dir_queue.empty()) {
              break;
            }

            if (!dir_queue.empty()) {
              current_dir = std::move(dir_queue.front());
              dir_queue.pop();
              active_workers++;
            } else {
              continue;
            }
          }

          std::vector<std::wstring> subdirs;
          ScanSingleDirectory(current_dir, local_entries, subdirs);

          {
            std::lock_guard<std::mutex> lock(queue_mutex);
            for (auto& sd : subdirs) {
              dir_queue.push(std::move(sd));
            }
            active_workers--;
            if (active_workers.load() == 0 && dir_queue.empty()) {
              done.store(true);
              cv.notify_all();
            } else {
              cv.notify_all();
            }
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

private:
  static void ScanSingleDirectory(
    const std::wstring& dir,
    std::vector<FileEntry>& files,
    std::vector<std::wstring>& subdirs
  ) {
    std::wstring search_pattern = dir + L"\\*";
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

    do {
      if (wcscmp(find_data.cFileName, L".") == 0 || wcscmp(find_data.cFileName, L"..") == 0) {
        continue;
      }

      std::wstring filename = find_data.cFileName;
      std::wstring full_path = dir + L"\\" + filename;
      bool is_directory = (find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;

      FileEntry entry;
      entry.name = WideToUtf8(filename);
      entry.path = WideToUtf8(full_path);
      entry.is_dir = is_directory;
      entry.size = (static_cast<uint64_t>(find_data.nFileSizeHigh) << 32) | find_data.nFileSizeLow;
      entry.mtime = (static_cast<uint64_t>(find_data.ftLastWriteTime.dwHighDateTime) << 32) | find_data.ftLastWriteTime.dwLowDateTime;

      PinyinEngine::Convert(entry.name, entry.acronym, entry.pinyin_full, entry.name_lower);
      files.push_back(std::move(entry));

      if (is_directory && !(find_data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        subdirs.push_back(std::move(full_path));
      }
    } while (FindNextFileW(hFind, &find_data));

    FindClose(hFind);
  }

  size_t thread_count_ = 4;
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
