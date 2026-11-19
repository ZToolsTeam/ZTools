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

#include "file_scanner.hpp"
#include "flat_trie.hpp"
#include "../shared/json_rpc.hpp"

using namespace ztools::sidecar;
using namespace ztools::indexer;

int main(int argc, char* argv[]) {
#ifdef _WIN32
  // Ensure binary mode for standard streams on Windows
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  std::string pipe_name;
  size_t auto_mock_count = 0;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg.rfind("--pipe=", 0) == 0) {
      pipe_name = arg.substr(7);
    } else if (arg.rfind("--mock-count=", 0) == 0) {
      auto_mock_count = std::stoull(arg.substr(13));
    }
  }

  FlatTrieIndex index;
  std::mutex index_mutex;
  std::mutex write_mutex;
  std::atomic<bool> cancel_scan(false);

  if (auto_mock_count > 0) {
    std::vector<FileEntry> entries;
    MockDatasetGenerator::Generate(auto_mock_count, entries);
    index.Build(std::move(entries));
  }

  // 后台异步索引工作线程，避免磁盘扫描与建索引阻塞主线程的心跳 ping 与 search_files
  std::queue<std::function<void()>> bg_queue;
  std::mutex bg_mutex;
  std::condition_variable bg_cv;
  bool bg_stop = false;

  std::thread bg_worker([&]() {
    while (true) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lk(bg_mutex);
        bg_cv.wait(lk, [&]() { return bg_stop || !bg_queue.empty(); });
        if (bg_stop && bg_queue.empty()) {
          return;
        }
        task = std::move(bg_queue.front());
        bg_queue.pop();
      }
      task();
    }
  });

  auto stop_bg_worker = [&]() {
    cancel_scan.store(true, std::memory_order_relaxed);
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
      }
      auto t1 = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("elapsed_ms", JsonValue(ms));
      return JsonRpcResponse::Success(req.id, res);
    }

    // req.method == "index_path"
    std::string path_str = req.params.get_string("path", ".");
    std::string scanner_pref = req.params.get_string("scanner", "auto");
    const bool force_staged = req.params.get_bool("staged", false);

    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<FileEntry> entries;
    std::string scanner_used = "concurrent_directory";

    auto run_staged_concurrent_scan = [&](
      const std::vector<ConcurrentDirectoryScanner::RootTarget>& root_targets,
      size_t per_group_max_entries,
      std::vector<FileEntry>& out_entries,
      bool publish_quick_stage
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

    if (path_str == "*" || path_str == "all") {
      std::vector<std::wstring> drives = ConcurrentDirectoryScanner::EnumerateFixedDrives();
      scanner_used = "all_drives_concurrent";

      bool is_empty = false;
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        is_empty = (index.Size() == 0);
      }

      static constexpr size_t kPerDriveMaxEntries = 150000;
      std::vector<ConcurrentDirectoryScanner::RootTarget> root_targets;
      root_targets.reserve(drives.size());
      for (size_t i = 0; i < drives.size(); ++i) {
        root_targets.push_back({drives[i], i, -1});
      }
      run_staged_concurrent_scan(root_targets, kPerDriveMaxEntries, entries, is_empty || force_staged);
    } else {
      std::wstring wpath = Utf8ToWide(path_str);
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
          run_staged_concurrent_scan(targets, ConcurrentDirectoryScanner::kDefaultMaxEntries, entries, true);
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
    {
      std::lock_guard<std::mutex> lk(index_mutex);
      index.SwapData(staging);
    }
    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

    JsonValue res = JsonValue::Object();
    res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
    res.set("scanner_used", JsonValue(scanner_used));
    res.set("elapsed_ms", JsonValue(ms));
    return JsonRpcResponse::Success(req.id, res);
  };

  auto rpc_handler = [&](const JsonRpcRequest& req) -> JsonRpcResponse {
    if (req.method == "ping") {
      return JsonRpcResponse::Success(req.id, JsonValue("pong"));
    }

    if (req.method == "search_files") {
      std::string query = req.params.get_string("query", "");
      size_t limit = static_cast<size_t>(req.params.get_int("limit", 50));
      if (limit == 0) limit = 50;

      SearchResponse sresp;
      size_t total_indexed = 0;
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        sresp = index.Search(query, limit);
        total_indexed = index.Size();
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
      res.set("elapsed_us", JsonValue(static_cast<int64_t>(sresp.elapsed_us)));
      res.set("elapsed_ms", JsonValue(sresp.elapsed_ms));
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));

      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "get_stats") {
      size_t total_indexed = 0;
      {
        std::lock_guard<std::mutex> lk(index_mutex);
        total_indexed = index.Size();
      }
      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(total_indexed)));
      res.set("index_type", JsonValue("flat_trie_pinyin_acronym"));
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
    if ((req.method == "index_path" || req.method == "generate_mock_dataset") &&
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

#ifdef _WIN32
  if (!pipe_name.empty()) {
    // Named Pipe mode
    HANDLE hPipe = CreateNamedPipeA(
      pipe_name.c_str(),
      PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      128 * 1024,
      128 * 1024,
      0,
      NULL
    );
    if (hPipe != INVALID_HANDLE_VALUE) {
      ConnectNamedPipe(hPipe, NULL);
      auto pipe_write = [&](const std::string& out) {
        std::lock_guard<std::mutex> lk(write_mutex);
        DWORD written = 0;
        WriteFile(hPipe, out.data(), static_cast<DWORD>(out.size()), &written, NULL);
      };
      std::string buffer;
      char readBuf[2048];
      DWORD bytesRead = 0;
      bool running = true;
      while (running && ReadFile(hPipe, readBuf, sizeof(readBuf), &bytesRead, NULL) && bytesRead > 0) {
        buffer.append(readBuf, bytesRead);
        size_t newlinePos = std::string::npos;
        while ((newlinePos = buffer.find('\n')) != std::string::npos) {
          std::string line = buffer.substr(0, newlinePos);
          buffer.erase(0, newlinePos + 1);
          if (line.empty() || line == "\r") continue;
          if (!line.empty() && line.back() == '\r') line.pop_back();

          bool should_shutdown = false;
          handle_incoming_line(line, pipe_write, should_shutdown);
          if (should_shutdown) {
            running = false;
            break;
          }
        }
      }
      stop_bg_worker();
      DisconnectNamedPipe(hPipe);
      CloseHandle(hPipe);
      return 0;
    }
  }
#endif

  // Stdin/Stdout mode
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
