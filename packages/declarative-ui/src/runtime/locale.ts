export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en-US";

export const SYSTEM_LOCALE = "system" as const;

export type LocaleChangeListener = (locale: string) => void;

export type TranslationParamValue = string | number | boolean | null | undefined;
export type TranslationParams = Record<string, TranslationParamValue>;

export interface CreateTranslatorOptions {
  defaultLocale?: string;
}

export type Translator<K extends string = string> = (
  key: K,
  params?: TranslationParams
) => string;

/**
 * 清理语言标签：去首尾空白、剥离 POSIX `.UTF-8` / `@...` 后缀并将 `_` 转为 `-`。
 * 与 `packages/ztools-plugins-spec/src/locale.js` 保持 100% 行为等价。
 */
export function stripLocaleSuffix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withoutPosix = trimmed.split(/[.@]/)[0] || "";
  return withoutPosix.trim().replace(/_/g, "-");
}

/**
 * 严格匹配受支持语言标签（zh-CN / en-US）。
 * 遇到空值、`'system'`/`'auto'`/`'default'` 或第三语种（如 `ja-JP`/`fr-FR`）时返回 `null`。
 */
export function matchSupportedLocale(raw?: unknown): SupportedLocale | null {
  const cleaned = stripLocaleSuffix(raw);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === SYSTEM_LOCALE || lower === "auto" || lower === "default") {
    return null;
  }
  if (lower === "zh" || lower.startsWith("zh-")) {
    return "zh-CN";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en-US";
  }
  return null;
}

/**
 * 将单个或一组原始语言候选归一化为受支持的 locale（当前支持 zh-CN / en-US）。
 * 自动跳过空值、`'system'` 与第三语种；全部未命中时回退至 fallback，若 fallback 亦无效则回退至 DEFAULT_LOCALE ('en-US')。
 */
export function resolveLocale(
  raw?: unknown | readonly unknown[],
  fallback: string = DEFAULT_LOCALE
): SupportedLocale {
  const list = Array.isArray(raw) ? raw : [raw];
  for (const item of list) {
    const matched = matchSupportedLocale(item);
    if (matched) return matched;
  }
  return matchSupportedLocale(fallback) ?? DEFAULT_LOCALE;
}

function readInitialGlobalLocale(): SupportedLocale {
  const globalRecord = globalThis as Record<string, unknown>;
  const explicit =
    typeof globalRecord.__ztoolsLocale === "string"
      ? globalRecord.__ztoolsLocale
      : undefined;
  if (explicit) {
    return resolveLocale(explicit, DEFAULT_LOCALE);
  }
  // 兼容旧版前端壳层或未注入 __ztoolsLocale 的独立渲染窗口：
  // 仅在浏览器/Electron DOM 环境下读取 <html lang> 与 navigator.language，避免污染纯 Node 测试环境的确定性。
  if (typeof document !== "undefined") {
    const docLang = document.documentElement?.lang;
    const navLang = typeof navigator !== "undefined" ? navigator.language : undefined;
    return resolveLocale([docLang, navLang], DEFAULT_LOCALE);
  }
  return DEFAULT_LOCALE;
}

let currentLocale: SupportedLocale = readInitialGlobalLocale();
const localeListeners = new Set<LocaleChangeListener>();

/**
 * 读取当前声明式运行时生效的语言标识。
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * 订阅运行时语言变更事件；返回幂等的取消订阅函数。
 */
export function onLocaleChange(listener: LocaleChangeListener): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

/**
 * 供宿主 Worker 入口在 initialize / updateLocale 时调用，更新当前运行时语言并通知所有订阅者
 * （包含全部已挂载的 DeclarativeRenderInstance 触发 scheduleRender 热重绘）。
 */
export function setRuntimeLocale(nextLocale: string): void {
  const resolved = resolveLocale(nextLocale, DEFAULT_LOCALE);
  if (resolved === currentLocale) return;
  currentLocale = resolved;
  for (const listener of Array.from(localeListeners)) {
    try {
      listener(currentLocale);
    } catch (err) {
      console.error("[declarative-ui] Error in locale change listener:", err);
    }
  }
}

;(globalThis as Record<string, unknown>).__ztoolsSetRuntimeLocale = setRuntimeLocale;

