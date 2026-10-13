/**
 * @raycast/utils 兼容层实现
 * 覆盖社区扩展高频使用的 usePromise, useCachedPromise, useFetch, useCachedState
 * 支持标准 React Hooks 环境与 ZTools 声明式微运行时自适应
 */
import { useState as microUseState, useEffect as microUseEffect, useCallback as microUseCallback, useRef as microUseRef } from "../runtime/hooks.js";
import { Cache } from "../api/cache.js";
// 探测是否处于标准 React 运行时环境
function getHooks() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const react = globalThis.React || (typeof require === "function" ? require("react") : null);
        if (react && typeof react.useState === "function") {
            return {
                useState: react.useState,
                useEffect: react.useEffect,
                useCallback: react.useCallback,
                useRef: react.useRef
            };
        }
    }
    catch { }
    return {
        useState: microUseState,
        useEffect: microUseEffect,
        useCallback: microUseCallback,
        useRef: microUseRef
    };
}
export function usePromise(fn, args, options) {
    const hooks = getHooks();
    const execute = options?.execute !== false;
    const initialData = options?.initialData;
    const [data, setData] = hooks.useState(initialData);
    const [error, setError] = hooks.useState(undefined);
    const [isLoading, setIsLoading] = hooks.useState(execute);
    const fnRef = hooks.useRef(fn);
    fnRef.current = fn;
    const argsKey = JSON.stringify(args || []);
    const revalidate = hooks.useCallback(async () => {
        if (!execute) {
            setIsLoading(false);
            return undefined;
        }
        setIsLoading(true);
        setError(undefined);
        try {
            const result = await fnRef.current(...(args || []));
            setData(result);
            setIsLoading(false);
            options?.onData?.(result);
            return result;
        }
        catch (err) {
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
        }
        else {
            setIsLoading(false);
        }
        return () => {
            active = false;
        };
    }, [argsKey, execute]);
    const mutate = hooks.useCallback(async (asyncUpdate, mutateOptions) => {
        if (!asyncUpdate) {
            return revalidate();
        }
        try {
            if (typeof asyncUpdate === "function") {
                const next = await asyncUpdate(data);
                setData(next);
            }
            else {
                const next = await asyncUpdate;
                setData(next);
            }
            if (mutateOptions?.shouldRevalidate !== false) {
                return revalidate();
            }
            return data;
        }
        catch (err) {
            setError(err instanceof Error ? err : new Error(String(err)));
            return undefined;
        }
    }, [data, revalidate]);
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
export function useCachedPromise(fn, args, options) {
    const cacheKey = `${fn.name || "anon"}:${JSON.stringify(args || [])}`;
    // 尝试命中缓存初始化
    let cachedData = options?.initialData;
    const rawCached = internalPromiseCache.get(cacheKey);
    if (rawCached !== undefined) {
        try {
            cachedData = JSON.parse(rawCached);
        }
        catch { }
    }
    const result = usePromise(async (...callArgs) => {
        const res = await fn(...callArgs);
        try {
            internalPromiseCache.set(cacheKey, JSON.stringify(res));
        }
        catch { }
        return res;
    }, args, {
        ...options,
        initialData: cachedData,
        onData: (data) => {
            try {
                internalPromiseCache.set(cacheKey, JSON.stringify(data));
            }
            catch { }
            options?.onData?.(data);
        }
    });
    return result;
}
export function useFetch(url, options) {
    const resolvedUrl = typeof url === "function" ? url() : url;
    return usePromise(async () => {
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
        return (await res.json());
    }, [resolvedUrl, JSON.stringify(options?.headers), options?.method], {
        execute: options?.execute !== false && !!resolvedUrl,
        initialData: options?.initialData
    });
}
export function useCachedState(key, initialValue, options) {
    const hooks = getHooks();
    const cache = options?.cache || internalPromiseCache;
    let startVal = initialValue;
    const raw = cache.get(key);
    if (raw !== undefined) {
        try {
            startVal = JSON.parse(raw);
        }
        catch { }
    }
    const [state, setState] = hooks.useState(startVal);
    const setCachedState = hooks.useCallback((newValOrFn) => {
        setState((prev) => {
            const next = typeof newValOrFn === "function" ? newValOrFn(prev) : newValOrFn;
            try {
                cache.set(key, JSON.stringify(next));
            }
            catch { }
            return next;
        });
    }, [key]);
    return [state, setCachedState];
}
