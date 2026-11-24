import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  stripLocaleSuffix,
  matchSupportedLocale,
  resolveLocale,
  getLocale,
  setRuntimeLocale,
  onLocaleChange,
  createTranslator,
  useLocale,
  useI18n,
  ZToolsHostError,
  HOST_ERROR_MESSAGES,
  resolveHostErrorMessage,
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

describe("POSIX 后缀剥离、system 过滤与候选数组顺延（与 plugins-spec 单一信源等价）", () => {
  test("stripLocaleSuffix 与 matchSupportedLocale 严格处理 POSIX/system/第三语种", () => {
    assert.equal(stripLocaleSuffix("zh_CN.UTF-8"), "zh-CN");
    assert.equal(stripLocaleSuffix("en_US@euro"), "en-US");
    assert.equal(stripLocaleSuffix("  zh_TW.utf8@traditional  "), "zh-TW");
    assert.equal(stripLocaleSuffix(null), "");
    assert.equal(stripLocaleSuffix(undefined), "");

    assert.equal(matchSupportedLocale("zh_CN.UTF-8"), "zh-CN");
    assert.equal(matchSupportedLocale("en_GB@euro"), "en-US");
    assert.equal(matchSupportedLocale("system"), null);
    assert.equal(matchSupportedLocale("SYSTEM"), null);
    assert.equal(matchSupportedLocale("auto"), null);
    assert.equal(matchSupportedLocale("default"), null);
    assert.equal(matchSupportedLocale("ja-JP"), null);
    assert.equal(matchSupportedLocale("fr-FR"), null);
    assert.equal(matchSupportedLocale("ko-KR"), null);
    assert.equal(matchSupportedLocale(""), null);
    assert.equal(matchSupportedLocale(null), null);

    assert.equal(resolveLocale(["system", "fr-FR", "zh_CN.UTF-8"]), "zh-CN");
    assert.equal(resolveLocale(["system", "", null, "ja-JP", "en_US@euro"]), "en-US");
    assert.equal(resolveLocale(["system", "ja-JP"]), "en-US");
    assert.equal(resolveLocale(["system", "ja-JP"], "zh-CN"), "zh-CN");
  });
});

