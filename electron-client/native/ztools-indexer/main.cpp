#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <memory>
#include <chrono>
#include <fcntl.h>
#include <io.h>

#include "file_scanner.hpp"
#include "flat_trie.hpp"
#include "../shared/json_rpc.hpp"

using namespace ztools::sidecar;
using namespace ztools::indexer;

int main(int argc, char* argv[]) {
  // Ensure binary mode for standard streams on Windows
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

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
  if (auto_mock_count > 0) {
    std::vector<FileEntry> entries;
    MockDatasetGenerator::Generate(auto_mock_count, entries);
    index.Build(std::move(entries));
  }

  auto rpc_handler = [&](const JsonRpcRequest& req) -> JsonRpcResponse {
    if (req.method == "ping") {
      return JsonRpcResponse::Success(req.id, JsonValue("pong"));
    }

    if (req.method == "generate_mock_dataset") {
      size_t count = static_cast<size_t>(req.params.get_int("count", 1000000));
      auto t0 = std::chrono::high_resolution_clock::now();
      std::vector<FileEntry> entries;
      MockDatasetGenerator::Generate(count, entries);
      index.Build(std::move(entries));
      auto t1 = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(index.Size())));
      res.set("elapsed_ms", JsonValue(ms));
      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "index_path") {
      std::string path_str = req.params.get_string("path", ".");
      std::string scanner_pref = req.params.get_string("scanner", "auto");

      std::wstring wpath = Utf8ToWide(path_str);
      auto t0 = std::chrono::high_resolution_clock::now();
      std::vector<FileEntry> entries;
      std::string scanner_used = "concurrent_directory";

      bool is_drive_root = (wpath.size() <= 3) || (wpath.size() == 2 && wpath[1] == L':');
      if (scanner_pref == "usn" || (scanner_pref == "auto" && is_drive_root)) {
        UsnJournalScanner usn;
        if (usn.Scan(wpath, entries)) {
          scanner_used = "usn_journal";
        }
      }

      if (entries.empty()) {
        ConcurrentDirectoryScanner dirScanner;
        dirScanner.Scan(wpath, entries);
        scanner_used = "concurrent_directory";
      }

      index.Build(std::move(entries));
      auto t1 = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(index.Size())));
      res.set("scanner_used", JsonValue(scanner_used));
      res.set("elapsed_ms", JsonValue(ms));
      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "search_files") {
      std::string query = req.params.get_string("query", "");
      size_t limit = static_cast<size_t>(req.params.get_int("limit", 50));
      if (limit == 0) limit = 50;

      SearchResponse sresp = index.Search(query, limit);

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
      res.set("total_indexed", JsonValue(static_cast<int64_t>(index.Size())));

      return JsonRpcResponse::Success(req.id, res);
    }

    if (req.method == "get_stats") {
      JsonValue res = JsonValue::Object();
      res.set("total_indexed", JsonValue(static_cast<int64_t>(index.Size())));
      res.set("index_type", JsonValue("flat_trie_pinyin_acronym"));
      return JsonRpcResponse::Success(req.id, res);
    }

    return JsonRpcResponse::Error(req.id, -32601, "Method not found: " + req.method);
  };

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

          JsonRpcRequest req;
          std::string err;
          if (!ParseJsonRpcRequest(line, req, err)) {
            JsonRpcResponse err_resp = JsonRpcResponse::Error(JsonValue(), -32700, "Parse error: " + err);
            std::string out = err_resp.serialize() + "\n";
            DWORD written = 0;
            WriteFile(hPipe, out.data(), static_cast<DWORD>(out.size()), &written, NULL);
            continue;
          }

          JsonRpcResponse resp;
          bool should_shutdown = false;
          DispatchRpcRequest(req, rpc_handler, resp, should_shutdown);
          if (!req.is_notification) {
            std::string out = resp.serialize() + "\n";
            DWORD written = 0;
            WriteFile(hPipe, out.data(), static_cast<DWORD>(out.size()), &written, NULL);
          }
          if (should_shutdown) {
            running = false;
            break;
          }
        }
      }
      DisconnectNamedPipe(hPipe);
      CloseHandle(hPipe);
      return 0;
    }
  }

  // Stdin/Stdout mode
  RunLineRpcLoop(std::cin, std::cout, rpc_handler);
  return 0;
}
