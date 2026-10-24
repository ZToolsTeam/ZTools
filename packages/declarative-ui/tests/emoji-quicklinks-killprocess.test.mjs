import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  showToast,
  Toast,
  // 1. Emoji Picker
  EmojiPickerCommand,
  EmojiDetailView,
  CATEGORIES,
  EMOJI_DATABASE,
  getUnicodeHex,
  getHtmlEntity,
  getCategoryLabel,
  searchEmojis,
  getPinnedEmojis,
  savePinnedEmojis,
  togglePinnedEmoji,
  isEmojiPinned,
  // 2. Quicklinks
  QuicklinksCommand,
  CreateQuicklinkForm,
  EditQuicklinkForm,
  ImportQuicklinksForm,
  DEFAULT_QUICKLINKS,
  getQuicklinks,
  saveQuicklinks,
  resolveQuicklinkUrl,
  filterQuicklinks,
  exportQuicklinksJson,
  importQuicklinksJson,
  // 3. Kill Process
  KillProcessCommand,
  ProcessDetailView,
  SAMPLE_PROCESSES,
  filterAndSortProcesses,
  isSystemCriticalProcess,
  getKillCommandLine,
  inferProcessPlatform,
  revealProcessInExplorer,
  CRITICAL_PROCESSES
} from "../dist/index.js";
// 顶层 terminateProcess 现为宿主 API（按 pid 结束任意进程）；示例自己的实现从示例路径引用
import { terminateProcess } from "../dist/examples/kill-process/process-manager.js";

// 通用 LocalStorage 模拟容器
const mockStore = new Map();
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = {
    getItem: (key) => mockStore.get(key) ?? null,
    setItem: (key, val) => mockStore.set(key, String(val)),
    removeItem: (key) => mockStore.delete(key),
    clear: () => mockStore.clear()
  };
}

