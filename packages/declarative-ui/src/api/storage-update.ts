import { ZToolsHostError } from "./host-error.js";

export interface AtomicStorage {
  getItem<T = unknown>(key: string): Promise<T | undefined>;
  compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>;
}

/** 更新函数只描述本次修改；冲突后会重新执行，不应有外部副作用。 */
export async function updateStoredItem<T>(
  storage: AtomicStorage,
  key: string,
  update: (current: unknown) => T
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await storage.getItem(key);
    const before = JSON.stringify(current);
    const expected = before === undefined ? undefined : JSON.parse(before);
    const next = update(current);
    if (JSON.stringify(next) === before) return next;
    if (await storage.compareAndSet(key, expected, next)) return next;
  }
  throw new ZToolsHostError("STORAGE_CONFLICT", "数据正在被其他窗口修改，请重试");
}
