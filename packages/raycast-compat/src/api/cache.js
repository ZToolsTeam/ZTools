/**
 * cache.ts
 * Raycast 官方 Cache 内存/本地持久化缓存类
 */
const globalNamespaces = new Map();
export class Cache {
    namespace;
    store;
    subscribers = new Set();
    constructor(options) {
        this.namespace = options?.namespace || "default";
        if (!globalNamespaces.has(this.namespace)) {
            globalNamespaces.set(this.namespace, new Map());
        }
        this.store = globalNamespaces.get(this.namespace);
    }
    get(key) {
        return this.store.get(key);
    }
    set(key, data) {
        this.store.set(key, data);
        for (const sub of this.subscribers) {
            try {
                sub(key, data);
            }
            catch { }
        }
    }
    has(key) {
        return this.store.has(key);
    }
    remove(key) {
        const existed = this.store.delete(key);
        if (existed) {
            for (const sub of this.subscribers) {
                try {
                    sub(key, undefined);
                }
                catch { }
            }
        }
        return existed;
    }
    clear(options) {
        this.store.clear();
        if (options?.notifySubscribers !== false) {
            for (const sub of this.subscribers) {
                try {
                    sub(undefined, undefined);
                }
                catch { }
            }
        }
    }
    get isEmpty() {
        return this.store.size === 0;
    }
    subscribe(subscriber) {
        this.subscribers.add(subscriber);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }
}
