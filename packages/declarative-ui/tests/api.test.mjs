import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  showToast,
  Toast,
  Clipboard,
  LocalStorage,
  useNavigation,
  open,
  showHUD,
  confirmAlert,
  setDeclarativeBridge
} from "../dist/index.js";

describe("Raycast System APIs", () => {
  test("showToast should support creation, mutation and hiding", async () => {
    let bridgeCallCount = 0;
    let lastToastOpts = null;
    let updateCalled = false;
    let hideCalled = false;

    setDeclarativeBridge({
      showToast: (opts) => {
        bridgeCallCount++;
        lastToastOpts = opts;
        return {
          id: "toast-123",
          update: (u) => {
            updateCalled = true;
            Object.assign(lastToastOpts, u);
          },
          hide: () => {
            hideCalled = true;
          }
        };
      }
    });

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Loading data...",
      message: "Please wait"
    });

    assert.equal(bridgeCallCount, 1);
    assert.equal(toast.title, "Loading data...");
    assert.equal(toast.style, Toast.Style.Animated);

    // 更新属性
    toast.title = "Done!";
    toast.style = Toast.Style.Success;
    assert.equal(updateCalled, true);
    assert.equal(lastToastOpts.title, "Done!");
    assert.equal(lastToastOpts.style, Toast.Style.Success);

    // 隐藏
    await toast.hide();
    assert.equal(hideCalled, true);

    // 重置 bridge
    setDeclarativeBridge(null);
  });

  test("Clipboard should copy, read and clear content", async () => {
    await Clipboard.copy("Hello Raycast Compat");
    const text1 = await Clipboard.readText();
    assert.equal(text1, "Hello Raycast Compat");

    await Clipboard.copy({ text: "Object Text" });
    const text2 = await Clipboard.readText();
    assert.equal(text2, "Object Text");

    await Clipboard.clear();
    const text3 = await Clipboard.readText();
    assert.equal(text3, "");
  });

  test("LocalStorage should support get, set, remove, clear, allItems", async () => {
    await LocalStorage.clear();

    await LocalStorage.setItem("user", { name: "Alice", age: 30 });
    await LocalStorage.setItem("theme", "dark");

    const user = await LocalStorage.getItem("user");
    assert.deepEqual(user, { name: "Alice", age: 30 });

    const theme = await LocalStorage.getItem("theme");
    assert.equal(theme, "dark");

    const nonExistent = await LocalStorage.getItem("unknown");
    assert.equal(nonExistent, undefined);

    const all = await LocalStorage.allItems();
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all.theme, "dark");

    await LocalStorage.removeItem("theme");
    const afterRemove = await LocalStorage.getItem("theme");
    assert.equal(afterRemove, undefined);

    await LocalStorage.clear();
    const afterClear = await LocalStorage.allItems();
    assert.equal(Object.keys(afterClear).length, 0);
  });

  test("useNavigation should delegate to bridge or navigation stack", () => {
    let pushedTarget = null;
    let popCalled = false;

    setDeclarativeBridge({
      navigation: {
        push: (target) => {
          pushedTarget = target;
        },
        pop: () => {
          popCalled = true;
        }
      }
    });

    const nav = useNavigation();
    nav.push({ type: "Detail" });
    assert.deepEqual(pushedTarget, { type: "Detail" });

    nav.pop();
    assert.equal(popCalled, true);

    setDeclarativeBridge(null);
  });

  test("[破坏性] 没有宿主时 confirmAlert 按取消处理：不弹原生对话框，也不擅自确认", async () => {
    setDeclarativeBridge(null);
    let nativeCalled = false;
    const hadWindow = "window" in globalThis;
    const previousWindow = globalThis.window;
    globalThis.window = { confirm: () => { nativeCalled = true; return true; } };
    try {
      let primary = 0;
      let dismiss = 0;
      const ok = await confirmAlert({
        title: "清空全部？",
        primaryAction: { title: "清空", style: "destructive", onAction: () => { primary += 1; } },
        dismissAction: { onAction: () => { dismiss += 1; } }
      });
      assert.equal(ok, false);
      assert.equal(primary, 0);
      assert.equal(dismiss, 1);
      assert.equal(nativeCalled, false);
    } finally {
      if (hadWindow) globalThis.window = previousWindow;
      else delete globalThis.window;
    }
  });

  test("showHUD, open, confirmAlert should execute smoothly", async () => {
    let openedUrl = null;
    let alertConfirmed = false;

    setDeclarativeBridge({
      openExternal: async (url) => {
        openedUrl = url;
      },
      confirmAlert: async (opts) => {
        opts.primaryAction?.onAction?.();
        return true;
      }
    });

    await open("https://raycast.com");
    assert.equal(openedUrl, "https://raycast.com");

    const ok = await confirmAlert({
      title: "Delete item?",
      primaryAction: {
        title: "Delete",
        onAction: () => {
          alertConfirmed = true;
        }
      }
    });
    assert.equal(ok, true);
    assert.equal(alertConfirmed, true);

    // showHUD 降级测试
    await showHUD("Operation Completed");

    setDeclarativeBridge(null);
  });
});
