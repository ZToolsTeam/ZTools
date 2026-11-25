import { currentInstance, isEvaluatingChildElement, EffectCallback } from "./context.js";
import {
  DEFAULT_LOCALE,
  createTranslator,
  getLocale,
  onLocaleChange,
  resolveLocale,
  type CreateTranslatorOptions,
  type MessageCatalog,
  type SupportedLocale,
  type Translator
} from "./locale.js";

function areDepsEqual(prevDeps?: readonly unknown[], nextDeps?: readonly unknown[]): boolean {
  if (!prevDeps || !nextDeps) return false;
  if (prevDeps.length !== nextDeps.length) return false;
  for (let i = 0; i < prevDeps.length; i++) {
    if (!Object.is(prevDeps[i], nextDeps[i])) {
      return false;
    }
  }
  return true;
}

type StateSetter<T> = (action: T | ((prevState: T) => T)) => void;

function resolveInitial<T>(initialState: T | (() => T)): T {
  return typeof initialState === "function" ? (initialState as () => T)() : initialState;
}

/** 在当前实例的 hook 槽位上创建（首次）或读取 state 记录；initial 只在首次创建时调用 */
function useStateSlot<T>(initial: () => T): { value: T; setter: StateSetter<T>; index: number; created: boolean } {
  const instance = currentInstance!;
  const hooks = instance.getHooks();
  const index = instance.hookIndex;
  instance.hookIndex = index + 1;
  let created = false;

  if (hooks.length <= index) {
    created = true;
    const setter: StateSetter<T> = (action) => {
      const hookRecord = hooks[index];
      const prevVal = hookRecord.value as T;
      const nextVal = typeof action === "function" ? (action as (p: T) => T)(prevVal) : action;

      if (!Object.is(prevVal, nextVal)) {
        hookRecord.value = nextVal;
        instance.scheduleRender();
      }
    };

    hooks[index] = {
      type: "state",
      value: initial(),
      setter: setter as (newVal: unknown) => void
    };
  }

  const currentHook = hooks[index];
  return {
    value: currentHook.value as T,
    setter: currentHook.setter as StateSetter<T>,
    index,
    created
  };
}

/**
 * 声明式微状态 Hook: useState
 */
export function useState<T>(
  initialState: T | (() => T)
): [T, (action: T | ((prevState: T) => T)) => void] {
  if (!currentInstance) {
    return [resolveInitial(initialState), () => {}];
  }
  const slot = useStateSlot(() => resolveInitial(initialState));
  return [slot.value, slot.setter];
}

export interface PopoutStateOptions<T> {
  /**
   * 值里引用的本地路径。弹出独立窗口时，宿主把当前窗口对这些路径已有的授权（不会更多）转交给新窗口；
   * 当前窗口没有授权的路径会被跳过。
   */
  paths?: (value: T) => readonly string[] | null | undefined;
}

const MAX_POPOUT_KEY_LENGTH = 64;

function isValidPopoutKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_POPOUT_KEY_LENGTH && !/[\u0000-\u001f]/.test(key);
}

/**
 * 与 useState 相同；值会在「弹出独立窗口」时交给新窗口，新窗口首次渲染时用它代替 initialValue（只用一次）。
 *
 * - 只在根页面（导航栈第一层）生效；推入的二级页面里调用等同 useState；
 * - 值必须能 JSON 序列化（普通对象 / 数组 / 字符串 / 有限数字 / 布尔 / null），否则该项不带，新窗口用 initialValue；
 * - 插件升级后旧值的形状可能变化，插件要自己做容错；
 * - key 为 1–64 个字符、同一页面内唯一，重复的 key 只有第一个生效。
 */
export function usePopoutState<T>(
  key: string,
  initialValue: T | (() => T),
  options?: PopoutStateOptions<T>
): [T, (action: T | ((prevState: T) => T)) => void] {
  const instance = currentInstance;
  if (!instance) {
    return [resolveInitial(initialValue), () => {}];
  }
  const validKey = isValidPopoutKey(key);
  const slot = useStateSlot<T>(() => {
    if (validKey) {
      const seeded = instance.consumePopoutSeed(key);
      if (seeded.found) return seeded.value as T;
    }
    return resolveInitial(initialValue);
  });
  if (!validKey) {
    if (slot.created) console.warn(`[usePopoutState] key 无效（需要 1–${MAX_POPOUT_KEY_LENGTH} 个字符），按普通 useState 处理:`, key);
  } else if (!instance.registerPopoutState(key, slot.index, options?.paths as ((value: unknown) => unknown) | undefined) && slot.created) {
    console.warn(`[usePopoutState] key "${key}" 在同一页面重复使用，只有第一个会带到独立窗口`);
  }
  return [slot.value, slot.setter];
}

/**
 * 声明式微副作用 Hook: useEffect
 */
export function useEffect(effect: EffectCallback, deps?: readonly unknown[]): void {
  if (isEvaluatingChildElement) {
    return;
  }
  const instance = currentInstance;
  if (!instance) {
    try {
      effect();
    } catch {
      // ignore
    }
    return;
  }

  const hooks = instance.getHooks();
  const index = instance.hookIndex;
  instance.hookIndex = index + 1;

  if (hooks.length <= index) {
    hooks[index] = {
      type: "effect",
      value: effect,
      deps
    };
  } else {
    const prevHook = hooks[index];
    const hasChanged = !areDepsEqual(prevHook.deps, deps);
    if (hasChanged) {
      prevHook.value = effect;
      prevHook.deps = deps;
    } else {
      // 依赖没有变化，不需要重新执行
      prevHook.value = null;
    }
  }
}

