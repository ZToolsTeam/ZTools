#pragma once

#include <windows.h>
#include <uiautomation.h>
#include <psapi.h>
#include <oleacc.h>

#include <string>
#include <vector>
#include <memory>
#include <optional>
#include <iostream>
#include <fstream>
#include <mutex>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <cctype>

#include "../shared/json_rpc.hpp"

namespace ztools::uiaccess {

inline std::string WideToUtf8(const std::wstring& wstr) {
  if (wstr.empty()) return "";
  int size_needed = WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), NULL, 0, NULL, NULL);
  if (size_needed <= 0) return "";
  std::string result(size_needed, 0);
  WideCharToMultiByte(CP_UTF8, 0, wstr.data(), (int)wstr.size(), &result[0], size_needed, NULL, NULL);
  return result;
}

inline std::wstring Utf8ToWide(const std::string& str) {
  if (str.empty()) return L"";
  int size_needed = MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), NULL, 0);
  if (size_needed <= 0) return L"";
  std::wstring result(size_needed, 0);
  MultiByteToWideChar(CP_UTF8, 0, str.data(), (int)str.size(), &result[0], size_needed);
  return result;
}

struct ActiveWindowInfo {
  bool active = false;
  uint64_t hwnd = 0;
  std::string title;
  uint32_t pid = 0;
  std::string process_name;
  std::string process_path;
};

struct SelectedTextInfo {
  std::string text;
  std::string source; // "uia_text_pattern", "uia_value_pattern", "legacy_iaccessible", "none"
};

struct BrowserUrlInfo {
  std::string url;
  std::string browser; // "chrome", "msedge", "brave", "generic_chromium", "none"
  bool found = false;
};

struct WindowRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

struct WindowManagementResult {
  bool success = false;
  std::string action;
  WindowRect rect;
  WindowRect monitor;
  std::string error;
};

struct SnippetItem {
  std::string id;
  std::string name;
  std::string keyword;
  std::string snippet;
  bool enabled = true;
};

struct SnippetExpandResult {
  bool found = false;
  std::string keyword;
  std::string expanded;
  int cursor_offset = 0; // number of left arrow presses to reach {cursor}
  SnippetItem snippet;
};

struct KeystrokeSimulationResult {
  bool matched = false;
  std::string keyword;
  std::string expanded;
  int backspace_count = 0;
  int cursor_offset = 0;
  SnippetItem snippet;
};