describe("Built-in Suite: Emoji-Picker, Quicklinks & Kill-Process", () => {
  beforeEach(async () => {
    mockStore.clear();
    await LocalStorage.clear();
  });

  // =========================================================================
  // 1. Emoji & Symbols Picker
  // =========================================================================
  describe("1. Emoji Picker: Unicode Standards, Bilingual Pinyin Search & Dual-Column Detail", () => {
    test("Unicode Standard Categories Coverage: all 9 categories defined and populated", () => {
      assert.equal(CATEGORIES.length, 9);
      const expectedCatIds = [
        "smileys",
        "people",
        "nature",
        "food",
        "travel",
        "activities",
        "objects",
        "symbols",
        "flags"
      ];
      expectedCatIds.forEach(catId => {
        const cat = CATEGORIES.find(c => c.id === catId);
        assert.ok(cat, `Category ${catId} must exist`);
        assert.ok(cat.labelZh && cat.labelEn, `Category ${catId} must have both Chinese and English labels`);
      });

      // 验证数据库中每个分类均有代表性 Emoji
      expectedCatIds.forEach(catId => {
        const items = EMOJI_DATABASE.filter(e => e.category === catId);
        assert.ok(items.length >= 3, `Category ${catId} must contain at least 3 standard emojis`);
      });
    });

    test("Unicode Code Point & HTML Entity Computation", () => {
      // 基础单码点 Emoji (开怀大笑)
      const grinningHex = getUnicodeHex("😀");
      assert.equal(grinningHex, "U+1F600");
      assert.equal(getHtmlEntity("😀", true), "&#x1F600;");
      assert.equal(getHtmlEntity("😀", false), "&#128512;");

      // 复合国旗 Emoji (中国五星红旗由 Regional Indicator Symbol Letters 组成)
      const flagHex = getUnicodeHex("🇨🇳");
      assert.ok(flagHex.includes("U+1F1E8") && flagHex.includes("U+1F1F3"));

      // 汉字/符号回退
      const fireHex = getUnicodeHex("🔥");
      assert.equal(fireHex, "U+1F525");
    });

    test("Pinyin & Bilingual Search: Chinese, Pinyin, English, and Hex code points", () => {
      // 1. 拼音搜索 "xiao" 匹配 😄
      const resXiao = searchEmojis("xiao");
      assert.ok(resXiao.allFiltered.length > 0);
      assert.ok(resXiao.allFiltered.some(e => e.char === "😄" || e.char === "😀" || e.char === "🤣"));

      // 2. 拼音搜索 "diannao" 匹配 💻
      const resDiannao = searchEmojis("diannao");
      assert.ok(resDiannao.allFiltered.length > 0);
      assert.ok(resDiannao.allFiltered.some(e => e.char === "💻"));

      // 3. 拼音搜索 "huojian" 匹配 🚀
      const resHuojian = searchEmojis("huojian");
      assert.ok(resHuojian.allFiltered.length > 0);
      assert.ok(resHuojian.allFiltered.some(e => e.char === "🚀"));

      // 4. 英文名搜索 "rocket" 匹配 🚀
      const resRocket = searchEmojis("rocket");
      assert.ok(resRocket.allFiltered.some(e => e.char === "🚀"));

      // 5. 中文名称搜索 "国旗" 匹配各旗帜
      const resGuoqi = searchEmojis("国旗");
      assert.ok(resGuoqi.allFiltered.some(e => e.char === "🇨🇳"));

      // 6. Unicode Hex 搜索 "1F600" 匹配 😀
      const resHex = searchEmojis("1F600");
      assert.ok(resHex.allFiltered.some(e => e.char === "😀"));

      // 7. 分类筛选 "food" 仅返回食物类
      const resFood = searchEmojis("", "food");
      assert.ok(resFood.allFiltered.length > 0);
      assert.ok(resFood.allFiltered.every(e => e.category === "food"));
    });

    test("Pinned / Favorite Emojis: persistence and toggle state machine", async () => {
      const initial = await getPinnedEmojis();
      assert.ok(Array.isArray(initial));

      // 切换收藏状态
      const testChar = "🇨🇳";
      const beforePinned = await isEmojiPinned(testChar);
      const isNowPinned = await togglePinnedEmoji(testChar);
      assert.equal(isNowPinned, !beforePinned);

      const reloaded = await getPinnedEmojis();
      assert.equal(reloaded.includes(testChar), isNowPinned);

      // 再次切换还原
      const reverted = await togglePinnedEmoji(testChar);
      assert.equal(reverted, beforePinned);
    });

    test("EmojiDetailView: dual-column detail renders glyph, specs, and metadata", () => {
      const item = EMOJI_DATABASE.find(e => e.char === "💻");
      const view = EmojiDetailView({ item, isPinned: true });
      assert.equal(view.type, "List.Item.Detail");
      assert.match(view.props.markdown, /💻/);
      assert.match(view.props.markdown, /U\+1F4BB/);
      assert.match(view.props.markdown, /笔记本电脑/);
      assert.match(view.props.markdown, /已收藏/);
      assert.ok(
        view.props.metadata.type === "Detail.Metadata" ||
        view.props.metadata.type === "List.Item.Detail.Metadata"
      );
    });

    test("EmojiPickerCommand: mounts List with Dropdown, sections, and full ActionPanel", () => {
      const root = renderDeclarativeRoot(EmojiPickerCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.isShowingDetail, true);
      assert.ok(desc.props.searchBarPlaceholder.includes("拼音"));
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(desc.children.length >= 1);
      root.unmount();
    });

    test("Emoji Picker Chaos & Fault Injection: illegal unicode, boundary search, and storage failure", async () => {
      // 1. 空字符与全空格防御
      const emptyRes = searchEmojis("   ");
      assert.equal(emptyRes.allFiltered.length, EMOJI_DATABASE.length);

      // 2. 超长非法搜索字符防御 (10,000 字符)
      const longQuery = "a".repeat(10000);
      const longRes = searchEmojis(longQuery);
      assert.equal(longRes.allFiltered.length, 0);

      // 3. 畸形码点与未闭合代理对
      const hexRes = getUnicodeHex("");
      assert.equal(hexRes, "");
      const entityRes = getHtmlEntity("");
      assert.equal(entityRes, "");

      // 4. 不存在的分类过滤平滑降级
      const unknownCatRes = searchEmojis("", "non_existent_category");
      assert.equal(unknownCatRes.allFiltered.length, 0);

      // 5. 存储层损坏降级容灾
      globalThis.localStorage.setItem("ztools_emoji_pinned_v1", "{bad json}");
      const pinnedFallback = await getPinnedEmojis();
      assert.ok(Array.isArray(pinnedFallback));
    });
  });

  // =========================================================================
  // 2. Quicklinks Hub
  // =========================================================================
  describe("2. Quicklinks Hub: Dynamic Query Injection, Forms & ActionPanel Lifecycle", () => {
    test("Macro Resolution: supports {query}, {argument}, and {argument name=... default=...}", () => {
      // 1. 经典 {argument} 占位符
      const tpl1 = "https://www.google.com/search?q={argument}";
      const res1 = resolveQuicklinkUrl(tpl1, "Raycast 替代品");
      assert.equal(res1.hasQuery, true);
      assert.equal(res1.url, "https://www.google.com/search?q=Raycast%20%E6%9B%BF%E4%BB%A3%E5%93%81");
      assert.equal(res1.needsArgument, false);

      // 2. 兼容历史 {query} 占位符
      const tpl2 = "https://github.com/search?q={query}";
      const res2 = resolveQuicklinkUrl(tpl2, "ztools");
      assert.equal(res2.hasQuery, true);
      assert.equal(res2.url, "https://github.com/search?q=ztools");

      // 3. 带有默认值的宏占位符: {argument name="Search" default="auto"}
      const tpl3 = "https://translate.google.com/?sl=auto&tl=zh-CN&text={argument name=\"Query\" default=\"hello world\"}";
      const res3WithArg = resolveQuicklinkUrl(tpl3, "good morning");
      assert.equal(res3WithArg.url, "https://translate.google.com/?sl=auto&tl=zh-CN&text=good%20morning");

      // 未传参时自动应用 default 属性
      const res3Default = resolveQuicklinkUrl(tpl3);
      assert.equal(res3Default.url, "https://translate.google.com/?sl=auto&tl=zh-CN&text=hello%20world");
      assert.equal(res3Default.needsArgument, false);

      // 4. 固定静态链接无需替换
      const tplStatic = "https://chat.deepseek.com";
      const resStatic = resolveQuicklinkUrl(tplStatic);
      assert.equal(resStatic.hasQuery, false);
      assert.equal(resStatic.url, "https://chat.deepseek.com");
      assert.equal(resStatic.needsArgument, false);
    });

    test("Keyword Alias Direct Matching: 'g deepseek' jumps directly with arguments", () => {
      const qls = DEFAULT_QUICKLINKS;

      // 1. 精确别名匹配且携带参数
      const filter1 = filterQuicklinks(qls, "g deepseek r1");
      assert.ok(filter1.directMatch);
      assert.equal(filter1.directMatch.quicklink.keyword, "g");
      assert.equal(filter1.directMatch.queryArg, "deepseek r1");

      // 2. 别名单独输入 (例如只敲 "ds")
      const filter2 = filterQuicklinks(qls, "ds");
      assert.ok(filter2.matches.some(m => m.keyword === "ds"));

      // 3. 标题与说明模糊匹配
      const filter3 = filterQuicklinks(qls, "哔哩哔哩");
      assert.ok(filter3.matches.length >= 1);
      assert.equal(filter3.matches[0].keyword, "bili");
    });

    test("Batch Export & Import: JSON roundtrip, schema validation and deduplication", () => {
      const exportJson = exportQuicklinksJson(DEFAULT_QUICKLINKS);
      assert.ok(typeof exportJson === "string");
      assert.ok(exportJson.includes("Google 搜索"));

      // 导入新增一条记录
      const newQuicklink = {
        id: "ql-test-unique-999",
        title: "Vue 3 官方文档",
        link: "https://vuejs.org",
        keyword: "vue",
        description: "Vue 渐进式前端框架官方中文文档"
      };
      const importPayload = JSON.stringify([newQuicklink, DEFAULT_QUICKLINKS[0]]);
      const importResult = importQuicklinksJson(importPayload, DEFAULT_QUICKLINKS);

      assert.equal(importResult.success, true);
      assert.equal(importResult.importedCount, 1); // 第二个 ID 已存在被去重
      assert.equal(importResult.result.length, DEFAULT_QUICKLINKS.length + 1);
      assert.ok(importResult.result.some(q => q.id === "ql-test-unique-999"));
    });

    test("Forms Rendering: CreateQuicklinkForm, EditQuicklinkForm, and ImportQuicklinksForm", () => {
      // 1. CreateQuicklinkForm
      const rootCreate = renderDeclarativeRoot(() => CreateQuicklinkForm({}));
      const descCreate = rootCreate.getLatest();
      assert.equal(descCreate.type, "Form");
      assert.equal(descCreate.props.navigationTitle, "新建快捷直达链接");
      assert.ok(descCreate.children.length >= 4);
      rootCreate.unmount();

      // 2. EditQuicklinkForm
      const rootEdit = renderDeclarativeRoot(() =>
        EditQuicklinkForm({ quicklink: DEFAULT_QUICKLINKS[0] })
      );
      const descEdit = rootEdit.getLatest();
      assert.equal(descEdit.type, "Form");
      assert.match(descEdit.props.navigationTitle, /编辑/);
      rootEdit.unmount();

      // 3. ImportQuicklinksForm
      const rootImport = renderDeclarativeRoot(() => ImportQuicklinksForm({}));
      const descImport = rootImport.getLatest();
      assert.equal(descImport.type, "Form");
      assert.match(descImport.props.navigationTitle, /导入/);
      rootImport.unmount();
    });

    test("Quicklinks Chaos & Fault Injection: malformed JSON, boundary URL encoding, and unclosed macros", () => {
      // 1. 畸形 JSON 导入拦截
      const badJsonResult = importQuicklinksJson("{not an array}", DEFAULT_QUICKLINKS);
      assert.equal(badJsonResult.success, false);
      assert.equal(badJsonResult.importedCount, 0);

      // 2. 特殊字符与复杂查询 URL 编码安全性
      const complexQuery = "Node.js & C++ 100% #1 / ? = ' \" <script>";
      const resolved = resolveQuicklinkUrl("https://example.com/s?q={argument}", complexQuery);
      assert.ok(!resolved.url.includes(" "));
      assert.ok(resolved.url.includes("%26")); // & 转义
      assert.ok(resolved.url.includes("%2B")); // + 转义
      assert.ok(resolved.url.includes("%23")); // # 转义
      assert.ok(resolved.url.includes("%2F")); // / 转义

      // 3. 空模板防御
      const emptyRes = resolveQuicklinkUrl("");
      assert.equal(emptyRes.url, "");
      assert.equal(emptyRes.hasQuery, false);

      // 4. 缺少必要参数时提示 needsArgument 标志
      const noArgRes = resolveQuicklinkUrl("https://example.com?q={argument}");
      assert.equal(noArgRes.needsArgument, true);
    });
  });

  // =========================================================================
  // 3. Kill Process Emergency Kit
  // =========================================================================
  describe("3. Kill Process: Smart Resource Ranking, Critical Process Shield & Action Tree", () => {
    test("Process List Smart Sorting: Memory, CPU, Name, and PID", () => {
      // 1. 物理内存降序
      const byMem = filterAndSortProcesses(SAMPLE_PROCESSES, "", "memory");
      for (let i = 0; i < byMem.length - 1; i++) {
        assert.ok(
          byMem[i].memoryMB >= byMem[i + 1].memoryMB,
          `Memory sort violated: ${byMem[i].name} (${byMem[i].memoryMB}) < ${byMem[i + 1].name} (${byMem[i + 1].memoryMB})`
        );
      }

      // 2. CPU 占用率降序
      const byCpu = filterAndSortProcesses(SAMPLE_PROCESSES, "", "cpu");
      for (let i = 0; i < byCpu.length - 1; i++) {
        assert.ok(byCpu[i].cpuPercent >= byCpu[i + 1].cpuPercent);
      }

      // 3. 进程名排序
      const byName = filterAndSortProcesses(SAMPLE_PROCESSES, "", "name");
      for (let i = 0; i < byName.length - 1; i++) {
        assert.ok(byName[i].name.localeCompare(byName[i + 1].name) <= 0);
      }

      // 4. PID 升序
      const byPid = filterAndSortProcesses(SAMPLE_PROCESSES, "", "pid");
      for (let i = 0; i < byPid.length - 1; i++) {
        assert.ok(byPid[i].pid <= byPid[i + 1].pid);
      }
    });

    test("Pinyin & Fuzzy Process Search: 'guge' -> chrome, 'ziyuan' -> explorer, 'weiruan' -> Code", () => {
      const resGuge = filterAndSortProcesses(SAMPLE_PROCESSES, "guge");
      assert.ok(resGuge.some(p => p.name === "chrome.exe"));

      const resZiyuan = filterAndSortProcesses(SAMPLE_PROCESSES, "ziyuan");
      assert.ok(resZiyuan.some(p => p.name === "explorer.exe"));

      const resWeiruan = filterAndSortProcesses(SAMPLE_PROCESSES, "weiruan");
      assert.ok(resWeiruan.some(p => p.name === "Code.exe" || p.name === "Teams.exe"));

      const resPid = filterAndSortProcesses(SAMPLE_PROCESSES, "14220");
      assert.equal(resPid.length, 1);
      assert.equal(resPid[0].name, "chrome.exe");
    });

    test("Command Line Generation: Graceful, Force Kill, and Process Tree", () => {
      const pid = 12345;
      // Windows：taskkill
      assert.equal(getKillCommandLine(pid, "graceful", { platform: "win32" }), "taskkill /PID 12345");
      assert.equal(getKillCommandLine(pid, "force", { platform: "win32" }), "taskkill /F /PID 12345");
      assert.equal(getKillCommandLine(pid, "tree", { platform: "win32" }), "taskkill /F /T /PID 12345");
      // macOS / POSIX：kill / pkill
      assert.equal(getKillCommandLine(pid, "graceful", { platform: "darwin" }), "kill -15 12345");
      assert.equal(getKillCommandLine(pid, "force", { platform: "darwin" }), "kill -9 12345");
      assert.equal(getKillCommandLine(pid, "tree", { platform: "darwin" }), "pkill -9 -P 12345");
      assert.equal(getKillCommandLine(pid, "force", { platform: "linux" }), "kill -9 12345");
      // 兼容旧的布尔参数
      assert.equal(getKillCommandLine(pid, "force", true), "kill -9 12345");
      assert.equal(getKillCommandLine(pid, "force", false), "taskkill /F /PID 12345");
      // 进程路径推断平台
      assert.equal(inferProcessPlatform("C:\\Windows\\notepad.exe"), "win32");
      assert.equal(inferProcessPlatform("/Applications/Safari.app/Contents/MacOS/Safari"), "darwin");
      assert.equal(inferProcessPlatform(""), undefined);
    });

    test("Critical System Process Protection Shield: intercept fatal terminations", async () => {
      const criticalProcs = ["csrss.exe", "explorer.exe", "svchost.exe", "winlogon.exe", "dwm.exe"];

      for (const name of criticalProcs) {
        assert.equal(isSystemCriticalProcess(name), true, `${name} must be identified as critical`);

        // 尝试默认终止系统关键进程必须被拦截拒绝！
        const res = await terminateProcess({ pid: 999, name }, "force", false);
        assert.equal(res.success, false, `Termination of ${name} must be rejected`);
        assert.equal(res.error, "PROTECTED_CRITICAL_PROCESS");
        assert.match(res.message, /系统关键进程受安全保护/);
      }

      // PID 0 (Idle) 和 PID 4 (System) 同样受严格保护
      assert.equal(isSystemCriticalProcess(0), true);
      assert.equal(isSystemCriticalProcess(4), true);
      const resPid4 = await terminateProcess({ pid: 4, name: "System" }, "force", false);
      assert.equal(resPid4.success, false);
      assert.equal(resPid4.error, "PROTECTED_CRITICAL_PROCESS");
    });

    test("Normal User Process Termination: terminates gracefully or forcefully with valid command", async () => {
      const userProc = SAMPLE_PROCESSES.find(p => p.name === "node.exe");
      assert.equal(isSystemCriticalProcess(userProc.name), false);

      // 假宿主：记录 process_terminate_pid 的参数（契约只允许 pid / mode / tree / timeoutMs / expectedName）
      const calls = [];
      const host = {
        process_terminate_pid: async (params) => {
          calls.push(params);
          return { success: true, data: { pid: params.pid, mode: params.mode, tree: Boolean(params.tree), terminated: [params.pid] } };
        }
      };
      const res = await terminateProcess(userProc, "force", false, host);
      assert.equal(res.success, true);
      assert.equal(res.command, `taskkill /F /PID ${userProc.pid}`);
      assert.match(res.message, /已成功强制终结 node\.exe/);
      assert.deepEqual(calls[0], { pid: userProc.pid, mode: "force", tree: false, expectedName: "node.exe" });

      // 树终结
      const resTree = await terminateProcess(userProc, "tree", false, host);
      assert.equal(resTree.success, true);
      assert.equal(resTree.command, `taskkill /F /T /PID ${userProc.pid}`);
      assert.deepEqual(calls[1], { pid: userProc.pid, mode: "force", tree: true, expectedName: "node.exe" });

      // macOS 进程：命令按 POSIX 展示
      const macRes = await terminateProcess({ pid: 4321, name: "Safari", path: "/Applications/Safari.app/Contents/MacOS/Safari" }, "graceful", false, host);
      assert.equal(macRes.success, true);
      assert.equal(macRes.command, "kill -15 4321");
      assert.equal(calls[2].mode, "graceful");
    });

    test("[故障] Termination: no host / host rejection / DLL inner failure must not report success", async () => {
      const userProc = SAMPLE_PROCESSES.find(p => p.name === "node.exe");
      // 1. 没有宿主：如实失败
      const none = await terminateProcess(userProc, "force", false, undefined, { platform: "win32" });
      assert.equal(none.success, false);
      assert.equal(none.error, "HOST_UNAVAILABLE");

      // 2. 宿主拒绝 process_terminate_pid，DLL 内层也返回失败：如实失败并带上原因
      const rejecting = {
        process_terminate_pid: async () => ({ success: false, error: { code: "PLUGIN_IDENTITY_REQUIRED", message: "需要插件身份" } }),
        dllplugin_call: async () => ({ success: true, data: { result: JSON.stringify({ success: false, error: "ACCESS_DENIED" }) } })
      };
      const rejected = await terminateProcess(userProc, "force", false, rejecting);
      assert.equal(rejected.success, false);
      assert.equal(rejected.error, "EXECUTION_FAILED");
      assert.match(rejected.message, /ACCESS_DENIED/);

      // 3. 宿主抛错：如实失败
      const throwing = {
        process_terminate_pid: async () => { throw new Error("IPC 断开"); },
        dllplugin_call: async () => { throw new Error("DLL 未加载"); }
      };
      const thrown = await terminateProcess(userProc, "graceful", false, throwing);
      assert.equal(thrown.success, false);
      assert.match(thrown.message, /DLL 未加载|IPC 断开/);

      // 4. process_terminate_pid 失败但旧 DLL 成功：成功
      const dllOk = {
        process_terminate_pid: async () => ({ success: false, error: "METHOD_NOT_AVAILABLE" }),
        dllplugin_call: async (params) => {
          assert.deepEqual(Object.keys(params).sort(), ["func", "params", "plugin"]);
          return { success: true, data: { result: JSON.stringify({ success: true }) } };
        }
      };
      const viaDll = await terminateProcess(userProc, "force", false, dllOk);
      assert.equal(viaDll.success, true);

      // 4.1 旧宿主对象的 dllplugin.call：返回无法解析的结果、内层失败、抛错都如实失败；内层成功才算成功
      const legacyHost = (impl) => ({
        process_terminate_pid: async () => ({ success: false, error: "METHOD_NOT_AVAILABLE" }),
        dllplugin: { call: impl }
      });
      const malformed = await terminateProcess(userProc, "force", false, legacyHost(async () => "<html>not json"));
      assert.equal(malformed.success, false);
      assert.match(malformed.message, /无法解析/);
      const legacyInnerFail = await terminateProcess(userProc, "force", false, legacyHost(async () => JSON.stringify({ success: false, error: "ACCESS_DENIED" })));
      assert.equal(legacyInnerFail.success, false);
      assert.match(legacyInnerFail.message, /ACCESS_DENIED/);
      const legacyThrow = await terminateProcess(userProc, "force", false, legacyHost(async () => { throw new Error("DLL 崩溃"); }));
      assert.equal(legacyThrow.success, false);
      assert.match(legacyThrow.message, /DLL 崩溃/);
      const legacyCalls = [];
      const legacyOk = await terminateProcess(userProc, "tree", false, legacyHost(async (plugin, func, params) => {
        legacyCalls.push({ plugin, func, params });
        return JSON.stringify({ success: true });
      }));
      assert.equal(legacyOk.success, true);
      assert.deepEqual(legacyCalls, [{ plugin: "ProcessMonitorPlugin", func: "TerminateProcessByPID", params: { pid: userProc.pid, name: "node.exe", mode: "tree" } }]);

      // 5. 定位：宿主返回失败时返回 false
      const revealFail = await revealProcessInExplorer("C:\\x.exe", {
        shell_show_item_in_folder: async () => ({ success: false, error: "NOT_FOUND" }),
        shell_open_path: async () => ({ success: false, error: "NOT_FOUND" })
      });
      assert.equal(revealFail, false);
      const revealOk = await revealProcessInExplorer("C:\\x.exe", { shell_show_item_in_folder: async () => ({ success: true }) });
      assert.equal(revealOk, true);
      // 没有宿主时不假装成功
      assert.equal(await revealProcessInExplorer("C:\\x.exe"), false);
    });

    test("ProcessDetailView: renders comprehensive stats, warning box for critical, and ActionPanel", () => {
      // 1. 常规应用进程
      const procNormal = SAMPLE_PROCESSES.find(p => p.name === "chrome.exe");
      const viewNormal = ProcessDetailView({ process: procNormal });
      assert.equal(viewNormal.type, "Detail");
      assert.match(viewNormal.props.markdown, /物理内存/);
      assert.match(viewNormal.props.markdown, /taskkill/);

      // 2. 系统核心高危进程
      const procCritical = SAMPLE_PROCESSES.find(p => p.name === "explorer.exe");
      const viewCritical = ProcessDetailView({ process: procCritical });
      assert.match(viewCritical.props.markdown, /\[高危警告\] \*\*系统关键高危进程\*\*/);
    });

    test("KillProcessCommand: mounts with Dropdown sorting, section counters, and ActionPanel", () => {
      const root = renderDeclarativeRoot(KillProcessCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "进程管理急救箱");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");

      const sec = desc.children[0];
      assert.ok(sec.children.length >= SAMPLE_PROCESSES.length);

      // 验证 ActionPanel 中具有完整的极客动作
      const sampleItem = sec.children[0];
      const actionTitles = sampleItem.props.actions.children.map(a => a.props.title);
      assert.ok(actionTitles.includes("一键强制结束进程"));
      assert.ok(actionTitles.includes("优雅终结进程 (Kill Process)"));
      assert.ok(actionTitles.includes("终结进程树 (Kill Process Tree)"));
      assert.ok(actionTitles.includes("在资源管理器中定位 (Show in Explorer)"));
      assert.ok(actionTitles.includes("复制 PID"));
      root.unmount();
    });

    test("Kill Process Chaos & Fault Injection: extreme PID values, explorer reveal resilience", async () => {
      // 1. 负数 PID 与非法字符
      const resNegative = await terminateProcess({ pid: -1, name: "invalid" }, "force", false, undefined, { platform: "win32" });
      assert.equal(resNegative.command, "taskkill /F /PID -1");
      assert.equal(resNegative.success, false);
      assert.equal(resNegative.error, "INVALID_PID");
      const resNegativeMac = await terminateProcess({ pid: -1, name: "invalid" }, "force", false, undefined, { platform: "darwin" });
      assert.equal(resNegativeMac.command, "kill -9 -1");
      assert.equal(resNegativeMac.success, false);

      // 2. revealProcessInExplorer 在缺失路径时平滑返回 false 而不崩溃
      const okEmpty = await revealProcessInExplorer("");
      assert.equal(okEmpty, false);

      // 3. 搜索包含特殊正则符号的输入 (如 ".*" 或 "[" 或 "?")
      const regexSafe = filterAndSortProcesses(SAMPLE_PROCESSES, "[a-z]+.*$");
      assert.equal(regexSafe.length, 0); // 安全未崩溃
    });
  });
});
