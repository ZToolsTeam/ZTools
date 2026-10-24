import { currentInstance, isEvaluatingChildElement, EffectCallback } from "./context.js";

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
      const prevVal = hookRecord.value;
      const nextVal = typeof action === "function" ? (action as (p: T) => T)(prevVal) : action;

      if (!Object.is(prevVal, nextVal)) {
        hookRecord.value = nextVal;
        instance.scheduleRender();
      }
    };

    hooks[index] = {
      type: "state",
      value: initial(),
      setter
    };
  }

  const currentHook = hooks[index];
  return { value: currentHook.value, setter: currentHook.setter!, index, created };
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
  } else if (!instance.registerPopoutState(key, slot.index, options?.paths) && slot.created) {
    console.warn(`[usePopoutState] key "${key}" 在同一页面重复使用，只有第一个会带到独立窗口`);
  }
  return [slot.value, slot.setter];
}

/**
 * 声明式微副作用 Hook: useEffect
 */
export function useEffect(effect: EffectCallback, deps?: any[]): void {
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
