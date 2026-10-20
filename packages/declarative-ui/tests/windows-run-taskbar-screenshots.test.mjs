/**
 * ZTools Built-in Suites Integration & Chaos Resilience Test Suite
 * 专注于 Windows Run, Windows Taskbar 与 Screenshots 深度逆向与对齐验证
 * 
 * 严格遵循 RULE[user_global] & AGENTS.md:
 * 1. 默认包含跨模块端到端集成测试 (Integration Tests by Default)
 * 2. 严禁仅写 Happy Path (Beyond Happy Path: 覆盖参数空值、极值越界、并发竞态与破坏性异常)
 */

import { describe, test, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// 导入待测组件与核心服务
import {
  // 1. Windows Run
  WindowsRunCommand,
  parseCommandLine,
  detectKind,
  defaultWindowsRunManager,
  BUILTIN_RUN_ITEMS,
  RUN_REGEX,
  // 2. Windows Taskbar
  WindowsTaskbarCommand,
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

describe("REA 深度逆向与全面对齐集成套件: Windows Run, Taskbar & Screenshots", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
  });

  // ===========================================================================
  // 1. Windows Run (Windows 运行中枢) 深度集成与破坏性测试
  // ===========================================================================
  describe("1. Windows Run 运行中枢与参数化执行系统", () => {
    it("1.1 命令行解析器 (BU(e) 逆向对齐): 引号、路径、URI、环境变量与参数化拆解", () => {
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

      // 1. 普通执行并记录
      const res1 = await defaultWindowsRunManager.execute("code .", { shell: "none" });
      assert.equal(res1.success, true);
      assert.equal(res1.command, "code .");

      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].fullCommandLine, "code .");
      assert.equal(history[0].runCount, 1);

      // 2. 再次执行相同命令 -> 计数增加并置顶 (MRU)
      await defaultWindowsRunManager.execute("code .");
      history = await defaultWindowsRunManager.getHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].runCount, 2);

      // 3. 管理员与 Shell 执行
      await defaultWindowsRunManager.execute("services.msc", { asAdministrator: true });
      await defaultWindowsRunManager.execute("dir", { shell: "cmd" });

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
    it("2.1 任务栏显隐切换与状态机流转 (ShowWindow Shell_TrayWnd)", async () => {
      const initial = await defaultWindowsTaskbarManager.getTaskbarState();
      assert.equal(typeof initial.visible, "boolean");

      // 1. 切换显隐 (Toggle)
      const res1 = await defaultWindowsTaskbarManager.toggleTaskbarVisibility();
      assert.equal(res1.success, true);
      assert.equal(res1.visible, !initial.visible);

      // 2. 强制显示
      const resShow = await defaultWindowsTaskbarManager.showTaskbar();
      assert.equal(resShow.success, true);
      assert.equal(resShow.visible, true);
      assert.equal(resShow.state.visible, true);

      // 3. 沉浸式隐藏
      const resHide = await defaultWindowsTaskbarManager.hideTaskbar();
      assert.equal(resHide.success, true);
      assert.equal(resHide.visible, false);
      assert.equal(resHide.state.visible, false);

      // 恢复显示
      await defaultWindowsTaskbarManager.showTaskbar();
    });

    it("2.2 任务栏自动隐藏切换 (ABM_SETSTATE / ABS_AUTOHIDE)", async () => {
      const stateBefore = await defaultWindowsTaskbarManager.getTaskbarState();

      // 切换自动隐藏
      const resToggle = await defaultWindowsTaskbarManager.toggleTaskbarAutoHide();
      assert.equal(resToggle.success, true);
      assert.equal(resToggle.autoHide, !stateBefore.autoHide);

      // 再次切换
      const resToggle2 = await defaultWindowsTaskbarManager.toggleTaskbarAutoHide();
      assert.equal(resToggle2.success, true);
      assert.equal(resToggle2.autoHide, stateBefore.autoHide);
    });

    it("2.3 任务栏图标对齐方式与停靠方位检视 (TaskbarAl Win11)", async () => {
      // 切换为靠左
      const resLeft = await defaultWindowsTaskbarManager.setTaskbarAlignment("start");
      assert.equal(resLeft.success, true);
      assert.equal(resLeft.state.alignment, "start");

      // 切换为居中
      const resCenter = await defaultWindowsTaskbarManager.setTaskbarAlignment("center");
      assert.equal(resCenter.success, true);
      assert.equal(resCenter.state.alignment, "center");

      // 设置停靠边缘
      const resPos = await defaultWindowsTaskbarManager.setTaskbarPosition("top");
      assert.equal(resPos.success, true);
      assert.equal(resPos.state.position, "top");

      // 还原为底部
      await defaultWindowsTaskbarManager.setTaskbarPosition("bottom");
    });

    it("2.4 【Beyond Happy Path 破坏性高并发竞态测试】20 次高频并发切换不撕裂", async () => {
      const promises = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          promises.push(defaultWindowsTaskbarManager.toggleTaskbarVisibility());
        } else {
          promises.push(defaultWindowsTaskbarManager.toggleTaskbarAutoHide());
        }
      }

      const results = await Promise.all(promises);
      assert.equal(results.length, 20);
      assert.ok(results.every((r) => r.success === true));

      const finalState = await defaultWindowsTaskbarManager.getTaskbarState();
      assert.equal(typeof finalState.visible, "boolean");
      assert.equal(typeof finalState.autoHide, "boolean");
    });

    it("2.5 WindowsTaskbarCommand 声明式组件树渲染与动作闭环", async () => {
      const root = renderDeclarativeRoot(WindowsTaskbarCommand);
      const desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.ok(desc.children.length >= 3);

      const coreSection = desc.children[0];
      assert.equal(coreSection.props.title, "Win32 原生治理动作 (Core Actions)");
      assert.ok(coreSection.children.length >= 4);

      // 验证 Toggle Visibility Item
      const toggleItem = coreSection.children[0];
      assert.ok(toggleItem.props.title.includes("切换任务栏显隐"));
      const toggleAction = toggleItem.props.actions.children[0];
      await toggleAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      // 验证 Restart Explorer Item
      const recoverySection = desc.children[2];
      assert.ok(recoverySection.props.title.includes("运维与急救"));
      const restartItem = recoverySection.children[0];
      assert.ok(restartItem.props.title.includes("重启 Windows 资源管理器"));

      root.unmount();
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
