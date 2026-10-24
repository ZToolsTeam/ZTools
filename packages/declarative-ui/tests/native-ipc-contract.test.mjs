/**
 * examples/shared/native-ipc.ts 与宿主方法契约的对齐测试（含故障注入）
 *
 * - dllplugin_call 只发 plugin / func / params（宿主 validateDllPluginCall 会拒绝多余字段）；
 * - 没有宿主、也没有离线数据时如实返回不可达，不再返回 simulated 成功；
 * - 写剪贴板走宿主真实方法 clipboard_copy_text，宿主失败时返回 false；
 * - 文件 SHA-256 只认宿主给出的哈希（filesearch_sha256 的 fullPath 字段 / FileComparePlugin），
 *   拿不到时返回空串，不再把文件按 utf8 文本读出来再算（二进制文件得到的不是真实哈希）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  invokeDllPluginCapability,
  writeRealClipboardText,
  computeRealFileSha256
} from "../dist/examples/shared/native-ipc.js";

const SHA_A = "a".repeat(64);

describe("native-ipc 宿主契约", () => {
  test("dllplugin_call 只带 plugin / func / params，内层结果原样解包", async () => {
    const calls = [];
    const host = {
      dllplugin_call: async (params) => {
        calls.push(params);
        return { success: true, data: JSON.stringify({ code: 0, value: 42 }) };
      }
    };
    const res = await invokeDllPluginCapability("HardwareInfoPlugin", " getCpu ", { detail: true }, host);
    assert.equal(res.ok, true);
    assert.equal(res.fromFallback, false);
    assert.equal(res.data.value, 42);
    assert.deepEqual(calls, [{ plugin: "HardwareInfoPlugin", func: "getCpu", params: { detail: true } }]);
  });

  test("[故障] 没有宿主、没有离线数据：ok:false 且不含 simulated 数据", async () => {
    const res = await invokeDllPluginCapability("HardwareInfoPlugin", "getCpu", {});
    assert.equal(res.ok, false);
    assert.equal(res.fromFallback, true);
    assert.equal(res.data, null);
    assert.match(res.error, /^HOST_UNAVAILABLE/);

    // 调用方提供了离线数据时照常使用，并标记 fromFallback
    const offline = await invokeDllPluginCapability("HardwareInfoPlugin", "getCpu", {}, undefined, () => ({ cached: true }));
    assert.equal(offline.ok, true);
    assert.equal(offline.fromFallback, true);
    assert.deepEqual(offline.data, { cached: true });
  });

  test("[故障] 宿主拒绝 / 抛错 / DLL 内层报错：如实失败", async () => {
    const rejected = await invokeDllPluginCapability("P", "f", {}, {
      dllplugin_call: async () => ({ success: false, error: { code: "INVALID_REQUEST", message: "方法参数包含未知字段" } })
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /方法参数包含未知字段/);

    const thrown = await invokeDllPluginCapability("P", "f", {}, {
      dllplugin_call: async () => { throw new Error("IPC 断开"); }
    });
    assert.equal(thrown.ok, false);
    assert.match(thrown.error, /IPC 断开/);

    const innerError = await invokeDllPluginCapability("P", "f", {}, {
      dllplugin_call: async () => ({ success: true, data: JSON.stringify({ error: "ACCESS_DENIED" }) })
    });
    assert.equal(innerError.ok, false);
    assert.match(innerError.error, /DLL_ERROR: ACCESS_DENIED/);
  });

  test("写剪贴板走 clipboard_copy_text；[故障] 宿主失败时返回 false", async () => {
    const calls = [];
    const ok = await writeRealClipboardText("hello", {
      clipboard_copy_text: async (params) => {
        calls.push(params);
        return { success: true };
      },
      // 不存在的旧方法名不应被调用
      clipboard_write_text: async () => {
        throw new Error("不应调用 clipboard_write_text");
      }
    });
    assert.equal(ok, true);
    assert.deepEqual(calls, [{ text: "hello" }]);

    const failed = await writeRealClipboardText("hello", {
      clipboard_copy_text: async () => ({ success: false, error: "CLIPBOARD_BUSY" })
    });
    assert.equal(failed, false);

    const thrown = await writeRealClipboardText("hello", {
      clipboard_copy_text: async () => { throw new Error("IPC 断开"); }
    });
    assert.equal(thrown, false);
  });

  test("文件 SHA-256：filesearch_sha256 只带 fullPath；宿主失败时退到 FileComparePlugin", async () => {
    const shaCalls = [];
    const viaHost = await computeRealFileSha256("  /tmp/a.bin  ", {
      filesearch_sha256: async (params) => {
        shaCalls.push(params);
        return { success: true, data: { sha256: SHA_A.toUpperCase() } };
      }
    });
    assert.equal(viaHost, SHA_A);
    assert.deepEqual(shaCalls, [{ fullPath: "/tmp/a.bin" }]);

    const dllCalls = [];
    const viaDll = await computeRealFileSha256("C:\\a.bin", {
      filesearch_sha256: async () => ({ success: false, error: "NOT_FOUND" }),
      dllplugin_call: async (params) => {
        dllCalls.push(params);
        return { success: true, data: { sha256: SHA_A } };
      }
    });
    assert.equal(viaDll, SHA_A);
    assert.equal(dllCalls[0].plugin, "FileComparePlugin");
  });

  test("[故障] 文件 SHA-256：宿主都拿不到或返回非法值时返回空串，不读文本自行计算", async () => {
    let readCalled = false;
    const empty = await computeRealFileSha256("C:\\a.bin", {
      filesearch_sha256: async () => ({ success: true, data: { sha256: "not-a-hash" } }),
      dllplugin_call: async () => ({ success: false, error: "DLL 未加载" }),
      filesystem_read_file: async () => {
        readCalled = true;
        return { success: true, data: "binary-as-text" };
      }
    });
    assert.equal(empty, "");
    assert.equal(readCalled, false, "不能再按 utf8 读取文件内容计算哈希");

    assert.equal(await computeRealFileSha256("   "), "");
    assert.equal(await computeRealFileSha256("/tmp/a.bin"), "", "没有宿主时返回空串");
  });
});
