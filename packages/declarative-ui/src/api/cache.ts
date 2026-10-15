/**
 * cache.ts
 * Raycast 官方 Cache 内存/本地持久化缓存类
 */

export interface CacheOptions {
  namespace?: string;
}

export type CacheSubscriber = (key: string | undefined, data: string | undefined) => void;

const globalNamespaces = new Map<string, Map<string, string>>();

export class Cache {
  private namespace: string;
  private store: Map<string, string>;
  private subscribers = new Set<CacheSubscriber>();

  constructor(options?: CacheOptions) {
    this.namespace = options?.namespace || "default";
    if (!globalNamespaces.has(this.namespace)) {
      globalNamespaces.set(this.namespace, new Map<string, string>());
    }
    this.store = globalNamespaces.get(this.namespace)!;
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, data: string): void {
    this.store.set(key, data);
    for (const sub of this.subscribers) {
      try {
        sub(key, data);
      } catch {}
    }
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  remove(key: string): boolean {
    const existed = this.store.delete(key);
    if (existed) {
      for (const sub of this.subscribers) {
        try {
          sub(key, undefined);
        } catch {}
      }
    }
    return existed;
  }

  clear(options?: { notifySubscribers?: boolean }): void {
    this.store.clear();
    if (options?.notifySubscribers !== false) {
      for (const sub of this.subscribers) {
        try {
          sub(undefined, undefined);
        } catch {}
      }
    }
  }

  get isEmpty(): boolean {
    return this.store.size === 0;
  }

  subscribe(subscriber: CacheSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}
