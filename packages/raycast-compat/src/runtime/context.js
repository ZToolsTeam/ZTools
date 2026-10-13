import { setActiveNavigation } from "../api/navigation.js";
export class DeclarativeRenderInstance {
    component;
    hooks = [];
    currentHookIndex = 0;
    isQueued = false;
    isMounted = true;
    latestDescriptor = null;
    onUpdateCallback;
    navigationHandler;
    constructor(component, options) {
        this.component = component;
        this.onUpdateCallback = options?.onUpdate;
        this.navigationHandler = options?.navigation;
    }
    get hookIndex() {
        return this.currentHookIndex;
    }
    set hookIndex(idx) {
        this.currentHookIndex = idx;
    }
    getHooks() {
        return this.hooks;
    }
    getLatestDescriptor() {
        return this.latestDescriptor;
    }
    scheduleRender() {
        if (!this.isMounted || this.isQueued)
            return;
        this.isQueued = true;
        queueMicrotask(() => {
            if (!this.isMounted)
                return;
            this.isQueued = false;
            this.executeRender();
        });
    }
    executeRender() {
        if (!this.isMounted) {
            return this.latestDescriptor;
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
            this.latestDescriptor = rawResult;
            // 触发更新回调给宿主
            this.onUpdateCallback?.(this.latestDescriptor);
            // 执行所有的 effects
            this.runPendingEffects();
            return this.latestDescriptor;
        }
        finally {
            currentInstance = prevInstance;
            setActiveNavigation(null);
        }
    }
    runPendingEffects() {
        for (const hook of this.hooks) {
            if (hook.type === "effect" && typeof hook.value === "function") {
                const effectFn = hook.value;
                // 如果有之前的清理函数，先执行
                if (typeof hook.cleanup === "function") {
                    try {
                        hook.cleanup();
                    }
                    catch (err) {
                        console.error("[RaycastCompat] Error during effect cleanup:", err);
                    }
                    hook.cleanup = undefined;
                }
                try {
                    const cleanup = effectFn();
                    if (typeof cleanup === "function") {
                        hook.cleanup = cleanup;
                    }
                }
                catch (err) {
                    console.error("[RaycastCompat] Error running effect:", err);
                }
            }
        }
    }
    unmount() {
        this.isMounted = false;
        for (const hook of this.hooks) {
            if (hook.type === "effect" && typeof hook.cleanup === "function") {
                try {
                    hook.cleanup();
                }
                catch (err) {
                    console.error("[RaycastCompat] Error unmounting effect:", err);
                }
            }
        }
        this.hooks = [];
        this.latestDescriptor = null;
    }
}
export let currentInstance = null;