function lookupMessage(
  messages: Record<string, Record<string, string | undefined> | undefined>,
  locale: string,
  key: string
): string | undefined {
  const dict = messages[locale];
  if (!dict || !Object.prototype.hasOwnProperty.call(dict, key)) {
    return undefined;
  }
  const value = dict[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

const ESCAPED_PIPE_SENTINEL = "\uE000ZTOOLS_PIPE\uE001";
const ESCAPED_BRACE_PREFIX = "\uE000ZTOOLS_LBRACE:";
const ESCAPED_BRACE_SUFFIX = ":ZTOOLS_RBRACE\uE001";
const ESCAPED_PIPE_RE = /\\\|/g;
const ESCAPED_BRACE_RE = /\{\{([A-Za-z0-9_.-]+)\}\}/g;
const INLINE_PLURAL_RE = /\[\[([A-Za-z0-9_.-]+):([^\]]+)\]\]/g;
const INTERPOLATION_RE = /\{([A-Za-z0-9_.-]+)\}/g;
const RESTORE_BRACE_RE = new RegExp(`${ESCAPED_BRACE_PREFIX}([A-Za-z0-9_.-]+)${ESCAPED_BRACE_SUFFIX}`, "g");
const RESTORE_PIPE_RE = new RegExp(ESCAPED_PIPE_SENTINEL, "g");

function selectPluralForm(forms: string[], count: number): string {
  if (forms.length <= 1) {
    return forms[0] ?? "";
  }
  if (forms.length === 2) {
    return Math.abs(count) === 1 ? forms[0] : forms[1];
  }
  if (count === 0) {
    return forms[0];
  }
  return Math.abs(count) === 1 ? forms[1] : forms[2];
}

/**
 * 在排除 `[[...]]` 内联复数段之后，按顶层未转义 `|` 切分整串模板。
 */
function splitTopLevelPipeForms(template: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inInlinePlural = false;

  for (let i = 0; i < template.length; i += 1) {
    if (!inInlinePlural && template[i] === "[" && template[i + 1] === "[") {
      inInlinePlural = true;
      current += "[[";
      i += 1;
      continue;
    }
    if (inInlinePlural && template[i] === "]" && template[i + 1] === "]") {
      inInlinePlural = false;
      current += "]]";
      i += 1;
      continue;
    }
    if (!inInlinePlural && template[i] === "|") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += template[i];
  }

  parts.push(parts.length > 0 ? current.trim() : current);
  return parts;
}

function formatTemplate(template: string, params?: TranslationParams): string {
  // 纯静态文案（不含插值花括号、复数管道与内联复数段）快速零分配短路
  if (!template.includes("{") && !template.includes("|") && !template.includes("[[")) {
    return template;
  }

  // 1. 先保护字面量转义：`\|` 与 `{{var}}`，避免与复数切分和 `{var}` 插值冲突
  let hasEscapedPipe = false;
  let hasEscapedBrace = false;
  let working = template;
  if (working.includes("\\|")) {
    hasEscapedPipe = true;
    working = working.replace(ESCAPED_PIPE_RE, ESCAPED_PIPE_SENTINEL);
  }
  if (working.includes("{{")) {
    hasEscapedBrace = true;
    working = working.replace(
      ESCAPED_BRACE_RE,
      (_match, token: string) => `${ESCAPED_BRACE_PREFIX}${token}${ESCAPED_BRACE_SUFFIX}`
    );
  }

  // 2. 整串 `|` 分段复数（当 params.count 为有限数字且存在顶层未转义 `|` 时生效）
  const rawCount = params && Object.prototype.hasOwnProperty.call(params, "count") ? params.count : undefined;
  if (typeof rawCount === "number" && Number.isFinite(rawCount) && working.includes("|")) {
    const topForms = splitTopLevelPipeForms(working);
    if (topForms.length > 1) {
      working = selectPluralForm(topForms, rawCount);
    }
  }

  // 3. 内联复数段 `[[param:singular|plural]]` 与 `[[param:zero|one|other]]`
  if (params && working.includes("[[")) {
    working = working.replace(
      INLINE_PLURAL_RE,
      (match, token: string, body: string) => {
        if (!Object.prototype.hasOwnProperty.call(params, token)) {
          return match;
        }
        const value = params[token];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return match;
        }
        const forms = body.split("|");
        return selectPluralForm(forms, value);
      }
    );
  }

  // 4. 常规 `{var}` 插值（安全支持 0 / false / ""，忽略 null / undefined 与缺省参数）
  if (params && working.includes("{")) {
    working = working.replace(INTERPOLATION_RE, (match, token: string) => {
      if (!Object.prototype.hasOwnProperty.call(params, token)) {
        return match;
      }
      const value = params[token];
      if (value === undefined || value === null) {
        return match;
      }
      return String(value);
    });
  }

  // 5. 还原字面量转义：`{{var}}` -> `{var}`，`\|` -> `|`
  if (hasEscapedBrace) {
    working = working.replace(RESTORE_BRACE_RE, (_match, token: string) => `{${token}}`);
  }
  if (hasEscapedPipe) {
    working = working.replace(RESTORE_PIPE_RE, "|");
  }
  return working;
}

export type MessageCatalog<T extends Record<string, string>> = {
  readonly [K in keyof T]?: string;
};

/**
 * 创建带 `{var}` 插值、内联/管道复数、`{{var}}` 字面量转义与自动逐级回退（当前 locale → 'en-US' → defaultLocale → Key）的翻译函数。
 */
export function createTranslator<T extends Record<string, string> = Record<string, string>>(
  messages: Record<string, MessageCatalog<T>>,
  options?: CreateTranslatorOptions
): Translator<Extract<keyof T, string>> {
  const optionDefaultLocale =
    typeof options?.defaultLocale === "string" && options.defaultLocale.trim().length > 0
      ? options.defaultLocale.trim()
      : undefined;
  const resolvedOptionDefault = optionDefaultLocale
    ? resolveLocale(optionDefaultLocale, DEFAULT_LOCALE)
    : undefined;

  return (key, params) => {
    const activeLocale = getLocale();
    const candidates: string[] = [];
    const pushCandidate = (loc?: string) => {
      if (loc && !candidates.includes(loc)) {
        candidates.push(loc);
      }
    };

    pushCandidate(activeLocale);
    pushCandidate(DEFAULT_LOCALE);
    pushCandidate(optionDefaultLocale);
    pushCandidate(resolvedOptionDefault);

    let template: string | undefined;
    for (const candidate of candidates) {
      template = lookupMessage(messages, candidate, key);
      if (template !== undefined) {
        break;
      }
    }

    return formatTemplate(template ?? String(key), params);
  };
}
