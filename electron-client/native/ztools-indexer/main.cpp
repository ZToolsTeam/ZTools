#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#endif
#include <iostream>
#include <string>
#include <vector>
#include <queue>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <chrono>
#include <functional>
#include <iterator>
#include <algorithm>
#include <cstring>

#include "file_scanner.hpp"
#include "flat_trie.hpp"
#include "index_cache.hpp"
#include "../shared/json_rpc.hpp"

using namespace ztools::sidecar;
using namespace ztools::indexer;

namespace {

std::string NormalizeRootKey(const std::string& raw) {
  std::string out = raw;
  while (out.size() > 1 && (out.back() == '\\' || out.back() == '/')) {
    if (out.size() == 3 && out[1] == ':') break;
    out.pop_back();
  }
  if (out.size() == 2 && out[1] == ':') {
    out.push_back('\\');
  }
#ifdef _WIN32
  for (char& c : out) {
    if (c == '/') c = '\\';
    c = static_cast<char>(::tolower(static_cast<unsigned char>(c)));
  }
#endif
  return out;
}

// 零堆分配路径前缀匹配：norm_root 须已通过 NormalizeRootKey 预处理
bool PathMatchesNormalizedRoot(std::string_view file_path, std::string_view norm_root) {
  if (file_path.size() < norm_root.size() || norm_root.empty()) return false;
  for (size_t i = 0; i < norm_root.size(); ++i) {
    char p = file_path[i];
#ifdef _WIN32
    if (p == '/') p = '\\';
    p = static_cast<char>(::tolower(static_cast<unsigned char>(p)));
#endif
    if (p != norm_root[i]) return false;
  }
  if (file_path.size() == norm_root.size()) return true;
  if (norm_root.back() == '\\' || norm_root.back() == '/') return true;
  const char next = file_path[norm_root.size()];
  return next == '\\' || next == '/';
}

size_t ComputePerDriveQuota(size_t drive_count) {
  static constexpr size_t kAllDrivesTotalBudget = 1200000;
  static constexpr size_t kMinPerDrive = 150000;
  static constexpr size_t kMaxPerDrive = 350000;
  if (drive_count == 0) return kMinPerDrive;
  size_t quota = kAllDrivesTotalBudget / drive_count;
  return (std::clamp)(quota, kMinPerDrive, kMaxPerDrive);
}

struct ScopedAtomicFlag {
  std::atomic<bool>& flag;
  explicit ScopedAtomicFlag(std::atomic<bool>& f) : flag(f) {
    flag.store(true, std::memory_order_relaxed);
  }
  ~ScopedAtomicFlag() {
    flag.store(false, std::memory_order_relaxed);
  }
};

} // namespace