class UIAccessWorker {
public:
  UIAccessWorker() {
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER, IID_IUIAutomation, (void**)&pAutomation_);
    if (FAILED(hr)) {
      pAutomation_ = nullptr;
    }
  }

  ~UIAccessWorker() {
    if (pAutomation_) {
      pAutomation_->Release();
      pAutomation_ = nullptr;
    }
    CoUninitialize();
  }

  void SetMockState(const sidecar::JsonValue& mock) {
    std::lock_guard<std::mutex> lock(mock_mutex_);
    mock_active_ = true;
    mock_data_ = mock;
  }

  void ClearMockState() {
    std::lock_guard<std::mutex> lock(mock_mutex_);
    mock_active_ = false;
    mock_data_ = sidecar::JsonValue();
  }

  ActiveWindowInfo GetActiveWindow() {
    {
      std::lock_guard<std::mutex> lock(mock_mutex_);
      if (mock_active_) {
        ActiveWindowInfo info;
        const auto* win = mock_data_.find("active_window");
        if (win && win->is_object()) {
          info.active = win->get_bool("active", true);
          info.hwnd = (uint64_t)win->get_int("hwnd", 12345);
          info.title = win->get_string("title", "Mock Active Window");
          info.pid = (uint32_t)win->get_int("pid", 1000);
          info.process_name = win->get_string("process_name", "mock_app.exe");
          info.process_path = win->get_string("process_path", "C:\\Mock\\mock_app.exe");
          return info;
        }
      }
    }

    ActiveWindowInfo info;
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
      info.active = false;
      return info;
    }

    info.active = true;
    info.hwnd = reinterpret_cast<uint64_t>(hwnd);

    wchar_t titleBuf[512] = {0};
    GetWindowTextW(hwnd, titleBuf, 512);
    info.title = WideToUtf8(titleBuf);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    info.pid = pid;

    if (pid != 0) {
      HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (hProcess) {
        wchar_t pathBuf[MAX_PATH] = {0};
        DWORD pathLen = MAX_PATH;
        if (QueryFullProcessImageNameW(hProcess, 0, pathBuf, &pathLen)) {
          info.process_path = WideToUtf8(pathBuf);
          std::wstring wpath(pathBuf);
          size_t lastSlash = wpath.find_last_of(L"\\/");
          if (lastSlash != std::wstring::npos) {
            info.process_name = WideToUtf8(wpath.substr(lastSlash + 1));
          } else {
            info.process_name = info.process_path;
          }
        }
        CloseHandle(hProcess);
      }
    }

    return info;
  }

  SelectedTextInfo GetSelectedText() {
    {
      std::lock_guard<std::mutex> lock(mock_mutex_);
      if (mock_active_) {
        SelectedTextInfo info;
        info.text = mock_data_.get_string("selected_text", "");
        info.source = mock_data_.get_string("selected_text_source", "mock");
        return info;
      }
    }

    SelectedTextInfo info;
    info.source = "none";

    if (!pAutomation_) return info;

    IUIAutomationElement* pFocused = nullptr;
    HRESULT hr = pAutomation_->GetFocusedElement(&pFocused);
    if (FAILED(hr) || !pFocused) return info;

    // 1. Try TextPattern
    IUIAutomationTextPattern* pTextPattern = nullptr;
    hr = pFocused->GetCurrentPattern(UIA_TextPatternId, (IUnknown**)&pTextPattern);
    if (SUCCEEDED(hr) && pTextPattern) {
      IUIAutomationTextRangeArray* pSelections = nullptr;
      hr = pTextPattern->GetSelection(&pSelections);
      if (SUCCEEDED(hr) && pSelections) {
        int length = 0;
        pSelections->get_Length(&length);
        if (length > 0) {
          IUIAutomationTextRange* pRange = nullptr;
          hr = pSelections->GetElement(0, &pRange);
          if (SUCCEEDED(hr) && pRange) {
            BSTR bstr = nullptr;
            pRange->GetText(-1, &bstr);
            if (bstr) {
              info.text = WideToUtf8(bstr);
              info.source = "uia_text_pattern";
              SysFreeString(bstr);
              pRange->Release();
              pSelections->Release();
              pTextPattern->Release();
              pFocused->Release();
              return info;
            }
            pRange->Release();
          }
        }
        pSelections->Release();
      }
      pTextPattern->Release();
    }

    // 2. Try ValuePattern
    IUIAutomationValuePattern* pValuePattern = nullptr;
    hr = pFocused->GetCurrentPattern(UIA_ValuePatternId, (IUnknown**)&pValuePattern);
    if (SUCCEEDED(hr) && pValuePattern) {
      BSTR bstr = nullptr;
      hr = pValuePattern->get_CurrentValue(&bstr);
      if (SUCCEEDED(hr) && bstr) {
        info.text = WideToUtf8(bstr);
        info.source = "uia_value_pattern";
        SysFreeString(bstr);
        pValuePattern->Release();
        pFocused->Release();
        return info;
      }
      pValuePattern->Release();
    }

    // 3. Try LegacyIAccessiblePattern
    IUIAutomationLegacyIAccessiblePattern* pLegacy = nullptr;
    hr = pFocused->GetCurrentPattern(UIA_LegacyIAccessiblePatternId, (IUnknown**)&pLegacy);
    if (SUCCEEDED(hr) && pLegacy) {
      BSTR bstr = nullptr;
      hr = pLegacy->get_CurrentValue(&bstr);
      if (SUCCEEDED(hr) && bstr) {
        info.text = WideToUtf8(bstr);
        info.source = "legacy_iaccessible";
        SysFreeString(bstr);
        pLegacy->Release();
        pFocused->Release();
        return info;
      }
      pLegacy->Release();
    }

    pFocused->Release();
    return info;
  }

  BrowserUrlInfo GetBrowserUrl() {
    {
      std::lock_guard<std::mutex> lock(mock_mutex_);
      if (mock_active_) {
        BrowserUrlInfo info;
        info.url = mock_data_.get_string("browser_url", "");
        info.browser = mock_data_.get_string("browser_name", "msedge");
        info.found = !info.url.empty();
        return info;
      }
    }

    BrowserUrlInfo info;
    info.found = false;
    info.browser = "none";

    if (!pAutomation_) return info;

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) return info;

    // Detect browser from process
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    std::string procNameLower;
    if (pid != 0) {
      HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (hProc) {
        wchar_t buf[MAX_PATH] = {0};
        DWORD len = MAX_PATH;
        if (QueryFullProcessImageNameW(hProc, 0, buf, &len)) {
          std::wstring wpath(buf);
          size_t slash = wpath.find_last_of(L"\\/");
          std::wstring filename = (slash != std::wstring::npos) ? wpath.substr(slash + 1) : wpath;
          procNameLower = WideToUtf8(filename);
          std::transform(procNameLower.begin(), procNameLower.end(), procNameLower.begin(), ::tolower);
        }
        CloseHandle(hProc);
      }
    }

    if (procNameLower.find("chrome") != std::string::npos) {
      info.browser = "chrome";
    } else if (procNameLower.find("msedge") != std::string::npos) {
      info.browser = "msedge";
    } else if (procNameLower.find("brave") != std::string::npos) {
      info.browser = "brave";
    } else if (procNameLower.find("vivaldi") != std::string::npos) {
      info.browser = "vivaldi";
    } else {
      info.browser = "generic_chromium";
    }

    IUIAutomationElement* pWindowElement = nullptr;
    HRESULT hr = pAutomation_->ElementFromHandle(hwnd, &pWindowElement);
    if (FAILED(hr) || !pWindowElement) return info;

    // Search for Edit controls in the window
    VARIANT varCtrl;
    varCtrl.vt = VT_I4;
    varCtrl.lVal = UIA_EditControlTypeId;
    IUIAutomationCondition* pCond = nullptr;
    hr = pAutomation_->CreatePropertyCondition(UIA_ControlTypePropertyId, varCtrl, &pCond);
    if (SUCCEEDED(hr) && pCond) {
      IUIAutomationElementArray* pElements = nullptr;
      hr = pWindowElement->FindAll(TreeScope_Descendants, pCond, &pElements);
      if (SUCCEEDED(hr) && pElements) {
        int count = 0;
        pElements->get_Length(&count);
        for (int i = 0; i < count; ++i) {
          IUIAutomationElement* pElem = nullptr;
          if (SUCCEEDED(pElements->GetElement(i, &pElem)) && pElem) {
            // Check ValuePattern
            IUIAutomationValuePattern* pValPattern = nullptr;
            if (SUCCEEDED(pElem->GetCurrentPattern(UIA_ValuePatternId, (IUnknown**)&pValPattern)) && pValPattern) {
              BSTR bstrVal = nullptr;
              if (SUCCEEDED(pValPattern->get_CurrentValue(&bstrVal)) && bstrVal) {
                std::string val = WideToUtf8(bstrVal);
                SysFreeString(bstrVal);
                if (IsUrlCandidate(val)) {
                  info.url = NormalizeUrl(val);
                  info.found = true;
                  pValPattern->Release();
                  pElem->Release();
                  break;
                }
              }
              pValPattern->Release();
            }

            // Check LegacyIAccessiblePattern
            if (!info.found) {
              IUIAutomationLegacyIAccessiblePattern* pLegacy = nullptr;
              if (SUCCEEDED(pElem->GetCurrentPattern(UIA_LegacyIAccessiblePatternId, (IUnknown**)&pLegacy)) && pLegacy) {
                BSTR bstrVal = nullptr;
                if (SUCCEEDED(pLegacy->get_CurrentValue(&bstrVal)) && bstrVal) {
                  std::string val = WideToUtf8(bstrVal);
                  SysFreeString(bstrVal);
                  if (IsUrlCandidate(val)) {
                    info.url = NormalizeUrl(val);
                    info.found = true;
                    pLegacy->Release();
                    pElem->Release();
                    break;
                  }
                }
                pLegacy->Release();
              }
            }

            pElem->Release();
          }
        }
        pElements->Release();
      }
      pCond->Release();
    }

    pWindowElement->Release();
    return info;
  }

  // --- Window Management ---
  WindowManagementResult ManageWindow(const std::string& action) {
    static const std::vector<std::string> validActions = {
      "left-half", "right-half", "top-half", "bottom-half",
      "maximize", "restore", "center",
      "first-third", "center-third", "last-third",
      "first-two-thirds", "last-two-thirds",
      "make-larger", "make-smaller",
      "next-display", "previous-display"
    };

    bool isValid = false;
    for (const auto& a : validActions) {
      if (a == action) { isValid = true; break; }
    }

    WindowManagementResult res;
    res.action = action;
    if (!isValid) {
      res.success = false;
      res.error = "Invalid window management action: " + action;
      return res;
    }

    // Check mock mode
    {
      std::lock_guard<std::mutex> lock(mock_mutex_);
      if (mock_active_) {
        // Calculate mock geometry
        WindowRect monRect{0, 0, 1920, 1040}; // 1080 - 40 taskbar
        WindowRect curWin{100, 100, 800, 600};
        const auto* mockMon = mock_data_.find("mock_monitor");
        if (mockMon && mockMon->is_object()) {
          monRect.x = static_cast<int>(mockMon->get_int("x", 0));
          monRect.y = static_cast<int>(mockMon->get_int("y", 0));
          monRect.width = static_cast<int>(mockMon->get_int("width", 1920));
          monRect.height = static_cast<int>(mockMon->get_int("height", 1040));
        }
        const auto* mockWin = mock_data_.find("mock_window");
        if (mockWin && mockWin->is_object()) {
          curWin.x = static_cast<int>(mockWin->get_int("x", 100));
          curWin.y = static_cast<int>(mockWin->get_int("y", 100));
          curWin.width = static_cast<int>(mockWin->get_int("width", 800));
          curWin.height = static_cast<int>(mockWin->get_int("height", 600));
        }

        res.monitor = monRect;
        res.rect = CalculateTargetRect(action, curWin, monRect);
        res.success = true;
        return res;
      }
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
      res.success = false;
      res.error = "No foreground window found";
      return res;
    }

    HMONITOR hMon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    MONITORINFO mi = { sizeof(mi) };
    if (!GetMonitorInfoW(hMon, &mi)) {
      res.success = false;
      res.error = "Failed to query monitor info";
      return res;
    }

    RECT rcWork = mi.rcWork;
    WindowRect monRect{
      rcWork.left,
      rcWork.top,
      rcWork.right - rcWork.left,
      rcWork.bottom - rcWork.top
    };
    res.monitor = monRect;

    RECT rcWin = {0};
    GetWindowRect(hwnd, &rcWin);
    WindowRect curWin{
      rcWin.left,
      rcWin.top,
      rcWin.right - rcWin.left,
      rcWin.bottom - rcWin.top
    };

    if (action == "next-display" || action == "previous-display") {
      std::vector<MONITORINFO> monitors = GetAllMonitors();
      if (monitors.size() > 1) {
        int currentIdx = 0;
        for (size_t i = 0; i < monitors.size(); ++i) {
          if (monitors[i].rcMonitor.left == mi.rcMonitor.left &&
              monitors[i].rcMonitor.top == mi.rcMonitor.top) {
            currentIdx = static_cast<int>(i);
            break;
          }
        }
        int nextIdx = (action == "next-display")
          ? (currentIdx + 1) % static_cast<int>(monitors.size())
          : (currentIdx - 1 + static_cast<int>(monitors.size())) % static_cast<int>(monitors.size());

        RECT targetWork = monitors[nextIdx].rcWork;
        WindowRect targetMonRect{
          targetWork.left, targetWork.top,
          targetWork.right - targetWork.left, targetWork.bottom - targetWork.top
        };
        res.monitor = targetMonRect;

        // Position window relatively on the target monitor
        double relX = (double)(curWin.x - monRect.x) / (monRect.width > 0 ? monRect.width : 1);
        double relY = (double)(curWin.y - monRect.y) / (monRect.height > 0 ? monRect.height : 1);
        res.rect.width = (std::min)(curWin.width, targetMonRect.width);
        res.rect.height = (std::min)(curWin.height, targetMonRect.height);
        res.rect.x = targetMonRect.x + static_cast<int>(relX * targetMonRect.width);
        res.rect.y = targetMonRect.y + static_cast<int>(relY * targetMonRect.height);
      } else {
        res.rect = curWin;
      }
    } else {
      res.rect = CalculateTargetRect(action, curWin, monRect);
    }

    if (IsZoomed(hwnd) && action != "maximize") {
      ShowWindow(hwnd, SW_RESTORE);
    }

    if (action == "maximize") {
      ShowWindow(hwnd, SW_MAXIMIZE);
    } else {
      SetWindowPos(
        hwnd,
        NULL,
        res.rect.x,
        res.rect.y,
        res.rect.width,
        res.rect.height,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
      );
    }

    res.success = true;
    return res;
  }

  // --- Paste to Active Window ---
  bool PasteToActive(uint64_t targetHwnd = 0) {
    {
      std::lock_guard<std::mutex> lock(mock_mutex_);
      if (mock_active_) {
        return true;
      }
    }

    if (targetHwnd != 0) {
      HWND hwnd = reinterpret_cast<HWND>(targetHwnd);
      SetForegroundWindow(hwnd);
      Sleep(35);
    }

    INPUT inputs[4] = {};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 'V';
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 'V';
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

    UINT uSent = SendInput(4, inputs, sizeof(INPUT));
    return uSent == 4;
  }

  // --- Snippets Engine ---
  void SetSnippets(const std::vector<SnippetItem>& items) {
    std::lock_guard<std::mutex> lock(snippets_mutex_);
    snippets_ = items;
  }

  std::vector<SnippetItem> GetSnippets() const {
    std::lock_guard<std::mutex> lock(snippets_mutex_);
    return snippets_;
  }

  SnippetExpandResult ExpandSnippet(const std::string& keyword, const std::string& clipboardContent) {
    std::lock_guard<std::mutex> lock(snippets_mutex_);
    SnippetExpandResult res;
    res.keyword = keyword;

    for (const auto& item : snippets_) {
      if (item.enabled && item.keyword == keyword) {
        res.found = true;
        res.snippet = item;
        int cursorOffset = 0;
        res.expanded = ExpandTemplate(item.snippet, clipboardContent, cursorOffset);
        res.cursor_offset = cursorOffset;
        return res;
      }
    }
    return res;
  }

  KeystrokeSimulationResult SimulateKeystrokes(const std::string& input, const std::string& clipboardContent) {
    std::lock_guard<std::mutex> lock(snippets_mutex_);
    KeystrokeSimulationResult res;

    // Find snippet whose keyword matches the end of input
    const SnippetItem* bestMatch = nullptr;
    size_t longestKeyword = 0;

    for (const auto& item : snippets_) {
      if (!item.enabled || item.keyword.empty()) continue;
      if (input.size() >= item.keyword.size()) {
        size_t pos = input.size() - item.keyword.size();
        if (input.compare(pos, item.keyword.size(), item.keyword) == 0) {
          if (item.keyword.size() > longestKeyword) {
            longestKeyword = item.keyword.size();
            bestMatch = &item;
          }
        }
      }
    }

    if (bestMatch) {
      res.matched = true;
      res.keyword = bestMatch->keyword;
      res.snippet = *bestMatch;
      res.backspace_count = static_cast<int>(bestMatch->keyword.size());
      int cursorOffset = 0;
      res.expanded = ExpandTemplate(bestMatch->snippet, clipboardContent, cursorOffset);
      res.cursor_offset = cursorOffset;
    }
    return res;
  }

  static std::string ExpandTemplate(const std::string& tmpl, const std::string& clipboardContent, int& outCursorOffset) {
    outCursorOffset = 0;
    if (tmpl.empty()) return "";

    auto now = std::chrono::system_clock::now();
    std::time_t in_time_t = std::chrono::system_clock::to_time_t(now);
    std::tm bt{};
    localtime_s(&bt, &in_time_t);

    char dateBuf[32] = {0};
    strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%d", &bt);
    char timeBuf[32] = {0};
    strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", &bt);

    std::string result;
    result.reserve(tmpl.size() + 64);

    int cursorIndex = -1;
    size_t i = 0;
    while (i < tmpl.size()) {
      if (tmpl[i] == '{') {
        size_t closePos = tmpl.find('}', i);
        if (closePos != std::string::npos) {
          std::string token = tmpl.substr(i + 1, closePos - i - 1);
          if (token == "clipboard") {
            result += clipboardContent;
            i = closePos + 1;
            continue;
          } else if (token == "date") {
            result += dateBuf;
            i = closePos + 1;
            continue;
          } else if (token == "time") {
            result += timeBuf;
            i = closePos + 1;
            continue;
          } else if (token == "datetime") {
            result += dateBuf;
            result += " ";
            result += timeBuf;
            i = closePos + 1;
            continue;
          } else if (token == "uuid") {
            GUID guid{};
            CoCreateGuid(&guid);
            char guidBuf[64] = {0};
            snprintf(guidBuf, sizeof(guidBuf),
                     "%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                     guid.Data1, guid.Data2, guid.Data3,
                     guid.Data4[0], guid.Data4[1], guid.Data4[2], guid.Data4[3],
                     guid.Data4[4], guid.Data4[5], guid.Data4[6], guid.Data4[7]);
            result += guidBuf;
            i = closePos + 1;
            continue;
          } else if (token == "cursor") {
            cursorIndex = static_cast<int>(result.size());
            i = closePos + 1;
            continue;
          }
        }
      }
      result.push_back(tmpl[i]);
      ++i;
    }

    if (cursorIndex >= 0) {
      outCursorOffset = static_cast<int>(result.size()) - cursorIndex;
      if (outCursorOffset < 0) outCursorOffset = 0;
    }

    return result;
  }

