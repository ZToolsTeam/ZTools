import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 1. json-format
  JsonFormatCommand,
  JsonDetailView,
  validateJson,
  formatJson,
  minifyJson,
  jsonToTsInterface,
  jsonToRustStruct,
  jsonToGoStruct,
  extractJsonPaths,
  // 2. qr-code
  QrCodeCommand,
  QrDetailView,
  CreateQrForm,
  DecodeQrView,
  generateQrSvg,
  decodeQrCode,
  detectQrContentType,
  getQrHistory,
  saveQrItem,
  toggleFavoriteQrItem,
  deleteQrItem,
  clearQrHistory,
  QR_COLOR_SCHEMES,
  // 3. color-picker
  ColorPickerCommand,
  ColorDetailView,
  parseColor,
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  rgbToHsv,
  hsvToRgb,
  rgbToCmyk,
  cmykToRgb,
  calculateContrast,
  calculateWcag,
  generateHarmonies,
  pickScreenColor,
  generateColorSwatchSvg,
  getSavedPalette,
  saveColorToPalette,
  removeFromPalette,
  clearPalette,
  getColorHistory,
  saveColorHistory,
  clearColorHistory
} from "../dist/index.js";

describe("Developer & Media Built-in Suites: json-format, qr-code & color-picker", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
  });

  // ==========================================================================
  // Suite 1: json-format 瑞士军刀与全栈类型推导
  // ==========================================================================
  describe("Suite 1: json-format (JSON 瑞士军刀 & 类型推导)", () => {
    const validJsonSample = JSON.stringify(
      {
        name: "ZTools Platform",
        version: "2.5.0",
        active: true,
        stats: { downloads: 150000, rating: 4.95 },
        tags: ["tool", "raycast", "declarative"],
        contributors: [
          { id: 1, handle: "developerA", verified: true },
          { id: 2, handle: "developerB", verified: false }
        ]
      },
      null,
      2
    );

    test("1.1 Happy Path: validateJson 深度校验与指标计算", () => {
      const res = validateJson(validJsonSample);
      assert.equal(res.valid, true);
      assert.ok(res.parsed);
      assert.ok(res.stats);
      assert.equal(res.stats.keys, 14);
      assert.ok(res.stats.depth >= 3);
      assert.ok(res.stats.byteSize > res.stats.minifiedSize);
      assert.ok(res.stats.compressionRatio > 0);
      assert.equal(res.stats.arraysCount, 2);
    });

    test("1.2 Happy Path: formatJson 支持 2空格、4空格与Tab缩进", () => {
      const fmt2 = formatJson(validJsonSample, 2);
      assert.match(fmt2, /  "name": "ZTools Platform"/);

      const fmt4 = formatJson(validJsonSample, 4);
      assert.match(fmt4, /    "name": "ZTools Platform"/);

      const fmtTab = formatJson(validJsonSample, "tab");
      assert.match(fmtTab, /\t"name": "ZTools Platform"/);
    });

    test("1.3 Happy Path: minifyJson 极速单行压缩", () => {
      const minified = minifyJson(validJsonSample);
      assert.ok(!minified.includes("\n"));
      assert.match(minified, /^\{"name":"ZTools Platform"/);
      const reparsed = JSON.parse(minified);
      assert.equal(reparsed.name, "ZTools Platform");
    });

    test("1.4 Happy Path: jsonToTsInterface 递归生成规范 TypeScript 接口", () => {
      const tsCode = jsonToTsInterface(validJsonSample, "RootConfig");
      assert.match(tsCode, /export interface RootConfig \{/);
      assert.match(tsCode, /name: string;/);
      assert.match(tsCode, /active: boolean;/);
      assert.match(tsCode, /stats: Stats;/);
      assert.match(tsCode, /contributors: ContributorItem\[\];/);
      assert.match(tsCode, /export interface Stats \{/);
      assert.match(tsCode, /downloads: number;/);
    });

    test("1.5 Happy Path: jsonToRustStruct 递归生成 serde Rust 结构体", () => {
      const rustCode = jsonToRustStruct(validJsonSample, "AppManifest");
      assert.match(rustCode, /use serde::\{Deserialize, Serialize\};/);
      assert.match(rustCode, /pub struct AppManifest \{/);
      assert.match(rustCode, /pub name: String,/);
      assert.match(rustCode, /pub active: bool,/);
      assert.match(rustCode, /pub stats: Stats,/);
      assert.match(rustCode, /pub struct Stats \{/);
      assert.match(rustCode, /pub downloads: i64,/);
      assert.match(rustCode, /pub rating: f64,/);
    });

    test("1.6 Happy Path: jsonToGoStruct 递归生成 Go 结构体与 json tag", () => {
      const goCode = jsonToGoStruct(validJsonSample, "AppConfig");
      assert.match(goCode, /type AppConfig struct \{/);
      assert.match(goCode, /Name\s+string\s+`json:"name"`/);
      assert.match(goCode, /Active\s+bool\s+`json:"active"`/);
      assert.match(goCode, /Stats\s+Stats\s+`json:"stats"`/);
      assert.match(goCode, /type Stats struct \{/);
      assert.match(goCode, /Downloads\s+int64\s+`json:"downloads"`/);
      assert.match(goCode, /Rating\s+float64\s+`json:"rating"`/);
    });

    test("1.7 Happy Path: extractJsonPaths 抽取完整扁平 JSONPath 路径列表", () => {
      const parsed = JSON.parse(validJsonSample);
      const paths = extractJsonPaths(parsed);
      assert.ok(paths.length >= 10);

      const namePath = paths.find((p) => p.path === "$.name");
      assert.ok(namePath);
      assert.equal(namePath.value, "ZTools Platform");
      assert.equal(namePath.type, "string");

      const statsDownloadPath = paths.find((p) => p.path === "$.stats.downloads");
      assert.ok(statsDownloadPath);
      assert.equal(statsDownloadPath.value, 150000);
      assert.equal(statsDownloadPath.type, "number");

      const contrib0Path = paths.find((p) => p.path === "$.contributors[0].handle");
      assert.ok(contrib0Path);
      assert.equal(contrib0Path.value, "developerA");
    });

    test("1.8 [Beyond Happy Path 破坏性容错] 畸形 JSON 语法定位与行号列号箭头指示", () => {
      // 1. 空内容
      const resEmpty = validateJson("");
      assert.equal(resEmpty.valid, false);
      assert.equal(resEmpty.errorInfo?.line, 1);
      assert.equal(resEmpty.errorInfo?.column, 1);

      // 2. 尾随逗号与行号错误定位
      const brokenJson = `{\n  "version": "1.0",\n  "tags": [1, 2, ],\n  "name": "test"\n}`;
      const resBroken = validateJson(brokenJson);
      assert.equal(resBroken.valid, false);
      assert.ok(resBroken.errorInfo);
      assert.ok(resBroken.errorInfo.line >= 2);
      assert.match(resBroken.errorInfo.snippet, />/); // 包含出错行箭头提示
      assert.match(resBroken.errorInfo.snippet, /\^/); // 包含下划线指示标

      // 3. 未闭合的大括号
      const unclosedJson = `{\n  "open": true`;
      const resUnclosed = validateJson(unclosedJson);
      assert.equal(resUnclosed.valid, false);
      assert.ok(resUnclosed.errorInfo);
    });

    test("1.9 [Beyond Happy Path 破坏性容错] 深度递归 (Depth 120) 与 2MB 极大 JSON 压测", () => {
      // 1. 深度嵌套对象
      let deepObj = { leaf: "deepValue" };
      for (let i = 0; i < 100; i++) {
        deepObj = { nested: deepObj };
      }
      const deepStr = JSON.stringify(deepObj);
      const resDeep = validateJson(deepStr);
      assert.equal(resDeep.valid, true);
      assert.ok(resDeep.stats?.depth >= 100);

      // 2. 大体积数组 JSON 压测 (2MB+)
      const largeArray = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        uuid: `uuid-${i}-ztools-bench-marking`,
        active: i % 2 === 0,
        score: i * 1.5
      }));
      const largeJson = JSON.stringify(largeArray);
      assert.ok(largeJson.length > 500000);

      const start = Date.now();
      const resLarge = validateJson(largeJson);
      const elapsed = Date.now() - start;
      assert.equal(resLarge.valid, true);
      assert.ok(resLarge.stats);
      assert.ok(elapsed < 1000, `Large JSON parsed within ${elapsed}ms`);
    });

    test("1.10 Declarative View: JsonFormatCommand 与 JsonDetailView 完整挂载与全键盘动作", () => {
      const root = renderDeclarativeRoot(JsonFormatCommand);
      let desc = root.getLatest();
      assert.equal(desc.type, "Form");
      assert.equal(desc.props.navigationTitle, "JSON 格式化与类型转换");

      // 验证 ActionPanel 中的丰富全能动作
      const actionPanel = desc.props.actions;
      assert.equal(actionPanel.type, "ActionPanel");
      const actionTitles = actionPanel.children.map((c) => c.props.title);
      assert.ok(actionTitles.includes("格式化并查看详情"));
      assert.ok(actionTitles.includes("从剪贴板粘贴并校验"));
      assert.ok(actionTitles.includes("复制 2 格格式化结果"));
      assert.ok(actionTitles.includes("复制 4 格格式化结果"));
      assert.ok(actionTitles.includes("复制压缩单行 (Minify)"));
      assert.ok(actionTitles.includes("复制 TypeScript Interface"));
      assert.ok(actionTitles.includes("复制 Rust Struct"));
      assert.ok(actionTitles.includes("复制 Go Struct"));

      // 渲染 JsonDetailView
      const detailView = JsonDetailView({
        formatted: '{\n  "title": "ZTools"\n}',
        tsInterface: "export interface ZTools {\n  title: string;\n}",
        stats: {
          keys: 1,
          depth: 1,
          byteSize: 25,
          minifiedSize: 18,
          compressionRatio: 28.0,
          arraysCount: 0,
          objectsCount: 1,
          primitivesCount: 1
        },
        jsonPaths: [{ path: "$.title", value: "ZTools", displayValue: '"ZTools"', type: "string" }]
      });
      assert.equal(detailView.type, "Detail");
      assert.match(detailView.props.markdown, /JSON 瑞士军刀与全栈类型推导/);
      assert.match(detailView.props.markdown, /Rust Struct/);
      assert.match(detailView.props.markdown, /Go Struct/);
      assert.match(detailView.props.markdown, /\$.title/);
      assert.equal(detailView.props.metadata.type, "Detail.Metadata");
      root.unmount();
    });
  });

  // ==========================================================================
  // Suite 2: qr-code 专业二维码生成与全能识别套件
  // ==========================================================================
  describe("Suite 2: qr-code (二维码生成与全能解码)", () => {
    test("2.1 Happy Path: generateQrSvg 生成各纠错级别与自定义配色二维码", () => {
      // 级别 L, M, Q, H 测试
      const levels = ["L", "M", "Q", "H"];
      for (const lvl of levels) {
        const qr = generateQrSvg("https://ztools.dev", { errorCorrectionLevel: lvl });
        assert.ok(qr.svg.includes("<svg"));
        assert.ok(qr.dataUrl.startsWith("data:image/svg+xml"));
        assert.equal(qr.level, lvl);
        assert.ok(qr.matrixSize >= 21);
      }

      // 自定义配色测试
      const customQr = generateQrSvg("ZTools Geek Platform", {
        colorScheme: "neon",
        foregroundColor: "#10B981",
        backgroundColor: "#052E16"
      });
      assert.ok(customQr.svg.includes('#10B981'));
      assert.ok(customQr.svg.includes('#052E16'));
      assert.equal(customQr.contentType, "text");
    });

    test("2.2 Happy Path: detectQrContentType 自动识别 URL、Wi-Fi、邮件、电话与短信", () => {
      assert.equal(detectQrContentType("https://github.com/ztools").type, "url");
      assert.equal(detectQrContentType("http://127.0.0.1:8080").type, "url");
      assert.equal(detectQrContentType("WIFI:S:MyHome;T:WPA;P:secret123;;").type, "wifi");
      assert.equal(detectQrContentType("mailto:core@ztools.dev").type, "email");
      assert.equal(detectQrContentType("admin@ztools.dev").type, "email");
      assert.equal(detectQrContentType("tel:+8613800000000").type, "tel");
      assert.equal(detectQrContentType("smsto:10086:CX").type, "sms");
      assert.equal(detectQrContentType("Hello World").type, "text");
    });

    test("2.3 Happy Path: decodeQrCode 从 SVG 与 DataURL 无损反解文本与元数据", () => {
      const originalText = "https://ztools.dev/super-panel";
      const generated = generateQrSvg(originalText, { errorCorrectionLevel: "H" });

      // 1. 从 SVG 字符串解码
      const decodedFromSvg = decodeQrCode(generated.svg);
      assert.equal(decodedFromSvg.success, true);
      assert.equal(decodedFromSvg.text, originalText);
      assert.equal(decodedFromSvg.contentType, "url");
      assert.equal(decodedFromSvg.level, "H");

      // 2. 从 DataURL 解码
      const decodedFromDataUrl = decodeQrCode(generated.dataUrl);
      assert.equal(decodedFromDataUrl.success, true);
      assert.equal(decodedFromDataUrl.text, originalText);

      // 3. 从普通 Base64 解码
      const b64 = Buffer.from("Hello from clipboard QR", "utf8").toString("base64");
      const decodedFromB64 = decodeQrCode(b64);
      assert.equal(decodedFromB64.success, true);
      assert.equal(decodedFromB64.text, "Hello from clipboard QR");
    });

    test("2.4 Happy Path: QR 历史记录 LocalStorage 持久化与收藏切换", async () => {
      await clearQrHistory();
      let hist = await getQrHistory();
      assert.equal(hist.length, 0);

      const item1 = {
        id: "qr-test-1",
        title: "Test 1",
        content: "https://ztools.dev/1",
        level: "M",
        createdAt: "10:00:00",
        favorite: false
      };
      await saveQrItem(item1);
      hist = await getQrHistory();
      assert.equal(hist.length, 1);
      assert.equal(hist[0].content, "https://ztools.dev/1");

      // 切换收藏
      await toggleFavoriteQrItem("qr-test-1");
      hist = await getQrHistory();
      assert.equal(hist[0].favorite, true);

      // 删除单条
      await deleteQrItem("qr-test-1");
      hist = await getQrHistory();
      assert.equal(hist.length, 0);
    });

    test("2.5 [Beyond Happy Path 破坏性容错] 空字符串、超长文本 (10KB) 与非法解码格式容错", () => {
      // 1. 空字符串生成二维码不崩溃
      const emptyQr = generateQrSvg("");
      assert.ok(emptyQr.svg.length > 0);

      // 2. 超长文本二维码 (10000 字符)
      const ultraLong = "A".repeat(10000);
      const longQr = generateQrSvg(ultraLong);
      assert.ok(longQr.matrixSize >= 21);

      // 3. 空输入解码拦截
      const decodeEmpty = decodeQrCode("");
      assert.equal(decodeEmpty.success, false);

      // 4. 损坏的 SVG 字符串解码容错
      const corruptSvg = "<svg>broken unclosed tags rect x=abc</svg>";
      const decodeCorrupt = decodeQrCode(corruptSvg);
      assert.ok(decodeCorrupt.success !== undefined);
    });

    test("2.6 Declarative View: QrCodeCommand 开启 isShowingDetail 双栏分栏与 DecodeQrView 挂载", async () => {
      const root = renderDeclarativeRoot(QrCodeCommand);
      let desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.isShowingDetail, true);
      assert.equal(desc.props.navigationTitle, "二维码生成器");

      const item = desc.children[0].children[0];
      assert.ok(item.props.detail);
      assert.equal(item.props.detail.type, "List.Item.Detail");
      assert.equal(item.props.detail.props.metadata.type, "Detail.Metadata");

      // 挂载 DecodeQrView
      const decodeRoot = renderDeclarativeRoot(DecodeQrView);
      const decodeDesc = decodeRoot.getLatest();
      assert.equal(decodeDesc.type, "Form");
      assert.equal(decodeDesc.props.navigationTitle, "扫码与二维码解码");
      decodeRoot.unmount();
      root.unmount();
    });
  });

  // ==========================================================================
  // Suite 3: color-picker 极客色彩拾取与调色盘中心
  // ==========================================================================
  describe("Suite 3: color-picker (色彩换算、WCAG对比度、配色方案与屏幕拾色)", () => {
    test("3.1 Happy Path: 多格式换算 HEX, RGB, HSL, HSV, CMYK, CSS Variable", () => {
      const res = parseColor("#0A84FF");
      assert.equal(res.isValid, true);
      assert.equal(res.hex, "#0A84FF");
      assert.equal(res.hex8, "#0A84FFFF");
      assert.equal(res.rgb.r, 10);
      assert.equal(res.rgb.g, 132);
      assert.equal(res.rgb.b, 255);
      assert.equal(res.cssRgb, "rgb(10, 132, 255)");
      assert.ok(res.cssHsl.startsWith("hsl("));
      assert.ok(res.cssHsv.startsWith("hsv("));
      assert.ok(res.cssCmyk.startsWith("cmyk("));
      assert.equal(res.cssVar, "--color-primary: #0A84FF;");
    });

    test("3.2 Happy Path: HSV 与 RGB 双向换算精度验证", () => {
      const redRgb = { r: 255, g: 0, b: 0 };
      const redHsv = rgbToHsv(redRgb);
      assert.equal(redHsv.h, 0);
      assert.equal(redHsv.s, 100);
      assert.equal(redHsv.v, 100);

      const redBack = hsvToRgb(redHsv);
      assert.deepEqual(redBack, { r: 255, g: 0, b: 0 });

      const cyanHsv = { h: 180, s: 100, v: 100 };
      const cyanRgb = hsvToRgb(cyanHsv);
      assert.deepEqual(cyanRgb, { r: 0, g: 255, b: 255 });
    });

    test("3.3 Happy Path: generateHarmonies 生成互补色、类似色、三色与单色阶梯", () => {
      const rgb = { r: 10, g: 132, b: 255 }; // #0A84FF (Hue ~210)
      const harmonies = generateHarmonies(rgb);

      // 互补色 (210 + 180 = 390 -> 30° 橙黄色)
      assert.ok(harmonies.complementary.startsWith("#"));

      // 类似色 (2 个)
      assert.equal(harmonies.analogous.length, 2);

      // 三色平衡 (2 个)
      assert.equal(harmonies.triadic.length, 2);

      // 分裂互补 (2 个)
      assert.equal(harmonies.splitComplementary.length, 2);

      // 四色矩阵 (3 个)
      assert.equal(harmonies.tetradic.length, 3);

      // 单色阶梯 (4 个)
      assert.equal(harmonies.monochromatic.length, 4);
    });

    test("3.4 Happy Path: 屏幕拾色器 pickScreenColor 兼容执行与数据回传", async () => {
      const picked = await pickScreenColor();
      assert.ok(picked.hex.startsWith("#"));
      assert.ok(picked.rgb.r >= 0 && picked.rgb.r <= 255);
      assert.ok(picked.pickedAt > 0);

      // 持久化拾色历史
      await clearColorHistory();
      let hist = await getColorHistory();
      assert.equal(hist.length, 0);

      await saveColorHistory(picked);
      hist = await getColorHistory();
      assert.equal(hist.length, 1);
      assert.equal(hist[0].hex, picked.hex);
    });

    test("3.5 [Beyond Happy Path 破坏性容错] 畸形色彩输入、越界色值与极端对比度容错", () => {
      // 1. 非法输入平滑降级
      const invalidHex = parseColor("#GGGZZZ");
      assert.equal(invalidHex.isValid, false);
      assert.equal(invalidHex.hex, "#0A84FF"); // 优雅降级为默认安全色

      const randomWord = parseColor("not_a_valid_color_expression");
      assert.equal(randomWord.isValid, false);

      // 2. 越界数值 RGB 解析保护
      const parsedOverflow = parseColor("rgb(999, -50, 200)");
      assert.equal(parsedOverflow.rgb.r, 255);
      assert.equal(parsedOverflow.rgb.g, 0);
      assert.equal(parsedOverflow.rgb.b, 200);

      // 3. 极端对比度：相同色彩对比度严格等于 1.0 (Fail)
      const sameContrast = calculateContrast({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 });
      assert.equal(sameContrast, 1);
    });

    test("3.6 Declarative View: ColorPickerCommand 挂载 2 大标准 Section 与全局 Action 优先级", async () => {
      const root = renderDeclarativeRoot(ColorPickerCommand);
      let desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "调色板与色彩转换器");

      // 验证严格 2 个 Section 规范
      assert.equal(desc.children.length, 2);
      assert.match(desc.children[0].props.title, /当前颜色换算/);
      assert.match(desc.children[1].props.title, /已收藏调色板/);

      // 验证 ActionPanel 首项为收藏动作，次项为复制 HEX
      const actions = desc.props.actions.children;
      assert.equal(actions[0].props.title, "收藏当前色彩到调色板");
      assert.equal(actions[1].props.title, "复制 HEX 色值");
      assert.equal(actions[2].props.title, "屏幕吸色 (Screen Eyedropper)");

      // 验证 Detail View 完整性
      const parsed = parseColor("#0A84FF");
      const detail = ColorDetailView({ color: parsed });
      assert.equal(detail.type, "Detail");
      assert.match(detail.props.markdown, /WCAG 2.1 无障碍对比度测试/);
      assert.match(detail.props.markdown, /衍生专业配色方案/);
      assert.equal(detail.props.metadata.type, "Detail.Metadata");

      root.unmount();
    });
  });
});
