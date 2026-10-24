import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LocalStorage,
  Clipboard,
  ClipboardHistoryCommand,
  ClipboardDetailView,
  SAMPLE_CLIPBOARD_ITEMS,
  filterClipboardItems,
  detectClipboardContentType,
  parseColorDetails,
  maskSensitiveContent,
  calculateShannonEntropy,
  pasteSequenceManager,
  getClipboardPreferences,
  saveClipboardPreferences,
  SnippetsCommand,
  SnippetDetailView,
  CreateSnippetForm,
  ImportSnippetsForm,
  getSnippets,
  expandSnippetTemplate,
  exportSnippetsJSON,
  importSnippetsJSON,
  WindowManagementCommand,
  WindowActionDetailView,
  WindowPreferencesForm,
  WINDOW_ACTIONS,
  filterWindowActions,
  calculateWindowGeometry,
  getWindowPreferences,
  saveWindowPreferences,
  executeWindowAction,
  getSavedWindowState,
  clearSavedWindowStates,
  DEFAULT_WINDOW_PREFERENCES,
  SystemCommand,
  SYSTEM_ACTIONS,
  filterSystemActions,
  executeSystemAction,
  QuicklinksCommand,
  getQuicklinks,
  saveQuicklinks,
  resolveQuicklinkUrl,
  filterQuicklinks,
  DEFAULT_QUICKLINKS,
  setDeclarativeBridge
} from "../dist/index.js";

// 构造通用 localStorage 模拟环境以供浏览器存储层测试
const mockStore = new Map();
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = {
    getItem: (key) => mockStore.get(key) ?? null,
    setItem: (key, val) => mockStore.set(key, String(val)),
    removeItem: (key) => mockStore.delete(key),
    clear: () => mockStore.clear()
  };
}

