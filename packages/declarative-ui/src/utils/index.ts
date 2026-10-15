/**
 * @raycast/utils 兼容层实现
 * 覆盖社区扩展高频使用的 usePromise, useCachedPromise, useFetch, useCachedState
 * 支持标准 React Hooks 环境与 ZTools 声明式微运行时自适应
 */

import { useState as microUseState, useEffect as microUseEffect, useCallback as microUseCallback, useRef as microUseRef } from "../runtime/hooks.js";
import { Cache } from "../api/cache.js";

declare const require: any;

interface HooksAdapter {
  useState: <T>(initial: T | (() => T)) => [T, (val: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void) | Promise<void>, deps?: any[]) => void;
  useCallback: <T extends (...args: any[]) => any>(fn: T, deps?: any[]) => T;
  useRef: <T>(initial: T) => { current: T };
}

// 探测是否处于标准 React 运行时环境
function getHooks(): HooksAdapter {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const react = (globalThis as any).React || (typeof require === "function" ? require("react") : null);
    if (react && typeof react.useState === "function") {
      return {
        useState: react.useState,
        useEffect: react.useEffect,
        useCallback: react.useCallback,
        useRef: react.useRef
      };
    }
  } catch {}
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
  mutate: (asyncUpdate?: Promise<any> | ((currentData: T | undefined) => Promise<T> | T), options?: { shouldRevalidate?: boolean }) => Promise<T | undefined>;
}

export function usePromise<T, TArgs extends any[] = any[]>(
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
      const result = await fnRef.current(...(args || [] as any));
      setData(result);
      setIsLoading(false);
      options?.onData?.(result);
      return result;
    } catch (err: any) {
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
      asyncUpdate?: Promise<any> | ((currentData: T | undefined) => Promise<T> | T),
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
      } catch (err: any) {
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

// 缓存单例供 useCachedPromise 使用
const internalPromiseCache = new Cache({ namespace: "@raycast/utils.useCachedPromise" });

export interface UseCachedPromiseOptions<T> extends UsePromiseOptions<T> {
  keepPreviousData?: boolean;
}

export function useCachedPromise<T, TArgs extends any[] = any[]>(
  fn: (...args: TArgs) => Promise<T>,
  args?: TArgs,
  options?: UseCachedPromiseOptions<T>
): UsePromiseResult<T> {
  const cacheKey = `${fn.name || "anon"}:${JSON.stringify(args || [])}`;

  // 尝试命中缓存初始化
  let cachedData = options?.initialData;
  const rawCached = internalPromiseCache.get(cacheKey);
  if (rawCached !== undefined) {
    try {
      cachedData = JSON.parse(rawCached);
    } catch {}
  }

  const result = usePromise(
    async (...callArgs: TArgs) => {
      const res = await fn(...callArgs);
      try {
        internalPromiseCache.set(cacheKey, JSON.stringify(res));
      } catch {}
      return res;
    },
    args,
    {
      ...options,
      initialData: cachedData,
      onData: (data) => {
        try {
          internalPromiseCache.set(cacheKey, JSON.stringify(data));
        } catch {}
        options?.onData?.(data);
      }
    }
  );

  return result;
}

export interface UseFetchOptions<T> {
  headers?: Record<string, string>;
  method?: string;
  body?: any;
  execute?: boolean;
  initialData?: T;
  parseResponse?: (response: Response) => Promise<T>;
}

export function useFetch<T = any>(
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
  const hooks = getHooks();
  const cache = options?.cache || internalPromiseCache;

  let startVal = initialValue;
  const raw = cache.get(key);
  if (raw !== undefined) {
    try {
      startVal = JSON.parse(raw);
    } catch {}
  }

  const [state, setState] = hooks.useState<T>(startVal);

  const setCachedState = hooks.useCallback(
    (newValOrFn: T | ((prev: T) => T)) => {
      setState((prev: T) => {
        const next = typeof newValOrFn === "function" ? (newValOrFn as any)(prev) : newValOrFn;
        try {
          cache.set(key, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [key]
  );

  return [state, setCachedState];
}
