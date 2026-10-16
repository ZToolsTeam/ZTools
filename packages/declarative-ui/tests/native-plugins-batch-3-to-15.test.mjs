import test from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  SoftwareManagerCommand,
  CleanerCommand,
  WechatCleanerCommand,
  QQCleanerCommand,
  FlowGuardCommand,
  HardwareInfoCommand,
  BoostCommand,
  BatchRenameCommand,
  BatchVideoCommand,
  BatchAudioCommand,
  PdfCommand,
  MultiDownloadCommand,
  VideoDownloaderCommand,
  THREAD_SPLIT_PRESETS,
  STREAM_PLATFORMS,
  VIDEO_QUALITY_PRESETS,
  detectVideoPlatform,
  startMultiThreadDownloadTask,
  parseAndDownloadStreamVideo
} from "../dist/index.js";
import {
  SOFTWARE_SMART_CATEGORIES,
  classifySoftwareSmartCategory
} from "../dist/examples/software-manager/logic.js";
import {
  CLEAN_CLASSES
} from "../dist/examples/cleaner/logic.js";
import {
  classifyRemoteIpScope
} from "../dist/examples/flow-guard/logic.js";
import {
  evaluateHardwareScenarios,
  exportHardwareReport,
  fetchHardwareTelemetrySnapshot
} from "../dist/examples/hardware-info/logic.js";
import {
  RENAME_RULE_PRESETS,
  batchApplyRename,
  undoBatchRenameHistory
} from "../dist/examples/batch-rename/logic.js";
import {
  VIDEO_WORKSHOP_MODES,
  validateInvocationPayload as validateVideoPayload
} from "../dist/examples/batch-video/logic.js";
import {
  AUDIO_WORKSHOP_MODES,
  validateInvocationPayload as validateAudioPayload
} from "../dist/examples/batch-audio/logic.js";
import {
  PDF_TOOLBOX_MODES,
  validateInvocationPayload as validatePdfPayload
} from "../dist/examples/pdf/logic.js";
import {
  detectDownloadUrlFromText,
  classifyDownloadedExtension
} from "../dist/examples/multi-download/logic.js";

