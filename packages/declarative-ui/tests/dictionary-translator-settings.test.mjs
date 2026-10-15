import { describe, test, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// 导入待测组件与核心引擎
import {
  BUILTIN_DICTIONARY,
  lookupWord,
  normalizeWord,
  calculateLevenshtein,
  getOnlineDictionaryUrls,
  getBookmarks,
  toggleBookmark,
  isBookmarked,
  getRecentSearches,
  recordRecentSearch,
  clearRecentSearches,
  DICTIONARY_STORAGE_KEYS
} from "../dist/examples/dictionary/index.js";

import {
  SUPPORTED_LANGUAGES,
  detectLanguage,
  getLanguageByCode,
  translateText,
  swapLanguages,
  getRecentTranslations,
  saveRecentTranslation,
  clearRecentTranslations,
  getWebTranslatorUrls
} from "../dist/examples/translator/index.js";

import {
  BUILTIN_32_EXTENSIONS,
  DEFAULT_PREFERENCES,
  SETTINGS_SECTIONS,
  getPreferences,
  savePreferences,
  updateExtensionConfig,
  getSqliteCacheInfo,
  clearSqliteCache,
  resetPreferences,
  exportPreferencesJson,
  importPreferencesJson,
  sanitizePreferences,
  filterSettingsSections
} from "../dist/examples/settings/index.js";

import DictionaryCommand from "../dist/examples/dictionary/index.js";
import TranslatorCommand from "../dist/examples/translator/index.js";
import SettingsCommand from "../dist/examples/settings/index.js";

import { LocalStorage } from "../dist/api/storage.js";

describe("REA 深度逆向与全面对齐集成套件: Dictionary, Translator & Settings", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
  });

  // ===========================================================================
  // 1. Dictionary 深度集成与抗毁性测试
  // ===========================================================================
  describe("1. Dictionary 生词释义与双解词典系统", () => {
    it("1.1 精准查词与双解数据模型完整性", () => {
      assert.ok(BUILTIN_DICTIONARY.length >= 10, "词库应包含基础核心词汇");
      const arch = BUILTIN_DICTIONARY.find(w => w.word === "architecture");
      assert.ok(arch, "必须包含 architecture 词条");
      assert.ok(arch.phoneticUs.includes("ɑːr"), "包含美式音标");
      assert.ok(arch.phoneticUk.includes("ɑː"), "包含英式音标");
      assert.ok(arch.pos.includes("n."), "包含词性标记");
      assert.ok(arch.definitionZh.includes("架构"), "包含精准中文释义");
      assert.ok(arch.definitionEn.length > 10, "包含完整英英释义");
      assert.ok(arch.definitions.length >= 1, "包含分项详细释义");
      assert.ok(arch.synonyms.length >= 1, "包含同义词");
      assert.ok(arch.examples && arch.examples.length >= 1, "包含权威双语例句");
      assert.ok(arch.examples[0].en.includes("ZTools"), "例句包含真实项目上下文");
    });

    it("1.2 词形还原与模糊前缀检索", () => {
      // 词形还原
      assert.equal(normalizeWord("dictionaries"), "dictionary");
      assert.equal(normalizeWord("running"), "run");
      assert.equal(normalizeWord("concurrencies"), "concurrency");
      assert.equal(normalizeWord("optimized"), "optimize");

      // 搜索检索前缀
      const res = lookupWord("algo");
      assert.ok(res.suggestions.some(w => w.word === "algorithm"), "前缀匹配算法词条");
    });

    it("1.3 【Beyond Happy Path 破坏性容错】未知生词与 Levenshtein 容错猜词 (Did you mean?)", () => {
      // 拼写轻微错误 (algoritm 缺少 h)
      const typo1 = lookupWord("algoritm");
      assert.equal(typo1.exactMatches.length, 0, "未知词不产生假精准命中");
      assert.ok(typo1.guesses.some(g => g.word === "algorithm"), "Did you mean 应推荐 algorithm");

      // 拼写轻微错误 (dictinary 缺少 o)
      const typo2 = lookupWord("dictinary");
      assert.ok(typo2.guesses.some(g => g.word === "dictionary"), "Did you mean 应推荐 dictionary");

      // 完全无关词汇
      const unknown = lookupWord("supercalifragilistic");
      assert.equal(unknown.exactMatches.length, 0);
      assert.equal(unknown.suggestions.length, 0);
    });

    it("1.4 【破坏性参数校验】空输入、超长文本与 SQLi/XSS 安全过滤", () => {
      // 空值与空白输入
      const emptyRes = lookupWord("");
      assert.equal(emptyRes.exactMatches.length, 0);
      assert.equal(emptyRes.suggestions.length, 0);
      assert.equal(emptyRes.guesses.length, 0);

      const spaceRes = lookupWord("   \n\t   ");
      assert.equal(spaceRes.exactMatches.length, 0);

      // 超长文本注入 (10000 字符)
      const massiveInput = "word".repeat(2500);
      const massiveRes = lookupWord(massiveInput);
      assert.equal(massiveRes.exactMatches.length, 0);

      // SQL 注入与特殊符号
      const sqli = lookupWord("architecture' OR '1'='1");
      assert.ok(Array.isArray(sqli.exactMatches));
      assert.ok(Array.isArray(sqli.suggestions));
    });

    it("1.5 生词本 (Bookmarks) 收藏状态机与 LocalStorage 闭环", async () => {
      // 初始无收藏
      const initial = await getBookmarks();
      assert.equal(initial.length, 0);
      assert.equal(await isBookmarked("resilience"), false);

      // 1. 收藏 resilience
      const res1 = await toggleBookmark("resilience", "核心架构抗毁性");
      assert.equal(res1.isBookmarked, true);
      assert.equal(await isBookmarked("resilience"), true);
      assert.equal(res1.list[0].word, "resilience");
      assert.equal(res1.list[0].note, "核心架构抗毁性");

      // 2. 再次调用 toggle 取消收藏
      const res2 = await toggleBookmark("resilience");
      assert.equal(res2.isBookmarked, false);
      assert.equal(await isBookmarked("resilience"), false);
      assert.equal(res2.list.length, 0);

      // 3. 空值收藏防御
      const resEmpty = await toggleBookmark("");
      assert.equal(resEmpty.isBookmarked, false);
    });

    it("1.6 查词历史 (Recent Searches) 状态机与清空链路", async () => {
      await clearRecentSearches();

      // 记录 3 次查词
      await recordRecentSearch("architecture");
      await recordRecentSearch("latency");
      const list = await recordRecentSearch("architecture"); // 重复查词置顶

      assert.equal(list[0].word, "architecture", "最近查词应被排重并置顶");
      assert.equal(list.length, 2);

      // 清空
      await clearRecentSearches();
      const cleared = await getRecentSearches();
      assert.equal(cleared.length, 0);
    });

    it("1.7 外部权威词典 URL 生成链路", () => {
      const urls = getOnlineDictionaryUrls("algorithm");
      assert.ok(urls.cambridge.includes("dictionary.cambridge.org"));
      assert.ok(urls.cambridge.includes("algorithm"));
      assert.ok(urls.youdao.includes("dict.youdao.com"));
      assert.ok(urls.bing.includes("cn.bing.com"));
      assert.ok(urls.wordReference.includes("wordreference.com"));
    });
  });

  // ===========================================================================
  // 2. Translator 极速翻译与多语言即时解析集成测试
  // ===========================================================================
  describe("2. Translator 极速翻译与多语言引擎系统", () => {
    it("2.1 30+ 常用语言支持与高精度自动探测", () => {
      assert.ok(SUPPORTED_LANGUAGES.length >= 25, "必须支持至少 25 种核心语言");
      const zh = getLanguageByCode("zh-Hans");
      assert.equal(zh.nativeName, "简体中文");
      assert.equal(zh.flag, "🇨🇳");

      // 语言探测
      assert.equal(detectLanguage("你好世界").code, "zh-Hans");
      assert.equal(detectLanguage("Hello world").code, "en");
      assert.equal(detectLanguage("こんにちは").code, "ja");
      assert.equal(detectLanguage("안녕하세요").code, "ko");
      assert.equal(detectLanguage("Привет мир").code, "ru");
      assert.equal(detectLanguage("Bonjour le monde").code, "fr");
      assert.equal(detectLanguage("Guten Tag").code, "de");
    });

    it("2.2 英汉互译、注音与反向对照释义 (Reverse Translations)", async () => {
      // 英译中
      const resEnZh = await translateText("hello", "en", "zh-Hans");
      assert.equal(resEnZh.translatedText, "你好");
      assert.ok(resEnZh.phonetic?.includes("nǐ"));
      assert.ok(resEnZh.reverseTranslations && resEnZh.reverseTranslations.length >= 1);
      assert.equal(resEnZh.reverseTranslations[0].term, "你好");

      // 中译英
      const resZhEn = await translateText("你好", "zh-Hans", "en");
      assert.equal(resZhEn.translatedText, "Hello");
      assert.ok(resZhEn.phonetic?.includes("həˈloʊ"));

      // 科技词条翻译
      const resArch = await translateText("architecture", "en", "zh-Hans");
      assert.equal(resArch.translatedText, "架构");
      assert.ok(resArch.reverseTranslations?.[0].meaning.includes("architecture"));
    });

    it("2.3 双向语言对调状态机 (Swap Languages)", () => {
      // 显式指定语言对调
      const s1 = swapLanguages("en", "zh-Hans");
      assert.equal(s1.newSource, "zh-Hans");
      assert.equal(s1.newTarget, "en");

      // 自动探测源对调
      const s2 = swapLanguages("auto", "zh-Hans", "ja");
      assert.equal(s2.newSource, "zh-Hans");
      assert.equal(s2.newTarget, "ja");

      // 连续两次对调自洽还原
      const s3 = swapLanguages(s1.newSource, s1.newTarget);
      assert.equal(s3.newSource, "en");
      assert.equal(s3.newTarget, "zh-Hans");
    });

    it("2.4 【Beyond Happy Path 破坏性容错】空文本与极端长文本翻译防御", async () => {
      // 1. 空输入
      const empty = await translateText("");
      assert.equal(empty.translatedText, "");
      assert.equal(empty.sourceText, "");

      const spaces = await translateText("   ");
      assert.equal(spaces.translatedText, "");

      // 2. 超长文本 (>10,000 字符)
      const massiveText = "The quick brown fox jumps over the lazy dog. ".repeat(250);
      const massiveRes = await translateText(massiveText, "en", "zh-Hans");
      assert.ok(massiveRes.translatedText.length > 0);
      assert.equal(massiveRes.sourceLanguage, "en");

      // 3. 畸形特殊字符与 Emoji 混合
      const emojiText = "🚀 Rocket 🔥 Fire 💡 Light";
      const emojiRes = await translateText(emojiText, "en", "zh-Hans");
      assert.ok(emojiRes.translatedText.includes("Rocket"));
    });

    it("2.5 翻译历史 (Recent Translations) 增删查改生命周期闭环", async () => {
      await clearRecentTranslations();

      // 记录 2 条翻译
      await saveRecentTranslation("hello", "你好", "en", "zh-Hans");
      const list = await saveRecentTranslation("world", "世界", "en", "zh-Hans");
      assert.equal(list.length, 2);
      assert.equal(list[0].sourceText, "world");

      // 再次读取验证
      const recents = await getRecentTranslations();
      assert.equal(recents.length, 2);

      // 清空
      await clearRecentTranslations();
      const cleared = await getRecentTranslations();
      assert.equal(cleared.length, 0);
    });

    it("2.6 外部 Web 翻译器 URL 生成校验", () => {
      const urls = getWebTranslatorUrls("hello world", "en", "zh-Hans");
      assert.ok(urls.deepL.includes("deepl.com"));
      assert.ok(urls.googleTranslate.includes("translate.google.com"));
      assert.ok(urls.baidu.includes("fanyi.baidu.com"));
    });
  });

  // ===========================================================================
  // 3. Settings 系统偏好设置中心与 32 款扩展治理测试
  // ===========================================================================
  describe("3. Settings 系统设置管理与 32 款内置扩展治理", () => {
    it("3.1 32 款全量内置扩展清单覆盖与完整元数据", () => {
      assert.equal(BUILTIN_32_EXTENSIONS.length, 32, "必须完整定义 32 款官方内置扩展");
      for (const ext of BUILTIN_32_EXTENSIONS) {
        assert.ok(ext.id.length > 0);
        assert.ok(ext.name.length > 0);
        assert.ok(ext.description.length > 0);
        assert.equal(typeof ext.enabled, "boolean");
        assert.equal(ext.isBuiltin, true);
      }

      // 验证核心扩展存在性
      const ids = BUILTIN_32_EXTENSIONS.map(e => e.id);
      assert.ok(ids.includes("dictionary"));
      assert.ok(ids.includes("translator"));
      assert.ok(ids.includes("settings"));
      assert.ok(ids.includes("everything-file-search"));
      assert.ok(ids.includes("clipboard-history"));
      assert.ok(ids.includes("calculator"));
      assert.ok(ids.includes("ai-mcp"));
      assert.ok(ids.includes("sync-crypto"));
    });

    it("3.2 常规设置 (General) 与真实双向绑定存盘", async () => {
      const initial = await getPreferences();
      assert.equal(initial.general.openAtLogin, true);
      assert.equal(initial.general.autoHideOnBlur, true);
      assert.equal(initial.general.globalHotkey, "Alt+Space");

      // 变更常规设置并持久化
      const updated = await savePreferences({
        general: {
          ...initial.general,
          theme: "dark",
          autoHideOnBlur: false,
          globalHotkey: "Ctrl+Space"
        }
      });
      assert.equal(updated.general.theme, "dark");
      assert.equal(updated.general.autoHideOnBlur, false);
      assert.equal(updated.general.globalHotkey, "Ctrl+Space");

      // 重新读取验证真实双向绑定
      const reloaded = await getPreferences();
      assert.equal(reloaded.general.theme, "dark");
      assert.equal(reloaded.general.autoHideOnBlur, false);
      assert.equal(reloaded.general.globalHotkey, "Ctrl+Space");
    });

    it("3.3 扩展管理：单扩展独立启用/禁用、别名与唤醒热键更新", async () => {
      // 禁用 dictionary 扩展并设置专属热键和别名
      const updated = await updateExtensionConfig("dictionary", {
        enabled: false,
        alias: "dict_fast",
        hotkey: "Alt+D"
      });
      const dictExt = updated.extensions.find(e => e.id === "dictionary");
      assert.ok(dictExt);
      assert.equal(dictExt.enabled, false);
      assert.equal(dictExt.alias, "dict_fast");
      assert.equal(dictExt.hotkey, "Alt+D");

      // 重新启用
      const reEnabled = await updateExtensionConfig("dictionary", { enabled: true });
      const reDict = reEnabled.extensions.find(e => e.id === "dictionary");
      assert.equal(reDict?.enabled, true);
      assert.equal(reDict?.alias, "dict_fast", "别名应被完整保留");
    });

    it("3.4 高级与存储：SQLite WAL 缓存体积计算与一键清空", async () => {
      // 获取当前缓存信息
      const info1 = await getSqliteCacheInfo();
      assert.ok(info1.sizeBytes > 0);
      assert.ok(info1.formattedSize.includes("MB"));

      // 一键清空缓存
      const clearRes = await clearSqliteCache();
      assert.ok(clearRes.clearedBytes > 0);
      assert.equal(clearRes.remainingBytes, 65536);

      // 再次读取验证体积压降
      const info2 = await getSqliteCacheInfo();
      assert.equal(info2.sizeBytes, 65536);
      assert.ok(info2.formattedSize.includes("0.06 MB"));
    });

    it("3.5 【Beyond Happy Path 破坏性容错】损坏 JSON 导入防御与自愈", async () => {
      // 1. 尝试导入畸形损坏的 JSON
      const failRes1 = await importPreferencesJson("CORRUPTED_JSON_NOT_VALID");
      assert.equal(failRes1.success, false);
      assert.ok(failRes1.error?.includes("JSON 解析失败"));

      // 2. 尝试导入空字符串
      const failRes2 = await importPreferencesJson("");
      assert.equal(failRes2.success, false);

      // 3. 恶意篡改数据导入自动清洗
      const maliciousJson = JSON.stringify({
        general: { theme: "MALICIOUS_THEME_CODE", autoHideOnBlur: "not_a_boolean" },
        launcher: { searchSensitivity: -500 }
      });
      const cleanRes = await importPreferencesJson(maliciousJson);
      assert.equal(cleanRes.success, true);
      assert.equal(cleanRes.preferences?.general.theme, "auto");
      assert.equal(cleanRes.preferences?.launcher.searchSensitivity, 80);
    });

    it("3.6 配置导出 JSON 严格性与出厂默认恢复", async () => {
      const exported = await exportPreferencesJson();
      const parsed = JSON.parse(exported);
      assert.ok(parsed.general);
      assert.ok(parsed.extensions);
      assert.ok(parsed.advanced);

      // 恢复出厂默认
      const reset = await resetPreferences();
      assert.equal(reset.general.theme, "auto");
      assert.equal(reset.general.globalHotkey, "Alt+Space");
      assert.equal(reset.extensions.length, 32);
    });
  });

  // ===========================================================================
  // 4. Declarative Component Tree 虚拟视图描述符渲染验证
  // ===========================================================================
  describe("4. Declarative Component Tree 虚拟视图渲染", () => {
    it("4.1 DictionaryCommand 声明式虚拟树生成", () => {
      const vnode = DictionaryCommand();
      assert.ok(vnode, "DictionaryCommand 返回虚拟节点");
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(vnode.props.searchBarPlaceholder.includes("搜索"));
      assert.ok(vnode.props.searchBarAccessory, "包含 List.Dropdown 视图切换器");
    });

    it("4.2 TranslatorCommand 声明式虚拟树生成", () => {
      const vnode = TranslatorCommand();
      assert.ok(vnode, "TranslatorCommand 返回虚拟节点");
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(vnode.props.searchBarAccessory, "包含目标语言选择器");
    });

    it("4.3 SettingsCommand 声明式虚拟树生成", () => {
      const vnode = SettingsCommand();
      assert.ok(vnode, "SettingsCommand 返回虚拟节点");
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(vnode.props.searchBarAccessory, "包含 5 大 Tab 切换下拉菜单");
    });
  });
});
