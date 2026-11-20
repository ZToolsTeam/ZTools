export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en-US";

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

function matchSupportedLocale(raw?: string | null): SupportedLocale | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return null;

  for (const supported of SUPPORTED_LOCALES) {
    if (supported.toLowerCase() === normalized) {
      return supported;
    }
  }

  const primary = normalized.split("-")[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en-US";
  return null;
}

/**
 * 将任意原始语言标识归一化为受支持的 locale（当前支持 zh-CN / en-US）。
 * 无法识别时回退至 fallback，若 fallback 亦无效则回退至 DEFAULT_LOCALE ('en-US')。
 */
export function resolveLocale(
  raw?: string | null,
  fallback: string = DEFAULT_LOCALE
): SupportedLocale {
  return (
    matchSupportedLocale(raw) ??
    matchSupportedLocale(fallback) ??
    DEFAULT_LOCALE
  );
}

function readInitialGlobalLocale(): SupportedLocale {
  const globalRecord = globalThis as Record<string, unknown>;
  const raw =
    typeof globalRecord.__ztoolsLocale === "string"
      ? globalRecord.__ztoolsLocale
      : undefined;
  return raw ? resolveLocale(raw, DEFAULT_LOCALE) : DEFAULT_LOCALE;
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

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, token: string) => {
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

export type MessageCatalog<T extends Record<string, string>> = {
  readonly [K in keyof T]?: string;
};

/**
 * 创建带 `{var}` 插值与自动逐级回退（当前 locale → 'en-US' → defaultLocale → Key）的翻译函数。
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

    return interpolate(template ?? String(key), params);
  };
}