private:
  static WindowRect CalculateTargetRect(const std::string& action, const WindowRect& cur, const WindowRect& mon) {
    WindowRect r;
    if (action == "left-half") {
      r.x = mon.x;
      r.y = mon.y;
      r.width = mon.width / 2;
      r.height = mon.height;
    } else if (action == "right-half") {
      r.x = mon.x + mon.width / 2;
      r.y = mon.y;
      r.width = mon.width - (mon.width / 2);
      r.height = mon.height;
    } else if (action == "top-half") {
      r.x = mon.x;
      r.y = mon.y;
      r.width = mon.width;
      r.height = mon.height / 2;
    } else if (action == "bottom-half") {
      r.x = mon.x;
      r.y = mon.y + mon.height / 2;
      r.width = mon.width;
      r.height = mon.height - (mon.height / 2);
    } else if (action == "maximize") {
      r.x = mon.x;
      r.y = mon.y;
      r.width = mon.width;
      r.height = mon.height;
    } else if (action == "restore") {
      r.width = static_cast<int>(mon.width * 0.7);
      r.height = static_cast<int>(mon.height * 0.7);
      r.x = mon.x + (mon.width - r.width) / 2;
      r.y = mon.y + (mon.height - r.height) / 2;
    } else if (action == "center") {
      r.width = (std::max)(300, (std::min)(cur.width, static_cast<int>(mon.width * 0.9)));
      r.height = (std::max)(200, (std::min)(cur.height, static_cast<int>(mon.height * 0.9)));
      r.x = mon.x + (mon.width - r.width) / 2;
      r.y = mon.y + (mon.height - r.height) / 2;
    } else if (action == "first-third") {
      r.x = mon.x;
      r.y = mon.y;
      r.width = mon.width / 3;
      r.height = mon.height;
    } else if (action == "center-third") {
      r.x = mon.x + mon.width / 3;
      r.y = mon.y;
      r.width = mon.width / 3;
      r.height = mon.height;
    } else if (action == "last-third") {
      r.x = mon.x + (mon.width / 3) * 2;
      r.y = mon.y;
      r.width = mon.width - (mon.width / 3) * 2;
      r.height = mon.height;
    } else if (action == "first-two-thirds") {
      r.x = mon.x;
      r.y = mon.y;
      r.width = (mon.width / 3) * 2;
      r.height = mon.height;
    } else if (action == "last-two-thirds") {
      r.x = mon.x + mon.width / 3;
      r.y = mon.y;
      r.width = mon.width - mon.width / 3;
      r.height = mon.height;
    } else if (action == "make-larger") {
      int addW = static_cast<int>(cur.width * 0.1);
      int addH = static_cast<int>(cur.height * 0.1);
      r.width = (std::min)(mon.width, cur.width + addW);
      r.height = (std::min)(mon.height, cur.height + addH);
      r.x = (std::max)(mon.x, cur.x - addW / 2);
      r.y = (std::max)(mon.y, cur.y - addH / 2);
    } else if (action == "make-smaller") {
      int subW = static_cast<int>(cur.width * 0.1);
      int subH = static_cast<int>(cur.height * 0.1);
      r.width = (std::max)(300, cur.width - subW);
      r.height = (std::max)(200, cur.height - subH);
      r.x = cur.x + subW / 2;
      r.y = cur.y + subH / 2;
    } else {
      r = cur;
    }
    return r;
  }

  static std::vector<MONITORINFO> GetAllMonitors() {
    std::vector<MONITORINFO> monitors;
    EnumDisplayMonitors(NULL, NULL, [](HMONITOR hMon, HDC, LPRECT, LPARAM dwData) -> BOOL {
      auto* pList = reinterpret_cast<std::vector<MONITORINFO>*>(dwData);
      MONITORINFO mi = { sizeof(mi) };
      if (GetMonitorInfoW(hMon, &mi)) {
        pList->push_back(mi);
      }
      return TRUE;
    }, reinterpret_cast<LPARAM>(&monitors));
    return monitors;
  }

  mutable std::mutex snippets_mutex_;
  std::vector<SnippetItem> snippets_;

  static bool IsUrlCandidate(const std::string& str) {
    if (str.empty()) return false;
    if (str.rfind("http://", 0) == 0 ||
        str.rfind("https://", 0) == 0 ||
        str.rfind("edge://", 0) == 0 ||
        str.rfind("chrome://", 0) == 0 ||
        str.rfind("about:", 0) == 0 ||
        str.rfind("file://", 0) == 0) {
      return true;
    }
    // Might be domain like github.com/foo
    if (str.find('.') != std::string::npos && str.find(' ') == std::string::npos && str.size() >= 4) {
      return true;
    }
    return false;
  }

  static std::string NormalizeUrl(const std::string& str) {
    if (str.rfind("http://", 0) == 0 ||
        str.rfind("https://", 0) == 0 ||
        str.rfind("edge://", 0) == 0 ||
        str.rfind("chrome://", 0) == 0 ||
        str.rfind("about:", 0) == 0 ||
        str.rfind("file://", 0) == 0) {
      return str;
    }
    return "https://" + str;
  }

  IUIAutomation* pAutomation_ = nullptr;
  std::mutex mock_mutex_;
  bool mock_active_ = false;
  sidecar::JsonValue mock_data_;
};

} // namespace ztools::uiaccess
