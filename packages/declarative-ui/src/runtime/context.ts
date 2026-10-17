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

  constructor(
    component: () => any,
    options?: DeclarativeRenderInstanceOptions
  ) {
    this.component = component;
    this.onUpdateCallback = options?.onUpdate;
    this.onRenderEmptyCallback = options?.onRenderEmpty;
    this.onRenderEventCallback = options?.onRenderEvent;
    this.navigationHandler = options?.navigation;
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
        this.latestDescriptor = newDescriptor;
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

