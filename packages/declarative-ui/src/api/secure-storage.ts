import { getDeclarativeBridge } from "./bridge.js";
import { ZToolsHostError } from "./host-error.js";

/**
 * SecureStorage：用操作系统钥匙串（Electron safeStorage）加密保存插件机密（TOTP 密钥、令牌等）。
 *
 * - 加密不可用（钥匙串被拒、Linux basic_text 等）时 setItem 直接报错，**绝不**回落为明文、localStorage 或内存；
 * - 防的是「磁盘 / 备份 / 其他本机程序读到明文」；不防同一宿主里的其他 ZTools 插件（插件与宿主同一 JS 上下文）；
 * - 值以 JSON 保存，单个值 JSON 后不超过 64 KiB。
 */
export type SecureStorageUnavailableReason =
  | "encryption-unavailable"
  | "insecure-backend"
  | "backend-unknown"
  | "host-unsupported"
  | "identity-required";

export type SecureStorageStatus =
  | { available: true }
  | { available: false; reason: SecureStorageUnavailableReason };

export interface SecureStorageImportResult {
  status: "imported" | "not-found" | "kept-secure";
  value?: unknown;
  /** 加密存储与明文同时存在且内容不同：交给插件合并，合并写回后调用 discardLocalStorage 删除明文 */
  legacyValue?: unknown;
}

export interface SecureStorageApi {
  status(): Promise<SecureStorageStatus>;
  getItem<T = unknown>(key: string): Promise<T | undefined>;
  setItem(key: string, value: unknown): Promise<void>;
  removeItem(key: string): Promise<void>;
  /** 把 LocalStorage 里的明文条目搬进加密存储：写入 → 读回校验 → 删除明文（宿主库 + 浏览器旧键）→ 压缩 */
  importFromLocalStorage(key: string, options?: { targetKey?: string }): Promise<SecureStorageImportResult>;
  /** 删除 LocalStorage 里的明文条目（宿主库 + 浏览器旧键）并压缩插件数据库 */
  discardLocalStorage(key: string): Promise<void>;
}

/** 与宿主 credential_v1_* 的 key 规则一致 */
export const SECURE_STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const SECURE_STORAGE_MAX_VALUE_BYTES = 64 * 1024;

export function assertSecureStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !SECURE_STORAGE_KEY_PATTERN.test(key)) {
    throw new ZToolsHostError(
      "INVALID_STORAGE_KEY",
      "SecureStorage 的 key 必须是 1–128 个字符，以字母或数字开头，只含字母、数字和 . _ : -"
    );
  }
}

function unavailable(): ZToolsHostError {
  return new ZToolsHostError("SECURE_STORAGE_UNAVAILABLE", "当前宿主不支持加密存储，请升级 ZTools");
}

function implementation(): Partial<SecureStorageApi> | undefined {
  return getDeclarativeBridge()?.secureStorage;
}

export const SecureStorage: SecureStorageApi = {
  async status() {
    const impl = implementation();
    if (!impl?.status) return { available: false, reason: "host-unsupported" };
    return impl.status();
  },
  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    assertSecureStorageKey(key);
    const impl = implementation();
    if (!impl?.getItem) throw unavailable();
    return impl.getItem<T>(key);
  },
  async setItem(key, value) {
    assertSecureStorageKey(key);
    const impl = implementation();
    if (!impl?.setItem) throw unavailable();
    return impl.setItem(key, value);
  },
  async removeItem(key) {
    assertSecureStorageKey(key);
    const impl = implementation();
    if (!impl?.removeItem) throw unavailable();
    return impl.removeItem(key);
  },
  async importFromLocalStorage(key, options) {
    const impl = implementation();
    if (!impl?.importFromLocalStorage) throw unavailable();
    return impl.importFromLocalStorage(key, options);
  },
  async discardLocalStorage(key) {
    const impl = implementation();
    if (!impl?.discardLocalStorage) throw unavailable();
    return impl.discardLocalStorage(key);
  }
};
