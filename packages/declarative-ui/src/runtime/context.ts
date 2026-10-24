import { ViewDescriptor } from "../descriptors/types.js";
import { NavigationHandler, setActiveNavigation } from "../api/navigation.js";

export type EffectCleanup = () => void;
export type EffectCallback = () => void | EffectCleanup | Promise<void>;

export interface HookRecord {
  type: "state" | "effect" | "memo" | "ref";
  value?: any;
  setter?: (newVal: any) => void;
  deps?: any[];
  cleanup?: EffectCleanup;
}

export interface DeclarativeRenderInstanceOptions {
  onUpdate?: (descriptor: ViewDescriptor) => void;
  onRenderEmpty?: () => void;
  onRenderEvent?: (event: { type: "renderTree"; descriptor: ViewDescriptor } | { type: "renderEmpty" }) => void;
  navigation?: NavigationHandler;
  /**
   * 弹出独立窗口时由宿主交来的 usePopoutState 初值（key → 值，必须是纯 JSON）。
   * 每个 key 只在对应 hook 首次执行时用一次；没有被用到的 key 随实例卸载丢弃。
   */
  handoffSeed?: Record<string, unknown> | null;
}

/** usePopoutState 登记的一项：值所在的 hook 下标与可选的路径提取函数 */
interface PopoutRegistration {
  index: number;
  paths?: (value: any) => unknown;
}

export interface CollectedPopoutEntry {
  key: string;
  value: unknown;
  /** 插件声明值里引用的本地路径（只做了类型过滤，长度 / 是否绝对路径由宿主校验） */
  paths: string[];
}

export interface CollectedPopoutState {
  entries: CollectedPopoutEntry[];
  /** paths 函数抛错或返回了非数组的 key：整项不带，避免带着状态却丢了授权 */
  rejected: string[];
}