describe("createTranslator 复数语法与占位符字面量转义", () => {
  test("内联复数 [[count:singular|plural]] 与 [[count:zero|one|other]]", () => {
    setRuntimeLocale("en-US");
    const t = createTranslator({
      "en-US": {
        twoForm: "Found {count} [[count:item|items]]",
        threeForm: "[[count:No files|1 file|{count} files]] selected",
        nested: "{n} [[n:match|matches]] in {files} [[files:file|files]]",
        escapedPipeInline: "[[count:A \\| B|A \\| B (plural)]]"
      },
      "zh-CN": {
        twoForm: "找到 {count} 个项目",
        threeForm: "[[count:未选择文件|已选 1 个文件|已选 {count} 个文件]]",
        nested: "在 {files} 个文件中找到 {n} 处匹配",
        escapedPipeInline: "[[count:甲 \\| 乙|甲 \\| 乙（多）]]"
      }
    });

    assert.equal(t("twoForm", { count: 0 }), "Found 0 items");
    assert.equal(t("twoForm", { count: 1 }), "Found 1 item");
    assert.equal(t("twoForm", { count: 2 }), "Found 2 items");

    assert.equal(t("threeForm", { count: 0 }), "No files selected");
    assert.equal(t("threeForm", { count: 1 }), "1 file selected");
    assert.equal(t("threeForm", { count: 5 }), "5 files selected");

    assert.equal(t("nested", { n: 1, files: 3 }), "1 match in 3 files");
    assert.equal(t("nested", { n: 0, files: 1 }), "0 matches in 1 file");
    assert.equal(t("escapedPipeInline", { count: 1 }), "A | B");
    assert.equal(t("escapedPipeInline", { count: 2 }), "A | B (plural)");

    setRuntimeLocale("zh-CN");
    assert.equal(t("threeForm", { count: 0 }), "未选择文件");
    assert.equal(t("threeForm", { count: 1 }), "已选 1 个文件");
    assert.equal(t("threeForm", { count: 4 }), "已选 4 个文件");
  });

  test("整串 | 分段复数与 \\| 字面量转义", () => {
    setRuntimeLocale("en-US");
    const t = createTranslator({
      "en-US": {
        twoWay: "{count} apple | {count} apples",
        threeWay: "No apples | One apple | {count} apples",
        literalPipe: "Cmd \\| Ctrl + {key}",
        mixedPipeAndEscaped: "Empty \\| 0 | Single \\| 1 | Many \\| {count}"
      }
    });

    assert.equal(t("twoWay", { count: 0 }), "0 apples");
    assert.equal(t("twoWay", { count: 1 }), "1 apple");
    assert.equal(t("twoWay", { count: 7 }), "7 apples");

    assert.equal(t("threeWay", { count: 0 }), "No apples");
    assert.equal(t("threeWay", { count: 1 }), "One apple");
    assert.equal(t("threeWay", { count: 9 }), "9 apples");

    // 转义管道不触发分段，还原为字面量 |
    assert.equal(t("literalPipe", { key: "K", count: 1 }), "Cmd | Ctrl + K");
    assert.equal(t("literalPipe", { key: "K" }), "Cmd | Ctrl + K");
    assert.equal(t("mixedPipeAndEscaped", { count: 0 }), "Empty | 0");
    assert.equal(t("mixedPipeAndEscaped", { count: 1 }), "Single | 1");
    assert.equal(t("mixedPipeAndEscaped", { count: 3 }), "Many | 3");
  });

  test("占位符字面量转义 {{var}} 输出 {var} 且不被同名参数替换", () => {
    setRuntimeLocale("en-US");
    const t = createTranslator({
      "en-US": {
        macroHint: "Use {{date}} and {{query}} macros for {plugin}",
        noParamsMacro: "Pattern: {{date}}"
      }
    });

    assert.equal(
      t("macroHint", { date: "2026-01-01", query: "hello", plugin: "Snippets" }),
      "Use {date} and {query} macros for Snippets"
    );
    assert.equal(t("noParamsMacro"), "Pattern: {date}");
  });
});

describe("useI18n 组合 Hook 响应式热切换与 Intl 格式化", () => {
  test("随 setRuntimeLocale 响应更新 locale、t、formatNumber 与 formatDate", async () => {
    setRuntimeLocale("en-US");
    const messages = {
      "en-US": { title: "{count} [[count:item|items]]" },
      "zh-CN": { title: "共 {count} 项" }
    };

    const snapshots = [];
    const sampleDate = new Date(Date.UTC(2026, 4, 15, 12, 0, 0));

    function I18nProbe() {
      const { locale, t, formatNumber, formatDate } = useI18n(messages);
      const formattedNum = formatNumber(12345.5);
      const formattedDate = formatDate(sampleDate, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
      const invalidDate = formatDate("not-a-date");
      snapshots.push({ locale, title: t("title", { count: 2 }), formattedNum, formattedDate, invalidDate });
      return List({ navigationTitle: `${locale}|${t("title", { count: 2 })}|${formattedNum}`, children: [] });
    }

    const root = renderDeclarativeRoot(I18nProbe);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].locale, "en-US");
    assert.equal(snapshots[0].title, "2 items");
    assert.equal(snapshots[0].formattedNum, "12,345.5");
    assert.equal(snapshots[0].invalidDate, "");
    assert.match(snapshots[0].formattedDate, /2026/);

    setRuntimeLocale("zh_CN.UTF-8");
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1].locale, "zh-CN");
    assert.equal(snapshots[1].title, "共 2 项");
    assert.equal(snapshots[1].formattedNum, "12,345.5");
    assert.match(snapshots[1].formattedDate, /2026/);

    root.unmount();
  });
});

