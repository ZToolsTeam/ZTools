import { currentInstance, EffectCallback } from "./context.js";

function areDepsEqual(prevDeps?: any[], nextDeps?: any[]): boolean {
  if (!prevDeps || !nextDeps) return false;
  if (prevDeps.length !== nextDeps.length) return false;
  for (let i = 0; i < prevDeps.length; i++) {
    if (!Object.is(prevDeps[i], nextDeps[i])) {
      return false;
    }
  }
  return true;
}

/**
 * 声明式微状态 Hook: useState
 */
export function useState<T>(
  initialState: T | (() => T)
): [T, (action: T | ((prevState: T) => T)) => void] {
  const instance = currentInstance;
  if (!instance) {
    const val = typeof initialState === "function" ? (initialState as () => T)() : initialState;
    return [val, () => {}];
  }

  const hooks = instance.getHooks();
  const index = instance.hookIndex;
  instance.hookIndex = index + 1;

  if (hooks.length <= index) {
    const initialValue =
      typeof initialState === "function" ? (initialState as () => T)() : initialState;

    const setter = (action: T | ((prevState: T) => T)) => {
      const hookRecord = hooks[index];
      const prevVal = hookRecord.value;
      const nextVal = typeof action === "function" ? (action as (p: T) => T)(prevVal) : action;

      if (!Object.is(prevVal, nextVal)) {
        hookRecord.value = nextVal;
        instance.scheduleRender();
      }
    };

    hooks[index] = {
      type: "state",
      value: initialValue,
      setter
    };
  }

  const currentHook = hooks[index];
  return [currentHook.value, currentHook.setter!];
}

/**
 * 声明式微副作用 Hook: useEffect
 */
export function useEffect(effect: EffectCallback, deps?: any[]): void {
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
export function useMemo<T>(factory: () => T, deps?: any[]): T {
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

  return prevHook.value;
}

/**
 * 声明式回调 Hook: useCallback
 */
export function useCallback<T extends (...args: any[]) => any>(callback: T, deps?: any[]): T {
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

  return hooks[index].value;
}
