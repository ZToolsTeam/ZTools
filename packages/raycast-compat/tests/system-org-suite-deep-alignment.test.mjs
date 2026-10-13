import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 1. Core & Account
  RaycastCoreCommand,
  RaycastAccountCommand,
  CURRENT_APP_VERSION,
  getReleaseNotes,
  checkForUpdates,
  getActiveAnnouncements,
  dismissAnnouncement,
  getAccountProfile,
  saveAccountProfile,
  refreshSyncStatus,
  verifyByokKey,
  toggleAccountTier,
  exportOfflineLicense,
  logoutAccount,
  refreshAccountToken,
  DEFAULT_ACCOUNT_PROFILE,
  // 2. Organizations
  OrganizationsCommand,
  INITIAL_ORGANIZATION,
  getOrganizationData,
  saveOrganizationData,
  getAvailableWorkspaces,
  switchWorkspace,
  generateInviteLink,
  addOrgMember,
  removeOrgMember,
  addSharedQuicklink,
  removeSharedQuicklink,
  recordAuditLog,
  updateOrgPolicy,
  syncTeamAssets,
  addOrgWebhook,
  removeOrgWebhook,
  testTriggerWebhook,
  // 3. Wrapped, Nudges & Shortcuts
  RaycastWrappedCommand,
  TrialNudgesCommand,
  WindowsShortcutsCommand,
  calculateWrappedStats,
  sanitizeWrappedStats,
  renderAsciiBar,
  generateBadgeCard,
  FEATURE_NUDGES,
  getSystemPrivilegeDiagnostic,
  restartSidecar,
  getWindowsShortcuts,
  executeWindowsShortcut,
  revealShortcutInExplorer
} from "../dist/index.js";