export function areViewTreesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export class DeclarativeRenderInstance {
  private component: () => any;
  private hooks: HookRecord[] = [];
  private currentHookIndex = 0;
  private isQueued = false;
  private isMounted = true;
  private latestDescriptor: ViewDescriptor | null = null;
  private emptyRenderCount = 0;
  private hasWarnedInfiniteLoop = false;
  private onUpdateCallback?: (descriptor: ViewDescriptor) => void;
  private onRenderEmptyCallback?: () => void;
  private onRenderEventCallback?: (event: { type: "renderTree"; descriptor: ViewDescriptor } | { type: "renderEmpty" }) => void;
  private navigationHandler?: NavigationHandler;
  private popoutSeed: Map<string, unknown> | null = null;
  private popoutRegistry = new Map<string, PopoutRegistration>();

  constructor(
    component: () => any,
    options?: DeclarativeRenderInstanceOptions
  ) {
    this.component = component;
    this.onUpdateCallback = options?.onUpdate;
    this.onRenderEmptyCallback = options?.onRenderEmpty;
    this.onRenderEventCallback = options?.onRenderEvent;
    this.navigationHandler = options?.navigation;
    const seed = options?.handoffSeed;
    if (seed && typeof seed === "object" && !Array.isArray(seed)) {
      // 拷一份 key 表：宿主传入的对象不会被改动，也不受原型链上的属性影响
      this.popoutSeed = new Map(Object.entries(seed));
    }
  }

  /** 取出并删除某个 key 的交接初值（只用一次） */
  consumePopoutSeed(key: string): { found: true; value: unknown } | { found: false } {
    if (!this.popoutSeed || !this.popoutSeed.has(key)) return { found: false };
    const value = this.popoutSeed.get(key);
    this.popoutSeed.delete(key);
    return { found: true, value };
  }

  /** 登记 usePopoutState；同一实例里 key 重复时只保留第一个，返回 false */
  registerPopoutState(key: string, index: number, paths?: (value: any) => unknown): boolean {
    const existing = this.popoutRegistry.get(key);
    if (existing && existing.index !== index) return false;
    this.popoutRegistry.set(key, { index, paths });
    return true;
  }

  /** 读取当前登记的状态最新值（独立窗口弹出前调用） */
  collectPopoutState(): CollectedPopoutState {
    const entries: CollectedPopoutEntry[] = [];
    const rejected: string[] = [];
    for (const [key, registration] of this.popoutRegistry) {
      const hook = this.hooks[registration.index];
      if (!hook || hook.type !== "state") continue;
      const value = hook.value;
      let paths: string[] = [];
      if (typeof registration.paths === "function") {
        let raw: unknown;
        try {
          raw = registration.paths(value);
        } catch (err) {
          console.warn(`[usePopoutState] "${key}" 的 paths 计算失败，该项不带到独立窗口:`, err);
          rejected.push(key);
          continue;
        }
        if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
          rejected.push(key);
          continue;
        }
        paths = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
      }
      entries.push({ key, value, paths });
    }
    return { entries, rejected };
  }

  get hookIndex(): number {
    return this.currentHookIndex;
  }

  set hookIndex(idx: number) {
    this.currentHookIndex = idx;
  }

  getHooks(): HookRecord[] {
    return this.hooks;
  }

  getLatestDescriptor(): ViewDescriptor | null {
    return this.latestDescriptor;
  }

  getEmptyRenderCount(): number {
    return this.emptyRenderCount;
  }

  hasInfiniteLoopWarning(): boolean {
    return this.hasWarnedInfiniteLoop;
  }

  scheduleRender(): void {
    if (!this.isMounted || this.isQueued) return;
    this.isQueued = true;
    queueMicrotask(() => {
      if (!this.isMounted) return;
      this.isQueued = false;
      this.executeRender();
    });
  }

  executeRender(): ViewDescriptor {
    if (!this.isMounted) {
      return this.latestDescriptor as ViewDescriptor;
    }

    const prevInstance = currentInstance;
    currentInstance = this;
    this.currentHookIndex = 0;

    if (this.navigationHandler) {
      setActiveNavigation(this.navigationHandler);
    }

    try {
      let rawResult = this.component();

      // 如果返回的是嵌套函数或者 promise
      if (typeof rawResult === "function") {
        rawResult = rawResult();
      }

      const newDescriptor = rawResult as ViewDescriptor;
      const isUnchanged = this.latestDescriptor !== null && areViewTreesEqual(this.latestDescriptor, newDescriptor);
      // 始终更新 latestDescriptor，防止因 JSON.stringify 忽略函数引用导致事件回调闭包陈旧
      this.latestDescriptor = newDescriptor;

      if (isUnchanged) {
        this.emptyRenderCount++;
        this.onRenderEmptyCallback?.();
        this.onRenderEventCallback?.({ type: "renderEmpty" });
        if (this.emptyRenderCount >= 20 && !this.hasWarnedInfiniteLoop) {
          console.warn(
            "[RaycastCompat] Looks like the command is rendering a lot without any changes. " +
            "This might indicate a rendering loop caused by a `setState` not being wrapped in a `useEffect`..."
          );
          this.hasWarnedInfiniteLoop = true;
        }
      } else {
        this.emptyRenderCount = 0;
        this.hasWarnedInfiniteLoop = false;
        this.onUpdateCallback?.(this.latestDescriptor);
        this.onRenderEventCallback?.({ type: "renderTree", descriptor: this.latestDescriptor });
      }

      // 执行所有的 effects
      this.runPendingEffects();

      return this.latestDescriptor ?? newDescriptor;
    } finally {
      currentInstance = prevInstance;
      setActiveNavigation(null);
    }
  }

  private runPendingEffects(): void {
    for (const hook of this.hooks) {
      if (hook.type === "effect" && typeof hook.value === "function") {
        const effectFn = hook.value as EffectCallback;
        hook.value = null;
        // 如果有之前的清理函数，先执行
        if (typeof hook.cleanup === "function") {
          try {
            hook.cleanup();
          } catch (err) {
            console.error("[RaycastCompat] Error during effect cleanup:", err);
          }
          hook.cleanup = undefined;
        }

        try {
          const cleanup = effectFn();
          if (typeof cleanup === "function") {
            hook.cleanup = cleanup;
          }
        } catch (err) {
          console.error("[RaycastCompat] Error running effect:", err);
        }
      }
    }
  }

  unmount(): void {
    this.isMounted = false;
    for (const hook of this.hooks) {
      if (hook.type === "effect" && typeof hook.cleanup === "function") {
        try {
          hook.cleanup();
        } catch (err) {
          console.error("[RaycastCompat] Error unmounting effect:", err);
        }
      }
    }
    this.hooks = [];
    this.latestDescriptor = null;
    this.popoutRegistry.clear();
    this.popoutSeed = null;
  }
}

export let currentInstance: DeclarativeRenderInstance | null = null;
export let isEvaluatingChildElement = false;

export function setCurrentInstance(
  instance: DeclarativeRenderInstance | null
): DeclarativeRenderInstance | null {
  const prev = currentInstance;
  currentInstance = instance;
  return prev;
}

export function setEvaluatingChildElement(flag: boolean): boolean {
  const prev = isEvaluatingChildElement;
  isEvaluatingChildElement = flag;
  return prev;
}

