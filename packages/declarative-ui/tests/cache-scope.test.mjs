/**
 * Cache 作用域隔离与 showHUD 降级测试
 *
 * - 客户端为每个插件调用 createCacheScope()（宿主专用入口 dist/host，不从包入口导出），插件拿到的 Cache / useCachedPromise / useCachedState
 *   只能读写本插件作用域：同名 namespace、同名 key 也互不可见；
 * - 对抗：按字符串拼接 namespace、沿原型链取基类、派生子类都拿不到其他作用域的数据；
 * - 故障：订阅者抛错不影响写入与其他订阅者；缓存里的损坏 JSON 回落到初始值；
 * - 已移除的 environment / getPreferenceValues 等未实现接口不再从 SDK 导出；
 * - showHUD 在宿主未提供 HUD 时显示为成功轻提示，约 1.5 秒后自动隐藏。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as SDK from "../dist/index.js";
import * as UtilsEntry from "../dist/utils/index.js";
import { createCacheScope } from "../dist/host/index.js";

const {
  Cache,
  renderDeclarativeRoot,
  useCachedPromise,
  useCachedState,
  showHUD,
  setDeclarativeBridge,
  Toast
} = SDK;

const HOOK_NAMESPACE = "@raycast/utils.useCachedPromise";

function detail(markdown) {
  return {
    $$typeof: Symbol.for("ztools.declarative.descriptor"),
    type: "Detail",
    props: { markdown },
    children: []
  };
}

const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Cache 作用域隔离", () => {
  test("两个插件作用域用同一 namespace 与 key 互不可见，也与默认作用域隔离", () => {
    const pluginA = createCacheScope();
    const pluginB = createCacheScope();
    const a = new pluginA.Cache({ namespace: "shared" });
    const b = new pluginB.Cache({ namespace: "shared" });
    const fallback = new Cache({ namespace: "shared" });

    a.set("token", "secret-a");
    assert.equal(a.get("token"), "secret-a");
    assert.equal(b.get("token"), undefined, "插件 B 不能读到插件 A 的缓存");
    assert.equal(b.has("token"), false);
    assert.equal(fallback.get("token"), undefined, "默认作用域也读不到插件缓存");

    b.set("token", "secret-b");
    assert.equal(a.get("token"), "secret-a", "插件 B 写同名 key 不覆盖插件 A");

    // 不传 namespace 时落在各自作用域的 default 命名空间
    new pluginA.Cache().set("k", "1");
    assert.equal(new pluginB.Cache().get("k"), undefined);
    assert.equal(new pluginA.Cache().get("k"), "1", "同一作用域里新建实例共享数据");

    // 一方 clear / remove 不影响另一方
    b.clear();
    assert.equal(a.get("token"), "secret-a");
    assert.equal(b.remove("token"), false);
    assert.equal(a.isEmpty, false);
  });

  test("[对抗] 拼接 namespace、取原型链基类、派生子类都拿不到别的作用域", () => {
    const victim = createCacheScope();
    const attacker = createCacheScope();
    new victim.Cache({ namespace: "default" }).set("password", "p@ss");
    new victim.Cache({ namespace: HOOK_NAMESPACE }).set("k", JSON.stringify("hook-secret"));

    for (const ns of ["default", "victim::default", "\u0000default", "__proto__", "constructor", HOOK_NAMESPACE]) {
      const probe = new attacker.Cache({ namespace: ns });
      assert.equal(probe.get("password"), undefined, `namespace=${JSON.stringify(ns)} 不应读到受害插件数据`);
      assert.equal(probe.get("k"), undefined);
    }

    // 沿原型链拿到的基类只对应默认作用域
    const Base = Object.getPrototypeOf(attacker.Cache);
    assert.equal(Base, Cache);
    assert.equal(new Base({ namespace: "default" }).get("password"), undefined);

    // 插件从自己的 Cache 派生子类，数据仍在自己的作用域
    class MyCache extends attacker.Cache {}
    new MyCache({ namespace: "sub" }).set("x", "1");
    assert.equal(new attacker.Cache({ namespace: "sub" }).get("x"), "1");
    assert.equal(new victim.Cache({ namespace: "sub" }).get("x"), undefined);
  });

  test("[故障] 订阅者抛错不影响写入与其他订阅者，订阅只通知本实例", () => {
    const scope = createCacheScope();
    const cache = new scope.Cache({ namespace: "events" });
    const other = new scope.Cache({ namespace: "events" });
    const seen = [];
    cache.subscribe(() => {
      throw new Error("订阅者崩溃");
    });
    const unsubscribe = cache.subscribe((key, data) => seen.push([key, data]));
    let otherNotified = 0;
    other.subscribe(() => otherNotified++);

    assert.doesNotThrow(() => cache.set("a", "1"));
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.remove("a"), true);
    cache.clear();
    assert.deepEqual(seen, [["a", "1"], ["a", undefined], [undefined, undefined]]);
    assert.equal(otherNotified, 0, "订阅按实例生效，与 Raycast 行为一致");

    unsubscribe();
    cache.set("b", "2");
    assert.equal(seen.length, 3, "退订后不再收到通知");
    cache.clear({ notifySubscribers: false });
    assert.equal(cache.isEmpty, true);
  });

  test("[集成] 插件作用域的 useCachedState 与 useCachedPromise 互相隔离，也不进入默认作用域", async () => {
    const pluginA = createCacheScope();
    const pluginB = createCacheScope();

    // 插件 A 写入缓存状态
    let setA = null;
    const rootA = renderDeclarativeRoot(() => {
      const [value, setValue] = pluginA.useCachedState("token", "initial");
      setA = setValue;
      return detail(String(value));
    });
    setA("from-a");
    await flush();
    assert.equal(rootA.getLatest().props.markdown, "from-a");
    rootA.unmount();

    // 同一插件重新进入：首帧直接得到缓存值
    const rootA2 = renderDeclarativeRoot(() => detail(String(pluginA.useCachedState("token", "initial")[0])));
    assert.equal(rootA2.getLatest().props.markdown, "from-a");
    rootA2.unmount();

    // 插件 B 与默认作用域用同名 key 只能得到自己的初始值
    const rootB = renderDeclarativeRoot(() => detail(String(pluginB.useCachedState("token", "initial-b")[0])));
    assert.equal(rootB.getLatest().props.markdown, "initial-b");
    rootB.unmount();
    const rootDefault = renderDeclarativeRoot(() => detail(String(useCachedState("token", "initial-default")[0])));
    assert.equal(rootDefault.getLatest().props.markdown, "initial-default");
    rootDefault.unmount();

    // useCachedPromise：同名函数同参数，插件 B 首帧不能命中插件 A 的结果
    async function loadProfile(id) {
      return `profile-${id}`;
    }
    const promiseA = renderDeclarativeRoot(() => detail(pluginA.useCachedPromise(loadProfile, ["u1"]).data || "loading"));
    await flush(40);
    assert.equal(promiseA.getLatest().props.markdown, "profile-u1");
    promiseA.unmount();

    const promiseA2 = renderDeclarativeRoot(() => detail(pluginA.useCachedPromise(loadProfile, ["u1"]).data || "loading"));
    assert.equal(promiseA2.getLatest().props.markdown, "profile-u1", "同一插件首帧命中缓存");
    promiseA2.unmount();

    const promiseB = renderDeclarativeRoot(() => detail(pluginB.useCachedPromise(loadProfile, ["u1"]).data || "loading"));
    assert.equal(promiseB.getLatest().props.markdown, "loading", "插件 B 首帧不能命中插件 A 的缓存");
    promiseB.unmount();

    const promiseDefault = renderDeclarativeRoot(() => detail(useCachedPromise(loadProfile, ["u1"]).data || "loading"));
    assert.equal(promiseDefault.getLatest().props.markdown, "loading", "默认作用域不受插件缓存影响");
    promiseDefault.unmount();
    await flush(40);
  });

  test("[故障] 作用域缓存里的损坏 JSON 回落到初始值，不抛错", () => {
    const scope = createCacheScope();
    new scope.Cache({ namespace: HOOK_NAMESPACE }).set("broken", "{not json");
    const root = renderDeclarativeRoot(() => detail(String(scope.useCachedState("broken", "fallback")[0])));
    assert.equal(root.getLatest().props.markdown, "fallback");
    root.unmount();
  });
});

describe("未实现的接口已从 SDK 移除", () => {
  test("environment / getPreferenceValues 及其注入函数不再导出，包内私有的作用域工厂也不导出", () => {
    for (const name of [
      "environment",
      "setEnvironment",
      "getPreferenceValues",
      "setPreferenceValues",
      "clearPreferenceValues",
      "createScopedCacheClass",
      "createCacheScope"
    ]) {
      assert.equal(name in SDK, false, `${name} 不应再从 @ztools/declarative-ui 导出`);
      assert.equal(name in UtilsEntry, false, `${name} 不应再从 @ztools/declarative-ui/utils 导出`);
    }
    // 宿主专用入口只提供作用域工厂
    assert.equal(typeof createCacheScope, "function");
    // 插件可用的缓存 Hook 仍然从两个入口导出
    for (const name of ["usePromise", "useCachedPromise", "useFetch", "useCachedState"]) {
      assert.equal(typeof SDK[name], "function", `${name} 应从包入口导出`);
      assert.equal(typeof UtilsEntry[name], "function", `${name} 应从 utils 入口导出`);
    }
  });
});

describe("showHUD", () => {
  test("宿主未提供 HUD 时显示为成功轻提示，约 1.5 秒后自动隐藏", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const shown = [];
    let hidden = 0;
    setDeclarativeBridge({
      showToast: (opts) => {
        shown.push(opts);
        return { id: "t1", update: () => {}, hide: () => hidden++ };
      }
    });
    try {
      await showHUD("已复制");
      assert.equal(shown.length, 1);
      assert.equal(shown[0].title, "已复制");
      assert.equal(shown[0].style, Toast.Style.Success);
      t.mock.timers.tick(1499);
      assert.equal(hidden, 0, "1.5 秒内保持显示");
      t.mock.timers.tick(1);
      await Promise.resolve();
      assert.equal(hidden, 1, "1.5 秒后自动隐藏");
    } finally {
      setDeclarativeBridge(null);
      t.mock.timers.reset();
    }
  });

  test("宿主提供 HUD 时交给宿主显示，并透传图标", async () => {
    const calls = [];
    setDeclarativeBridge({
      showHUD: async (title, icon) => {
        calls.push([title, icon]);
      },
      showToast: () => {
        throw new Error("有 HUD 时不应退回轻提示");
      }
    });
    try {
      await showHUD("已锁屏", { icon: "lock" });
      await showHUD("已切换", "moon");
      assert.deepEqual(calls, [["已锁屏", "lock"], ["已切换", "moon"]]);
    } finally {
      setDeclarativeBridge(null);
    }
  });
});
