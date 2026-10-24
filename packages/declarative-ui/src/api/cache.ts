/**
 * cache.ts
 * 内存缓存类（与 Raycast Cache 用法一致），客户端重启后清空。
 *
 * 作用域：数据按「缓存作用域」隔离。宿主为每个插件调用 createCacheScope() 生成一个独立的 Cache 类，
 * 插件拿到的 Cache 只能读写本插件作用域里的命名空间；namespace 只在作用域内部区分，
 * 其他插件即使传同名 namespace 也读不到。直接使用 SDK 导出的 Cache（Node 测试、宿主自身）时落在默认作用域。
 */

export interface CacheOptions {
  namespace?: string;
}

export type CacheSubscriber = (key: string | undefined, data: string | undefined) => void;

/** 一个作用域内的全部命名空间：namespace -> (key -> data) */
type NamespaceRegistry = Map<string, Map<string, string>>;

/** 默认作用域：未经宿主分配作用域时使用 */
const defaultRegistry: NamespaceRegistry = new Map();
/** 宿主分配的作用域，按 createCacheScope() 生成的类登记；不提供按名字查找的入口 */
const scopedRegistries = new WeakMap<Function, NamespaceRegistry>();

/** 沿原型链找到最近的已登记作用域（插件再从 Cache 派生子类时仍落在所属作用域） */
function resolveRegistry(ctor: Function | undefined): NamespaceRegistry {
  let current: any = ctor;
  while (current && current !== Cache) {
    const registry = scopedRegistries.get(current);
    if (registry) return registry;
    current = Object.getPrototypeOf(current);
  }
  return defaultRegistry;
}

export class Cache {
  private namespace: string;
  private store: Map<string, string>;
  private subscribers = new Set<CacheSubscriber>();

  constructor(options?: CacheOptions) {
    this.namespace = options?.namespace || "default";
    const registry = resolveRegistry(new.target);
    let store = registry.get(this.namespace);
    if (!store) {
      store = new Map<string, string>();
      registry.set(this.namespace, store);
    }
    this.store = store;
  }

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, data: string): void {
    this.store.set(key, data);
    for (const sub of this.subscribers) {
      try {
        sub(key, data);
      } catch {
        // Ignore subscriber error to avoid breaking other listeners
      }
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
        } catch {
          // Ignore subscriber error to avoid breaking other listeners
        }
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
        } catch {
          // Ignore subscriber error to avoid breaking other listeners
        }
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

/**
 * 创建一个全新的缓存作用域，返回绑定到该作用域的 Cache 类（不从包入口导出，供 utils 的 createCacheScope 使用）。
 * 每次调用都是空的独立作用域，与默认作用域及其他作用域的数据互不可见；
 * 作用域只能通过持有返回的类访问，无法按名字取到别人的作用域。
 */
export function createScopedCacheClass(): typeof Cache {
  class ScopedCache extends Cache {}
  scopedRegistries.set(ScopedCache, new Map());
  return ScopedCache;
}
