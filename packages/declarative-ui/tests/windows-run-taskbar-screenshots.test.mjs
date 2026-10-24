/**
 * ZTools Built-in Suites Integration & Chaos Resilience Test Suite
 * 专注于 Windows Run, Windows Taskbar 与 Screenshots 的功能与容错验证
 * 
 * 测试原则:
 * 1. 默认包含跨模块端到端集成测试 (Integration Tests by Default)
 * 2. 严禁仅写 Happy Path (Beyond Happy Path: 覆盖参数空值、极值越界、并发竞态与破坏性异常)
 */

import { describe, test, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";

// 导入待测组件与核心服务
import {
  // 1. Windows Run
  WindowsRunCommand,
  parseCommandLine,
  detectKind,
  defaultWindowsRunManager,
  WindowsRunManager,
  BUILTIN_RUN_ITEMS,
  RUN_REGEX,
  // 2. Windows Taskbar
  WindowsTaskbarCommand,
  WindowsTaskbarManager,
  defaultWindowsTaskbarManager,
  // 3. Screenshots
  ScreenshotsCommand,
  ScreenshotDetailView,
  defaultScreenshotsManager,
  generateScreenshotThumbnailSvg,
  INITIAL_SCREENSHOTS,
  // Declarative Reconciler & API
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard
} from "../dist/index.js";

describe("内置套件集成测试: Windows Run, Taskbar & Screenshots", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
  });

  // ===========================================================================
  // 1. Windows Run (Windows 运行中枢) 深度集成与破坏性测试
  // ===========================================================================
  describe("1. Windows Run 运行中枢与参数化执行系统", () => {
    it("1.1 命令行解析器: 引号、路径、URI、环境变量与参数化拆解", () => {
      // 普通命令带参数
      const ping = parseCommandLine("ping 1.1.1.1");
      assert.equal(ping.command, "ping");
      assert.equal(ping.arguments, "1.1.1.1");
      assert.equal(ping.fullCommandLine, "ping 1.1.1.1");
      assert.equal(ping.kind, "executable");

      // 带引号的绝对路径与长参数
      const quoted = parseCommandLine('"C:\\Program Files\\Node\\node.exe" --version');
      assert.equal(quoted.command, "C:\\Program Files\\Node\\node.exe");
      assert.equal(quoted.arguments, "--version");

      // URI 协议
      const uri = parseCommandLine("https://ztools.dev/docs?lang=zh");
      assert.equal(uri.command, "https://ztools.dev/docs?lang=zh");
      assert.equal(uri.kind, "uri");

      // URI 带空格参数
      const uriWithArgs = parseCommandLine("ms-settings:windowsupdate now");
      assert.equal(uriWithArgs.command, "ms-settings:windowsupdate");
      assert.equal(uriWithArgs.arguments, "now");
      assert.equal(uriWithArgs.kind, "uri");

      // 环境变量
      const env = parseCommandLine("%APPDATA%");
      assert.equal(env.command, "%APPDATA%");
      assert.equal(env.kind, "environmentVariable");

      // MMC 控制台文件
      const msc = parseCommandLine("services.msc /s");
      assert.equal(msc.command, "services.msc");
      assert.equal(msc.arguments, "/s");
      assert.equal(msc.kind, "managementConsole");

      // 控制面板 CPL 文件
      const cpl = parseCommandLine("ncpa.cpl");
      assert.equal(cpl.command, "ncpa.cpl");
      assert.equal(cpl.kind, "controlPanelApplet");
    });

    it("1.2 【Beyond Happy Path 破坏性参数校验】命令行边界与畸形输入容错", () => {
      // 空值与纯空白
      const empty1 = parseCommandLine("");
      assert.equal(empty1.command, "");
      assert.equal(empty1.arguments, undefined);

      const empty2 = parseCommandLine("    \t\n  ");
      assert.equal(empty2.command, "");

      // 未闭合引号
      const unclosedQuote = parseCommandLine('"C:\\Program Files\\Unclosed Path');
      assert.ok(unclosedQuote.command.length > 0);

      // 超长 10,000 字符命令行防溢出
      const longArgs = "a".repeat(10000);
      const longCmd = parseCommandLine(`cmd.exe /c ${longArgs}`);
      assert.equal(longCmd.command, "cmd.exe");
      assert.ok(longCmd.arguments?.includes(longArgs));
    });

    it("1.3 预置 35+ 款高频 Windows 运行工具数据库完整性", () => {
      assert.ok(BUILTIN_RUN_ITEMS.length >= 25, "必须预置充足的高频 Windows 命令");

      // 验证核心 System32 工具
      const regedit = BUILTIN_RUN_ITEMS.find((c) => c.title === "regedit");
      assert.ok(regedit);
      assert.equal(regedit.runAsAdminByDefault, true, "注册表编辑器应默认标记为管理员提权");

      const taskmgr = BUILTIN_RUN_ITEMS.find((c) => c.title === "taskmgr");
      assert.ok(taskmgr);

      const services = BUILTIN_RUN_ITEMS.find((c) => c.title === "services.msc");
      assert.ok(services);
      assert.equal(services.kind, "managementConsole");

      const ncpa = BUILTIN_RUN_ITEMS.find((c) => c.title === "ncpa.cpl");
      assert.ok(ncpa);
      assert.equal(ncpa.kind, "controlPanelApplet");
    });

    it("1.4 搜索与动态参数化直达项构建", async () => {
      // 搜索内置命令
      const searchRes = await defaultWindowsRunManager.search("gpedit");
      assert.ok(searchRes.items.some((i) => i.command.includes("gpedit.msc")));

      // 搜索参数化指令并自动构建 directItem
      const customRes = await defaultWindowsRunManager.search("ping 8.8.8.8");
      assert.ok(customRes.directItem, "输入包含参数时应生成 directItem");
      assert.equal(customRes.directItem.command, "ping");
      assert.equal(customRes.directItem.arguments, "8.8.8.8");
      assert.equal(customRes.directItem.fullCommandLine, "ping 8.8.8.8");
    });

    it("1.5 执行流水线与运行历史记录持久化 (CRUD & Ranking)", async () => {
      await defaultWindowsRunManager.clearHistory();
      let history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 0);

      // 1. 普通执行并记录（假宿主：记录 windows_run_execute 的参数）
      const hostCalls = [];
      const fakeHostManager = new WindowsRunManager({
        hostOverride: {
          windows_run_execute: async (params) => {
            hostCalls.push(params);
            return { success: true, data: { success: true, pid: 4242 } };
          }
        }
      });
      const res1 = await fakeHostManager.execute("code .", { shell: "none" });
      assert.equal(res1.success, true);
      assert.equal(res1.command, "code .");
      assert.equal(res1.pid, 4242);
      assert.deepEqual(hostCalls[0], { command: "code", args: ["."], runAsAdmin: false, shell: "none" });

      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].fullCommandLine, "code .");
      assert.equal(history[0].runCount, 1);

      // 2. 再次执行相同命令 -> 计数增加并置顶 (MRU)
      await fakeHostManager.execute("code .");
      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].runCount, 2);

      // 3. 管理员与 Shell 执行
      const resAdmin = await fakeHostManager.execute("services.msc", { asAdministrator: true });
      assert.equal(resAdmin.success, true);
      assert.deepEqual(hostCalls[2], { command: "services.msc", runAsAdmin: true, shell: "none" });
      await fakeHostManager.execute("dir", { shell: "cmd" });
      assert.deepEqual(hostCalls[3], { command: "dir", runAsAdmin: false, shell: "cmd" });

      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 3);
      assert.equal(history[0].command, "dir");

      // 4. 删除单条历史
      const toDelete = history[0].id;
      const delSuccess = await defaultWindowsRunManager.deleteHistoryItem(toDelete);
      assert.equal(delSuccess, true);

      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 2);
      assert.equal(history.some((h) => h.id === toDelete), false);

      // 5. 清空全部历史
      await defaultWindowsRunManager.clearHistory();
      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 0);
    });

    it("1.6 【Beyond Happy Path 执行异常注入】空命令拒绝与安全隔离", async () => {
      await assert.rejects(
        async () => {
          await defaultWindowsRunManager.execute("");
        },
        /执行命令不能为空/
      );

      await assert.rejects(
        async () => {
          await defaultWindowsRunManager.execute("    ");
        },
        /执行命令不能为空/
      );
    });

    it("1.5.1 【故障注入】没有宿主 / 宿主返回失败 / 宿主抛错：execute 如实返回 success:false", async () => {
      // 1. 没有宿主（Node 环境、浏览器预览）
      const none = await defaultWindowsRunManager.execute("notepad.exe");
      assert.equal(none.success, false);
      assert.match(none.message, /未连接 ZTools 宿主/);

      // 2. 宿主内层 success:false（例如 UAC 被拒）
      const rejected = await new WindowsRunManager({
        hostOverride: { windows_run_execute: async () => ({ success: true, data: { success: false, error: "管理员提权启动失败" } }) }
      }).execute("services.msc", { asAdministrator: true });
      assert.equal(rejected.success, false);
      assert.match(rejected.message, /管理员提权启动失败/);

      // 3. 宿主抛错（参数校验拒绝等）
      const thrown = await new WindowsRunManager({
        hostOverride: { windows_run_execute: async () => { throw new Error("方法参数包含未知字段"); } }
      }).execute("cmd");
      assert.equal(thrown.success, false);
      assert.match(thrown.message, /方法参数包含未知字段/);
      assert.equal(thrown.pid, undefined);
      await defaultWindowsRunManager.clearHistory();
    });

    it("1.6.1 【故障注入】Node 环境执行命令绝不拉起真实进程（不回退到 child_process）", async () => {
      // 把 child_process 的进程创建函数换成会记录并抛错的替身，同步到 ESM 导出，动态 import 拿到的也是替身
      const childProcess = createRequire(import.meta.url)("node:child_process");
      const names = ["spawn", "exec", "execFile", "fork"];
      const originals = Object.fromEntries(names.map((n) => [n, childProcess[n]]));
      const spawned = [];
      for (const n of names) {
        childProcess[n] = (...args) => {
          spawned.push([n, args[0]]);
          throw new Error("测试中不允许创建真实进程");
        };
      }
      syncBuiltinESMExports();
      try {
        for (const shell of ["none", "cmd", "powershell"]) {
          const res = await defaultWindowsRunManager.execute("notepad.exe C:\\a.txt", { shell });
          assert.equal(res.command, "notepad.exe C:\\a.txt");
          assert.equal(res.pid, undefined, `${shell}: 没有宿主时不应产生真实进程号`);
          assert.equal(res.success, false, `${shell}: 没有宿主时不能报告成功`);
        }
        assert.deepEqual(spawned, [], "不能经 Node child_process 拉起任何进程");
      } finally {
        for (const n of names) childProcess[n] = originals[n];
        syncBuiltinESMExports();
        await defaultWindowsRunManager.clearHistory();
      }
    });

    it("1.7 WindowsRunCommand 声明式组件树挂载与 ActionPanel 全动作集成", async () => {
      const root = renderDeclarativeRoot(WindowsRunCommand);
      let desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.ok(desc.props.searchBarPlaceholder.includes("ping"));
      assert.ok(desc.children.length >= 2, "应渲染管理工具和 CPL 专项等 Section");

      // 模拟用户输入带有参数的指令
      desc.props.onSearchTextChange("ping 127.0.0.1");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      // 验证生成了执行输入指令的第一个 Section
      const directSection = desc.children[0];
      assert.equal(directSection.props.title, "执行输入指令");
      const directItem = directSection.children[0];
      assert.equal(directItem.props.title, "ping 127.0.0.1");

      // 验证 ActionPanel 包含 6 个核心动作
      const actionPanel = directItem.props.actions;
      assert.equal(actionPanel.type, "ActionPanel");
      const actions = actionPanel.children;

      const titles = actions.map((a) => a.props.title);
      assert.ok(titles.some((t) => t.includes("运行 (Run)")));
      assert.ok(titles.some((t) => t.includes("以管理员身份运行")));
      assert.ok(titles.some((t) => t.includes("PowerShell")));
      assert.ok(titles.some((t) => t.includes("CMD")));
      assert.ok(titles.some((t) => t.includes("复制完整命令")));

      // 触发 Run 动作并验证 Toast 提示与历史入库
      const runAction = actions.find((a) => a.props.title.includes("运行 (Run)"));
      await runAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      const history = await defaultWindowsRunManager.getHistory();
      assert.ok(history.some((h) => h.fullCommandLine === "ping 127.0.0.1"));

      root.unmount();
    });
  });

  // ===========================================================================
  // 2. Windows Taskbar (任务栏治理中枢) 深度集成与状态机测试
  // ===========================================================================
  describe("2. Windows Taskbar 任务栏治理中枢与状态机系统", () => {
    /**
     * 模拟宿主：与 router 返回结构一致，记录每次调用；所有测试都通过它执行，
     * 绝不调用真实的 taskbar / Dock 命令，避免改动开发者本机设置
     */
    function createFakeTaskbarHost({ platform = "win32", visible = true, fail = {}, throwOn = {} } = {}) {
      const calls = [];
      const host = {
        state: { visible },
        calls,
        taskbar_status: async () => {
          calls.push(["taskbar_status"]);
          if (throwOn.taskbar_status) throw new Error("status 管道断开");
          return { visible: host.state.visible };
        },
        taskbar_show: async () => {
          calls.push(["taskbar_show"]);
          if (throwOn.taskbar_show) throw new Error("IPC 超时");
          if (fail.taskbar_show) return { success: false, visible: host.state.visible, message: "任务栏切换失败", error: fail.taskbar_show };
          host.state.visible = true;
          return { success: true, visible: true, message: platform === "darwin" ? "Dock 常驻显示已开启" : "任务栏已显示" };
        },
        taskbar_hide: async () => {
          calls.push(["taskbar_hide"]);
          if (throwOn.taskbar_hide) throw new Error("IPC 超时");
          if (fail.taskbar_hide) return { success: false, visible: host.state.visible, message: "任务栏切换失败", error: fail.taskbar_hide };
          host.state.visible = false;
          return { success: true, visible: false, message: platform === "darwin" ? "Dock 自动隐藏已开启" : "任务栏已隐藏" };
        },
        taskbar_set_dock_position: async (params) => {
          calls.push(["taskbar_set_dock_position", params]);
          if (fail.taskbar_set_dock_position) return { success: false, edge: params.position, message: fail.taskbar_set_dock_position, error: fail.taskbar_set_dock_position };
          return { success: true, edge: params.position, message: "Dock 停靠位置已切换" };
        },
        taskbar_restart_dock: async () => {
          calls.push(["taskbar_restart_dock"]);
          if (fail.taskbar_restart_dock) return { success: false, message: fail.taskbar_restart_dock, error: fail.taskbar_restart_dock };
          return { success: true, message: "Dock 已重启" };
        }
      };
      return host;
    }

    const methodsCalled = (host) => host.calls.map((c) => c[0]).filter((m) => m !== "taskbar_status");

    it("2.1 显隐按目标状态显式调用 taskbar_show / taskbar_hide，不再使用 toggle", async () => {
      const mgr = new WindowsTaskbarManager({ platform: "win32" });
      const host = createFakeTaskbarHost({ visible: true });

      const resHide = await mgr.hideTaskbar(host);
      assert.equal(resHide.success, true);
      assert.equal(resHide.visible, false);
      assert.equal(resHide.state.visible, false);
      assert.equal(resHide.message, "任务栏已隐藏");

      // 重复隐藏仍调用 hide（显式目标状态），不会因为缓存方向反转而把任务栏显示出来
      const resHide2 = await mgr.hideTaskbar(host);
      assert.equal(resHide2.success, true);
      assert.equal(resHide2.visible, false);

      const resShow = await mgr.showTaskbar(host);
      assert.equal(resShow.success, true);
      assert.equal(resShow.state.visible, true);
      assert.deepEqual(methodsCalled(host), ["taskbar_hide", "taskbar_hide", "taskbar_show"]);
      assert.ok(!host.calls.some((c) => c[0] === "taskbar_toggle"), "不应再调用 taskbar_toggle");
    });

    it("2.2 切换显隐以宿主真实状态决定方向（本地缓存过期也不会反转）", async () => {
      const mgr = new WindowsTaskbarManager({ platform: "win32" });
      // 本地缓存认为是显示中，但宿主真实状态已是隐藏
      await mgr.showTaskbar(createFakeTaskbarHost());
      const host = createFakeTaskbarHost({ visible: false });
      const res = await mgr.toggleTaskbarVisibility(host);
      assert.equal(res.success, true);
      assert.equal(res.visible, true);
      assert.deepEqual(methodsCalled(host), ["taskbar_show"]);

      // 宿主状态读取失败时回退本地缓存（当前为显示 → 隐藏）
      const brokenStatus = createFakeTaskbarHost({ throwOn: { taskbar_status: true } });
      const res2 = await mgr.toggleTaskbarVisibility(brokenStatus);
      assert.equal(res2.success, true);
      assert.equal(res2.visible, false);
    });

    it("2.3 【故障注入】宿主内层 success:false / 抛错 / 未连接宿主都如实返回失败且不改动状态", async () => {
      const mgr = new WindowsTaskbarManager({ platform: "win32" });
      await mgr.showTaskbar(createFakeTaskbarHost());

      const innerFail = createFakeTaskbarHost({ fail: { taskbar_hide: "Win32 ShowWindow 调用失败" } });
      const r1 = await mgr.hideTaskbar(innerFail);
      assert.equal(r1.success, false);
      assert.equal(r1.message, "隐藏任务栏失败");
      assert.equal(r1.error, "Win32 ShowWindow 调用失败");
      assert.equal(r1.visible, true);
      assert.equal(r1.state.visible, true, "失败时不能把状态改成已隐藏");

      const throwing = createFakeTaskbarHost({ throwOn: { taskbar_hide: true } });
      const r2 = await mgr.hideTaskbar(throwing);
      assert.equal(r2.success, false);
      assert.equal(r2.error, "IPC 超时");
      assert.equal(r2.state.visible, true);

      // 宿主对象里没有该方法，也不在 Electron 宿主中：如实返回未连接
      const r3 = await mgr.hideTaskbar({});
      assert.equal(r3.success, false);
      assert.match(r3.message, /未连接 ZTools 宿主/);
      assert.equal(r3.state.visible, true);

      // 完全没有宿主（Node / 浏览器预览）：同样失败，绝不假装成功
      const r4 = await mgr.toggleTaskbarVisibility();
      assert.equal(r4.success, false);
      assert.match(r4.message, /未连接 ZTools 宿主/);
    });

    it("2.4 自动隐藏：macOS 映射为 Dock 自动隐藏，Windows 如实返回不支持", async () => {
      const mac = new WindowsTaskbarManager({ platform: "darwin" });
      const macHost = createFakeTaskbarHost({ platform: "darwin", visible: true });
      const on = await mac.toggleTaskbarAutoHide(macHost);
      assert.equal(on.success, true);
      assert.equal(on.autoHide, true);
      assert.equal(on.state.visible, false);
      const off = await mac.setTaskbarAutoHide(false, macHost);
      assert.equal(off.success, true);
      assert.equal(off.autoHide, false);
      assert.equal(off.state.visible, true);
      assert.deepEqual(methodsCalled(macHost), ["taskbar_hide", "taskbar_show"]);

      // macOS 上 Automation 权限被拒：如实失败并带上宿主原因
      const denied = createFakeTaskbarHost({ platform: "darwin", fail: { taskbar_hide: "Not authorized to send Apple events to System Events. (-1743)" } });
      const deniedRes = await mac.setTaskbarAutoHide(true, denied);
      assert.equal(deniedRes.success, false);
      assert.match(deniedRes.error, /-1743/);
      assert.equal(deniedRes.state.autoHide, false);

      const win = new WindowsTaskbarManager({ platform: "win32" });
      const winHost = createFakeTaskbarHost();
      const winRes = await win.toggleTaskbarAutoHide(winHost);
      assert.equal(winRes.success, false);
      assert.match(winRes.message, /暂不支持/);
      assert.equal(winHost.calls.length, 0, "Windows 上不能误调用 show/hide 冒充自动隐藏");
    });

    it("2.5 停靠位置 / 重启 Dock / 重启资源管理器 / 对齐以宿主真实结果为准", async () => {
      const mac = new WindowsTaskbarManager({ platform: "darwin" });
      const host = createFakeTaskbarHost({ platform: "darwin" });
      const pos = await mac.setDockPosition("left", host);
      assert.equal(pos.success, true);
      assert.equal(pos.state.position, "left");
      assert.deepEqual(host.calls.at(-1), ["taskbar_set_dock_position", { position: "left" }]);

      const posFail = await mac.setDockPosition("right", createFakeTaskbarHost({ platform: "darwin", fail: { taskbar_set_dock_position: "osascript 超时" } }));
      assert.equal(posFail.success, false);
      assert.equal(posFail.error, "osascript 超时");
      assert.equal(posFail.state.position, "left", "失败时保留原停靠位置");

      const top = await mac.setTaskbarPosition("top", host);
      assert.equal(top.success, false, "Dock 不支持停靠到顶部");

      const restart = await mac.restartDock(host);
      assert.equal(restart.success, true);
      const restartFail = await mac.restartExplorer(createFakeTaskbarHost({ platform: "darwin", fail: { taskbar_restart_dock: "killall: No matching processes" } }));
      assert.equal(restartFail.success, false);
      assert.match(restartFail.error, /No matching processes/);

      // Windows：Dock 命令显示不支持且不调用宿主；资源管理器重启与对齐宿主未实现，如实失败
      const win = new WindowsTaskbarManager({ platform: "win32" });
      const winHost = createFakeTaskbarHost();
      const winPos = await win.setDockPosition("left", winHost);
      assert.equal(winPos.success, false);
      assert.match(winPos.message, /仅 macOS 支持/);
      const winDock = await win.restartDock(winHost);
      assert.equal(winDock.success, false);
      assert.match(winDock.message, /仅 macOS 支持/);
      const winExplorer = await win.restartExplorer(winHost);
      assert.equal(winExplorer.success, false);
      assert.equal(winHost.calls.length, 0);
      const align = await win.setTaskbarAlignment("start");
      assert.equal(align.success, false);
      assert.notEqual(align.state.alignment, "start", "未生效的对齐不能写进状态");
      const badAlign = await win.setTaskbarAlignment("middle");
      assert.equal(badAlign.success, false);
    });

    it("2.6 【并发】20 次并发切换全部经宿主执行，结果与宿主最终状态一致", async () => {
      const mgr = new WindowsTaskbarManager({ platform: "darwin" });
      const host = createFakeTaskbarHost({ platform: "darwin" });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? mgr.showTaskbar(host) : mgr.hideTaskbar(host)))
      );
      assert.equal(results.length, 20);
      assert.ok(results.every((r) => r.success === true));
      assert.equal(methodsCalled(host).length, 20);
      const finalState = await mgr.getTaskbarState();
      assert.equal(finalState.visible, host.state.visible);
      assert.equal(finalState.autoHide, !host.state.visible);
    });

    it("2.7 WindowsTaskbarCommand 渲染与动作闭环：经 Electron 传输层调用，内层失败不改状态", async () => {
      const prevWindow = globalThis.window;
      const invoked = [];
      let hideResult = { success: true, data: { success: false, visible: true, message: "任务栏切换失败", error: "任务栏切换失败" } };
      // 模拟 preload 暴露的 transport.methods（外层 IPC 成功、内层业务失败），不会执行任何真实系统命令
      globalThis.window = {
        __ztoolsElectron: {
          transport: {
            methods: {
              taskbar_status: async () => ({ success: true, data: { visible: true } }),
              taskbar_hide: async (req) => {
                invoked.push(["taskbar_hide", req.params]);
                return hideResult;
              },
              taskbar_show: async (req) => {
                invoked.push(["taskbar_show", req.params]);
                return { success: true, data: { success: true, visible: true, message: "任务栏已显示" } };
              }
            }
          }
        }
      };
      try {
        const winMgr = new WindowsTaskbarManager({ platform: "win32" });
        await winMgr.showTaskbar();
        invoked.length = 0;

        const root = renderDeclarativeRoot(() => WindowsTaskbarCommand({ manager: winMgr }));
        const desc = root.getLatest();
        assert.equal(desc.type, "List");
        // Windows：宿主只实现了显示 / 隐藏，自动隐藏、对齐、重启资源管理器、Dock 相关一律不展示
        assert.equal(desc.children.length, 1, "Windows 只展示核心显隐分区");
        const coreSection = desc.children[0];
        assert.equal(coreSection.props.title, "Win32 原生治理动作 (Core Actions)");
        const winKeys = coreSection.children.map((c) => c.key || c.props.key || c.props.title);
        assert.equal(coreSection.children.length, 3);
        assert.ok(!coreSection.children.some((c) => String(c.props.title).includes("自动隐藏")), String(winKeys));
        const winFilterIds = desc.props.filterBar.actions.map((a) => a.id);
        assert.deepEqual(winFilterIds, ["tb-act-visibility"]);

        const toggleItem = coreSection.children[0];
        assert.ok(toggleItem.props.title.includes("切换任务栏显隐"));
        const toggleAction = toggleItem.props.actions.children[0];
        await toggleAction.props.onAction();
        await new Promise((r) => queueMicrotask(r));
        assert.deepEqual(invoked, [["taskbar_hide", {}]]);
        assert.equal((await winMgr.getTaskbarState()).visible, true, "内层失败时状态保持显示");

        hideResult = { success: true, data: { success: true, visible: false, message: "任务栏已隐藏" } };
        await toggleAction.props.onAction();
        assert.equal((await winMgr.getTaskbarState()).visible, false);
        root.unmount();

        // macOS：展示 Dock 自动隐藏、停靠位置与重启 Dock；不展示 Windows 资源管理器与对齐
        const macMgr = new WindowsTaskbarManager({ platform: "darwin" });
        const macRoot = renderDeclarativeRoot(() => WindowsTaskbarCommand({ manager: macMgr }));
        const macDesc = macRoot.getLatest();
        assert.equal(macDesc.children.length, 3);
        assert.ok(macDesc.children[0].children.some((c) => String(c.props.title).includes("自动隐藏")));
        assert.ok(macDesc.children[1].props.title.includes("Dock"));
        assert.ok(!macDesc.children[1].children.some((c) => String(c.props.title).includes("对齐")));
        const recoverySection = macDesc.children[2];
        assert.ok(recoverySection.props.title.includes("运维与急救"));
        assert.equal(recoverySection.children.length, 1);
        assert.ok(recoverySection.children[0].props.title.includes("macOS 程序坞"));
        assert.deepEqual(macDesc.props.filterBar.actions.map((a) => a.id), ["tb-act-visibility", "tb-act-autohide", "tb-act-restart"]);
        macRoot.unmount();
      } finally {
        globalThis.window = prevWindow;
        await defaultWindowsTaskbarManager.showTaskbar(createFakeTaskbarHost());
      }
    });
  });

  // ===========================================================================
  // 3. Screenshots (截图历史与 OCR 中枢) 深度集成与双栏详情测试
  // ===========================================================================
  describe("3. Screenshots 截图历史管理与 OCR 识别中枢", () => {
    it("3.1 默认截图目录检测与数据集完整性", () => {
      const dirs = defaultScreenshotsManager.getDefaultLocations();
      assert.ok(dirs.length >= 1, "应至少包含一个默认截图检测目录");
      assert.ok(dirs.some((d) => d.includes("Screenshots") || d.includes("Pictures")));

      assert.ok(INITIAL_SCREENSHOTS.length >= 4, "必须预置丰富维度的测试截图记录");
      const ideScreenshot = INITIAL_SCREENSHOTS.find((s) => s.id === "ss-ide-01");
      assert.ok(ideScreenshot);
      assert.equal(ideScreenshot.dimensions, "2560 x 1440");
      assert.ok(ideScreenshot.ocrText.includes("ZTools Runner Native Execution Pipeline"));
      assert.equal(ideScreenshot.pinned, true);
    });

    it("3.2 SVG 缩略图生成与 Markdown 图文渲染数据", () => {
      const svg = generateScreenshotThumbnailSvg("Test Preview", 1920, 1080);
      assert.ok(svg.startsWith("data:image/svg+xml;utf8,"));
      assert.ok(svg.includes("1920x1080"));
      assert.ok(svg.includes("Test%20Preview") || svg.includes("Test Preview"));
    });

    it("3.3 搜索与分类过滤 (文件名、分辨率、OCR 文字)", async () => {
      const list = await defaultScreenshotsManager.loadScreenshots();

      // 1. 搜索分辨率
      const searchRes = defaultScreenshotsManager.filterScreenshots(list, "4K", "all");
      assert.ok(searchRes.length >= 1);
      assert.equal(searchRes[0].dimensions.includes("4K"), true);

      // 2. 搜索 OCR 提取文字 (例如错误代码 "0x80070005")
      const searchOcr = defaultScreenshotsManager.filterScreenshots(list, "0x80070005", "all");
      assert.ok(searchOcr.length >= 1);
      assert.ok(searchOcr[0].ocrText.includes("Access is denied"));

      // 3. 分类过滤: 置顶项 (Pinned)
      const pinnedOnly = defaultScreenshotsManager.filterScreenshots(list, "", "pinned");
      assert.ok(pinnedOnly.length >= 1);
      assert.ok(pinnedOnly.every((s) => s.pinned === true));

      // 4. 分类过滤: 包含 OCR 文本 (ocr)
      const withOcr = defaultScreenshotsManager.filterScreenshots(list, "", "ocr");
      assert.ok(withOcr.length >= 1);
      assert.ok(withOcr.every((s) => s.ocrText.length > 0));
    });

    it("3.4 截图置顶、回贴、复制与删除生命周期闭环", async () => {
      const list = await defaultScreenshotsManager.loadScreenshots();
      const target = list[0];

      // 1. 回贴最新截图
      const pasteLatestRes = await defaultScreenshotsManager.pasteLatestScreenshot();
      assert.equal(pasteLatestRes.success, true);
      assert.ok(pasteLatestRes.screenshot);

      // 2. 复制图片本身
      const copyImgRes = await defaultScreenshotsManager.copyImageToClipboard(target);
      assert.equal(copyImgRes.success, true);

      // 3. 复制本地路径
      const copyPathRes = await defaultScreenshotsManager.copyImagePath(target);
      assert.equal(copyPathRes.success, true);
      assert.equal(copyPathRes.screenshot?.path, target.path);

      // 4. 复制 OCR 识别文字
      const copyOcrRes = await defaultScreenshotsManager.copyOcrText(target);
      assert.equal(copyOcrRes.success, true);
      assert.ok(copyOcrRes.ocrText);

      // 5. 资源管理器定位与系统默认打开
      const revealRes = await defaultScreenshotsManager.showInExplorer(target);
      assert.equal(revealRes.success, true);

      const openRes = await defaultScreenshotsManager.openWithDefaultApp(target);
      assert.equal(openRes.success, true);

      // 6. 置顶切换
      const pinBefore = target.pinned;
      const togglePinRes = await defaultScreenshotsManager.togglePinScreenshot(target);
      assert.equal(togglePinRes.success, true);
      assert.equal(togglePinRes.screenshot?.pinned, !pinBefore);

      // 7. 删除截图
      const delRes = await defaultScreenshotsManager.deleteScreenshot(target);
      assert.equal(delRes.success, true);
      const afterDelList = await defaultScreenshotsManager.loadScreenshots();
      assert.equal(afterDelList.some((s) => s.id === target.id), false);
    });

    it("3.5 【Beyond Happy Path 异常容错】空对象处理与非法路径防御", async () => {
      // 空对象粘贴
      const resNullPaste = await defaultScreenshotsManager.pasteToActiveWindow(null);
      assert.equal(resNullPaste.success, false);
      assert.equal(resNullPaste.error, "NULL_ITEM");

      // 空对象复制
      const resNullCopy = await defaultScreenshotsManager.copyImageToClipboard(null);
      assert.equal(resNullCopy.success, false);

      // 空对象删除
      const resNullDel = await defaultScreenshotsManager.deleteScreenshot(null);
      assert.equal(resNullDel.success, false);

      // 空路径定位
      const resInvalidReveal = await defaultScreenshotsManager.showInExplorer({ id: "fake", path: "" });
      assert.equal(resInvalidReveal.success, false);
      assert.equal(resInvalidReveal.error, "INVALID_PATH");
    });

    it("3.6 ScreenshotsCommand 双栏详情 (<List.Item.Detail>) 与 7 大 Action 全量挂载", async () => {
      const root = renderDeclarativeRoot(ScreenshotsCommand);
      let desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.equal(desc.props.isShowingDetail, false, "布局三模式启用 workbenchPanel + subList");
      assert.ok(desc.props.workbenchPanel, "必须挂载左侧参数工作台 workbenchPanel");
      assert.ok(desc.props.subList, "必须挂载右侧截图队列 subList");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");

      const section = desc.children[0];
      assert.ok(section.children.length >= 1);
      const item = section.children[0];

      // 1. 验证双栏详情 <List.Item.Detail>
      const detail = item.props.detail;
      assert.ok(detail, "每个截图项必须挂载 detail");
      assert.equal(detail.type, "List.Item.Detail");
      assert.match(detail.props.markdown, /OCR 文字提取识别/);
      assert.match(detail.props.markdown, /!\[.*?\]\(data:image\/svg\+xml/);

      // 2. 验证 Detail Metadata
      const meta = detail.props.metadata;
      assert.ok(meta);
      assert.equal(meta.type, "Detail.Metadata");

      // 3. 验证 7 大 ActionPanel 动作
      const actionPanel = item.props.actions;
      assert.equal(actionPanel.type, "ActionPanel");
      const actions = actionPanel.children;
      const titles = actions.map((a) => a.props.title);

      assert.ok(titles.some((t) => t.includes("粘贴到活动窗口")));
      assert.ok(titles.some((t) => t.includes("复制图片本身")));
      assert.ok(titles.some((t) => t.includes("复制图片本地路径")));
      assert.ok(titles.some((t) => t.includes("复制提取的文字")));
      assert.ok(titles.some((t) => t.includes("在资源管理器中定位")));
      assert.ok(titles.some((t) => t.includes("用默认图片查看器打开")));
      assert.ok(titles.some((t) => t.includes("删除此截图")));

      // 4. 触发粘贴动作
      const pasteAction = actions.find((a) => a.props.title.includes("粘贴到活动窗口"));
      await pasteAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      // 5. 触发复制 OCR 文字动作
      const copyOcrAction = actions.find((a) => a.props.title.includes("复制提取的文字"));
      await copyOcrAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      root.unmount();
    });

    it("3.7 ScreenshotDetailView 独立路由视图测试", () => {
      const mockItem = INITIAL_SCREENSHOTS[0];
      const view = ScreenshotDetailView({ item: mockItem });

      assert.equal(view.type, "Detail");
      assert.match(view.props.navigationTitle, /Screenshot_/);
      assert.match(view.props.markdown, /识别提取文字/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });
});