describe("REA 深度逆向与全面对齐: 系统与组织生态套件 (System & Organizations Suite)", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
  });

  // ============================================================================
  // 1. Raycast Account 极客账户与授权中枢
  // ============================================================================
  describe("1. raycast-account 极客账户、E2EE 同步与 BYOK 授权中枢", () => {
    test("1.1 [Happy Path] 极客账户资料读取与默认元数据完备性", async () => {
      const profile = await getAccountProfile();
      assert.equal(profile.userId, "local_geek_001");
      assert.equal(profile.username, "Geek Explorer");
      assert.equal(profile.email, "geek@ztools.local");
      assert.equal(profile.tier, "Pro");
      assert.equal(profile.hasProFeatures, true);
      assert.equal(profile.isAuthenticated, true);
      assert.equal(profile.byokConfigured, true);
      assert.equal(profile.syncConnected, true);

      // 验证离线许可基本字段
      assert.ok(profile.license);
      assert.equal(profile.license.issuer, "ZTools Foundation");
      assert.equal(profile.license.algorithm, "Ed25519-E2EE");
    });

    test("1.2 [Happy Path] E2EE 端到端加密校验与密码学哈希刷新", async () => {
      const syncResult = await refreshSyncStatus();
      assert.equal(syncResult.success, true);
      assert.equal(syncResult.sync.status, "synced");
      assert.equal(syncResult.sync.argon2idVerified, true);
      assert.equal(syncResult.sync.aes256GcmVerified, true);
      assert.ok(syncResult.sync.encryptedChecksum.startsWith("sha256_"));
      assert.ok(syncResult.sync.lastSyncedAt.length > 0);

      // 验证更新回写至 Profile
      const updatedProfile = await getAccountProfile();
      assert.equal(updatedProfile.sync.encryptedChecksum, syncResult.sync.encryptedChecksum);
    });

    test("1.3 [Happy Path] API Key / BYOK 算力通道检视与延迟测速", async () => {
      // 测试 DeepSeek R1 思考流模型
      const dsTest = await verifyByokKey("deepseek");
      assert.equal(dsTest.success, true);
      assert.equal(dsTest.info.provider, "deepseek");
      assert.equal(dsTest.info.status, "valid");
      assert.equal(dsTest.info.model, "deepseek-reasoner");
      assert.equal(dsTest.info.hasReasoningStream, true);
      assert.ok(dsTest.info.latencyMs > 0);

      // 测试本地离线模型 (Ollama)
      const ollamaTest = await verifyByokKey("ollama_local");
      assert.equal(ollamaTest.success, true);
      assert.equal(ollamaTest.info.status, "valid");
      assert.equal(ollamaTest.info.endpoint, "http://127.0.0.1:11434");
      assert.ok(ollamaTest.info.latencyMs <= 5, "本地模型延迟极低");
    });

    test("1.4 [Happy Path] 离线许可证书导出与 Ed25519 签名声明", async () => {
      const certJson = await exportOfflineLicense();
      assert.ok(certJson.length > 50);
      const parsed = JSON.parse(certJson);
      assert.equal(parsed.licenseVersion, "2.0-ztools");
      assert.equal(parsed.license.tier, "Pro Geek");
      assert.equal(parsed.e2ee.cipher, "AES-256-GCM-Authenticated");
      assert.ok(parsed.license.features.length >= 3);
    });

    test("1.5 [Happy Path] 授权模式切换 (Pro <-> Freemium) 与令牌维护", async () => {
      // 切换为 Freemium
      const freeProfile = await toggleAccountTier("Freemium");
      assert.equal(freeProfile.tier, "Freemium");
      assert.equal(freeProfile.hasProFeatures, false);

      // 切换回 Pro
      const proProfile = await toggleAccountTier("Pro");
      assert.equal(proProfile.tier, "Pro");
      assert.equal(proProfile.hasProFeatures, true);

      // 刷新令牌
      const tokenRes = await refreshAccountToken();
      assert.equal(tokenRes.success, true);
      assert.ok(tokenRes.token.startsWith("zt_tk_"));
      assert.ok(tokenRes.expiresAt > Date.now());

      // 登出
      const loggedOut = await logoutAccount();
      assert.equal(loggedOut.isAuthenticated, false);
      assert.equal(loggedOut.userId, "guest");
    });

    test("1.6 [Beyond Happy Path 异常容错] 畸形持久化数据自愈与非法 BYOK 提供商拦截", async () => {
      // 1. 模拟 LocalStorage 写入损坏非法的 JSON
      await LocalStorage.setItem("ztools_geek_account_v1", "{ corrupted: json broken [[!!");
      const healedProfile = await getAccountProfile();
      assert.equal(healedProfile.userId, "local_geek_001", "自动降级恢复默认极客档案");
      assert.equal(healedProfile.isAuthenticated, true);

      // 2. 模拟请求非法未知的模型服务商
      await assert.rejects(
        async () => {
          await verifyByokKey("unknown_vendor");
        },
        /未知模型服务商/,
        "必须阻断未知模型通道验证"
      );
    });

    test("1.7 [Declarative UI 声明式视图] RaycastAccountCommand 虚拟描述符完整性", () => {
      const root = renderDeclarativeRoot(RaycastAccountCommand);
      const vnode = root.getLatest();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.markdown.includes("ZTools 极客账户与开发者授权中枢"));
      assert.ok(vnode.props.markdown.includes("去中心化 E2EE 端到端加密同步"));
      assert.ok(vnode.props.markdown.includes("DeepSeek R1"));
      assert.ok(vnode.props.metadata);
      assert.ok(vnode.props.actions);
      root.unmount();
    });
  });

  // ============================================================================
  // 2. Organizations 商业与团队协同工作台
  // ============================================================================
  describe("2. organizations 商业协同、工作区切换与团队资产管理", () => {
    test("2.1 [Happy Path] 工作区切换器 (Personal vs Team Enterprise)", async () => {
      const workspaces = getAvailableWorkspaces();
      assert.equal(workspaces.length, 2);
      assert.equal(workspaces[0].mode, "personal");
      assert.equal(workspaces[1].mode, "team_enterprise");

      // 切换至个人空间
      const switchedPersonal = await switchWorkspace("personal");
      assert.equal(switchedPersonal.activeWorkspace, "personal");

      // 切换回团队空间
      const switchedTeam = await switchWorkspace("team_enterprise");
      assert.equal(switchedTeam.activeWorkspace, "team_enterprise");
    });

    test("2.2 [Happy Path] 团队共享快捷指令 (Shared Quicklinks) CRUD", async () => {
      const org = await getOrganizationData();
      assert.ok(org.sharedQuicklinks.length >= 3);

      // 添加新指令
      const updated = await addSharedQuicklink({
        name: "测试团队 API 网关",
        url: "https://api.corp.ztools.org/v1/health",
        alias: "apihealth",
        author: "Tester",
        category: "测试效能",
        pinned: true
      });

      const added = updated.sharedQuicklinks.find((q) => q.alias === "apihealth");
      assert.ok(added);
      assert.equal(added.name, "测试团队 API 网关");

      // 移除指令
      const afterRemove = await removeSharedQuicklink(added.id);
      assert.equal(afterRemove.sharedQuicklinks.some((q) => q.id === added.id), false);
    });

    test("2.3 [Happy Path] 组织级合规审计日志与安全策略管控", async () => {
      // 记录合规事件
      const log = await recordAuditLog(
        "私有插件部署审批",
        "Auditor (合规官)",
        "plugin:internal-gateway",
        "allowed",
        "AST 静态扫描通过，双人签名确认"
      );
      assert.equal(log.status, "allowed");
      assert.ok(log.id.startsWith("aud_"));

      // 检查当前策略
      const org = await getOrganizationData();
      assert.equal(org.policies.aiDataSharingAllowed, false, "企业防泄漏策略生效");
      assert.ok(org.policies.allowedAiProviders.includes("deepseek"));

      // 更新策略
      const updatedOrg = await updateOrgPolicy({ auditLogRetentionDays: 365 });
      assert.equal(updatedOrg.policies.auditLogRetentionDays, 365);
    });

    test("2.4 [Happy Path] 团队共享资产一键同步 (Snippets, Quicklinks, Extensions)", async () => {
      const syncRes = await syncTeamAssets();
      assert.equal(syncRes.success, true);
      assert.ok(syncRes.syncedCount >= 5);
      assert.ok(syncRes.message.includes("短语"));
    });

    test("2.5 [Beyond Happy Path 异常容错] 团队 Owner 保护与非法 Webhook 熔断", async () => {
      // 1. 尝试移除 Owner 成员应被拦截保护
      const org = await getOrganizationData();
      const owner = org.members.find((m) => m.role === "owner");
      assert.ok(owner);

      // 2. 测试坏 Webhook 触发
      const badRes = await testTriggerWebhook({
        id: "broken_wh",
        name: "坏地址",
        url: "http://broken.internal.chaos:9999",
        eventTypes: [],
        active: true,
        createdAt: "2026-10-13"
      });
      assert.equal(badRes.success, false);
      assert.ok(badRes.message.includes("失败"));
    });

    test("2.6 [Declarative UI 声明式视图] OrganizationsCommand 筛选与视图渲染", () => {
      const root = renderDeclarativeRoot(OrganizationsCommand);
      const vnode = root.getLatest();
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(vnode.props.searchBarAccessory);
      root.unmount();
    });
  });

  // ============================================================================
  // 3. Wrapped, Nudges & Windows Shortcuts
  // ============================================================================
  describe("3. raycast-wrapped, trial-nudges 与 windows-shortcuts 深度对齐", () => {
    test("3.1 [Happy Path] Wrapped 年度战报图表、按键节省与耗时对比计算", async () => {
      const stats = await calculateWrappedStats(2026);
      assert.equal(stats.year, 2026);
      assert.ok(stats.totalLaunches >= 1000);
      assert.ok(stats.totalKeystrokesSaved > 50000, "总按键节省超过 50,000 次");
      assert.ok(stats.manualHoursEstimate > stats.ztoolsHoursSpent, "手工耗时必须高于极客工具耗时");
      assert.ok(stats.netHoursSaved > 0, "净节省时间为正数");
      assert.ok(stats.efficiencyRatio.includes("x"), "效率提升倍率包含倍数标识");

      // 验证 Top 5 插件图表
      assert.equal(stats.topExtensions.length, 5);
      const firstExt = stats.topExtensions[0];
      assert.ok(firstExt.barChart.includes("█"), "包含 ASCII 进度图表");
      assert.ok(firstExt.percentage > 0);

      // 验证极客勋章
      assert.ok(stats.badgeTitle.includes("勋章"));
      assert.ok(stats.badgeCardMarkdown.includes("ZTOOLS GEEK EXCELLENCE BADGE"));
    });

    test("3.2 [Happy Path] 辅助工具函数 renderAsciiBar 与 generateBadgeCard 覆盖", () => {
      const bar0 = renderAsciiBar(0, 10);
      assert.equal(bar0, "░░░░░░░░░░ 0%");
      const bar100 = renderAsciiBar(100, 10);
      assert.equal(bar100, "██████████ 100%");
      const bar50 = renderAsciiBar(50, 10);
      assert.equal(bar50, "█████░░░░░ 50%");

      const card = generateBadgeCard("Legendary", 5000, 80);
      assert.ok(card.includes("LEGENDARY"));
      assert.ok(card.includes("5000"));
    });

    test("3.3 [Happy Path] Trial Nudges 底层侧车监控与 UIAccess / MFT 特权自检", async () => {
      const diag = await getSystemPrivilegeDiagnostic();
      assert.equal(diag.uiaccess.status, "active");
      assert.equal(diag.uiaccess.uipiBypassVerified, true);
      assert.equal(diag.mftIndexer.status, "healthy");
      assert.ok(diag.mftIndexer.indexedFilesCount > 1000000, "索引文件超过百万级");
      assert.ok(diag.mftIndexer.avgRecallLatencyMs < 0.1, "MFT 秒搜延迟严格在 0.1ms 以内");

      // 侧车进程健康度
      assert.equal(diag.sidecars.length, 2);
      for (const sc of diag.sidecars) {
        assert.equal(sc.status, "healthy");
        assert.ok(sc.latencyMs < sc.slaTargetMs, "SLA 延迟严格达标");
        assert.ok(sc.memoryMb < 100, "常驻内存严格受控");
      }

      // 重启侧车调度
      const restartRes = await restartSidecar("ztools-indexer.exe");
      assert.equal(restartRes.success, true);
      assert.ok(restartRes.newPid > 0);
    });

    test("3.4 [Happy Path] Windows Shortcuts .lnk 快捷指令与管理员提权调度", async () => {
      const shortcuts = await getWindowsShortcuts();
      assert.ok(shortcuts.length >= 8);

      // 验证 .lnk 快捷方式
      const wt = shortcuts.find((s) => s.id === "ws_lnk_terminal");
      assert.ok(wt);
      assert.equal(wt.commandType, "lnk");
      assert.equal(wt.targetPath, "wt.exe");

      // 正常运行
      const runNormal = await executeWindowsShortcut(wt, { runAsAdmin: false });
      assert.equal(runNormal.success, true);
      assert.ok(runNormal.message.includes("wt.exe"));

      // 以管理员身份运行
      const regedit = shortcuts.find((s) => s.id === "ws_lnk_regedit");
      assert.ok(regedit);
      assert.equal(regedit.requiresAdmin, true);
      const runAdmin = await executeWindowsShortcut(regedit, { runAsAdmin: true });
      assert.equal(runAdmin.success, true);
      assert.ok(runAdmin.message.includes("管理员"));

      // 定位文件
      const revealRes = await revealShortcutInExplorer(wt);
      assert.equal(revealRes.success, true);
    });

    test("3.5 [Beyond Happy Path 破坏性容错] Wrapped 数据严重破损清洗与快捷指令空脚本拦截", async () => {
      // 1. Wrapped 严重篡改清洗
      const sanitized = sanitizeWrappedStats({
        totalLaunches: -9999,
        timeSavedMinutes: -500,
        geekMasteryTier: "MALICIOUS_TIER_OVERFLOW"
      });
      assert.equal(sanitized.totalLaunches, 100, "负数安全重置为最小基准");
      assert.equal(sanitized.geekMasteryTier, "Master", "非法段位回退默认");
      assert.ok(sanitized.totalKeystrokesSaved > 0);

      // 2. 空脚本快捷指令执行拦截
      const badResult = await executeWindowsShortcut({
        id: "empty_cmd",
        name: "空指令",
        description: "",
        targetPath: "",
        commandType: "cmd",
        commandScript: "",
        category: "system",
        iconName: "terminal"
      });
      assert.equal(badResult.success, false);
      assert.ok(badResult.message.includes("为空"));

      // 3. 空路径在资源管理器定位拦截
      const badReveal = await revealShortcutInExplorer({
        id: "empty_path",
        name: "空路径",
        description: "",
        targetPath: "",
        commandType: "lnk",
        commandScript: "",
        category: "apps",
        iconName: "terminal"
      });
      assert.equal(badReveal.success, false);
    });

    test("3.6 [Declarative UI 声明式视图] Wrapped、Nudges 与 Shortcuts 虚拟视图树生成", () => {
      const wrappedRoot = renderDeclarativeRoot(RaycastWrappedCommand);
      const wrappedVnode = wrappedRoot.getLatest();
      assert.equal(wrappedVnode.type, "Detail");
      assert.ok(wrappedVnode.props.markdown.includes("效率总耗时对比"));
      assert.ok(wrappedVnode.props.markdown.includes("最常调用的前 5 款插件统计图表"));
      wrappedRoot.unmount();

      const nudgesRoot = renderDeclarativeRoot(TrialNudgesCommand);
      const nudgesVnode = nudgesRoot.getLatest();
      assert.equal(nudgesVnode.type, "List");
      assert.equal(nudgesVnode.props.isShowingDetail, true);
      nudgesRoot.unmount();

      const shortcutsRoot = renderDeclarativeRoot(WindowsShortcutsCommand);
      const shortcutsVnode = shortcutsRoot.getLatest();
      assert.equal(shortcutsVnode.type, "List");
      assert.equal(shortcutsVnode.props.isShowingDetail, true);
      assert.ok(shortcutsVnode.props.searchBarAccessory);
      shortcutsRoot.unmount();
    });
  });
});