describe("Core Built-in Suites Integration & Chaos Resilience", () => {
  beforeEach(async () => {
    mockStore.clear();
    await LocalStorage.clear();
  });

  // =========================================================================
  // 4. Window Management: Action Catalog, Geometry Engine & Preferences
  // =========================================================================
  describe("Window Management: 30+ Action Grid, Geometry Calculation & Gap Offsets", () => {
    test("Happy Path: catalog registration and full category coverage", () => {
      // 验证动作总数达到 30+ 项
      assert.ok(WINDOW_ACTIONS.length >= 30, `Current count: ${WINDOW_ACTIONS.length}`);

      // 验证核心动作存在
      const actionIds = WINDOW_ACTIONS.map(a => a.id);
      assert.ok(actionIds.includes("left-half"));
      assert.ok(actionIds.includes("right-half"));
      assert.ok(actionIds.includes("top-half"));
      assert.ok(actionIds.includes("bottom-half"));
      assert.ok(actionIds.includes("center-half"));

      assert.ok(actionIds.includes("first-third"));
      assert.ok(actionIds.includes("center-third"));
      assert.ok(actionIds.includes("last-third"));
      assert.ok(actionIds.includes("first-two-thirds"));
      assert.ok(actionIds.includes("center-two-thirds"));
      assert.ok(actionIds.includes("last-two-thirds"));

      assert.ok(actionIds.includes("top-left-quarter"));
      assert.ok(actionIds.includes("top-right-quarter"));
      assert.ok(actionIds.includes("bottom-left-quarter"));
      assert.ok(actionIds.includes("bottom-right-quarter"));

      assert.ok(actionIds.includes("top-left-sixth"));
      assert.ok(actionIds.includes("bottom-right-sixth"));

      assert.ok(actionIds.includes("maximize"));
      assert.ok(actionIds.includes("restore"));
      assert.ok(actionIds.includes("almost-maximize"));
      assert.ok(actionIds.includes("reasonable-size"));
      assert.ok(actionIds.includes("center"));

      assert.ok(actionIds.includes("next-display"));
      assert.ok(actionIds.includes("previous-display"));
    });

    test("Happy Path: Halves and Thirds geometry calculations", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };

      // 左半屏: 0, 0, 960, 1080
      const leftHalf = calculateWindowGeometry("left-half", cur, mon);
      assert.equal(leftHalf.x, 0);
      assert.equal(leftHalf.y, 0);
      assert.equal(leftHalf.width, 960);
      assert.equal(leftHalf.height, 1080);

      // 右半屏: 960, 0, 960, 1080
      const rightHalf = calculateWindowGeometry("right-half", cur, mon);
      assert.equal(rightHalf.x, 960);
      assert.equal(rightHalf.y, 0);
      assert.equal(rightHalf.width, 960);
      assert.equal(rightHalf.height, 1080);

      // 左三分之一: 0, 0, 640, 1080
      const firstThird = calculateWindowGeometry("first-third", cur, mon);
      assert.equal(firstThird.x, 0);
      assert.equal(firstThird.width, 640);
      assert.equal(firstThird.height, 1080);

      // 左三分之二: 0, 0, 1280, 1080
      const firstTwoThirds = calculateWindowGeometry("first-two-thirds", cur, mon);
      assert.equal(firstTwoThirds.x, 0);
      assert.equal(firstTwoThirds.width, 1280);
      assert.equal(firstTwoThirds.height, 1080);
    });

    test("Happy Path: Quarters, Sixths, Center and Almost Maximize", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };

      // 左上四分之一
      const topLeft = calculateWindowGeometry("top-left-quarter", cur, mon);
      assert.equal(topLeft.x, 0);
      assert.equal(topLeft.y, 0);
      assert.equal(topLeft.width, 960);
      assert.equal(topLeft.height, 540);

      // 右下四分之一
      const bottomRight = calculateWindowGeometry("bottom-right-quarter", cur, mon);
      assert.equal(bottomRight.x, 960);
      assert.equal(bottomRight.y, 540);
      assert.equal(bottomRight.width, 960);
      assert.equal(bottomRight.height, 540);

      // 几乎最大化 90%
      const almostMax = calculateWindowGeometry("almost-maximize", cur, mon, { percentage: 0.9 });
      assert.equal(almostMax.width, 1728);
      assert.equal(almostMax.height, 972);
      assert.equal(almostMax.x, 96);
      assert.equal(almostMax.y, 54);

      // 居中显示
      const centered = calculateWindowGeometry("center", cur, mon);
      assert.equal(centered.width, 800);
      assert.equal(centered.height, 600);
      assert.equal(centered.x, (1920 - 800) / 2);
      assert.equal(centered.y, (1080 - 600) / 2);
    });

    test("Gap Offsets: innerGap and outerGap boundary math", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };
      const prefs = { innerGap: 16, outerGap: 20 };

      // 左半屏 (带 outerGap 20 与 innerGap 16)
      // effW = 1920 - 40 = 1880, effH = 1080 - 40 = 1040
      // halfW = (1880 - 16) / 2 = 932
      const leftHalf = calculateWindowGeometry("left-half", cur, mon, prefs);
      assert.equal(leftHalf.x, 20);
      assert.equal(leftHalf.y, 20);
      assert.equal(leftHalf.width, 932);
      assert.equal(leftHalf.height, 1040);

      // 右半屏: x = 20 + 932 + 16 = 968, width = 1880 - 932 - 16 = 932
      const rightHalf = calculateWindowGeometry("right-half", cur, mon, prefs);
      assert.equal(rightHalf.x, 968);
      assert.equal(rightHalf.y, 20);
      assert.equal(rightHalf.width, 932);
      assert.equal(rightHalf.height, 1040);
    });

    test("Search & Filter: keyword, category, and fuzzy matching", () => {
      // 类别筛选
      const halves = filterWindowActions(WINDOW_ACTIONS, { category: "halves" });
      assert.ok(halves.length >= 5);
      assert.ok(halves.every(a => a.category === "halves"));

      // 关键词检索
      const searchMatches = filterWindowActions(WINDOW_ACTIONS, { query: "四分之一" });
      assert.ok(searchMatches.length >= 4);

      // 快捷键检索
      const shortcutMatches = filterWindowActions(WINDOW_ACTIONS, { query: "Ctrl + Alt + Return" });
      assert.ok(shortcutMatches.some(a => a.id === "maximize"));
    });

    test("Preferences Storage: get and save preferences", async () => {
      const initial = await getWindowPreferences();
      assert.equal(initial.innerGap, DEFAULT_WINDOW_PREFERENCES.innerGap);

      // 更新偏好设置
      await saveWindowPreferences({ innerGap: 12, outerGap: 16, percentage: 0.8 });
      const updated = await getWindowPreferences();
      assert.equal(updated.innerGap, 12);
      assert.equal(updated.outerGap, 16);
      assert.equal(updated.percentage, 0.8);
    });

    test("Window Action Execution Pipeline & HUD Feedback", async () => {
      // 假宿主：契约 window_manage_action 只接受 action 字段
      const calls = [];
      const host = {
        window_manage_action: async (params) => {
          calls.push(params);
          return { success: true, data: { success: true } };
        }
      };
      const res = await executeWindowAction("left-half", {
        monRect: { x: 0, y: 0, width: 1920, height: 1040 },
        hostOverride: host
      });
      assert.equal(res.success, true);
      assert.equal(res.actionId, "left-half");
      assert.ok(res.rect);
      assert.equal(res.rect.width, 960);
      assert.deepEqual(calls, [{ action: "left-half" }]);
    });

    test("[故障] Window Action: no host / host rejects -> success:false", async () => {
      const none = await executeWindowAction("left-half", { monRect: { x: 0, y: 0, width: 1920, height: 1040 } });
      assert.equal(none.success, false);
      assert.match(none.error, /未连接 ZTools 宿主/);

      const rejected = await executeWindowAction("right-half", {
        monRect: { x: 0, y: 0, width: 1920, height: 1040 },
        hostOverride: { window_manage_action: async () => ({ success: false, error: { code: "NATIVE_HOST_UNAVAILABLE", message: "UIAccess sidecar is not running" } }) }
      });
      assert.equal(rejected.success, false);
      assert.match(rejected.error, /UIAccess sidecar is not running/);

      // 宿主抛错（例如参数校验拒绝）同样如实失败
      const thrown = await executeWindowAction("maximize", {
        monRect: { x: 0, y: 0, width: 1920, height: 1040 },
        hostOverride: { window_manage_action: async () => { throw new Error("方法参数包含未知字段"); } }
      });
      assert.equal(thrown.success, false);
      assert.match(thrown.error, /方法参数包含未知字段/);
    });

    test("[故障] Window Action: 失败时不记录新位置、不覆盖还原点；成功后才记录", async () => {
      clearSavedWindowStates();
      const mon = { x: 0, y: 0, width: 1920, height: 1040 };
      const original = { x: 100, y: 100, width: 800, height: 600 };
      const okHost = { window_manage_action: async () => ({ success: true, data: { success: true } }) };
      const failHost = { window_manage_action: async () => ({ success: false, error: "UIAccess sidecar is not running" }) };
      try {
        // 1. 首次动作失败：还原点与当前位置都不写入
        const failed = await executeWindowAction("left-half", { windowId: "hwnd-42", curWin: original, monRect: mon, hostOverride: failHost });
        assert.equal(failed.success, false);
        assert.equal(getSavedWindowState("hwnd-42"), undefined, "失败的动作不能写入还原点");

        // 2. 成功：还原点为动作前的位置
        const left = await executeWindowAction("left-half", { windowId: "hwnd-42", curWin: original, monRect: mon, hostOverride: okHost });
        assert.equal(left.success, true);
        assert.deepEqual(getSavedWindowState("hwnd-42"), original);

        // 3. 之后的动作失败：还原点仍是最初的位置，当前位置仍是左半屏（下一次计算以它为起点）
        const right = await executeWindowAction("right-half", { windowId: "hwnd-42", monRect: mon, hostOverride: failHost });
        assert.equal(right.success, false);
        assert.deepEqual(getSavedWindowState("hwnd-42"), original, "失败的动作不能覆盖还原点");
        const restore = await executeWindowAction("restore", { windowId: "hwnd-42", monRect: mon, hostOverride: okHost });
        assert.equal(restore.success, true);
        assert.deepEqual(restore.rect, original, "还原回最初位置，而不是失败动作前后的位置");
      } finally {
        clearSavedWindowStates();
      }
    });
  });

  // =========================================================================
  // 5. System Actions: Native Operations & Destructive Gating
  // =========================================================================
  describe("System Actions: Operations, Search & Safety Metadata", () => {
    test("Happy Path: system action catalog and category classification", () => {
      // 1. 全量 20+ 原生指令覆盖
      assert.ok(SYSTEM_ACTIONS.length >= 20);

      // 电源与会话 (Power & Session)
      const powerActions = filterSystemActions("", "power");
      assert.ok(powerActions.length >= 6);
      const powerKeys = powerActions.map(a => a.actionKey);
      assert.ok(powerKeys.includes("lockScreen"));
      assert.ok(powerKeys.includes("shutDown"));
      assert.ok(powerKeys.includes("restart"));
      assert.ok(powerKeys.includes("sleep"));
      assert.ok(powerKeys.includes("logOut"));
      assert.ok(powerKeys.includes("hibernate"));

      // 进程与桌面治理 (Apps & Windows)
      const appsActions = filterSystemActions("", "apps");
      assert.ok(appsActions.length >= 4);
      const appsKeys = appsActions.map(a => a.actionKey);
      assert.ok(appsKeys.includes("hideAllAppsExceptFrontmost"));
      assert.ok(appsKeys.includes("quitAllApplications"));
      assert.ok(appsKeys.includes("quitAllApplicationsExceptFrontmost"));
      assert.ok(appsKeys.includes("quitActiveApplication"));

      // 音频与硬件控制 (Audio & Hardware)
      const audioActions = filterSystemActions("", "audio");
      assert.ok(audioActions.length >= 8);
      const audioKeys = audioActions.map(a => a.actionKey);
      assert.ok(audioKeys.includes("toggleMuteCurrentApp"));
      assert.ok(audioKeys.includes("turnCurrentAppVolumeUp"));
      assert.ok(audioKeys.includes("turnCurrentAppVolumeDown"));
      assert.ok(audioKeys.includes("volumeMixer"));
      assert.ok(audioKeys.includes("toggleMute"));
      assert.ok(audioKeys.includes("turnVolumeUp"));
      assert.ok(audioKeys.includes("turnVolumeDown"));
      assert.ok(audioKeys.includes("turnDisplayOff"));
      assert.ok(audioKeys.includes("ejectAllDisks"));

      // 维护与通知 (Maintenance)
      const maintActions = filterSystemActions("", "maintenance");
      assert.ok(maintActions.length >= 3);
      const maintKeys = maintActions.map(a => a.actionKey);
      assert.ok(maintKeys.includes("emptyTrash"));
      assert.ok(maintKeys.includes("openTrash"));
      assert.ok(maintKeys.includes("dismissNotifications"));

      // 验证破坏性标记 (Destructive actions)
      const shutdown = SYSTEM_ACTIONS.find(a => a.actionKey === "shutDown");
      assert.ok(shutdown);
      assert.equal(shutdown.destructive, true);

      const emptyTrash = SYSTEM_ACTIONS.find(a => a.actionKey === "emptyTrash");
      assert.ok(emptyTrash);
      assert.equal(emptyTrash.destructive, true);

      const quitAll = SYSTEM_ACTIONS.find(a => a.actionKey === "quitAllApplications");
      assert.ok(quitAll);
      assert.equal(quitAll.destructive, true);

      // 验证非破坏性安全操作
      const lock = SYSTEM_ACTIONS.find(a => a.actionKey === "lockScreen");
      assert.ok(lock);
      assert.equal(Boolean(lock.destructive), false);

      const toggleMute = SYSTEM_ACTIONS.find(a => a.actionKey === "toggleMute");
      assert.ok(toggleMute);
      assert.equal(Boolean(toggleMute.destructive), false);

      const dismiss = SYSTEM_ACTIONS.find(a => a.actionKey === "dismissNotifications");
      assert.ok(dismiss);
      assert.equal(Boolean(dismiss.destructive), false);
    });

    test("Search & Filter: keywords, title and category matching", () => {
      // 中文关键词检索
      const lockMatches = filterSystemActions("锁定");
      assert.ok(lockMatches.length >= 1);
      assert.equal(lockMatches[0].actionKey, "lockScreen");

      // 英文指令检索
      const restartMatches = filterSystemActions("restart");
      assert.ok(restartMatches.length >= 1);
      assert.equal(restartMatches[0].actionKey, "restart");

      // 音频控制指令
      const muteMatches = filterSystemActions("静音");
      assert.ok(muteMatches.some(a => a.actionKey === "toggleMute"));

      // 硬件显示指令
      const displayMatches = filterSystemActions("熄屏");
      assert.ok(displayMatches.some(a => a.actionKey === "turnDisplayOff"));

      // 类别筛选
      const audioActions = filterSystemActions("", "audio");
      assert.ok(audioActions.every(a => a.category === "audio"));
    });

    test("Execution Pipeline & Destructive Confirmation Gating (Beyond Happy Path)", async () => {
      // 1. 安全操作直接调度无需弹窗
      const lockItem = SYSTEM_ACTIONS.find(a => a.actionKey === "lockScreen");
      assert.ok(lockItem);
      const resSafe = await executeSystemAction(lockItem);
      assert.equal(resSafe.success, true);
      assert.equal(resSafe.executed, true);

      // 2. 高危破坏性操作：用户拒绝确认 -> 中断执行
      setDeclarativeBridge({
        confirmAlert: async () => false
      });
      const shutdownItem = SYSTEM_ACTIONS.find(a => a.actionKey === "shutDown");
      assert.ok(shutdownItem);
      const resRejected = await executeSystemAction(shutdownItem);
      assert.equal(resRejected.success, false);
      assert.equal(resRejected.executed, false);
      assert.match(resRejected.message, /取消/);

      // 3. 高危破坏性操作：用户批准确认 -> 顺利下发
      let alertPrompted = false;
      setDeclarativeBridge({
        confirmAlert: async () => {
          alertPrompted = true;
          return true;
        },
        system: {
          execute: async (key) => ({ success: true, message: `Dispatched ${key}` })
        }
      });
      const resApproved = await executeSystemAction(shutdownItem);
      assert.equal(alertPrompted, true);
      assert.equal(resApproved.success, true);
      assert.equal(resApproved.executed, true);

      // 4. 强制执行绕过确认 (force / confirmBypass)
      alertPrompted = false;
      const resForced = await executeSystemAction(shutdownItem, { confirmBypass: true });
      assert.equal(alertPrompted, false); // 未触发弹窗
      assert.equal(resForced.success, true);
      assert.equal(resForced.executed, true);

      // 5. 底层异常故障注入：Bridge 抛出错误被优雅捕获
      setDeclarativeBridge({
        system: {
          execute: async () => {
            throw new Error("Win32 Native API Error: 0x80070005 Access Denied");
          }
        }
      });
      const resError = await executeSystemAction(lockItem);
      assert.equal(resError.success, false);
      assert.equal(resError.executed, false);
      assert.match(resError.message, /Access Denied/);

      // 清理 Bridge 模拟
      setDeclarativeBridge(null);
    });

    test("Chaos & Fault Injection: empty, whitespace and unknown queries", () => {
      // 空白返回全量
      assert.equal(filterSystemActions("").length, SYSTEM_ACTIONS.length);
      assert.equal(filterSystemActions("   ").length, SYSTEM_ACTIONS.length);

      // 未知指令返回空数组
      assert.equal(filterSystemActions("unknown-impossible-action-xyz").length, 0);
      assert.equal(filterSystemActions("", "non-existent-category").length, 0);
    });
  });

  // =========================================================================
  // 6. Quicklinks: Dynamic Query Resolution, Keyword Alias & Storage
  // =========================================================================
  describe("Quicklinks: Macro Resolution & Alias Direct Match", () => {
    test("Happy Path: dynamic {query} replacement and static URLs", () => {
      // 带 {query} 的动态链接
      const tpl = "https://www.google.com/search?q={query}";
      const res1 = resolveQuicklinkUrl(tpl, "deepseek r1");
      assert.equal(res1.hasQuery, true);
      assert.equal(res1.url, "https://www.google.com/search?q=deepseek%20r1");

      // 静态链接无需替换
      const staticUrl = "https://github.com";
      const res2 = resolveQuicklinkUrl(staticUrl, "ignored arg");
      assert.equal(res2.hasQuery, false);
      assert.equal(res2.url, "https://github.com");

      // 带 {query} 但未传入参数
      const res3 = resolveQuicklinkUrl(tpl, "");
      assert.equal(res3.hasQuery, true);
      assert.equal(res3.url, "https://www.google.com/search?q=");
    });

    test("Happy Path: alias instant jump matching", () => {
      // 别名 + 参数 (例如 'g react')
      const filter1 = filterQuicklinks(DEFAULT_QUICKLINKS, "g react framework");
      assert.ok(filter1.directMatch);
      assert.equal(filter1.directMatch.quicklink.keyword, "g");
      assert.equal(filter1.directMatch.queryArg, "react framework");

      // 检索包含关键字的普通匹配
      const filter2 = filterQuicklinks(DEFAULT_QUICKLINKS, "gh");
      assert.ok(filter2.matches.some(m => m.keyword === "gh"));

      // 普通标题或链接模糊检索
      const filter3 = filterQuicklinks(DEFAULT_QUICKLINKS, "bilibili");
      assert.ok(filter3.matches.length >= 1);
      assert.equal(filter3.matches[0].keyword, "bili");
    });

    test("Storage: LocalStorage persistence and fallback", async () => {
      // 初始加载默认数据
      const initial = await getQuicklinks();
      assert.ok(initial.length >= 3);

      // 新增记录
      const customItem = {
        id: "custom-1",
        title: "自定义开发文档",
        link: "https://developer.mozilla.org/zh-CN/search?q={query}",
        keyword: "mdn",
        openCount: 5,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await saveQuicklinks([customItem, ...initial]);

      const reloaded = await getQuicklinks();
      assert.equal(reloaded.length, initial.length + 1);
      assert.equal(reloaded[0].id, "custom-1");
      assert.equal(reloaded[0].keyword, "mdn");
    });

    test("Chaos & Fault Injection: malformed data and boundary characters", () => {
      // 特殊字符 URL 编码安全性
      const resSpecial = resolveQuicklinkUrl("https://example.com/search?q={query}", "C++ & C# 100%");
      assert.ok(!resSpecial.url.includes(" "));
      assert.ok(resSpecial.url.includes("%2B%2B")); // + 转义
      assert.ok(resSpecial.url.includes("%23")); // # 转义

      // 异常输入过滤
      assert.equal(filterQuicklinks([], "test").matches.length, 0);
      assert.equal(filterQuicklinks(DEFAULT_QUICKLINKS, "").matches.length, DEFAULT_QUICKLINKS.length);
    });
  });

  // =========================================================================
  // 6. Clipboard History: Deep Integration, Sensitivity & Sequential Paste State Machine
  // =========================================================================
  describe("Clipboard History: Deep Integration, Sensitivity & Sequential Paste State Machine", () => {
    test("Happy Path: filter by types, pinyin initials and content search", () => {
      // 1. All items
      const all = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "all" });
      assert.equal(all.length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(all[0].pinned, true);

      // 2. Filter by category
      const codeOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "code" });
      assert.equal(codeOnly.length, 1);
      assert.equal(codeOnly[0].type, "code");

      const colorsOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "color" });
      assert.equal(colorsOnly.length, 1);
      assert.equal(colorsOnly[0].type, "color");

      // 3. Pinyin initials match: "jtb" matches "剪贴板"
      const pinyinRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "jtb" });
      assert.ok(pinyinRes.length >= 1);
      assert.match(pinyinRes[0].content, /剪贴板/);
    });

    test("Sensitive Content: Masking & Desensitization (API Keys, Tokens, Secrets)", () => {
      // 1. OpenAI API Key
      const openAiKey = "sk-proj-12345678abcdefghijklmnopQRSTUVWX";
      const resOpenAi = maskSensitiveContent(openAiKey);
      assert.equal(resOpenAi.isSensitive, true);
      assert.equal(resOpenAi.reason, "API Key");
      assert.ok(resOpenAi.masked.includes("••••••••"));
      assert.ok(!resOpenAi.masked.includes("abcdefghijklmnop"));

      // 2. GitHub Token
      const ghToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const resGh = maskSensitiveContent(ghToken);
      assert.equal(resGh.isSensitive, true);
      assert.equal(resGh.reason, "GitHub Token");
      assert.ok(resGh.masked.includes("••••••••"));

      // 3. AWS Key
      const awsKey = "AKIA1234567890ABCDEF";
      const resAws = maskSensitiveContent(awsKey);
      assert.equal(resAws.isSensitive, true);
      assert.equal(resAws.reason, "AWS Access Key");

      // 4. Private Key
      const privKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
      const resPriv = maskSensitiveContent(privKey);
      assert.equal(resPriv.isSensitive, true);
      assert.match(resPriv.masked, /PROTECTED PRIVATE KEY/);

      // 5. Normal text is not sensitive
      const normalText = "Hello, this is regular code snippet for testing.";
      const resNormal = maskSensitiveContent(normalText);
      assert.equal(resNormal.isSensitive, false);
      assert.equal(resNormal.masked, normalText);
    });

    test("Sequential Paste State Machine: Advances, Calculates Remaining & Resets", async () => {
      pasteSequenceManager.reset();
      const items = [...SAMPLE_CLIPBOARD_ITEMS];

      // 1. First invocation
      const step1 = pasteSequenceManager.pasteNext(items);
      assert.ok(step1.item);
      assert.equal(step1.offset, 1);
      assert.equal(step1.remaining, items.length - 1);

      // 2. Second invocation
      const step2 = pasteSequenceManager.pasteNext(items);
      assert.ok(step2.item);
      assert.equal(step2.offset, 2);
      assert.equal(step2.remaining, items.length - 2);

      // 3. Reset
      pasteSequenceManager.reset();
      const state = pasteSequenceManager.getState();
      assert.equal(state.offset, 0);
      assert.equal(state.lastInvocation, null);

      // 4. Next invocation starts from 0 again
      const stepAfterReset = pasteSequenceManager.pasteNext(items);
      assert.equal(stepAfterReset.offset, 1);
      assert.equal(stepAfterReset.item.id, items[0].id);
    });

    test("Preferences: Storage, defaults and updates", async () => {
      const initialPrefs = await getClipboardPreferences();
      assert.equal(initialPrefs.historyDuration, "P1W");
      assert.equal(initialPrefs.primaryAction, "paste");

      await saveClipboardPreferences({
        historyDuration: "P1M",
        primaryAction: "copy",
        preferPastingAsPlainText: true
      });

      const updatedPrefs = await getClipboardPreferences();
      assert.equal(updatedPrefs.historyDuration, "P1M");
      assert.equal(updatedPrefs.primaryAction, "copy");
      assert.equal(updatedPrefs.preferPastingAsPlainText, true);
    });

    test("Chaos & Fault Injection: 10MB ultra-large payload, malformed colors and entropy extremes", () => {
      // 1. 10MB ultra-large text
      const tenMbChunk = "A".repeat(1024 * 1024 * 10);
      const start = Date.now();
      const type = detectClipboardContentType(tenMbChunk);
      const entropy = calculateShannonEntropy(tenMbChunk);
      const masked = maskSensitiveContent(tenMbChunk);
      const duration = Date.now() - start;

      assert.equal(type, "text");
      assert.equal(entropy, 0); // single repeated character has 0 entropy
      assert.equal(masked.isSensitive, false);
      assert.ok(duration < 2000, `Large 10MB payload processed in ${duration}ms, must be < 2000ms`);

      // 2. Malformed color inputs
      assert.equal(parseColorDetails("#xyz"), null);
      assert.equal(parseColorDetails(""), null);
      assert.equal(parseColorDetails("rgb(256, 999)"), null);

      // 3. Empty and boundary queries
      assert.equal(filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "" }).length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "   " }).length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(filterClipboardItems([], { query: "test" }).length, 0);
    });
  });

  // =========================================================================
  // 7. Snippets: Dynamic Macro Engine, CRUD, Import/Export & Fault Injection
  // =========================================================================
  describe("Snippets: Dynamic Macro Engine, CRUD, Import/Export & Fault Injection", () => {
    test("Happy Path: dynamic macro replacement ({clipboard}, {date format}, {time}, {datetime}, {uuid}, {cursor}, {argument})", () => {
      const fixedDate = new Date(2026, 9, 13, 15, 30, 45); // 2026-10-13 15:30:45
      const ctx = {
        clipboard: "Hello Clipboard",
        now: fixedDate,
        args: { user: "Alice", project: "ZTools" }
      };

      // 1. {clipboard}
      const resClip = expandSnippetTemplate("Val: {clipboard}", "", ctx);
      assert.equal(resClip.expanded, "Val: Hello Clipboard");

      // 2. {date format=\"YYYY/MM/DD\"}
      const resDateFmt = expandSnippetTemplate("Date: {date format=\"YYYY/MM/DD\"}", "", ctx);
      assert.equal(resDateFmt.expanded, "Date: 2026/10/13");

      // 3. {time format=\"HH:mm\"}
      const resTimeFmt = expandSnippetTemplate("Time: {time format=\"HH:mm\"}", "", ctx);
      assert.equal(resTimeFmt.expanded, "Time: 15:30");

      // 4. {datetime}
      const resDateTime = expandSnippetTemplate("Stamp: {datetime}", "", ctx);
      assert.equal(resDateTime.expanded, "Stamp: 2026-10-13 15:30:45");

      // 5. {year}, {month}, {day}
      const resParts = expandSnippetTemplate("{year}-{month}-{day}", "", ctx);
      assert.equal(resParts.expanded, "2026-10-13");

      // 6. {uuid}
      const resUuid = expandSnippetTemplate("UUID: {uuid}", "", ctx);
      assert.match(resUuid.expanded, /UUID: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);

      // 7. {cursor}
      const resCursor = expandSnippetTemplate("const x = '{cursor}';", "", ctx);
      assert.equal(resCursor.expanded, "const x = '';");
      assert.equal(resCursor.cursorOffset, 2);
      assert.equal(resCursor.hasCursor, true);

      // 8. {argument name=\"user\"}
      const resArg = expandSnippetTemplate("Author: {argument name=\"user\"}, Project: {argument name=\"project\"}", "", ctx);
      assert.equal(resArg.expanded, "Author: Alice, Project: ZTools");
    });

    test("Batch Import & Export: JSON import, keyword deduplication and export roundtrip", async () => {
      const initialSnippets = await getSnippets();
      const exportJson = await exportSnippetsJSON(initialSnippets);
      assert.ok(exportJson.includes(":mail"));

      // Import valid snippets
      const batchData = [
        { name: "工作邮箱快速输入", keyword: ":mail", snippet: "updated@ztools.org" }, // should update
        { name: "新建宏短语", keyword: ":newmacro", snippet: "Welcome {date}" } // should insert
      ];

      const importRes = await importSnippetsJSON(batchData, initialSnippets);
      assert.equal(importRes.total, 2);
      assert.equal(importRes.updated, 1);
      assert.equal(importRes.imported, 1);
      assert.equal(importRes.failed, 0);

      const reloaded = await getSnippets();
      const updatedMail = reloaded.find(s => s.keyword === ":mail");
      assert.equal(updatedMail.snippet, "updated@ztools.org");

      const newSnippet = reloaded.find(s => s.keyword === ":newmacro");
      assert.ok(newSnippet);
    });

    test("Chaos & Fault Injection: 10MB template, malformed macro tags, and corrupted JSON import", async () => {
      // 1. 10MB ultra-large template with multiple macros
      const largeChunk = "Prefix ".repeat(100000) + "{date} Middle " + "{cursor} " + "Suffix ".repeat(100000);
      const start = Date.now();
      const largeRes = expandSnippetTemplate(largeChunk);
      const duration = Date.now() - start;

      assert.ok(largeRes.expanded.includes("Middle"));
      assert.equal(largeRes.hasCursor, true);
      assert.ok(largeRes.cursorOffset > 0);
      assert.ok(duration < 2500, `10MB template expanded in ${duration}ms, must be < 2500ms`);

      // 2. Malformed macro tags
      const unclosed = expandSnippetTemplate("Broken {date and {argument name= without end");
      assert.equal(unclosed.expanded, "Broken {date and {argument name= without end");

      // 3. Corrupted JSON import (Beyond Happy Path)
      const corruptedRes = await importSnippetsJSON("{ not valid json at all", []);
      assert.equal(corruptedRes.failed, 1);
      assert.ok(corruptedRes.errors && corruptedRes.errors.length > 0);

      // 4. Non-array JSON import
      const nonArrayRes = await importSnippetsJSON("{\"name\": \"single object\"}", []);
      assert.equal(nonArrayRes.failed, 1);

      // 5. Missing required fields in array
      const missingFieldsRes = await importSnippetsJSON([
        { name: "No keyword or snippet" },
        { keyword: ":nokeyword" }
      ], []);
      assert.equal(missingFieldsRes.failed, 2);
    });
  });

  // =========================================================================
  // 9. Declarative Component Tree Integration (Renderer Compatibility)
  // =========================================================================
  describe("Declarative Component Tree: Virtual Descriptors Rendering", () => {

    test("ClipboardHistoryCommand renders <List> with Dropdown and Items", () => {
      const vnode = ClipboardHistoryCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("ClipboardDetailView renders <Detail> with Metadata", () => {
      const vnode = ClipboardDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("SnippetsCommand renders <List> with Dropdown and Items", () => {
      const vnode = SnippetsCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarPlaceholder);
    });

    test("CreateSnippetForm renders <Form> with 4 primary fields", () => {
      const vnode = CreateSnippetForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.children.length, 4);
    });

    test("ImportSnippetsForm renders <Form> with TextArea", () => {
      const vnode = ImportSnippetsForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.children[0].type, "Form.TextArea");
    });

    test("SnippetDetailView renders <Detail> with Metadata", () => {
      const vnode = SnippetDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("WindowManagementCommand renders <List> with Dropdown and Action Sections", () => {
      const vnode = WindowManagementCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("WindowPreferencesForm renders <Form> with Dropdowns", () => {
      const vnode = WindowPreferencesForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.props.navigationTitle, "窗口管理偏好设置 (Window Preferences)");
    });

    test("WindowActionDetailView renders <Detail> with Metadata", () => {
      const vnode = WindowActionDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("SystemCommand renders <List> with Dropdown and Action Sections", () => {
      const vnode = SystemCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("QuicklinksCommand renders <List> with Sections and ActionPanel", () => {
      const vnode = QuicklinksCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarPlaceholder);
    });
  });
});
