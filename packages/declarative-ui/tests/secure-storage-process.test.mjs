import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SecureStorage,
  terminateProcess,
  getHostTransport,
  ZToolsHostError,
  isZToolsHostError,
  setDeclarativeBridge,
  LocalStorage
} from "../dist/index.js";

afterEach(() => setDeclarativeBridge(null));

describe("SecureStorage 默认实现：没有宿主注入时绝不回落明文", () => {
  test("status 报 host-unsupported，读写抛 SECURE_STORAGE_UNAVAILABLE，且不写 localStorage / 内存", async () => {
    const written = [];
    globalThis.localStorage = {
      getItem: () => null,
      setItem: (k, v) => written.push([k, v]),
      removeItem: () => {},
      key: () => null,
      length: 0
    };
    try {
      assert.deepEqual(await SecureStorage.status(), { available: false, reason: "host-unsupported" });
      for (const run of [
        () => SecureStorage.setItem("totp", { secret: "JBSWY3DP" }),
        () => SecureStorage.getItem("totp"),
        () => SecureStorage.removeItem("totp"),
        () => SecureStorage.importFromLocalStorage("totp"),
        () => SecureStorage.discardLocalStorage("totp")
      ]) {
        await assert.rejects(run(), (error) => {
          assert.ok(error instanceof ZToolsHostError);
          assert.equal(error.code, "SECURE_STORAGE_UNAVAILABLE");
          return true;
        });
      }
      assert.deepEqual(written, [], "SecureStorage 不可用时没有任何明文落地");
      // LocalStorage 仍按原逻辑工作，不受影响
      await LocalStorage.setItem("plain", 1);
      assert.equal(written.length, 1);
    } finally {
      delete globalThis.localStorage;
    }
  });

  test("key 校验先于宿主调用；宿主注入后委托给宿主实现", async () => {
    const calls = [];
    setDeclarativeBridge({
      secureStorage: {
        status: async () => ({ available: true }),
        getItem: async (key) => { calls.push(["get", key]); return { ok: true }; },
        setItem: async (key, value) => { calls.push(["set", key, value]); },
        removeItem: async (key) => { calls.push(["remove", key]); },
        importFromLocalStorage: async (key, options) => { calls.push(["import", key, options]); return { status: "not-found" }; },
        discardLocalStorage: async (key) => { calls.push(["discard", key]); }
      }
    });
    for (const bad of ["", "../x", "a b", "x".repeat(129), 42, null, "-start"]) {
      await assert.rejects(SecureStorage.setItem(bad, 1), (error) => error.code === "INVALID_STORAGE_KEY");
      await assert.rejects(SecureStorage.getItem(bad), (error) => error.code === "INVALID_STORAGE_KEY");
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await SecureStorage.status(), { available: true });
    assert.deepEqual(await SecureStorage.getItem("a.b:c-d_e"), { ok: true });
    await SecureStorage.setItem("k", [1]);
    await SecureStorage.removeItem("k");
    assert.deepEqual(await SecureStorage.importFromLocalStorage("k", { targetKey: "k2" }), { status: "not-found" });
    await SecureStorage.discardLocalStorage("k");
    assert.deepEqual(calls.map((item) => item[0]), ["get", "set", "remove", "import", "discard"]);
  });

  test("宿主实现抛出的错误原样透传（code / details）", async () => {
    setDeclarativeBridge({
      secureStorage: {
        getItem: async () => { throw new ZToolsHostError("DATA_CORRUPT", "损坏", { key: "k" }); }
      }
    });
    await assert.rejects(SecureStorage.getItem("k"), (error) => {
      assert.ok(isZToolsHostError(error));
      assert.equal(error.code, "DATA_CORRUPT");
      assert.deepEqual(error.details, { key: "k" });
      return true;
    });
  });
});

describe("terminateProcess / getHostTransport", () => {
  test("宿主过旧：HOST_FEATURE_UNAVAILABLE；getHostTransport 返回 null", async () => {
    await assert.rejects(terminateProcess(1234), (error) => error.code === "HOST_FEATURE_UNAVAILABLE");
    assert.equal(getHostTransport(), null);
  });

  test("非法 pid 在 SDK 层拒绝，不调用宿主", async () => {
    let called = 0;
    setDeclarativeBridge({ terminateProcess: async () => { called += 1; return null; } });
    for (const pid of [0, 1, -1, 1.5, "12", 2 ** 32, Number.NaN, Infinity]) {
      await assert.rejects(terminateProcess(pid), (error) => error.code === "INVALID_REQUEST");
    }
    assert.equal(called, 0);
  });

  test("委托给宿主实现并透传结果与错误", async () => {
    setDeclarativeBridge({
      terminateProcess: async (pid, options) => {
        if (pid === 4) throw new ZToolsHostError("PROCESS_PROTECTED", "受保护", { reason: "system", pid });
        return { pid, mode: options.mode ?? "graceful", tree: options.tree === true, terminated: [pid] };
      },
      hostTransport: { call: async (method) => ({ method }) }
    });
    assert.deepEqual(await terminateProcess(99, { mode: "force", tree: true }), { pid: 99, mode: "force", tree: true, terminated: [99] });
    await assert.rejects(terminateProcess(4), (error) => error.code === "PROCESS_PROTECTED" && error.details.reason === "system");
    assert.deepEqual(await getHostTransport().call("clipboard_read_text"), { method: "clipboard_read_text" });
  });
});
