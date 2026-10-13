import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ApplicationsCommand,
  AppDetailView,
  ApplicationsManager,
  INITIAL_APPLICATIONS,
  computePinyin
} from "../dist/examples/index.js";
import { renderDeclarativeRoot } from "../dist/runtime/reconciler.js";

describe("Applications Management Suite (REA 深度逆向与 Raycast 标杆对齐)", () => {
  describe("1. ApplicationsManager 核心服务与全量应用扫描", () => {
    it("全量应用库包含 Win32、UWP 与 Windows 核心系统工具", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();

      assert.ok(apps.length >= 10, "必须包含丰富的高保真真实应用");

      // 验证 Win32 经典应用
      const vscode = apps.find((a) => a.id === "app-vscode");
      assert.ok(vscode);
      assert.equal(vscode.architecture, "x64");
      assert.equal(vscode.category, "developer");
      assert.ok(vscode.path.includes("Code.exe"));
      assert.ok(vscode.uninstallString);

      // 验证 UWP 现代化应用
      const calc = apps.find((a) => a.id === "app-calculator");
      assert.ok(calc);
      assert.equal(calc.isUwp, true);
      assert.equal(calc.architecture, "neutral");
      assert.equal(calc.category, "system");
      assert.ok(calc.bundleId?.includes("Microsoft.WindowsCalculator"));

      // 验证 Windows 核心系统工具
      const taskmgr = apps.find((a) => a.id === "app-taskmgr");
      assert.ok(taskmgr);
      assert.equal(taskmgr.isSystemComponent, true);
      assert.equal(taskmgr.architecture, "x64");
      assert.ok(taskmgr.path.toLowerCase().includes("taskmgr.exe"));
    });

    it("拼音计算器准确提取全拼与缩写首字母 (支持中英文、特殊软件)", () => {
      const wechat = computePinyin("微信 (WeChat)");
      assert.equal(wechat.pinyin, "weixin");
      assert.equal(wechat.initials, "wx");

      const taskmgr = computePinyin("任务管理器 (Task Manager)");
      assert.equal(taskmgr.pinyin, "renwuguanliqi");
      assert.equal(taskmgr.initials, "rwglq");

      const cp2077 = computePinyin("赛博朋克 2077");
      assert.equal(cp2077.pinyin, "saibopengke2077");
      assert.equal(cp2077.initials, "sbpk");

      const english = computePinyin("Visual Studio Code");
      assert.ok(english.pinyin.includes("visualstudiocode"));
    });

    it("支持全部分类 Dropdown 细致过滤 (installed, system, developer, game, running)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();

      // 1. 全部
      const all = manager.filterAndSearch(apps, "", "all");
      assert.equal(all.length, apps.length);

      // 2. 开发者工具
      const dev = manager.filterAndSearch(apps, "", "developer");
      assert.ok(dev.length > 0);
      assert.ok(dev.every((a) => a.category === "developer"));
      assert.ok(dev.some((a) => a.name.includes("Visual Studio Code")));

      // 3. 系统组件
      const sys = manager.filterAndSearch(apps, "", "system");
      assert.ok(sys.length > 0);
      assert.ok(sys.every((a) => a.category === "system"));
      assert.ok(sys.some((a) => a.name.includes("任务管理器")));

      // 4. 游戏
      const games = manager.filterAndSearch(apps, "", "game");
      assert.ok(games.length > 0);
      assert.ok(games.every((a) => a.category === "game"));
      assert.ok(games.some((a) => a.name.includes("Steam") || a.name.includes("赛博朋克")));

      // 5. 正在运行应用
      const running = manager.filterAndSearch(apps, "", "running");
      assert.ok(running.length > 0);
      assert.ok(running.every((a) => a.isRunning));
    });

    it("支持拼音、缩写、包名、英文名称全方位模糊搜索", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();

      // 拼音缩写 wx -> 微信
      const resWx = manager.filterAndSearch(apps, "wx", "all");
      assert.ok(resWx.some((a) => a.name.includes("微信")));

      // 拼音全拼 jsq -> 计算器
      const resJsq = manager.filterAndSearch(apps, "jsq", "all");
      assert.ok(resJsq.some((a) => a.name.includes("计算器")));

      // 包名搜索
      const resBundle = manager.filterAndSearch(apps, "WindowsTerminal", "all");
      assert.ok(resBundle.some((a) => a.name.includes("终端")));

      // 不存在搜索词返回空集合
      const none = manager.filterAndSearch(apps, "NonExistentApp123456", "all");
      assert.equal(none.length, 0);
    });
  });

  describe("2. Raycast 官方级 ActionPanel 动作集全闭环", () => {
    it("openApplication 能够打开应用并更新进程运行状态与 PID", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const nodeApp = apps.find((a) => a.id === "app-nodejs");
      assert.equal(nodeApp.isRunning, false);

      const res = await manager.openApplication(nodeApp, { runAsAdmin: false });
      assert.equal(res.success, true);
      assert.match(res.message, /已启动应用程序/);
      assert.equal(res.app?.isRunning, true);
      assert.ok(typeof res.app?.pid === "number");
    });

    it("openApplication 支持管理员身份提权运行 (Run as Administrator)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const regedit = apps.find((a) => a.id === "app-regedit");

      const res = await manager.openApplication(regedit, { runAsAdmin: true });
      assert.equal(res.success, true);
      assert.match(res.message, /以管理员身份启动/);
      assert.equal(res.app?.isRunning, true);
    });

    it("revealApplication 能够成功调用资源管理器定位", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const chrome = apps.find((a) => a.id === "app-chrome");

      const res = await manager.revealApplication(chrome);
      assert.equal(res.success, true);
      assert.match(res.message, /已在资源管理器中定位/);
    });

    it("terminateApplication 支持优雅退出与强制终结进程", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const wechat = apps.find((a) => a.id === "app-wechat");
      assert.equal(wechat.isRunning, true);

      // 优雅退出
      const resGraceful = await manager.terminateApplication(wechat, false);
      assert.equal(resGraceful.success, true);
      assert.match(resGraceful.message, /已优雅退出/);
      assert.equal(resGraceful.app?.isRunning, false);

      // 重新打开后强制退出
      await manager.openApplication(wechat);
      const resForce = await manager.terminateApplication(wechat, true);
      assert.equal(resForce.success, true);
      assert.match(resForce.message, /已强制终结/);
      assert.equal(resForce.app?.isRunning, false);
    });

    it("restartApplication 串联重启应用程序", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const terminal = apps.find((a) => a.id === "app-terminal");

      const res = await manager.restartApplication(terminal);
      assert.equal(res.success, true);
      assert.equal(res.app?.isRunning, true);
    });

    it("toggleGameStatus 动态切换游戏管理标记 (Treat as Game)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const chrome = apps.find((a) => a.id === "app-chrome");
      assert.equal(chrome.isGame, false);

      const resMark = manager.toggleGameStatus(chrome);
      assert.equal(resMark.success, true);
      assert.equal(resMark.app?.isGame, true);
      assert.equal(resMark.app?.category, "game");

      const resUnmark = manager.toggleGameStatus(chrome);
      assert.equal(resUnmark.success, true);
      assert.equal(resUnmark.app?.isGame, false);
    });

    it("toggleAutoQuit 动态切换空闲自动退出", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const vscode = apps.find((a) => a.id === "app-vscode");
      assert.equal(vscode.autoQuitEnabled, false);

      const resEnable = manager.toggleAutoQuit(vscode);
      assert.equal(resEnable.success, true);
      assert.equal(resEnable.app?.autoQuitEnabled, true);

      const resDisable = manager.toggleAutoQuit(vscode);
      assert.equal(resDisable.success, true);
      assert.equal(resDisable.app?.autoQuitEnabled, false);
    });

    it("uninstallApplication 成功启动官方卸载向导", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const vscode = apps.find((a) => a.id === "app-vscode");

      const res = await manager.uninstallApplication(vscode);
      assert.equal(res.success, true);
      assert.match(res.message, /已调起.*官方卸载向导/);
    });
  });

  describe("3. 破坏性与边界极端异常测试 (Fault Injection & Edge Cases)", () => {
    it("超长路径 (>260 字符) 边界安全处理与超限拦截 (>1024 字符)", async () => {
      const manager = new ApplicationsManager();
      const longPath = "C:\\" + "very_long_nested_directory_name\\".repeat(12) + "application.exe";
      assert.ok(longPath.length > 260, "路径长度必须超过 260 字符");

      const fakeApp = {
        id: "fake-long-path-app",
        name: "Long Path App",
        path: longPath
      };

      const res = await manager.openApplication(fakeApp);
      assert.equal(res.success, true, "正常超长路径应安全通过");

      // 极端恶意超限路径 (>1024 字符)
      const extremePath = "C:\\" + "a".repeat(1050) + ".exe";
      const extremeApp = { id: "extreme", name: "Extreme", path: extremePath };
      const extremeRes = await manager.openApplication(extremeApp);
      assert.equal(extremeRes.success, false);
      assert.equal(extremeRes.error, "PATH_TOO_LONG");
    });

    it("非英文字符路径 (中文、特殊符号、空格) 安全通过", async () => {
      const manager = new ApplicationsManager();
      const cjkApp = {
        id: "app-cjk",
        name: "中文应用 2026",
        path: "C:\\Program Files\\测试目录-2026 (测试版本)\\应用程序_main.exe"
      };

      const res = await manager.openApplication(cjkApp);
      assert.equal(res.success, true);
    });

    it("试图优雅终止受保护系统核心组件时拦截 (SYSTEM_COMPONENT_PROTECTED)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const taskmgr = apps.find((a) => a.id === "app-taskmgr");

      // 试图优雅退出被拦截
      const res = await manager.terminateApplication(taskmgr, false);
      assert.equal(res.success, false);
      assert.equal(res.error, "SYSTEM_COMPONENT_PROTECTED");

      // 强制退出允许
      const resForce = await manager.terminateApplication(taskmgr, true);
      assert.equal(resForce.success, true);
    });

    it("试图终止未在运行的应用时返回明确错误 (PROCESS_NOT_RUNNING)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const notRunning = apps.find((a) => !a.isRunning);

      const res = await manager.terminateApplication(notRunning, false);
      assert.equal(res.success, false);
      assert.equal(res.error, "PROCESS_NOT_RUNNING");
    });

    it("试图卸载无卸载注册表项的系统核心组件时安全拦截 (SYSTEM_COMPONENT_LOCKED)", async () => {
      const manager = new ApplicationsManager();
      const apps = await manager.getApplications();
      const control = apps.find((a) => a.id === "app-control");

      const res = await manager.uninstallApplication(control);
      assert.equal(res.success, false);
      assert.equal(res.error, "SYSTEM_COMPONENT_LOCKED");
    });

    it("空对象与无效路径输入安全拦截", async () => {
      const manager = new ApplicationsManager();

      const resNull = await manager.openApplication(null );
      assert.equal(resNull.success, false);
      assert.equal(resNull.error, "INVALID_PATH");

      const resEmpty = await manager.openApplication({ id: "x", name: "x", path: "" } );
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.error, "INVALID_PATH");

      const resTermNull = await manager.terminateApplication(null );
      assert.equal(resTermNull.success, false);
      assert.equal(resTermNull.error, "NULL_APP");
    });
  });

  describe("4. 声明式 UI 挂载与视图树渲染 (Reconciler & Virtual Tree)", () => {
    it("ApplicationsCommand 正确挂载为 List 视图树与 Dropdown", () => {
      const root = renderDeclarativeRoot(ApplicationsCommand);
      const desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.match(desc.props.searchBarPlaceholder, /搜索已安装应用/);
      assert.ok(desc.props.searchBarAccessory);
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");

      // 验证 List.Item 生成
      assert.ok(Array.isArray(desc.children));
      assert.ok(desc.children.length >= 10);
      assert.equal(desc.children[0].type, "List.Item");

      // 验证 List.Item 的 ActionPanel
      const firstItem = desc.children[0];
      assert.ok(firstItem.props.actions);
      assert.equal(firstItem.props.actions.type, "ActionPanel");
      root.unmount();
    });

    it("AppDetailView 能够准确生成 Markdown 详情与 Metadata 侧边栏", () => {
      const sample = INITIAL_APPLICATIONS[0];
      const detailDesc = AppDetailView({ app: sample });

      assert.equal(detailDesc.type, "Detail");
      assert.match(detailDesc.props.markdown, /文件系统与执行路径/);
      assert.match(detailDesc.props.markdown, /进程与运行状态/);
      assert.ok(detailDesc.props.metadata);
      assert.equal(detailDesc.props.metadata.type, "Detail.Metadata");
      assert.ok(detailDesc.props.actions);
      assert.equal(detailDesc.props.actions.type, "ActionPanel");
    });
  });
});