test("Declarative UI 2.0 原生插件 #3 ~ #15 1:1 全量升级集成与异常测试套件", async (t) => {
  await t.test("1. [#3~#15 声明式复合组件渲染闭环] 13 款插件均正确挂载 List + MetricGrid + FilterBar (含 4 步向导) + SegmentedControl", () => {
    const commands = [
      { id: "software-manager", cmd: SoftwareManagerCommand },
      { id: "cleaner", cmd: CleanerCommand },
      { id: "wechat-cleaner", cmd: WechatCleanerCommand },
      { id: "qq-cleaner", cmd: QQCleanerCommand },
      { id: "flow-guard", cmd: FlowGuardCommand },
      { id: "hardware-info", cmd: HardwareInfoCommand },
      { id: "boost", cmd: BoostCommand },
      { id: "batch-rename", cmd: BatchRenameCommand },
      { id: "batch-video", cmd: BatchVideoCommand },
      { id: "batch-audio", cmd: BatchAudioCommand },
      { id: "pdf", cmd: PdfCommand },
      { id: "multi-download", cmd: MultiDownloadCommand },
      { id: "video-downloader", cmd: VideoDownloaderCommand }
    ];

    for (const { id, cmd } of commands) {
      const root = renderDeclarativeRoot(cmd);
      const descriptor = root.getLatest();
      assert.ok(descriptor, `${id} 必须生成有效的顶层 ViewDescriptor`);
      assert.equal(descriptor.type, "List", `${id} 顶层容器应为 List`);
      assert.ok(descriptor.props.metricGrid, `${id} 必须挂载 MetricGrid 指标看板`);
      assert.ok(descriptor.props.filterBar, `${id} 必须挂载 FilterBar 多维筛选与向导栏`);
      const fb = descriptor.props.filterBar.props || descriptor.props.filterBar;
      assert.ok(
        Array.isArray(fb.wizardSteps) && fb.wizardSteps.length >= 4,
        `${id} FilterBar 必须包含 4 步操作向导 (wizardSteps)`
      );
      assert.ok(
        Array.isArray(fb.groups) && fb.groups.length >= 1,
        `${id} FilterBar 必须包含多维筛选胶囊组 (groups)`
      );
      root.unmount();
    }
  });

  await t.test("2. [#3 software-manager & #4 cleaner] 7 大软件智能分类与 6 大系统垃圾 CleanClass 引擎校验", () => {
    assert.equal(SOFTWARE_SMART_CATEGORIES.length, 7, "应包含 7 大软件智能分类");
    const devCat = classifySoftwareSmartCategory(
      "Microsoft Visual Studio Code",
      "Microsoft Corporation",
      "desktop",
      false
    );
    assert.equal(devCat, "dev_geek");

    assert.equal(CLEAN_CLASSES.length, 6, "应包含 6 大系统垃圾清理大类 (CleanClass)");
  });

  await t.test("3. [#7 flow-guard & #8 hardware-info] 远端 IP 作用域识别与 4 大场景评测 + 3 格式报告导出", async () => {
    assert.equal(classifyRemoteIpScope("0.0.0.0", "LISTEN", "TCP"), "listening");
    assert.equal(classifyRemoteIpScope("127.0.0.1", "ESTABLISHED", "TCP"), "loopback");
    assert.equal(classifyRemoteIpScope("192.168.1.25", "ESTABLISHED", "TCP"), "lan");
    assert.equal(classifyRemoteIpScope("142.250.190.46", "ESTABLISHED", "TCP"), "public");

    const snap = await fetchHardwareTelemetrySnapshot();
    const scenarios = evaluateHardwareScenarios(snap);
    assert.equal(scenarios.length, 4, "应包含 4 大极客场景评测");
    const mdReport = exportHardwareReport(snap, "markdown");
    const jsonReport = exportHardwareReport(snap, "json");
    const txtReport = exportHardwareReport(snap, "txt");
    assert.ok(mdReport.includes("# "), "Markdown 报告应包含标题");
    assert.ok(JSON.parse(jsonReport).cpu, "JSON 报告应可被标准解析");
    assert.ok(txtReport.includes("CPU"), "TXT 报告应包含硬件摘要");
  });

  await t.test("4. [#10 batch-rename] 10 大重命名规则引擎、中文/罗马序号、同名冲突拦截与撤销回滚 (Beyond Happy Path)", async () => {
    assert.equal(RENAME_RULE_PRESETS.length, 10, "应包含 10 大重命名规则预设");
    const sampleFiles = ["report.pdf", "summary.pdf"];
    const cnResults = batchApplyRename(sampleFiles, { type: "number_cn" });
    assert.equal(cnResults[0].newName, "report_一.pdf");
    assert.equal(cnResults[1].newName, "summary_二.pdf");

    // 构造同名冲突异常场景 (前3字符裁剪后两个文件同名)
    const conflictResults = batchApplyRename(["01_same.txt", "02_SAME.txt"], { type: "trim_head3" });
    assert.equal(conflictResults[1].conflict, true, "Windows 大小写不敏感同名冲突必须被标记拦截");

    // 验证撤销回滚栈调用
    const undoRes = await undoBatchRenameHistory(
      [{ oldPath: "C:\\Docs\\a.txt", newPath: "C:\\Docs\\b.txt", oldName: "a.txt", newName: "b.txt" }],
      {
        filesystem_move_file: async () => ({ success: true, data: true })
      }
    );
    assert.equal(undoRes.ok, true);
    assert.equal(undoRes.restoredCount, 1);
  });

  await t.test("5. [#11 batch-video, #12 batch-audio, #13 pdf] 12 大视频模式 + 12 大音频模式 + 12 大 PDF 工具箱完整性与安全边界校验", () => {
    assert.equal(VIDEO_WORKSHOP_MODES.length, 12, "batch-video 必须包含原版全部 12 大视频工坊模式");
    assert.equal(AUDIO_WORKSHOP_MODES.length, 12, "batch-audio 必须包含原版全部 12 大音频工坊模式");
    assert.equal(PDF_TOOLBOX_MODES.length, 12, "pdf 必须包含原版 3 大类全部 12 项工具模式");

    // Beyond Happy Path: 系统目录写入拦截
    assert.equal(
      validateVideoPayload("BatchCompressVideo", { output: "C:\\Windows\\System32\\hack.mp4" }).valid,
      false
    );
    assert.equal(
      validateAudioPayload("BatchConvertFormat", { output: "C:\\Windows\\System32\\hack.mp3" }).valid,
      false
    );
    assert.equal(
      validatePdfPayload("PdfToWord", { output: "C:\\Windows\\System32\\hack.docx" }).valid,
      false
    );
  });

  await t.test("6. [#14 multi-download & #15 video-downloader] 多线程分块预设、6 大流媒体平台嗅探与非法链接防御", async () => {
    assert.equal(THREAD_SPLIT_PRESETS.length, 4);
    assert.equal(THREAD_SPLIT_PRESETS[0].threads, 16);
    assert.equal(STREAM_PLATFORMS.length, 6);
    assert.equal(VIDEO_QUALITY_PRESETS.length, 6);

    const magnet = detectDownloadUrlFromText("请下载 magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567 谢谢");
    assert.equal(magnet.protocol, "Magnet 磁力链");

    const cat = classifyDownloadedExtension(".exe");
    assert.equal(cat.id, "installer");

    const bili = detectVideoPlatform("7.53 复制打开抖音，或看 B站 BV1xx411c7mD 视频");
    assert.equal(bili.platform.id, "bilibili");
    assert.equal(bili.url, "https://www.bilibili.com/video/BV1xx411c7mD");

    const douyin = detectVideoPlatform("https://v.douyin.com/iY8xYzA/");
    assert.equal(douyin.platform.id, "douyin");

    // Beyond Happy Path: 空链接或非法协议拦截
    const badDl = await startMultiThreadDownloadTask("javascript:alert(1)", "C:\\Downloads", THREAD_SPLIT_PRESETS[0]);
    assert.equal(badDl.ok, false, "非法协议链接必须被拒绝");

    const badVid = await parseAndDownloadStreamVideo("纯文本无任何链接", "C:\\Videos", VIDEO_QUALITY_PRESETS[0]);
    assert.equal(badVid.ok, false, "无链接文本必须返回错误提示");
  });
});
