import { getDeclarativeBridge } from "./bridge.js";

import { ZToolsHostError } from "./host-error.js";
import { updateStoredItem } from "./storage-update.js";

const memoryStorage = new Map<string, string>();

export const LocalStorage = {
  async compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const bridge = getDeclarativeBridge();
    if (!bridge?.storageCompareAndSet) {
      throw new ZToolsHostError("HOST_FEATURE_UNAVAILABLE", "当前宿主不支持原子存储，请升级 ZTools");
    }
    return bridge.storageCompareAndSet(key, expected, value);
  },
  async updateItem<T>(key: string, update: (current: unknown) => T): Promise<T> {
    return updateStoredItem(LocalStorage, key, update);
  },
  /**
   * 获取存储项
   */
  async getItem<T = any>(key: string): Promise<T | undefined> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageGetItem) {
      return await bridge.storageGetItem(key);
    }

    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(`raycast_${key}`);
        if (raw === null) return undefined;
        return JSON.parse(raw) as T;
      } catch {
        // fallback to memory
      }
    }

    const val = memoryStorage.get(key);
    if (val === undefined) return undefined;
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as unknown as T;
    }
  },

  /**
   * 写入存储项
   */
  async setItem(key: string, value: any): Promise<void> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageSetItem) {
      await bridge.storageSetItem(key, value);
      return;
    }

    const str = JSON.stringify(value);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`raycast_${key}`, str);
        memoryStorage.set(key, str);
        return;
      } catch {
        // fallback to memory
      }
    }

    memoryStorage.set(key, str);
  },

  /**
   * 删除存储项
   */
  async removeItem(key: string): Promise<void> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageRemoveItem) {
      await bridge.storageRemoveItem(key);
      return;
    }

    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`raycast_${key}`);
      } catch {
        // ignore
      }
    }

    memoryStorage.delete(key);
  },

  /**
   * 清空所有存储项
   */
  async clear(): Promise<void> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageClear) {
      await bridge.storageClear();
      return;
    }

    if (typeof localStorage !== "undefined") {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("raycast_")) {
            keysToRemove.push(k);
          }
        }
        for (const k of keysToRemove) {
          localStorage.removeItem(k);
        }
      } catch {
        // ignore
      }
    }

    memoryStorage.clear();
  },

  /**
   * 获取所有存储项
   */
  async allItems<T = any>(): Promise<Record<string, T>> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageAll) {
      return await bridge.storageAll();
    }

    const result: Record<string, T> = {};
    if (typeof localStorage !== "undefined") {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("raycast_")) {
            const raw = localStorage.getItem(k);
            if (raw !== null) {
              const actualKey = k.replace(/^raycast_/, "");
              try {
                result[actualKey] = JSON.parse(raw);
              } catch {
                result[actualKey] = raw as any;
              }
            }
          }
        }
        return result;
      } catch {
        // fallback
      }
    }

    for (const [k, v] of memoryStorage.entries()) {
      try {
        result[k] = JSON.parse(v);
      } catch {
        result[k] = v as any;
      }
    }
    return result;
  }
};
