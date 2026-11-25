/**
 * @raycast/utils 兼容层实现
 * 覆盖社区扩展高频使用的 usePromise, useCachedPromise, useFetch, useCachedState
 * 支持标准 React Hooks 环境与 ZTools 声明式微运行时自适应
 *
 * 插件可用的名字由 ./index.ts 列出；createCacheScope 只给宿主用，经 ../host/index.ts 引出，不进包入口。
 */

import { useState as microUseState, useEffect as microUseEffect, useCallback as microUseCallback, useRef as microUseRef } from "../runtime/hooks.js";
import { Cache, createScopedCacheClass } from "../api/cache.js";

interface HooksAdapter {
  useState: <T>(initial: T | (() => T)) => [T, (val: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void) | Promise<void>, deps?: readonly unknown[]) => void;
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps?: readonly unknown[]) => T;
  useRef: <T>(initial: T) => { current: T };
}

interface GlobalWithReact {
  require?: (id: string) => unknown;
  React?: Partial<HooksAdapter>;
}

// 探测是否处于标准 React 运行时环境
function getHooks(): HooksAdapter {
  try {
    const g = globalThis as unknown as GlobalWithReact;
    const req = typeof g.require === "function" ? g.require : null;
    const react = (g.React || (req ? req("react") : null)) as Partial<HooksAdapter> | null;
    if (
      react &&
      typeof react.useState === "function" &&
      typeof react.useEffect === "function" &&
      typeof react.useCallback === "function" &&
      typeof react.useRef === "function"
    ) {
      return {
        useState: react.useState,
        useEffect: react.useEffect,
        useCallback: react.useCallback,
        useRef: react.useRef
      };
    }
  } catch (err) {
    // 非标准 React 环境或宿主未注入 require("react")，回落到声明式微运行时 hooks
    void err;
  }
  return {
    useState: microUseState,
    useEffect: microUseEffect,
    useCallback: microUseCallback,
    useRef: microUseRef
  };
}

export interface UsePromiseOptions<T> {
  execute?: boolean;
  initialData?: T;
  onData?: (data: T) => void;
  onError?: (error: Error) => void;
}

export interface UsePromiseResult<T> {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
  revalidate: () => Promise<T | undefined>;
  mutate: (asyncUpdate?: Promise<T> | ((currentData: T | undefined) => Promise<T> | T), options?: { shouldRevalidate?: boolean }) => Promise<T | undefined>;
}

export function usePromise<T, TArgs extends unknown[] = unknown[]>(
  fn: (...args: TArgs) => Promise<T>,
  args?: TArgs,
  options?: UsePromiseOptions<T>
): UsePromiseResult<T> {
  const hooks = getHooks();
  const execute = options?.execute !== false;
  const initialData = options?.initialData;

  const [data, setData] = hooks.useState<T | undefined>(initialData);
  const [error, setError] = hooks.useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = hooks.useState<boolean>(execute);
  const fnRef = hooks.useRef(fn);
  fnRef.current = fn;

  const argsKey = JSON.stringify(args || []);

  const revalidate = hooks.useCallback(async (): Promise<T | undefined> => {
    if (!execute) {
      setIsLoading(false);
      return undefined;
    }
    setIsLoading(true);
    setError(undefined);
    try {
      const callArgs = (args || []) as TArgs;
      const result = await fnRef.current(...callArgs);
      setData(result);
      setIsLoading(false);
      options?.onData?.(result);
      return result;
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      setError(errorObj);
      setIsLoading(false);
      options?.onError?.(errorObj);
      return undefined;
    }
  }, [argsKey, execute]);

  hooks.useEffect(() => {
    let active = true;
    if (execute) {
      revalidate();
    } else {
      setIsLoading(false);
    }
    return () => {
      active = false;
    };
  }, [argsKey, execute]);

  const mutate = hooks.useCallback(
    async (
      asyncUpdate?: Promise<T> | ((currentData: T | undefined) => Promise<T> | T),
      mutateOptions?: { shouldRevalidate?: boolean }
    ): Promise<T | undefined> => {
      if (!asyncUpdate) {
        return revalidate();
      }
      try {
        if (typeof asyncUpdate === "function") {
          const next = await asyncUpdate(data);
          setData(next);
        } else {
          const next = await asyncUpdate;
          setData(next);
        }
        if (mutateOptions?.shouldRevalidate !== false) {
          return revalidate();
        }
        return data;
      } catch (err: unknown) {
        setError(err instanceof Error ? err : new Error(String(err)));
        return undefined;
      }
    },
    [data, revalidate]
  );

  return {
    data,
    error,
    isLoading,
    revalidate,
    mutate
  };
}

// useCachedPromise / useCachedState 共用的缓存命名空间
const CACHED_HOOKS_NAMESPACE = "@raycast/utils.useCachedPromise";

// 默认作用域的缓存单例（未经宿主分配作用域时使用，如 Node 测试）
const internalPromiseCache = new Cache({ namespace: CACHED_HOOKS_NAMESPACE });

