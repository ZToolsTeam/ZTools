#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
#include <fcntl.h>
#include <io.h>

#include "uiaccess_worker.hpp"
#include "../shared/json_rpc.hpp"

using namespace ztools::sidecar;
using namespace ztools::uiaccess;

int main(int argc, char* argv[]) {
  // Ensure binary mode on Windows stdin/stdout
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);

  std::string pipe_name;
  bool initial_mock = false;

  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg.rfind("--pipe=", 0) == 0) {
      pipe_name = arg.substr(7);
    } else if (arg == "--mock") {
      initial_mock = true;
    }
  }

  UIAccessWorker worker;
  if (initial_mock) {
    JsonValue mockData = JsonValue::Object();
    JsonValue win = JsonValue::Object();
    win.set("active", JsonValue(true));
    win.set("hwnd", JsonValue(99999));
    win.set("title", JsonValue("Test Window - Edge Browser"));
    win.set("pid", JsonValue(4321));
    win.set("process_name", JsonValue("msedge.exe"));
    win.set("process_path", JsonValue("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"));
    mockData.set("active_window", win);
    mockData.set("selected_text", JsonValue("ZTools UIAccess Test Selected Text"));
    mockData.set("selected_text_source", JsonValue("uia_text_pattern"));
    mockData.set("browser_url", JsonValue("https://ztools.local/test"));
    mockData.set("browser_name", JsonValue("msedge"));
    worker.SetMockState(mockData);
  }

  auto rpc_handler = [&](const JsonRpcRequest& req) -> JsonRpcResponse {
    if (req.method == "ping") {
      return JsonRpcResponse::Success(req.id, JsonValue("pong"));
    }

    if (req.method == "get_active_window") {
      ActiveWindowInfo info = worker.GetActiveWindow();
      JsonValue result = JsonValue::Object();
      result.set("active", JsonValue(info.active));
      result.set("hwnd", JsonValue(static_cast<int64_t>(info.hwnd)));
      result.set("title", JsonValue(info.title));
      result.set("pid", JsonValue(info.pid));
      result.set("process_name", JsonValue(info.process_name));
      result.set("process_path", JsonValue(info.process_path));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "get_selected_text") {
      SelectedTextInfo info = worker.GetSelectedText();
      JsonValue result = JsonValue::Object();
      result.set("text", JsonValue(info.text));
      result.set("source", JsonValue(info.source));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "get_browser_url") {
      BrowserUrlInfo info = worker.GetBrowserUrl();
      JsonValue result = JsonValue::Object();
      result.set("found", JsonValue(info.found));
      result.set("url", JsonValue(info.url));
      result.set("browser", JsonValue(info.browser));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "manage_window") {
      std::string action = req.params.get_string("action");
      if (action.empty()) {
        return JsonRpcResponse::Error(req.id, -32602, "Missing action param");
      }
      WindowManagementResult res = worker.ManageWindow(action);
      if (!res.success && res.error.rfind("Invalid window management action", 0) == 0) {
        return JsonRpcResponse::Error(req.id, -32602, res.error);
      }
      JsonValue result = JsonValue::Object();
      result.set("success", JsonValue(res.success));
      result.set("action", JsonValue(res.action));
      if (!res.error.empty()) {
        result.set("error", JsonValue(res.error));
      }
      JsonValue rectObj = JsonValue::Object();
      rectObj.set("x", JsonValue(res.rect.x));
      rectObj.set("y", JsonValue(res.rect.y));
      rectObj.set("width", JsonValue(res.rect.width));
      rectObj.set("height", JsonValue(res.rect.height));
      result.set("rect", rectObj);

      JsonValue monObj = JsonValue::Object();
      monObj.set("x", JsonValue(res.monitor.x));
      monObj.set("y", JsonValue(res.monitor.y));
      monObj.set("width", JsonValue(res.monitor.width));
      monObj.set("height", JsonValue(res.monitor.height));
      result.set("monitor", monObj);
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "paste_to_active") {
      uint64_t hwnd = static_cast<uint64_t>(req.params.get_int("target_hwnd", 0));
      bool ok = worker.PasteToActive(hwnd);
      JsonValue result = JsonValue::Object();
      result.set("success", JsonValue(ok));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "set_snippets") {
      std::vector<SnippetItem> items;
      const JsonValue* listPtr = nullptr;
      if (req.params.is_array()) {
        listPtr = &req.params;
      } else if (req.params.is_object()) {
        listPtr = req.params.find("snippets");
      }
      if (listPtr && listPtr->is_array()) {
        for (const auto& el : listPtr->arr_val) {
          if (el.is_object()) {
            SnippetItem item;
            item.id = el.get_string("id");
            item.name = el.get_string("name");
            item.keyword = el.get_string("keyword");
            item.snippet = el.get_string("snippet");
            item.enabled = el.get_bool("enabled", true);
            items.push_back(item);
          }
        }
      }
      worker.SetSnippets(items);
      JsonValue result = JsonValue::Object();
      result.set("success", JsonValue(true));
      result.set("count", JsonValue(static_cast<int64_t>(items.size())));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "get_snippets") {
      std::vector<SnippetItem> items = worker.GetSnippets();
      JsonValue arr = JsonValue::Array();
      for (const auto& item : items) {
        JsonValue obj = JsonValue::Object();
        obj.set("id", JsonValue(item.id));
        obj.set("name", JsonValue(item.name));
        obj.set("keyword", JsonValue(item.keyword));
        obj.set("snippet", JsonValue(item.snippet));
        obj.set("enabled", JsonValue(item.enabled));
        arr.push_back(obj);
      }
      JsonValue result = JsonValue::Object();
      result.set("snippets", arr);
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "expand_snippet") {
      std::string keyword = req.params.get_string("keyword");
      std::string clipboard = req.params.get_string("clipboard");
      if (keyword.empty()) {
        return JsonRpcResponse::Error(req.id, -32602, "Missing keyword param");
      }
      SnippetExpandResult res = worker.ExpandSnippet(keyword, clipboard);
      JsonValue result = JsonValue::Object();
      result.set("found", JsonValue(res.found));
      result.set("keyword", JsonValue(res.keyword));
      result.set("expanded", JsonValue(res.expanded));
      result.set("cursor_offset", JsonValue(res.cursor_offset));
      if (res.found) {
        JsonValue snip = JsonValue::Object();
        snip.set("id", JsonValue(res.snippet.id));
        snip.set("name", JsonValue(res.snippet.name));
        snip.set("keyword", JsonValue(res.snippet.keyword));
        snip.set("snippet", JsonValue(res.snippet.snippet));
        snip.set("enabled", JsonValue(res.snippet.enabled));
        result.set("snippet", snip);
      }
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "simulate_keystrokes") {
      std::string input = req.params.get_string("input");
      std::string clipboard = req.params.get_string("clipboard");
      KeystrokeSimulationResult res = worker.SimulateKeystrokes(input, clipboard);
      JsonValue result = JsonValue::Object();
      result.set("matched", JsonValue(res.matched));
      result.set("keyword", JsonValue(res.keyword));
      result.set("expanded", JsonValue(res.expanded));
      result.set("backspace_count", JsonValue(res.backspace_count));
      result.set("cursor_offset", JsonValue(res.cursor_offset));
      return JsonRpcResponse::Success(req.id, result);
    }

    if (req.method == "set_mock_state") {
      worker.SetMockState(req.params);
      return JsonRpcResponse::Success(req.id, JsonValue(true));
    }

    if (req.method == "clear_mock_state") {
      worker.ClearMockState();
      return JsonRpcResponse::Success(req.id, JsonValue(true));
    }

    if (req.method == "trim_process_memory") {
      int64_t target_pid = req.params.get_int("pid", 0);
      bool trimmed = false;
      if (target_pid <= 0 || target_pid == static_cast<int64_t>(GetCurrentProcessId())) {
        trimmed = (SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1) != 0);
      } else {
        HANDLE hProc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, FALSE, static_cast<DWORD>(target_pid));
        if (hProc != NULL) {
          trimmed = (SetProcessWorkingSetSize(hProc, (SIZE_T)-1, (SIZE_T)-1) != 0);
          CloseHandle(hProc);
        }
      }
      JsonValue result = JsonValue::Object();
      result.set("success", JsonValue(true));
      result.set("pid", JsonValue(target_pid));
      result.set("trimmed", JsonValue(trimmed));
      return JsonRpcResponse::Success(req.id, result);
    }

    return JsonRpcResponse::Error(req.id, -32601, "Method not found: " + req.method);
  };

  if (!pipe_name.empty()) {
    // Named pipe mode
    HANDLE hPipe = CreateNamedPipeA(
      pipe_name.c_str(),
      PIPE_ACCESS_DUPLEX,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      64 * 1024,
      64 * 1024,
      0,
      NULL
    );
    if (hPipe != INVALID_HANDLE_VALUE) {
      ConnectNamedPipe(hPipe, NULL);
      // Run loop reading lines from pipe
      std::string buffer;
      char readBuf[1024];
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

  // Standard Stdin/Stdout mode
  RunLineRpcLoop(std::cin, std::cout, rpc_handler);
  return 0;
}
