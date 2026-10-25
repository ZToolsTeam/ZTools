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
  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const bridge = getDeclarativeBridge();
    if (bridge?.storageGetItem) {
      return await bridge.storageGetItem(key);
    }

    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(`raycast_${key}`);
        if (raw === null) return undefined;
        return JSON.parse(raw) as T;
      } catch (err) {
        console.warn("[LocalStorage] localStorage.getItem 失败，回退内存存储:", err);
      }
    }

    const val = memoryStorage.get(key);
    if (val === undefined) return undefined;
    try {
      return JSON.parse(val) as T;
    } catch (err) {
      console.warn("[LocalStorage] JSON.parse 失败，返回原始值:", err);
      return val as unknown as T;
    }
  },

  /**
   * 写入存储项
   */
  async setItem(key: string, value: unknown): Promise<void> {
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
      } catch (err) {
        console.warn("[LocalStorage] localStorage.setItem 失败，回退内存存储:", err);
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
      } catch (err) {
        console.warn("[LocalStorage] localStorage.removeItem 失败:", err);
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
      } catch (err) {
        console.warn("[LocalStorage] localStorage.clear 失败:", err);
      }
    }

    memoryStorage.clear();
  },

  /**
   * 获取所有存储项
   */
  async allItems<T = unknown>(): Promise<Record<string, T>> {
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
                result[actualKey] = JSON.parse(raw) as T;
              } catch (err) {
                console.warn("[LocalStorage] JSON.parse 失败，返回原始值:", err);
                result[actualKey] = raw as unknown as T;
              }
            }
          }
        }
        return result;
      } catch (err) {
        console.warn("[LocalStorage] 读取 localStorage 全量项失败，回退内存存储:", err);
      }
    }

    for (const [k, v] of memoryStorage.entries()) {
      try {
        result[k] = JSON.parse(v) as T;
      } catch (err) {
        console.warn("[LocalStorage] 内存存储项 JSON.parse 失败，返回原始值:", err);
        result[k] = v as unknown as T;
      }
    }
    return result;
  }
};