export interface UseCachedPromiseOptions<T> extends UsePromiseOptions<T> {
  keepPreviousData?: boolean;
}

export function useCachedPromise<T, TArgs extends unknown[] = unknown[]>(
  fn: (...args: TArgs) => Promise<T>,
  args?: TArgs,
  options?: UseCachedPromiseOptions<T>
): UsePromiseResult<T> {
  return useCachedPromiseWith(internalPromiseCache, fn, args, options);
}

function useCachedPromiseWith<T, TArgs extends unknown[] = unknown[]>(
  cache: Cache,
  fn: (...args: TArgs) => Promise<T>,
  args?: TArgs,
  options?: UseCachedPromiseOptions<T>
): UsePromiseResult<T> {
  const hooks = getHooks();
  const cacheKey = `${fn.name || "anon"}:${JSON.stringify(args || [])}`;
  const initializedRef = hooks.useRef(false);

  // 仅首次渲染读取并反序列化缓存，避免后续每次重渲染重复同步 JSON.parse
  let cachedData = options?.initialData;
  if (!initializedRef.current) {
    initializedRef.current = true;
    const rawCached = cache.get(cacheKey);
    if (rawCached !== undefined) {
      try {
        cachedData = JSON.parse(rawCached) as T;
      } catch (err) {
        // 缓存 JSON 损坏时安全回落 initialData
        void err;
      }
    }
  }

  const result = usePromise(
    fn,
    args,
    {
      ...options,
      initialData: cachedData,
      onData: (data) => {
        try {
          cache.set(cacheKey, JSON.stringify(data));
        } catch (err) {
          // 不可序列化数据跳过写入缓存，不影响本次结果展示
          void err;
        }
        options?.onData?.(data);
      }
    }
  );

  return result;
}

export interface UseFetchOptions<T> {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  execute?: boolean;
  initialData?: T;
  parseResponse?: (response: Response) => Promise<T>;
}

export function useFetch<T = unknown>(
  url: string | (() => string),
  options?: UseFetchOptions<T>
): UsePromiseResult<T> {
  const resolvedUrl = typeof url === "function" ? url() : url;

  return usePromise<T>(
    async () => {
      const res = await fetch(resolvedUrl, {
        method: options?.method || "GET",
        headers: options?.headers,
        body: options?.body ? JSON.stringify(options.body) : undefined
      });
      if (!res.ok) {
        throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
      }
      if (options?.parseResponse) {
        return options.parseResponse(res);
      }
      return (await res.json()) as T;
    },
    [resolvedUrl, JSON.stringify(options?.headers), options?.method],
    {
      execute: options?.execute !== false && !!resolvedUrl,
      initialData: options?.initialData
    }
  );
}

export function useCachedState<T>(
  key: string,
  initialValue: T,
  options?: { cache?: Cache }
): [T, (val: T | ((prev: T) => T)) => void] {
  return useCachedStateWith(internalPromiseCache, key, initialValue, options);
}

function useCachedStateWith<T>(
  defaultCache: Cache,
  key: string,
  initialValue: T,
  options?: { cache?: Cache }
): [T, (val: T | ((prev: T) => T)) => void] {
  const hooks = getHooks();
  const cache = options?.cache || defaultCache;

  const [state, setState] = hooks.useState<T>(() => {
    const raw = cache.get(key);
    if (raw !== undefined) {
      try {
        return JSON.parse(raw) as T;
      } catch (err) {
        // 缓存 JSON 损坏时安全回落 initialValue
        void err;
      }
    }
    return initialValue;
  });

  const setCachedState = hooks.useCallback(
    (newValOrFn: T | ((prev: T) => T)) => {
      setState((prev: T) => {
        const next = typeof newValOrFn === "function" ? (newValOrFn as (p: T) => T)(prev) : newValOrFn;
        try {
          cache.set(key, JSON.stringify(next));
        } catch (err) {
          // 不可序列化状态跳过缓存持久化
          void err;
        }
        return next;
      });
    },
    [key]
  );

  return [state, setCachedState];
}

/** 一个缓存作用域内的 Cache 类与绑定到该作用域的缓存 Hook */
export interface CacheScope {
  Cache: typeof Cache;
  useCachedPromise: typeof useCachedPromise;
  useCachedState: typeof useCachedState;
}

/**
 * 创建一个独立的缓存作用域。客户端为每个插件调用一次，插件拿到的 Cache、useCachedPromise、
 * useCachedState 都落在本插件的作用域里，读不到其他插件的缓存。
 * 只供宿主加载器使用（@ztools/declarative-ui/host），不从包入口导出给插件。
 */
export function createCacheScope(): CacheScope {
  const ScopedCache = createScopedCacheClass();
  const hookCache = new ScopedCache({ namespace: CACHED_HOOKS_NAMESPACE });
  return {
    Cache: ScopedCache,
    useCachedPromise: (fn, args, options) => useCachedPromiseWith(hookCache, fn, args, options),
    useCachedState: (key, initialValue, options) => useCachedStateWith(hookCache, key, initialValue, options)
  };
}