/**
 * 声明式记忆化 Hook: useMemo
 */
export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const instance = currentInstance;
  if (!instance) {
    return factory();
  }

  const hooks = instance.getHooks();
  const index = instance.hookIndex;
  instance.hookIndex = index + 1;

  const actualDeps = deps || [];

  if (hooks.length <= index) {
    const value = factory();
    hooks[index] = {
      type: "memo",
      value,
      deps: actualDeps
    };
    return value;
  }

  const prevHook = hooks[index];
  if (!areDepsEqual(prevHook.deps, actualDeps)) {
    const value = factory();
    prevHook.value = value;
    prevHook.deps = actualDeps;
    return value;
  }

  return prevHook.value as T;
}

/**
 * 声明式回调 Hook: useCallback
 */
export function useCallback<T extends (...args: never[]) => unknown>(
  callback: T,
  deps?: readonly unknown[]
): T {
  return useMemo(() => callback, deps);
}

/**
 * 声明式引用 Hook: useRef
 */
export function useRef<T>(initialValue: T): { current: T } {
  const instance = currentInstance;
  if (!instance) {
    return { current: initialValue };
  }

  const hooks = instance.getHooks();
  const index = instance.hookIndex;
  instance.hookIndex = index + 1;

  if (hooks.length <= index) {
    const ref = { current: initialValue };
    hooks[index] = {
      type: "ref",
      value: ref
    };
    return ref;
  }

  return hooks[index].value as { current: T };
}

/**
 * 声明式语言 Hook: useLocale
 * 订阅运行时语言变更，语言切换时自动触发组件重绘，卸载时成对清理监听器。
 */
export function useLocale(): string {
  const [locale, setLocale] = useState<string>(() => getLocale());

  useEffect(() => {
    const latest = getLocale();
    setLocale((prev) => (prev === latest ? prev : latest));
    return onLocaleChange((nextLocale) => {
      setLocale(nextLocale);
    });
  }, []);

  return locale;
}

export interface UseI18nResult<K extends string = string> {
  locale: SupportedLocale;
  t: Translator<K>;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
}

const INTL_FORMATTER_CACHE_LIMIT = 64;
const numberFormatCache = new Map<string, Intl.NumberFormat>();
const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();

function buildIntlCacheKey(locale: string, options?: Record<string, unknown>): string {
  if (!options) return locale;
  const keys = Object.keys(options).sort();
  if (keys.length === 0) return locale;
  let key = locale;
  for (const k of keys) {
    const v = options[k];
    if (v !== undefined) {
      key += `|${k}=${String(v)}`;
    }
  }
  return key;
}

function getCachedNumberFormat(
  locale: string,
  formatOptions?: Intl.NumberFormatOptions
): Intl.NumberFormat {
  const key = buildIntlCacheKey(locale, formatOptions as Record<string, unknown> | undefined);
  let formatter = numberFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, formatOptions);
    if (numberFormatCache.size >= INTL_FORMATTER_CACHE_LIMIT) {
      const oldestKey = numberFormatCache.keys().next().value;
      if (oldestKey !== undefined) numberFormatCache.delete(oldestKey);
    }
    numberFormatCache.set(key, formatter);
  }
  return formatter;
}

function getCachedDateTimeFormat(
  locale: string,
  formatOptions?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = buildIntlCacheKey(locale, formatOptions as Record<string, unknown> | undefined);
  let formatter = dateTimeFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, formatOptions);
    if (dateTimeFormatCache.size >= INTL_FORMATTER_CACHE_LIMIT) {
      const oldestKey = dateTimeFormatCache.keys().next().value;
      if (oldestKey !== undefined) dateTimeFormatCache.delete(oldestKey);
    }
    dateTimeFormatCache.set(key, formatter);
  }
  return formatter;
}

/**
 * 声明式多语言组合 Hook: useI18n
 * 组合 useLocale() 与 createTranslator()，并提供绑定当前响应式 locale 的 Intl 数字/日期格式化函数。
 */
export function useI18n<T extends Record<string, string> = Record<string, string>>(
  messages: Record<string, MessageCatalog<T>>,
  options?: CreateTranslatorOptions
): UseI18nResult<Extract<keyof T, string>> {
  const rawLocale = useLocale();
  const locale = resolveLocale(rawLocale, DEFAULT_LOCALE);
  const defaultLocale = options?.defaultLocale;

  return useMemo(() => {
    const t = createTranslator<T>(
      messages,
      defaultLocale !== undefined ? { defaultLocale } : undefined
    );

    const formatNumber = (value: number, formatOptions?: Intl.NumberFormatOptions): string => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return String(value);
      }
      return getCachedNumberFormat(locale, formatOptions).format(value);
    };

    const formatDate = (
      value: Date | number | string,
      formatOptions?: Intl.DateTimeFormatOptions
    ): string => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return getCachedDateTimeFormat(locale, formatOptions).format(date);
    };

    return {
      locale,
      t,
      formatNumber,
      formatDate
    };
  }, [locale, messages, defaultLocale]);
}
