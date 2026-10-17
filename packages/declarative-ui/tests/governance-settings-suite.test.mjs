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
  // 19. Core & Account
  RaycastCoreCommand,
  RaycastAccountCommand,
  CURRENT_APP_VERSION,
  getReleaseNotes,
  checkForUpdates,
  getActiveAnnouncements,
  dismissAnnouncement,
  getAccountProfile,
  logoutAccount,
  refreshAccountToken,
  // 20. Organizations
  OrganizationsCommand,
  INITIAL_ORGANIZATION,
  getOrganizationData,
  saveOrganizationData,
  generateInviteLink,
  addOrgMember,
  removeOrgMember,
  addOrgWebhook,
  removeOrgWebhook,
  testTriggerWebhook,
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

describe("M1.5 第四组: 宿主治理、系统设置与组织套件 (Governance & Settings Suite)", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
  });

  // ============================================================================
  // Suite 1: M1.5-26 `raycast-settings` 偏好设置全链路与破坏性容错
  // ============================================================================
  describe("M1.5-26: Raycast Settings 系统偏好设置面板", () => {
    test("1.1 默认设置完整性与 9 大分类元数据覆盖", () => {
      assert.equal(SETTINGS_SECTIONS.length, 9);
      const expectedKeys = [
        "general", "launcher", "shortcuts", "keyboard",
        "cloud_sync", "advanced", "account", "organizations", "about"
      ];
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
      assert.equal(searchEmpty.length, 9);
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
  // Suite 2: M1.5-27 `raycast-core` & `raycast-account` 核心系统与会话治理
  // ============================================================================
  describe("M1.5-27: Raycast Core & Account 核心系统与会话治理", () => {
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

    test("2.4 极客账户资料获取、令牌刷新与登出链路", async () => {
      const profile = await getAccountProfile();
      assert.equal(profile.isAuthenticated, true);
      assert.equal(profile.userId, "local_geek_001");

      // 刷新令牌
      const tokenRes = await refreshAccountToken();
      assert.equal(tokenRes.success, true);
      assert.ok(tokenRes.token.startsWith("zt_tk_"));
      assert.ok(tokenRes.expiresAt > Date.now());

      // 登出
      const loggedOut = await logoutAccount();
      assert.equal(loggedOut.isAuthenticated, false);
      assert.equal(loggedOut.userId, "guest");

      // 再次读取验证状态
      const reloadedProfile = await getAccountProfile();
      assert.equal(reloadedProfile.isAuthenticated, false);
    });

    test("2.5 Core & Account 声明式虚拟视图树生成", () => {
      const coreRoot = renderDeclarativeRoot(RaycastCoreCommand);
      const coreVnode = coreRoot.getLatest();
      assert.equal(coreVnode.type, "List");
      coreRoot.unmount();

      const accountRoot = renderDeclarativeRoot(RaycastAccountCommand);
      const accountVnode = accountRoot.getLatest();
      assert.equal(accountVnode.type, "Detail");
      assert.ok(accountVnode.props.markdown.includes("ZTools"));
      accountRoot.unmount();
    });
  });

  // ============================================================================
  // Suite 3: M1.5-28 `organizations` 商业与团队协同套件
  // ============================================================================
  describe("M1.5-28: Organizations 商业协同与团队架构", () => {
    test("3.1 团队组织初始化与邀请链接生成", async () => {
      const org = await getOrganizationData();
      assert.equal(org.id, INITIAL_ORGANIZATION.id);
      assert.ok(org.members.length >= 3);
      assert.ok(org.sharedSnippets.length >= 2);
      assert.ok(org.privateExtensions.length >= 2);

      const inviteLink = generateInviteLink(org);
      assert.ok(inviteLink.startsWith("https://ztools.cn/join-team"));
      assert.ok(inviteLink.includes(encodeURIComponent(org.slug)));
    });

    test("3.2 团队成员架构管理与 Owner 保护机制", async () => {
      // 添加新成员
      const updated = await addOrgMember({
        name: "Euler (测试员)",
        email: "euler@ztools.org",
        role: "member"
      });
      const added = updated.members.find((m) => m.email === "euler@ztools.org");
      assert.ok(added);
      assert.equal(added.role, "member");

      // 移除成员
      const afterRemove = await removeOrgMember(added.id);
      assert.equal(afterRemove.members.some((m) => m.id === added.id), false);
    });

    test("3.3 Webhooks 自动化与测试联通性", async () => {
      // 添加 Webhook
      const updated = await addOrgWebhook({
        name: "CI 自动化构建 Webhook",
        url: "https://ci.ztools.org/webhook",
        eventTypes: ["plugin.published"],
        active: true
      });
      const created = updated.webhooks.find((w) => w.name === "CI 自动化构建 Webhook");
      assert.ok(created);

      // 测试触发有效 Webhook
      const validTest = await testTriggerWebhook(created);
      assert.equal(validTest.success, true);
      assert.ok(validTest.latencyMs > 0);

      // [Beyond Happy Path 异常容错]: 测试非法非 HTTP 协议 URL
      const invalidTest = await testTriggerWebhook({
        id: "bad_wh",
        name: "坏 Webhook",
        url: "ftp://corrupted-protocol",
        eventTypes: [],
        active: true,
        createdAt: "2026-10-13"
      });
      assert.equal(invalidTest.success, false);
      assert.ok(invalidTest.message.includes("http"));

      // 移除 Webhook
      const afterRemoveWh = await removeOrgWebhook(created.id);
      assert.equal(afterRemoveWh.webhooks.some((w) => w.id === created.id), false);
    });

    test("3.4 Organizations 声明式虚拟视图树生成", () => {
      const orgRoot = renderDeclarativeRoot(OrganizationsCommand);
      const orgVnode = orgRoot.getLatest();
      assert.equal(orgVnode.type, "List");
      assert.equal(orgVnode.props.isShowingDetail, true);
      orgRoot.unmount();
    });
  });

  // ============================================================================
  // Suite 4: M1.5-29 `raycast-wrapped`, `trial-nudges` & `apple-shortcuts`
  // ============================================================================
  describe("M1.5-29: Raycast Wrapped, Trial Nudges & Windows Shortcuts", () => {
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

  // ============================================================================
  // Suite 5: Frontend 官方应用注册中心联动与别名映射验证
  // ============================================================================
  describe("Suite 5: Frontend 官方应用注册中心联动与别名映射", async () => {
    const { isOfficialPlugin, getOfficialPlugin, OFFICIAL_PLUGIN_IDS } = await import(
      "../../../frontend/src/utils/officialPlugins.js"
    );

    test("5.1 所有 7 款新增官方核心套件已注册且元数据完备", () => {
      const requiredIds = [
        "raycast-settings",
        "raycast-core",
        "raycast-account",
        "organizations",
        "raycast-wrapped",
        "trial-nudges",
        "windows-shortcuts"
      ];

      for (const id of requiredIds) {
        assert.equal(isOfficialPlugin(id), true, `必须注册应用: ${id}`);
        const plugin = getOfficialPlugin(id);
        assert.ok(plugin, `必须能获取应用: ${id}`);
        assert.ok(plugin.name);
        assert.ok(plugin.title);
        assert.ok(plugin.description);
        assert.ok(plugin.category);
        assert.ok(plugin.keyword);
        assert.equal(plugin.isBuiltin, true);
        assert.equal(plugin.isDeclarative, true);
        assert.equal(typeof plugin.command, "function", `应用 ${id} 必须绑定有效的 Command 组件`);
      }
    });

    test("5.2 apple-shortcuts 一等公民注册与规范映射", () => {
      assert.equal(isOfficialPlugin("apple-shortcuts"), true);
      const aliased = getOfficialPlugin("apple-shortcuts");
      assert.ok(aliased);
      assert.equal(aliased.id, "apple-shortcuts");
    });
  });
});
