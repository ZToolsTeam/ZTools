import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 18. Settings
  SettingsCommand,
  SettingsFormView,
  DEFAULT_PREFERENCES,
  SETTINGS_SECTIONS,
  getPreferences,
  savePreferences,
  updatePreferenceSection,
  resetPreferences,
  sanitizePreferences,
  exportPreferencesJson,
  importPreferencesJson,
  filterSettingsSections,
  // 19. Core（账户与团队协同演示已整体删除，只保留更新检查、更新日志与公告）
  RaycastCoreCommand,
  CURRENT_APP_VERSION,
  getReleaseNotes,
  checkForUpdates,
  getActiveAnnouncements,
  dismissAnnouncement,
  // 21. Wrapped, Nudges & Shortcuts
  RaycastWrappedCommand,
  TrialNudgesCommand,
  WindowsShortcutsCommand,
  calculateWrappedStats,
  FEATURE_NUDGES,
  DEFAULT_WINDOWS_SHORTCUTS,
  getWindowsShortcuts,
  executeWindowsShortcut
} from "../dist/index.js";

describe("第四组: 宿主治理与系统设置套件 (Governance & Settings Suite)", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
  });

  // ============================================================================
  // Suite 1: `raycast-settings` 偏好设置全链路与破坏性容错
  // ============================================================================
  describe("Raycast Settings 系统偏好设置面板", () => {
    test("1.1 默认设置完整性与 8 个分类元数据覆盖（账户与团队协同分区已移除）", () => {
      assert.equal(SETTINGS_SECTIONS.length, 8);
      const expectedKeys = [
        "general", "launcher", "shortcuts", "keyboard",
        "cloud_sync", "advanced", "ai", "about"
      ];
      for (const removed of ["account", "organizations"]) {
        assert.equal(SETTINGS_SECTIONS.some((s) => s.key === removed), false, `不应再有设置分区: ${removed}`);
        assert.equal(removed in DEFAULT_PREFERENCES, false, `默认设置不应再有 ${removed}`);
      }
      assert.equal(DEFAULT_PREFERENCES.ai.ollamaEndpoint, "http://127.0.0.1:11434");
      assert.equal(DEFAULT_PREFERENCES.ai.lmStudioEndpoint, "http://127.0.0.1:1234");
      for (const k of expectedKeys) {
        const found = SETTINGS_SECTIONS.find((s) => s.key === k);
        assert.ok(found, `必须包含设置分区: ${k}`);
        assert.ok(found.title.length > 0);
        assert.ok(found.keywords.length >= 3);
      }

      assert.equal(DEFAULT_PREFERENCES.general.theme, "auto");
      assert.equal(DEFAULT_PREFERENCES.general.windowMode, "compact");
      assert.equal(DEFAULT_PREFERENCES.launcher.sortAlgorithm, "frecency");
      assert.equal(DEFAULT_PREFERENCES.cloudSync.e2eeEnabled, true);
    });

    test("1.2 偏好设置读写与局部字段更新链路", async () => {
      // 初始读取应为默认配置
      const initial = await getPreferences();
      assert.equal(initial.general.theme, "auto");

      // 局部更新 general.theme 与 launcher.maxHistoryItems
      const updated = await updatePreferenceSection("general", { theme: "dark" });
      assert.equal(updated.general.theme, "dark");

      // 再次读取验证持久化
      const reloaded = await getPreferences();
      assert.equal(reloaded.general.theme, "dark");

      // 重置回出厂默认
      const reset = await resetPreferences();
      assert.equal(reset.general.theme, "auto");
    });

    test("1.3 [Beyond Happy Path 破坏性容错] 畸形数据清洗与极值边界拦截", () => {
      // 1. 传入 null / undefined / 非对象
      const fromNull = sanitizePreferences(null);
      assert.deepEqual(fromNull, DEFAULT_PREFERENCES);

      const fromString = sanitizePreferences("CORRUPTED_STRING_PAYLOAD");
      assert.deepEqual(fromString, DEFAULT_PREFERENCES);

      // 2. 恶意枚举注入测试 (SQLi / XSS / 非法枚举)
      const corruptedEnum = sanitizePreferences({
        general: { theme: "<script>alert(1)</script>" },
        launcher: { sortAlgorithm: "DROP TABLE users;" },
        advanced: { proxyMode: "HACKER_PROXY_INJECTION" }
      });
      assert.equal(corruptedEnum.general.theme, "auto", "非法主题枚举必须安全回退");
      assert.equal(corruptedEnum.launcher.sortAlgorithm, "frecency", "非法排序枚举必须安全回退");
      assert.equal(corruptedEnum.advanced.proxyMode, "system", "非法代理枚举必须安全回退");

      // 3. 边界极值溢出与负数测试
      const overflowValues = sanitizePreferences({
        launcher: {
          maxHistoryItems: -9999, // 负数
          searchSensitivity: 9999 // 超过 100
        },
        cloudSync: {
          autoSyncIntervalMinutes: -10 // 负数周期
        }
      });
      assert.equal(overflowValues.launcher.maxHistoryItems, 50, "负数历史条数应保留安全默认");
      assert.equal(overflowValues.launcher.searchSensitivity, 80, "溢出灵敏度应保留安全默认");
      assert.equal(overflowValues.cloudSync.autoSyncIntervalMinutes, 30, "负数同步间隔应保留安全默认");

      // 4. 畸形 shortcuts 数组过滤 (丢弃缺少 id 或 name 的残缺条目)
      const corruptedShortcuts = sanitizePreferences({
        shortcuts: [
          null,
          { id: "valid_1", name: "有效热键", commandId: "cmd_1" },
          { id: 123 }, // 缺少 name
          "invalid string item"
        ]
      });
      assert.equal(corruptedShortcuts.shortcuts.length, 1);
      assert.equal(corruptedShortcuts.shortcuts[0].id, "valid_1");
    });

    test("1.4 配置导出、损坏 JSON 导入拦截与恢复", async () => {
      const exportedJson = await exportPreferencesJson();
      assert.ok(exportedJson.includes('"theme": "auto"'));

      // 尝试导入完全损坏的 JSON 文本
      const failRes = await importPreferencesJson("{ invalid_json_syntax: ### }");
      assert.equal(failRes.success, false);
      assert.ok(failRes.error, "损坏 JSON 必须明确返回错误信息");

      // 导入空内容拦截
      const emptyRes = await importPreferencesJson("");
      assert.equal(emptyRes.success, false);

      // 导入合法自定义配置
      const customConfig = JSON.stringify({
        general: { theme: "light", windowMode: "expanded" }
      });
      const successRes = await importPreferencesJson(customConfig);
      assert.equal(successRes.success, true);
      assert.equal(successRes.preferences.general.theme, "light");
      assert.equal(successRes.preferences.general.windowMode, "expanded");
    });

    test("1.5 中英文模糊与拼音检索过滤", () => {
      const searchTheme = filterSettingsSections("theme");
      assert.ok(searchTheme.some((s) => s.key === "general"));

      const searchChinese = filterSettingsSections("代理");
      assert.ok(searchChinese.some((s) => s.key === "advanced"));

      const searchWebdav = filterSettingsSections("webdav");
      assert.ok(searchWebdav.some((s) => s.key === "cloud_sync"));

      const searchEmpty = filterSettingsSections("");
      assert.equal(searchEmpty.length, 8);

      const searchOllama = filterSettingsSections("ollama");
      assert.deepEqual(searchOllama.map((s) => s.key), ["ai"]);
      // 已移除的账户、团队分区搜不到
      assert.equal(filterSettingsSections("organizations").length, 0);
      assert.equal(filterSettingsSections("团队").length, 0);
    });

    test("1.5b [破坏性] 旧版本配置里的账户、团队字段与已下线扩展被丢弃，内置扩展文案以当前清单为准", async () => {
      const legacy = {
        account: { userId: "u1", plan: "team_enterprise", byokOpenAiKey: "sk-should-not-persist", ollamaEndpoint: "http://10.0.0.1:11434" },
        organizations: { currentOrgId: "org_x", orgName: "某团队", enableTeamSnippets: true },
        extensions: [
          { id: "organizations", name: "团队协同 (Organizations)", enabled: true, isBuiltin: true },
          { id: "core-account", name: "极客账户 (Core & Account)", description: "旧文案", enabled: false, alias: " acc ", isBuiltin: true },
          { id: "core-account", name: "重复条目", enabled: true, isBuiltin: true },
          { id: "my-ext", name: "自定义扩展", description: "用户自己的", enabled: true, isBuiltin: false }
        ]
      };
      const clean = sanitizePreferences(legacy);
      assert.equal("account" in clean, false);
      assert.equal("organizations" in clean, false);
      assert.equal(JSON.stringify(clean).includes("sk-should-not-persist"), false, "旧 account 里的密钥不能被带进新配置");
      // 旧 account 里的地址不迁移，AI 地址保持默认
      assert.equal(clean.ai.ollamaEndpoint, DEFAULT_PREFERENCES.ai.ollamaEndpoint);

      const ids = clean.extensions.map((e) => e.id);
      assert.equal(ids.includes("organizations"), false, "已下线的团队协同不再显示");
      assert.equal(ids.filter((id) => id === "core-account").length, 1, "重复条目只保留第一条");
      const core = clean.extensions.find((e) => e.id === "core-account");
      assert.equal(core.name, "更新与版本公告 (Release Notes)", "内置扩展名称以当前清单为准");
      assert.equal(core.enabled, false, "用户的启用状态保留");
      assert.equal(core.alias, "acc", "用户的别名保留");
      const custom = clean.extensions.find((e) => e.id === "my-ext");
      assert.equal(custom.name, "自定义扩展", "非内置扩展保留自己的名称");
      assert.equal(custom.isBuiltin, false);
      assert.equal(JSON.stringify(clean).includes("团队协同"), false);
      assert.equal(JSON.stringify(clean).includes("极客账户"), false);

      // 存盘再读取，结果一致
      await LocalStorage.setItem("ztools_global_preferences_v1", JSON.stringify(legacy));
      const loaded = await getPreferences();
      assert.deepEqual(loaded, clean);
    });

    test("1.5c [破坏性] AI 本地模型地址校验：非 http(s)、带账号密码、畸形与超长地址回落默认", () => {
      const ok = sanitizePreferences({ ai: { ollamaEndpoint: " http://192.168.1.5:11434/ ", lmStudioEndpoint: "https://lm.local:1234/v1/" } });
      assert.equal(ok.ai.ollamaEndpoint, "http://192.168.1.5:11434");
      assert.equal(ok.ai.lmStudioEndpoint, "https://lm.local:1234/v1");

      for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://user:pass@127.0.0.1:11434", "not a url", 12345, null, "http://" + "a".repeat(3000)]) {
        const res = sanitizePreferences({ ai: { ollamaEndpoint: bad, lmStudioEndpoint: bad } });
        assert.equal(res.ai.ollamaEndpoint, DEFAULT_PREFERENCES.ai.ollamaEndpoint, `非法地址 ${String(bad).slice(0, 40)} 必须回落默认`);
        assert.equal(res.ai.lmStudioEndpoint, DEFAULT_PREFERENCES.ai.lmStudioEndpoint);
      }
      // ai 不是对象时整体保持默认
      for (const bad of ["x", [], 1]) {
        assert.deepEqual(sanitizePreferences({ ai: bad }).ai, DEFAULT_PREFERENCES.ai);
      }
    });

    test("1.6 Settings 声明式虚拟视图树生成", () => {
      const root = renderDeclarativeRoot(SettingsCommand);
      const vnode = root.getLatest();
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(Array.isArray(vnode.children));
      root.unmount();
    });
  });

  // ============================================================================
  // Suite 2: `raycast-core` 核心系统（更新检查与版本公告）
  // ============================================================================
  describe("Raycast Core 核心系统与版本公告", () => {
    test("2.1 Release Notes 历史记录与当前版本一致性", () => {
      const notes = getReleaseNotes();
      assert.ok(notes.length >= 2);
      const current = notes.find((n) => n.isCurrentVersion);
      assert.ok(current, "必须存在当前版本标记");
      assert.equal(current.version, CURRENT_APP_VERSION);
      assert.ok(current.highlights.length >= 3);
      assert.ok(current.markdownNotes.includes("ZTools"));
    });

    test("2.2 更新检测接口与降级防御", async () => {
      const checkRes = await checkForUpdates();
      assert.equal(checkRes.currentVersion, CURRENT_APP_VERSION);
      assert.equal(typeof checkRes.hasUpdate, "boolean");
    });

    test("2.3 系统公告获取、忽略标记与持久化", async () => {
      const anns = await getActiveAnnouncements();
      assert.ok(anns.length >= 2);

      const targetId = anns[0].id;
      await dismissAnnouncement(targetId);

      const afterDismiss = await getActiveAnnouncements();
      assert.equal(afterDismiss.some((a) => a.id === targetId), false, "被忽略的公告不应再次出现");

      // [Beyond Happy Path 异常容错]: 重复忽略不存在的 ID 不应报错
      await dismissAnnouncement("non_existent_announcement_id_999");
    });

    test("2.4 Core 声明式虚拟视图树生成", () => {
      const coreRoot = renderDeclarativeRoot(RaycastCoreCommand);
      const coreVnode = coreRoot.getLatest();
      assert.equal(coreVnode.type, "List");
      coreRoot.unmount();
    });
  });

  // ============================================================================
  // Suite 4: `raycast-wrapped`, `trial-nudges` & `apple-shortcuts`
  // ============================================================================
  describe("Raycast Wrapped, Trial Nudges & Windows Shortcuts", () => {
    test("4.1 极客年度使用报告统计计算", async () => {
      const stats = await calculateWrappedStats(2026);
      assert.equal(stats.year, 2026);
      assert.ok(stats.totalLaunches >= 100);
      assert.ok(stats.timeSavedMinutes > 0);
      assert.equal(stats.topExtensions.length, 5);
      assert.ok(stats.topShortcuts.length >= 3);
      assert.ok(["Apprentice", "Specialist", "Master", "Grandmaster", "Legendary"].includes(stats.geekMasteryTier));
    });

    test("4.2 [Beyond Happy Path 破坏性容错] Wrapped 本地数据被篡改清洗", async () => {
      // 写入被恶意篡改的非数字或越界数据
      await LocalStorage.setItem("ztools_wrapped_stats_v1_2026", JSON.stringify({
        year: "invalid_year_string",
        totalLaunches: -500,
        timeSavedMinutes: NaN,
        geekMasteryTier: "HACKER_TIER_OVERFLOW"
      }));

      const sanitized = await calculateWrappedStats(2026);
      assert.equal(sanitized.year, 2026);
      assert.equal(sanitized.totalLaunches, 100, "负数启动次数安全清洗");
      assert.equal(sanitized.geekMasteryTier, "Master", "非法段位安全清洗为默认 Master");
    });

    test("4.3 核心技术方案 (Trial Nudges) 特权元数据覆盖", () => {
      assert.ok(FEATURE_NUDGES.length >= 4);
      const keys = FEATURE_NUDGES.map((f) => f.featureKey);
      assert.ok(keys.includes("mft_indexer"), "必须包含 MFT 硬件极速索引");
      assert.ok(keys.includes("uiaccess_penetration"), "必须包含 UIAccess 特权穿透");
      assert.ok(keys.includes("e2ee_cloud_sync"), "必须包含 E2EE 加密同步");
      assert.ok(keys.includes("byok_local_ai"), "必须包含 BYOK 自由原则");
    });

    test("4.4 Windows 自动化快捷指令获取与执行调度", async () => {
      const shortcuts = await getWindowsShortcuts();
      assert.ok(shortcuts.length >= 4);

      const flushDns = shortcuts.find((s) => s.id === "ws_flush_dns");
      assert.ok(flushDns);
      assert.equal(flushDns.commandType, "powershell");

      // 执行测试
      const execResult = await executeWindowsShortcut(flushDns);
      assert.equal(execResult.success, true);
      assert.ok(execResult.message.length > 0);

      // [Beyond Happy Path 异常容错]: 执行空指令脚本拦截
      const badResult = await executeWindowsShortcut({
        id: "bad_cmd",
        name: "空指令",
        description: "",
        commandType: "cmd",
        commandScript: "",
        category: "system",
        iconName: "terminal"
      });
      assert.equal(badResult.success, false);
      assert.ok(badResult.message.includes("空"));
    });

    test("4.5 Wrapped, Nudges & Shortcuts 声明式虚拟视图树生成", () => {
      const wrappedRoot = renderDeclarativeRoot(RaycastWrappedCommand);
      const wrappedVnode = wrappedRoot.getLatest();
      assert.equal(wrappedVnode.type, "Detail");
      wrappedRoot.unmount();

      const nudgesRoot = renderDeclarativeRoot(TrialNudgesCommand);
      const nudgesVnode = nudgesRoot.getLatest();
      assert.equal(nudgesVnode.type, "List");
      nudgesRoot.unmount();

      const shortcutsRoot = renderDeclarativeRoot(WindowsShortcutsCommand);
      const shortcutsVnode = shortcutsRoot.getLatest();
      assert.equal(shortcutsVnode.type, "List");
      shortcutsRoot.unmount();
    });
  });
});
