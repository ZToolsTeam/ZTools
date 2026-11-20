import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  resolveLocale,
  getLocale,
  setRuntimeLocale,
  onLocaleChange,
  createTranslator,
  useLocale,
  renderDeclarativeRoot,
  List,
  Clipboard,
  LocalStorage,
  SecureStorage,
  terminateProcess,
  setDeclarativeBridge
} from "../dist/index.js";
import { updateStoredItem } from "../dist/api/storage-update.js";

const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));

afterEach(() => {
  setDeclarativeBridge(null);
  setRuntimeLocale(DEFAULT_LOCALE);
});

describe("resolveLocale 与常量契约", () => {
  test("导出受支持语言与默认语言常量", () => {
    assert.deepEqual([...SUPPORTED_LOCALES], ["zh-CN", "en-US"]);
    assert.equal(DEFAULT_LOCALE, "en-US");
  });

  test("支持大小写、下划线与区域变体归一化", () => {
    assert.equal(resolveLocale("zh-CN"), "zh-CN");
    assert.equal(resolveLocale("zh_cn"), "zh-CN");
    assert.equal(resolveLocale("zh-Hans-SG"), "zh-CN");
    assert.equal(resolveLocale("zh-TW"), "zh-CN");
    assert.equal(resolveLocale("en-US"), "en-US");
    assert.equal(resolveLocale("en_GB"), "en-US");
    assert.equal(resolveLocale("EN"), "en-US");
  });

  test("未知或空值按 fallback -> DEFAULT_LOCALE 兜底", () => {
    assert.equal(resolveLocale(undefined), "en-US");
    assert.equal(resolveLocale(null), "en-US");
    assert.equal(resolveLocale("   "), "en-US");
    assert.equal(resolveLocale("fr-FR"), "en-US");
    assert.equal(resolveLocale("fr-FR", "zh-CN"), "zh-CN");
    assert.equal(resolveLocale("de-DE", "zh_HK"), "zh-CN");
    assert.equal(resolveLocale("ja-JP", "ko-KR"), "en-US");
  });
});

describe("createTranslator 逐级回退、插值与空值处理", () => {
  test("支持 {var} 插值且正确处理 0 / false / 空串 / 缺省参数", () => {
    setRuntimeLocale("en-US");
    const t = createTranslator({
      "en-US": {
        summary: "Found {count} items (exact={exact}, label={label}, missing={missing})"
      },
      "zh-CN": {
        summary: "找到 {count} 项 (exact={exact}, label={label}, missing={missing})"
      }
    });

    assert.equal(
      t("summary", { count: 0, exact: false, label: "", missing: undefined }),
      "Found 0 items (exact=false, label=, missing={missing})"
    );
    assert.equal(
      t("summary", { count: 3, exact: true, label: null }),
      "Found 3 items (exact=true, label={label}, missing={missing})"
    );

    setRuntimeLocale("zh-CN");
    assert.equal(
      t("summary", { count: 5, exact: true, label: "ok" }),
      "找到 5 项 (exact=true, label=ok, missing={missing})"
    );
  });

  test("逐级回退：当前 locale -> en-US -> defaultLocale -> key（空串视作缺失）", () => {
    const t = createTranslator(
      {
        "zh-CN": {
          onlyZh: "仅中文",
          emptyInZh: "",
          onlyDefault: ""
        },
        "en-US": {
          emptyInZh: "Fallback to English",
          onlyEn: "English Only"
        },
        "custom-fallback": {
          onlyDefault: "From defaultLocale {n}"
        }
      },
      { defaultLocale: "custom-fallback" }
    );

    setRuntimeLocale("zh-CN");
    assert.equal(t("onlyZh"), "仅中文");
    assert.equal(t("emptyInZh"), "Fallback to English");
    assert.equal(t("onlyEn"), "English Only");
    assert.equal(t("onlyDefault", { n: 42 }), "From defaultLocale 42");
    assert.equal(t("untranslated.key"), "untranslated.key");
  });
});

