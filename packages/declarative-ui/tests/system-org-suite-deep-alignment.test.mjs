import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 账户与团队协同演示已整体删除（内部与公开版都不再提供）
  // Wrapped, Nudges & Shortcuts
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

describe("内置套件集成测试: 系统生态套件 (Wrapped, Nudges & Shortcuts)", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
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
