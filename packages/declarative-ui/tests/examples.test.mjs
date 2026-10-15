import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateJson,
  formatJson,
  minifyJson,
  jsonToTsInterface,
  JsonFormatCommand,
  generateQrSvg,
  QrCodeCommand,
  renderDeclarativeRoot
} from "../dist/index.js";

describe("Raycast Ported Applications", () => {
  describe("json-format", () => {
    test("validateJson should validate correct and incorrect JSON", () => {
      const good = '{"name": "ZTools", "version": 1, "active": true, "list": [1, 2]}';
      const resGood = validateJson(good);
      assert.equal(resGood.valid, true);
      assert.equal(resGood.stats?.keys, 4);
      assert.equal(resGood.stats?.depth, 3);

      const bad = '{"name": "Broken", }';
      const resBad = validateJson(bad);
      assert.equal(resBad.valid, false);
      assert.ok(resBad.error);
    });

    test("formatJson & minifyJson should transform JSON strings accurately", () => {
      const raw = '{"a":1,"b":2}';
      const formatted = formatJson(raw, 2);
      assert.equal(formatted, '{\n  "a": 1,\n  "b": 2\n}');

      const minified = minifyJson(formatted);
      assert.equal(minified, '{"a":1,"b":2}');
    });

    test("jsonToTsInterface should generate valid TypeScript interfaces", () => {
      const sample = JSON.stringify({
        id: "abc",
        count: 42,
        enabled: true,
        user: {
          username: "alice",
          tags: ["admin", "dev"]
        }
      });

      const ts = jsonToTsInterface(sample, "UserConfig");
      assert.match(ts, /export interface UserConfig {/);
      assert.match(ts, /id: string;/);
      assert.match(ts, /count: number;/);
      assert.match(ts, /enabled: boolean;/);
      assert.match(ts, /export interface User {/);
      assert.match(ts, /username: string;/);
      assert.match(ts, /tags: string\[\];/);
    });

    test("JsonFormatCommand should render Form and provide action panel", () => {
      const root = renderDeclarativeRoot(JsonFormatCommand);
      const descriptor = root.getLatest();
      assert.equal(descriptor.type, "Form");
      assert.equal(descriptor.props.navigationTitle, "JSON 格式化与类型转换");
      assert.equal(descriptor.props.actions.type, "ActionPanel");
      assert.ok(descriptor.props.actions.children.length >= 3);
      assert.equal(descriptor.children.length, 2);
      root.unmount();
    });
  });

  describe("qr-code", () => {
    test("generateQrSvg should generate valid SVG and dataUrl", () => {
      const { svg, dataUrl, matrixSize } = generateQrSvg("https://ztools.dev", {
        size: 200,
        errorCorrectionLevel: "M"
      });

      assert.ok(matrixSize >= 21);
      assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
      assert.match(svg, /<rect/);
      assert.match(dataUrl, /^data:image\/svg\+xml;utf8,/);
    });

    test("QrCodeCommand should render List with initial history and actions", () => {
      const root = renderDeclarativeRoot(QrCodeCommand);
      const descriptor = root.getLatest();
      assert.equal(descriptor.type, "List");
      assert.equal(descriptor.props.navigationTitle, "二维码生成器");
      assert.equal(descriptor.children.length, 1);

      const section = descriptor.children[0];
      assert.equal(section.type, "List.Section");
      assert.ok(section.children.length >= 2);

      const firstItem = section.children[0];
      assert.equal(firstItem.type, "List.Item");
      assert.equal(firstItem.props.title, "ZTools 官方主页");
      assert.equal(firstItem.props.actions.type, "ActionPanel");
      root.unmount();
    });
  });
});
