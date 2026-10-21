import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  ColorPickerCommand,
  ColorDetailView,
  parseColor,
  rgbToHsv,
  hsvToRgb,
  calculateContrast,
  generateHarmonies,
  pickScreenColor,
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