describe("resolveHostErrorMessage 双语结构化错误对称防漏", () => {
  test("英文态拦截中文原文、中文态拦截纯英文技术原文，语言匹配时保留具体详情", () => {
    assert.deepEqual(
      Object.keys(HOST_ERROR_MESSAGES["en-US"]).sort(),
      Object.keys(HOST_ERROR_MESSAGES["zh-CN"]).sort()
    );

    // 1. 英文态下含中文原文的 HostError -> 映射英文标准译文
    const zhHostErr = new ZToolsHostError("PROCESS_PROTECTED", "受保护的系统进程，禁止结束");
    assert.equal(resolveHostErrorMessage(zhHostErr, "en-US"), HOST_ERROR_MESSAGES["en-US"].PROCESS_PROTECTED);
    // 中文态下保留具体中文原文
    assert.equal(resolveHostErrorMessage(zhHostErr, "zh-CN"), "受保护的系统进程，禁止结束");

    // 2. 中文态下纯英文技术原文的 HostError -> 映射中文标准译文
    const enHostErr = new ZToolsHostError("STORAGE_CONFLICT", "CAS version mismatch on storage key");
    assert.equal(resolveHostErrorMessage(enHostErr, "zh-CN"), HOST_ERROR_MESSAGES["zh-CN"].STORAGE_CONFLICT);
    // 英文态下保留具体英文原文
    assert.equal(resolveHostErrorMessage(enHostErr, "en-US"), "CAS version mismatch on storage key");

    // 3. 普通 { code, message } 对象与空 message
    assert.equal(
      resolveHostErrorMessage({ code: "PERMISSION_DENIED", message: "" }, "zh-CN"),
      HOST_ERROR_MESSAGES["zh-CN"].PERMISSION_DENIED
    );
    assert.equal(
      resolveHostErrorMessage({ code: "PERMISSION_DENIED", message: "无权限访问" }, "en-US"),
      HOST_ERROR_MESSAGES["en-US"].PERMISSION_DENIED
    );

    // 4. 未知错误码与原生 Error 的对称防漏
    assert.equal(
      resolveHostErrorMessage(new Error("ECONNREFUSED 127.0.0.1:9999"), "zh-CN"),
      HOST_ERROR_MESSAGES["zh-CN"].UNKNOWN_ERROR
    );
    assert.equal(
      resolveHostErrorMessage(new Error("网络连接超时"), "en-US"),
      HOST_ERROR_MESSAGES["en-US"].UNKNOWN_ERROR
    );

    // 5. 未显式传 locale 时跟随运行期 getLocale()
    setRuntimeLocale("zh-CN");
    assert.equal(
      resolveHostErrorMessage({ code: "TIMEOUT", message: "Request timed out after 5000ms" }),
      HOST_ERROR_MESSAGES["zh-CN"].TIMEOUT
    );
    setRuntimeLocale("en-US");
    assert.equal(
      resolveHostErrorMessage({ code: "TIMEOUT", message: "请求超时" }),
      HOST_ERROR_MESSAGES["en-US"].TIMEOUT
    );
  });
});

describe("浏览器 DOM 环境初始语言兜底（兼容未注入 __ztoolsLocale 的旧版前端）", () => {
  test("未注入 __ztoolsLocale 时，自动回退读取 document.documentElement.lang", async () => {
    const g = globalThis;
    const prevDoc = g.document;
    const prevLocale = g.__ztoolsLocale;
    try {
      delete g.__ztoolsLocale;
      g.document = { documentElement: { lang: "zh-CN" } };
      const fresh = await import(`../dist/runtime/locale.js?dom-fallback=${Date.now()}`);
      assert.equal(fresh.getLocale(), "zh-CN");
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
      if (prevLocale === undefined) delete g.__ztoolsLocale;
      else g.__ztoolsLocale = prevLocale;
    }
  });
});