describe("setRuntimeLocale / onLocaleChange / useLocale 热重绘与清理", () => {
  test("setRuntimeLocale 幂等且监听器异常隔离", () => {
    setRuntimeLocale("en-US");
    const seen = [];
    const off1 = onLocaleChange(() => {
      throw new Error("boom");
    });
    const off2 = onLocaleChange((loc) => seen.push(loc));

    try {
      setRuntimeLocale("en-US");
      assert.deepEqual(seen, []);

      setRuntimeLocale("zh_CN");
      assert.equal(getLocale(), "zh-CN");
      assert.deepEqual(seen, ["zh-CN"]);

      setRuntimeLocale("zh-CN");
      assert.deepEqual(seen, ["zh-CN"]);
    } finally {
      off1();
      off2();
    }
  });

  test("useLocale 在 setRuntimeLocale 后触发热重绘，卸载后自动清理监听器", async () => {
    setRuntimeLocale("en-US");
    let renderCount = 0;
    const observedLocales = [];

    function LocaleProbe() {
      renderCount += 1;
      const locale = useLocale();
      observedLocales.push(locale);
      return List({ navigationTitle: `Lang:${locale}`, children: [] });
    }

    const updates = [];
    const root = renderDeclarativeRoot(LocaleProbe, {
      onUpdate: (descriptor) => updates.push(descriptor.props?.navigationTitle)
    });

    assert.equal(renderCount, 1);
    assert.deepEqual(observedLocales, ["en-US"]);
    assert.equal(root.getLatest().props?.navigationTitle, "Lang:en-US");

    setRuntimeLocale("zh-CN");
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(renderCount, 2);
    assert.deepEqual(observedLocales, ["en-US", "zh-CN"]);
    assert.equal(root.getLatest().props?.navigationTitle, "Lang:zh-CN");
    assert.deepEqual(updates, ["Lang:en-US", "Lang:zh-CN"]);

    root.unmount();
    setRuntimeLocale("en-US");
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(renderCount, 2, "卸载后不应再触发重绘");
    assert.deepEqual(observedLocales, ["en-US", "zh-CN"]);
  });

  test("未使用 useLocale 仅使用 createTranslator 的组件也会随 setRuntimeLocale 热重绘", async () => {
    const t = createTranslator({
      "en-US": { title: "Hello" },
      "zh-CN": { title: "你好" }
    });
    setRuntimeLocale("en-US");

    let renders = 0;
    const root = renderDeclarativeRoot(() => {
      renders += 1;
      return List({ navigationTitle: t("title"), children: [] });
    });

    assert.equal(root.getLatest().props?.navigationTitle, "Hello");
    setRuntimeLocale("zh-CN");
    await flushMicrotasks();

    assert.equal(renders, 2);
    assert.equal(root.getLatest().props?.navigationTitle, "你好");

    root.unmount();
    setRuntimeLocale("en-US");
    await flushMicrotasks();
    assert.equal(renders, 2);
  });
});

describe("api/ 内置双语报错词典", () => {
  test("在 en-US 与 zh-CN 下返回对应语言报错且保留原有错误码", async () => {
    setDeclarativeBridge({ copyToClipboard: async () => {} });

    const conflictStorage = {
      async getItem() {
        return { v: 1 };
      },
      async compareAndSet() {
        return false;
      }
    };

    // 1. 英文模式 (en-US)
    setRuntimeLocale("en-US");
    await assert.rejects(Clipboard.paste("abc"), (err) => {
      assert.equal(err.code, "NOT_SUPPORTED");
      assert.match(err.message, /does not support pasting/i);
      return true;
    });
    await assert.rejects(terminateProcess(1), (err) => {
      assert.equal(err.code, "INVALID_REQUEST");
      assert.match(err.message, /pid must be an integer/i);
      return true;
    });
    await assert.rejects(terminateProcess(1234), (err) => {
      assert.equal(err.code, "HOST_FEATURE_UNAVAILABLE");
      assert.match(err.message, /terminating arbitrary processes/i);
      return true;
    });
    await assert.rejects(SecureStorage.getItem("../bad"), (err) => {
      assert.equal(err.code, "INVALID_STORAGE_KEY");
      assert.match(err.message, /SecureStorage key must be/i);
      return true;
    });
    await assert.rejects(SecureStorage.getItem("valid_key"), (err) => {
      assert.equal(err.code, "SECURE_STORAGE_UNAVAILABLE");
      assert.match(err.message, /encrypted storage/i);
      return true;
    });
    await assert.rejects(updateStoredItem(conflictStorage, "k", () => ({ v: 2 })), (err) => {
      assert.equal(err.code, "STORAGE_CONFLICT");
      assert.match(err.message, /modified by another window/i);
      return true;
    });
    await assert.rejects(LocalStorage.compareAndSet("k", 1, 2), (err) => {
      assert.equal(err.code, "HOST_FEATURE_UNAVAILABLE");
      assert.match(err.message, /atomic storage/i);
      return true;
    });

    // 2. 中文模式 (zh-CN)
    setRuntimeLocale("zh-CN");
    await assert.rejects(Clipboard.paste("abc"), (err) => {
      assert.equal(err.code, "NOT_SUPPORTED");
      assert.match(err.message, /当前宿主不支持粘贴到前台应用/);
      return true;
    });
    await assert.rejects(terminateProcess(1), (err) => {
      assert.equal(err.code, "INVALID_REQUEST");
      assert.match(err.message, /pid 必须是/);
      return true;
    });
    await assert.rejects(terminateProcess(1234), (err) => {
      assert.equal(err.code, "HOST_FEATURE_UNAVAILABLE");
      assert.match(err.message, /不支持结束任意进程/);
      return true;
    });
    await assert.rejects(SecureStorage.getItem("../bad"), (err) => {
      assert.equal(err.code, "INVALID_STORAGE_KEY");
      assert.match(err.message, /SecureStorage 的 key 必须是/);
      return true;
    });
    await assert.rejects(SecureStorage.getItem("valid_key"), (err) => {
      assert.equal(err.code, "SECURE_STORAGE_UNAVAILABLE");
      assert.match(err.message, /不支持加密存储/);
      return true;
    });
    await assert.rejects(updateStoredItem(conflictStorage, "k", () => ({ v: 2 })), (err) => {
      assert.equal(err.code, "STORAGE_CONFLICT");
      assert.match(err.message, /正在被其他窗口修改/);
      return true;
    });
    await assert.rejects(LocalStorage.compareAndSet("k", 1, 2), (err) => {
      assert.equal(err.code, "HOST_FEATURE_UNAVAILABLE");
      assert.match(err.message, /不支持原子存储/);
      return true;
    });
  });
});