int main(int argc, char* argv[]) {
#ifdef _WIN32
  // Ensure binary mode for standard streams on Windows
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  size_t auto_mock_count = 0;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--pipe" || arg.rfind("--pipe=", 0) == 0) {
      // 安全加固：彻底移除无 DACL 鉴权的 Named Pipe 调试入口，遇该参数直接 Fail-Closed 退出
      std::cerr << "[ztools-indexer] Named pipe transport (--pipe) is disabled for security reasons. Use stdin/stdout JSON-RPC transport.\n";
      return 2;
    } else if (arg.rfind("--mock-count=", 0) == 0) {
      auto_mock_count = std::stoull(arg.substr(13));
    }
  }

  FlatTrieIndex index;
  std::mutex index_mutex;
  std::mutex write_mutex;
  std::atomic<bool> cancel_scan(false);
  std::atomic<bool> is_indexing(false);
  std::atomic<bool> all_drives_mode(false);
  std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> tracked_volumes;
  std::string active_cache_path;

  if (auto_mock_count > 0) {
    std::vector<FileEntry> entries;
    MockDatasetGenerator::Generate(auto_mock_count, entries);
    index.Build(std::move(entries));
  }

  auto build_indexed_drives_json = [&]() -> JsonValue {
    JsonValue arr = JsonValue::Array();
    std::lock_guard<std::mutex> lk(index_mutex);
    for (const auto& vol : tracked_volumes) {
      arr.push_back(JsonValue(vol.root_utf8));
    }
    return arr;
  };

  auto run_staged_concurrent_scan = [&](
    const std::vector<ConcurrentDirectoryScanner::RootTarget>& root_targets,
    size_t per_group_max_entries,
    std::vector<FileEntry>& out_entries,
    bool publish_quick_stage,
    const std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo>* quick_volumes
  ) {
    if (root_targets.empty() || cancel_scan.load(std::memory_order_relaxed)) return;

    ConcurrentDirectoryScanner::GroupQuotaTracker quota(root_targets.size(), per_group_max_entries);
    ConcurrentDirectoryScanner::VisitedDirTracker visited_tracker;

    if (publish_quick_stage) {
      // Stage 1: 并发扫描全盘前 4 层并收集未深入的边界子目录，随后立即上线浅层索引
      static constexpr size_t kQuickStageMaxDepth = 4;
      std::vector<ConcurrentDirectoryScanner::RootTarget> boundary_dirs;
      ConcurrentDirectoryScanner quickScanner(0, 0, &cancel_scan, kQuickStageMaxDepth);
      quickScanner.ScanGroupedRoots(root_targets, out_entries, quota, &boundary_dirs, &visited_tracker);

      if (!out_entries.empty() && !cancel_scan.load(std::memory_order_relaxed)) {
        std::vector<FileEntry> quick_copy = out_entries;
        FlatTrieIndex quick_staging(false);
        quick_staging.Build(std::move(quick_copy));
        std::lock_guard<std::mutex> lk(index_mutex);
        index.SwapData(quick_staging);
        if (quick_volumes != nullptr) {
          tracked_volumes = *quick_volumes;
        }
      }

      // Stage 2: 以 boundary_dirs 为起点多盘真并发续扫深层目录，合并结果而绝不重扫前 4 层
      if (!boundary_dirs.empty() && !cancel_scan.load(std::memory_order_relaxed)) {
        std::vector<FileEntry> stage2_entries;
        ConcurrentDirectoryScanner deepScanner(0, 0, &cancel_scan, 0);
        deepScanner.ScanGroupedRoots(boundary_dirs, stage2_entries, quota, nullptr, &visited_tracker);
        if (!stage2_entries.empty()) {
          out_entries.reserve(out_entries.size() + stage2_entries.size());
          out_entries.insert(
            out_entries.end(),
            std::make_move_iterator(stage2_entries.begin()),
            std::make_move_iterator(stage2_entries.end())
          );
        }
      }
    } else {
      // 已有索引刷新时直接多盘并发一趟扫完，仍按每盘独立配额上限控制
      ConcurrentDirectoryScanner fullScanner(0, 0, &cancel_scan, 0);
      fullScanner.ScanGroupedRoots(root_targets, out_entries, quota, nullptr, &visited_tracker);
    }
  };

  struct VolumeSyncSummary {
    bool changed = false;
    size_t added_count = 0;
    size_t removed_count = 0;
    size_t total_indexed = 0;
    double elapsed_ms = 0.0;
  };

  // 按卷增量同步：新插入的移动硬盘/U盘仅扫描新卷并合并，拔出的卷直接剔除旧条目，零全盘重扫开销
  auto sync_volumes_incremental = [&](const std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo>& desired) -> VolumeSyncSummary {
    VolumeSyncSummary summary;
    if (cancel_scan.load(std::memory_order_relaxed)) return summary;

    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> current;
    {
      std::lock_guard<std::mutex> lk(index_mutex);
      current = tracked_volumes;
      summary.total_indexed = index.Size();
    }

    std::unordered_map<std::string, ConcurrentDirectoryScanner::DriveVolumeInfo> current_map;
    for (const auto& vol : current) {
      current_map[NormalizeRootKey(vol.root_utf8)] = vol;
    }

    std::unordered_map<std::string, ConcurrentDirectoryScanner::DriveVolumeInfo> desired_map;
    for (const auto& vol : desired) {
      desired_map[NormalizeRootKey(vol.root_utf8)] = vol;
    }

    std::vector<std::string> strip_roots;
    std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> added_vols;

    for (const auto& [key, cur_vol] : current_map) {
      auto it = desired_map.find(key);
      if (it == desired_map.end()) {
        strip_roots.push_back(cur_vol.root_utf8);
        ++summary.removed_count;
      } else if (cur_vol.volume_serial != it->second.volume_serial ||
                 cur_vol.drive_type != it->second.drive_type) {
        strip_roots.push_back(cur_vol.root_utf8);
        added_vols.push_back(it->second);
        ++summary.removed_count;
        ++summary.added_count;
      }
    }

    for (const auto& vol : desired) {
      std::string key = NormalizeRootKey(vol.root_utf8);
      if (current_map.find(key) == current_map.end()) {
        added_vols.push_back(vol);
        ++summary.added_count;
      }
    }

    if (strip_roots.empty() && added_vols.empty()) {
      return summary;
    }

    ScopedAtomicFlag indexing_guard(is_indexing);
    summary.changed = true;

    // 锁外预先归一化待剔除卷前缀，避免在百万条目循环内反复分配字符串
    std::vector<std::string> norm_strip_roots;
    norm_strip_roots.reserve(strip_roots.size());
    for (const auto& root : strip_roots) {
      norm_strip_roots.push_back(NormalizeRootKey(root));
    }

    // 1. 保留未变化卷的已有索引条目（不触碰原盘 I/O）
    std::vector<FileEntry> merged_entries;
    {
      std::lock_guard<std::mutex> lk(index_mutex);
      const auto& existing = index.GetEntries();
      if (norm_strip_roots.empty()) {
        merged_entries = existing;
      } else {
        merged_entries.reserve(existing.size());
        for (const auto& entry : existing) {
          bool stripped = false;
          for (const auto& norm_root : norm_strip_roots) {
            if (PathMatchesNormalizedRoot(entry.path, norm_root)) {
              stripped = true;
              break;
            }
          }
          if (!stripped) {
            merged_entries.push_back(entry);
          }
        }
      }
    }

    // 2. 仅扫描新增或卷序列号变更的卷；深层大移动硬盘先发布前 4 层秒级可搜，再后台补齐深层
    if (!added_vols.empty() && !cancel_scan.load(std::memory_order_relaxed)) {
      const size_t per_drive_quota = ComputePerDriveQuota(desired.size());
      std::vector<ConcurrentDirectoryScanner::RootTarget> targets;
      targets.reserve(added_vols.size());
      for (size_t i = 0; i < added_vols.size(); ++i) {
        targets.push_back({added_vols[i].root, i, -1});
      }

      ConcurrentDirectoryScanner::GroupQuotaTracker quota(targets.size(), per_drive_quota);
      ConcurrentDirectoryScanner::VisitedDirTracker visited_tracker;
      static constexpr size_t kHotplugQuickDepth = 4;
      std::vector<ConcurrentDirectoryScanner::RootTarget> boundary_dirs;
      std::vector<FileEntry> new_entries;
      ConcurrentDirectoryScanner quickScanner(0, 0, &cancel_scan, kHotplugQuickDepth);
      quickScanner.ScanGroupedRoots(targets, new_entries, quota, &boundary_dirs, &visited_tracker);

      // 仅当新卷存在深层子目录（如大容量移动硬盘）时提前发布 Stage 1，小 U 盘直接单次合入零额外建索引
      if (!boundary_dirs.empty() && !new_entries.empty() && !cancel_scan.load(std::memory_order_relaxed)) {
        std::vector<FileEntry> quick_merged = merged_entries;
        quick_merged.reserve(quick_merged.size() + new_entries.size());
        quick_merged.insert(quick_merged.end(), new_entries.begin(), new_entries.end());
        FlatTrieIndex quick_staging(false);
        quick_staging.Build(std::move(quick_merged));
        std::lock_guard<std::mutex> lk(index_mutex);
        index.SwapData(quick_staging);
        tracked_volumes = desired;
      }

      if (!boundary_dirs.empty() && !cancel_scan.load(std::memory_order_relaxed)) {
        std::vector<FileEntry> deep_entries;
        ConcurrentDirectoryScanner deepScanner(0, 0, &cancel_scan, 0);
        deepScanner.ScanGroupedRoots(boundary_dirs, deep_entries, quota, nullptr, &visited_tracker);
        if (!deep_entries.empty()) {
          new_entries.reserve(new_entries.size() + deep_entries.size());
          new_entries.insert(
            new_entries.end(),
            std::make_move_iterator(deep_entries.begin()),
            std::make_move_iterator(deep_entries.end())
          );
        }
      }

      if (!new_entries.empty()) {
        merged_entries.reserve(merged_entries.size() + new_entries.size());
        merged_entries.insert(
          merged_entries.end(),
          std::make_move_iterator(new_entries.begin()),
          std::make_move_iterator(new_entries.end())
        );
      }
    }

    if (cancel_scan.load(std::memory_order_relaxed)) {
      return summary;
    }

    FlatTrieIndex staging(false);
    staging.Build(std::move(merged_entries));
    summary.total_indexed = staging.Size();
    {
      std::lock_guard<std::mutex> lk(index_mutex);
      index.SwapData(staging);
      tracked_volumes = desired;
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    summary.elapsed_ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
    return summary;
  };

  // 后台异步索引工作线程，避免磁盘扫描与建索引阻塞主线程的心跳 ping 与 search_files；
  // 全盘模式下空闲期每 3 秒极轻检测卷列表变更，自动热插拔增量索引外接移动硬盘与 U 盘
  std::queue<std::function<void()>> bg_queue;
  std::mutex bg_mutex;
  std::condition_variable bg_cv;
  bool bg_stop = false;

  std::atomic<uint32_t> last_drive_mask(ConcurrentDirectoryScanner::GetLogicalDriveMask());

  std::thread bg_worker([&]() {
    int removable_poll_ticks = 0;
    while (true) {
      std::function<void()> task;
      bool should_poll_drives = false;
      {
        std::unique_lock<std::mutex> lk(bg_mutex);
        if (all_drives_mode.load(std::memory_order_relaxed)) {
          bool woke = bg_cv.wait_for(lk, std::chrono::seconds(3), [&]() {
            return bg_stop || !bg_queue.empty();
          });
          if (bg_stop && bg_queue.empty()) {
            return;
          }
          if (!woke && bg_queue.empty()) {
            should_poll_drives = all_drives_mode.load(std::memory_order_relaxed);
          } else if (!bg_queue.empty()) {
            task = std::move(bg_queue.front());
            bg_queue.pop();
          }
        } else {
          bg_cv.wait(lk, [&]() { return bg_stop || !bg_queue.empty(); });
          if (bg_stop && bg_queue.empty()) {
            return;
          }
          task = std::move(bg_queue.front());
          bg_queue.pop();
        }
      }
      if (task) {
        removable_poll_ticks = 0;
        task();
      } else if (should_poll_drives && !cancel_scan.load(std::memory_order_relaxed)) {
#ifdef _WIN32
        // 优先仅检查内核逻辑盘符位掩码（零磁盘 I/O，绝不唤醒休眠机械硬盘/外接硬盘）
        const uint32_t current_mask = ConcurrentDirectoryScanner::GetLogicalDriveMask();
        const uint32_t prev_mask = last_drive_mask.load(std::memory_order_relaxed);
        if (current_mask != prev_mask) {
          last_drive_mask.store(current_mask, std::memory_order_relaxed);
          removable_poll_ticks = 0;
          auto current_drives = ConcurrentDirectoryScanner::EnumerateIndexableDrives();
          sync_volumes_incremental(current_drives);
        } else if (++removable_poll_ticks >= 5) {
          // 盘符未变时仅每 15 秒探测已存在的可移动槽位（适配读卡器同盘符换卡），绝不触碰 DRIVE_FIXED
          removable_poll_ticks = 0;
          if (ConcurrentDirectoryScanner::HasRemovableDriveLetter(current_mask)) {
            auto ready_removables = ConcurrentDirectoryScanner::EnumerateReadyRemovableDrives();
            std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> desired;
            {
              std::lock_guard<std::mutex> lk(index_mutex);
              for (const auto& vol : tracked_volumes) {
                if (vol.drive_type != "removable") {
                  desired.push_back(vol);
                }
              }
            }
            for (auto& rv : ready_removables) {
              desired.push_back(std::move(rv));
            }
            sync_volumes_incremental(desired);
          }
        }
#else
        auto current_drives = ConcurrentDirectoryScanner::EnumerateIndexableDrives();
        sync_volumes_incremental(current_drives);
#endif
      }
    }
  });

  auto stop_bg_worker = [&]() {
    cancel_scan.store(true, std::memory_order_relaxed);
    all_drives_mode.store(false, std::memory_order_relaxed);
    {
      std::lock_guard<std::mutex> lk(bg_mutex);
      bg_stop = true;
      std::queue<std::function<void()>> empty;
      std::swap(bg_queue, empty);
    }
    bg_cv.notify_all();
    if (bg_worker.joinable()) {
      bg_worker.join();
    }
  };

  auto execute_heavy_rpc = [&](const JsonRpcRequest& req) -> JsonRpcResponse {
    if (req.method == "generate_mock_dataset") {
      ScopedAtomicFlag indexing_guard(is_indexing);
      all_drives_mode.store(false, std::memory_order_relaxed);
      size_t count = static_cast<size_t>(req.params.get_int("count", 1000000));
      auto t0 = std::chrono::high_resolution_clock::now();
      std::vector<FileEntry> entries;
      MockDatasetGenerator::Generate(count, entries);
      FlatTrieIndex staging(false);
      staging.Build(std::move(entries));
      size_t total_indexed = staging.Size();
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        index.SwapData(staging);
        tracked_volumes.clear();
      }
      auto t1 = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("elapsed_ms", JsonValue(ms));
      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "sync_drives") {
      std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> desired;
      const JsonValue* roots_val = req.params.find("roots");
      if (roots_val != nullptr && roots_val->is_array()) {
        // 显式指定卷根列表（测试或手动自定义同步），关闭自动盘符轮询防止覆盖
        all_drives_mode.store(false, std::memory_order_relaxed);
        for (const auto& item : roots_val->arr_val) {
          if (item.is_string() && !item.str_val.empty()) {
            ConcurrentDirectoryScanner::DriveVolumeInfo info;
            info.root = Utf8ToWide(item.str_val);
            info.root_utf8 = item.str_val;
            info.drive_type = "directory";
            info.volume_serial = 0;
            desired.push_back(std::move(info));
          }
        }
      } else {
        const uint32_t pre_sync_mask = ConcurrentDirectoryScanner::GetLogicalDriveMask();
        desired = ConcurrentDirectoryScanner::EnumerateIndexableDrives();
        last_drive_mask.store(pre_sync_mask, std::memory_order_relaxed);
        all_drives_mode.store(true, std::memory_order_relaxed);
      }

      VolumeSyncSummary summary = sync_volumes_incremental(desired);
      JsonValue res = JsonValue::Object();
      res.set("changed", JsonValue(summary.changed));
      res.set("added_count", JsonValue(static_cast<int64_t>(summary.added_count)));
      res.set("removed_count", JsonValue(static_cast<int64_t>(summary.removed_count)));
      res.set("total_indexed", JsonValue(static_cast<int64_t>(summary.total_indexed)));
      res.set("elapsed_ms", JsonValue(summary.elapsed_ms));
      res.set("indexed_drives", build_indexed_drives_json());
      return JsonRpcResponse::Success(req.id, res);
    }

    // req.method == "index_path"
    ScopedAtomicFlag indexing_guard(is_indexing);
    std::string path_str = req.params.get_string("path", ".");
    std::string scanner_pref = req.params.get_string("scanner", "auto");
    std::string cache_path = req.params.get_string("cache_path", "");
    const bool force_staged = req.params.get_bool("staged", false);
    if (!cache_path.empty()) {
      std::lock_guard<std::mutex> lk(index_mutex);
      active_cache_path = cache_path;
    }

    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<FileEntry> entries;
    std::string scanner_used = "concurrent_directory";
    std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> scanned_volumes;

    if (path_str == "*" || path_str == "all") {
      // 必须在枚举卷之前采样逻辑盘符掩码：若耗时全盘扫描期间插入新 U 盘/移动硬盘，
      // 扫描结束后下一次 3s 轮询才会检测到掩码变化并自动增量补扫，绝不漏盘
      const uint32_t pre_scan_mask = ConcurrentDirectoryScanner::GetLogicalDriveMask();
      scanned_volumes = ConcurrentDirectoryScanner::EnumerateIndexableDrives();
      scanner_used = "all_drives_concurrent";

      bool is_empty = false;
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        is_empty = (index.Size() == 0);
      }

      const size_t per_drive_max_entries = ComputePerDriveQuota(scanned_volumes.size());
      std::vector<ConcurrentDirectoryScanner::RootTarget> root_targets;
      root_targets.reserve(scanned_volumes.size());
      for (size_t i = 0; i < scanned_volumes.size(); ++i) {
        root_targets.push_back({scanned_volumes[i].root, i, -1});
      }
      run_staged_concurrent_scan(root_targets, per_drive_max_entries, entries, is_empty || force_staged, &scanned_volumes);
      last_drive_mask.store(pre_scan_mask, std::memory_order_relaxed);
      all_drives_mode.store(true, std::memory_order_relaxed);
    } else {
      all_drives_mode.store(false, std::memory_order_relaxed);
      std::wstring wpath = Utf8ToWide(path_str);
      scanned_volumes.push_back({wpath, path_str, "directory", 0});
      bool is_drive_root = (wpath.size() <= 3) || (wpath.size() == 2 && wpath[1] == L':');
      if (!force_staged && (scanner_pref == "usn" || (scanner_pref == "auto" && is_drive_root))) {
        UsnJournalScanner usn;
        if (usn.Scan(wpath, entries)) {
          scanner_used = "usn_journal";
        }
      }

      if (entries.empty()) {
        if (force_staged) {
          std::vector<ConcurrentDirectoryScanner::RootTarget> targets = {{wpath, 0, -1}};
          run_staged_concurrent_scan(targets, ConcurrentDirectoryScanner::kDefaultMaxEntries, entries, true, &scanned_volumes);
        } else {
          ConcurrentDirectoryScanner dirScanner(0, ConcurrentDirectoryScanner::kDefaultMaxEntries, &cancel_scan);
          dirScanner.Scan(wpath, entries);
#ifdef __APPLE__
          if (path_str.rfind("/Users/", 0) == 0 && !cancel_scan.load(std::memory_order_relaxed)) {
            dirScanner.Scan(Utf8ToWide("/Applications"), entries);
            dirScanner.Scan(Utf8ToWide("/System/Applications"), entries);
          }
#endif
        }
        scanner_used = "concurrent_directory";
      }
    }

    FlatTrieIndex staging(false);
    staging.Build(std::move(entries));
    size_t total_indexed = staging.Size();
    std::string snapshot_target;
    std::vector<std::string> drive_roots_snapshot;
    drive_roots_snapshot.reserve(scanned_volumes.size());
    for (const auto& vol : scanned_volumes) {
      drive_roots_snapshot.push_back(vol.root_utf8);
    }
    {
      std::lock_guard<std::mutex> lk(index_mutex);
      index.SwapData(staging);
      tracked_volumes = std::move(scanned_volumes);
      snapshot_target = active_cache_path;
    }
    if (!snapshot_target.empty() && total_indexed > 0 && !cancel_scan.load(std::memory_order_relaxed)) {
      std::vector<FileEntry> snapshot_copy;
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        snapshot_copy = index.GetEntries();
      }
      IndexSnapshotCache::Save(snapshot_target, snapshot_copy, drive_roots_snapshot);
    }
    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

    JsonValue res = JsonValue::Object();
    res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
    res.set("scanner_used", JsonValue(scanner_used));
    res.set("elapsed_ms", JsonValue(ms));
    res.set("indexed_drives", build_indexed_drives_json());
    return JsonRpcResponse::Success(req.id, res);
  };

  auto rpc_handler = [&](const JsonRpcRequest& req) -> JsonRpcResponse {
    if (req.method == "ping") {
      return JsonRpcResponse::Success(req.id, JsonValue("pong"));
    }

    if (req.method == "load_cache") {
      auto t0 = std::chrono::high_resolution_clock::now();
      std::string cache_path = req.params.get_string("cache_path", "");
      bool loaded = false;
      size_t total_indexed = 0;
      if (!cache_path.empty()) {
        std::vector<FileEntry> cached_entries;
        std::vector<std::string> cached_roots;
        if (IndexSnapshotCache::Load(cache_path, cached_entries, cached_roots) && !cached_entries.empty()) {
          FlatTrieIndex staging(false);
          staging.Build(std::move(cached_entries));
          std::vector<ConcurrentDirectoryScanner::DriveVolumeInfo> vols;
          vols.reserve(cached_roots.size());
          for (const auto& r : cached_roots) {
            ConcurrentDirectoryScanner::DriveVolumeInfo info;
            info.root = Utf8ToWide(r);
            info.root_utf8 = r;
            info.drive_type = "cached";
            vols.push_back(std::move(info));
          }
          std::lock_guard<std::mutex> lk(index_mutex);
          active_cache_path = cache_path;
          if (index.Size() == 0) {
            index.SwapData(staging);
            tracked_volumes = std::move(vols);
            loaded = true;
          }
          total_indexed = index.Size();
        }
      }
      auto t1 = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;
      JsonValue res = JsonValue::Object();
      res.set("loaded", JsonValue(loaded));
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("elapsed_ms", JsonValue(ms));
      res.set("indexed_drives", build_indexed_drives_json());
      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "search_files") {
      std::string query = req.params.get_string("query", "");
      SearchOptions opts;
      int64_t raw_limit = req.params.get_int("limit", 50);
      opts.limit = (raw_limit > 0) ? static_cast<size_t>(raw_limit) : 50;
      int64_t raw_offset = req.params.get_int("offset", 0);
      opts.offset = (raw_offset > 0) ? static_cast<size_t>(raw_offset) : 0;

      if (const JsonValue* ct_val = req.params.find("content_type")) {
        if (ct_val->is_number() && ct_val->int_val >= 0) {
          opts.content_type_mask = static_cast<uint16_t>(ct_val->int_val & 0xFFFF);
        } else if (ct_val->is_string()) {
          opts.content_type_mask = ParseContentTypeMaskString(ct_val->str_val);
        }
      }
      opts.kind = ParseSearchKind(req.params.get_string("kind", "all"));
      opts.sort_by = ParseSearchSortBy(req.params.get_string("sort_by", "relevance"));
      opts.include_hidden = req.params.get_bool("include_hidden", true);
      opts.path_prefix = req.params.get_string("path_prefix", "");

      SearchResponse sresp;
      size_t total_indexed = 0;
      JsonValue drivesArr = JsonValue::Array();
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        sresp = index.Search(query, opts);
        total_indexed = index.Size();
        for (const auto& vol : tracked_volumes) {
          drivesArr.push_back(JsonValue(vol.root_utf8));
        }
      }

      JsonValue res = JsonValue::Object();
      JsonValue filesArr = JsonValue::Array();
      for (const auto& f : sresp.files) {
        JsonValue item = JsonValue::Object();
        item.set("name", JsonValue(f.name));
        item.set("path", JsonValue(f.path));
        item.set("is_dir", JsonValue(f.is_dir));
        item.set("size", JsonValue(static_cast<int64_t>(f.size)));
        item.set("mtime", JsonValue(static_cast<int64_t>(f.mtime)));
        item.set("acronym", JsonValue(f.acronym));
        item.set("pinyin", JsonValue(f.pinyin_full));
        filesArr.push_back(item);
      }
      res.set("files", filesArr);
      res.set("count", JsonValue(static_cast<int64_t>(sresp.files.size())));
      res.set("total_matches", JsonValue(static_cast<int64_t>(sresp.total_matches)));
      res.set("offset", JsonValue(static_cast<int64_t>(sresp.offset)));
      res.set("has_more", JsonValue(sresp.has_more));
      res.set("elapsed_us", JsonValue(static_cast<int64_t>(sresp.elapsed_us)));
      res.set("elapsed_ms", JsonValue(sresp.elapsed_ms));
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("indexing", JsonValue(is_indexing.load(std::memory_order_relaxed)));
      res.set("indexed_drives", drivesArr);

      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "get_stats") {
      size_t total_indexed = 0;
      JsonValue drivesArr = JsonValue::Array();
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        total_indexed = index.Size();
        for (const auto& vol : tracked_volumes) {
          drivesArr.push_back(JsonValue(vol.root_utf8));
        }
      }
      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("index_type", JsonValue("fzf_v2_bloom_parallel"));
      res.set("indexing", JsonValue(is_indexing.load(std::memory_order_relaxed)));
      res.set("indexed_drives", drivesArr);
      return JsonRpcResponse::Success(req.id, res);
    }

    return JsonRpcResponse::Error(req.id, -32601, "Method not found: " + req.method);
  };

  auto handle_incoming_line = [&](const std::string& line, std::function<void(const std::string&)> write_fn, bool& should_shutdown) {
    JsonRpcRequest req;
    std::string err;
    if (!ParseJsonRpcRequest(line, req, err)) {
      JsonRpcResponse err_resp = JsonRpcResponse::Error(JsonValue(), -32700, "Parse error: " + err);
      write_fn(err_resp.serialize() + "\n");
      return;
    }

    // 已被鉴权放行的重耗时索引请求，投递到后台工作线程异步执行，不阻塞主循环心跳与查询
    if ((req.method == "index_path" || req.method == "generate_mock_dataset" || req.method == "sync_drives") &&
        SidecarSecurityGuard::Instance().CheckAccess(req.method)) {
      std::lock_guard<std::mutex> lk(bg_mutex);
      bg_queue.push([req, write_fn, &execute_heavy_rpc]() {
        JsonRpcResponse resp = execute_heavy_rpc(req);
        if (!req.is_notification) {
          write_fn(resp.serialize() + "\n");
        }
      });
      bg_cv.notify_one();
      return;
    }

    JsonRpcResponse resp;
    DispatchRpcRequest(req, rpc_handler, resp, should_shutdown);
    if (!req.is_notification) {
      write_fn(resp.serialize() + "\n");
    }
  };

  // 仅保留标准 Stdin/Stdout 传输模式（由父进程通过匿名管道独占通信）
  auto stdout_write = [&](const std::string& out) {
    std::lock_guard<std::mutex> lk(write_mutex);
    std::cout << out;
    std::cout.flush();
  };
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty() || line == "\r") continue;
    if (!line.empty() && line.back() == '\r') line.pop_back();

    bool should_shutdown = false;
    handle_incoming_line(line, stdout_write, should_shutdown);
    if (should_shutdown) {
      break;
    }
  }
  stop_bg_worker();
  return 0;
}
