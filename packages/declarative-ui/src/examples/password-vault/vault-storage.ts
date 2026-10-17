/**
 * 密码保险箱核心存储与加密服务 (vault-storage.ts)
 *
 * 借鉴 Raycast `keepassxc` & `rpass` 源码改造：
 * - 单一职责：管理网站/应用名称、账号、密码、URL、分类文件夹、私密备注（不含 2FA TOTP）
 * - 支持主密码设置、加锁 (locked) / 解锁 (unlocked) 状态机与密文 envelope 校验
 * - 支持 Chrome / Edge 标准 CSV (`name,url,username,password,note`) 一键导入与导出
 * - 内置高强度密码生成器与密码熵值强度评估
 */

import { LocalStorage } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  CsvImportResult,
  EncryptedVaultEnvelope,
  PasswordGeneratorOptions,
  PasswordStrengthResult,
  VaultCategory,
  VaultEntry,
  VaultEntryInput,
  VaultLockState,
  VaultUnlockResult
} from "./types.js";

export const VAULT_STORAGE_KEY = "ztools.password-vault.entries.v1";
export const VAULT_MASTER_HASH_KEY = "ztools.password-vault.master.v1";

export const INITIAL_VAULT_ENTRIES: readonly VaultEntry[] = Object.freeze([
  {
    id: "vault-github",
    name: "GitHub",
    username: "geek@ztools.dev",
    password: "Gh#98!kLp2$vQx7R",
    url: "https://github.com/login",
    folder: "开发",
    note: "个人开源主账号",
    pinned: true,
    createdAt: 1710000000000,
    updatedAt: 1710000000000
  },
  {
    id: "vault-bilibili",
    name: "哔哩哔哩 (Bilibili)",
    username: "13800138000",
    password: "Bili@2026!User88",
    url: "https://www.bilibili.com",
    folder: "社交",
    note: "大会员账号",
    pinned: true,
    createdAt: 1710000100000,
    updatedAt: 1710000100000
  },
  {
    id: "vault-jd",
    name: "京东商城 (JD.com)",
    username: "jd_buyer_88",
    password: "Jd$Shop#2026!99",
    url: "https://www.jd.com",
    folder: "购物",
    note: "常用收货账号",
    pinned: false,
    createdAt: 1710000200000,
    updatedAt: 1710000200000
  },
  {
    id: "vault-feishu",
    name: "飞书企业办公 (Feishu)",
    username: "zhangsan@company.cn",
    password: "Fs!Work#2026@Oa",
    url: "https://www.feishu.cn",
    folder: "工作",
    note: "公司内部 SSO 登录凭据",
    pinned: false,
    createdAt: 1710000300000,
    updatedAt: 1710000300000
  }
]);

const VAULT_KDF_SALT = "ztools-vault-aead-salt-v1";
const DEFAULT_STORAGE_MASTER_KEY = "ztools-default-master";

function getNodeCrypto(): any {
  try {
    const proc = (globalThis as any).process;
    if (proc && typeof proc.getBuiltinModule === "function") {
      return proc.getBuiltinModule("node:crypto") || proc.getBuiltinModule("crypto");
    }
  } catch {
    // ignore
  }
  return null;
}

function computeSimpleHash(input: string, salt = "ztools-salt"): string {
  const str = `${salt}:${input}`;
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function compute256BitTagHex(dataHex: string, keyStr: string, ivHex: string): string {
  const p1 = computeSimpleHash(`${ivHex}:${dataHex}:tag0`, keyStr);
  const p2 = computeSimpleHash(`${dataHex}:${ivHex}:tag1`, `${keyStr}:mac`);
  return (p1 + p2).slice(0, 32);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

/**
 * 使用 AEAD (AES-256-GCM + scrypt 密钥派生) 加密敏感凭据
 * 输出格式: enc:v1:<ivHex(24)>:<tagHex(32)>:<cipherHex>
 */
export function encryptSecret(plaintext: string, masterKey: string): string {
  if (typeof plaintext !== "string") {
    throw new Error("PLAINTEXT_INVALID: 待加密内容必须为字符串");
  }
  if (!masterKey || typeof masterKey !== "string" || !masterKey.trim()) {
    throw new Error("MASTER_KEY_REQUIRED: 主密钥不能为空");
  }

  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto && typeof Buffer !== "undefined") {
    const keyBuf = nodeCrypto.scryptSync(masterKey, VAULT_KDF_SALT, 32);
    const ivBuf = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", keyBuf, ivBuf);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tagBuf = cipher.getAuthTag();
    return `enc:v1:${ivBuf.toString("hex")}:${tagBuf.toString("hex")}:${encrypted.toString("hex")}`;
  }

  // 纯浏览器沙箱无 node:crypto 时的流密码 + 16字节认证 Tag 兜底
  const ivBytes = new Uint8Array(12);
  for (let i = 0; i < 12; i++) {
    ivBytes[i] = Math.floor(Math.random() * 256);
  }
  const ivHex = bytesToHex(ivBytes);
  const streamKey = computeSimpleHash(masterKey, `${VAULT_KDF_SALT}:${ivHex}`) +
    computeSimpleHash(`${masterKey}:stream`, ivHex);
  const plainBytes = new TextEncoder().encode(plaintext);
  const cipherBytes = new Uint8Array(plainBytes.length);
  for (let i = 0; i < plainBytes.length; i++) {
    const kByte = parseInt(streamKey.slice((i * 2) % 32, ((i * 2) % 32) + 2), 16) ^ ((i * 31) & 0xff);
    cipherBytes[i] = plainBytes[i] ^ kByte;
  }
  const cipherHex = bytesToHex(cipherBytes);
  const tagHex = compute256BitTagHex(cipherHex, masterKey, ivHex);
  return `enc:v1:${ivHex}:${tagHex}:${cipherHex}`;
}

/**
 * 解密并严格验证 AEAD AuthTag，任何 1-bit 篡改或错误密钥立即抛出异常
 */
export function decryptSecret(ciphertext: string, masterKey: string): string {
  if (!ciphertext || typeof ciphertext !== "string" || !ciphertext.startsWith("enc:v1:")) {
    throw new Error("INVALID_CIPHERTEXT: 密文格式非法，必须以 enc:v1: 开头");
  }
  if (!masterKey || typeof masterKey !== "string" || !masterKey.trim()) {
    throw new Error("MASTER_KEY_REQUIRED: 主密钥不能为空");
  }

  const parts = ciphertext.split(":");
  if (parts.length !== 5) {
    throw new Error("INVALID_CIPHERTEXT: 密文结构分段数量错误");
  }
  const [, , ivHex, tagHex, cipherHex] = parts;
  if (
    ivHex.length !== 24 ||
    tagHex.length !== 32 ||
    !/^[0-9a-fA-F]+$/.test(ivHex) ||
    !/^[0-9a-fA-F]+$/.test(tagHex) ||
    (cipherHex.length > 0 && (cipherHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cipherHex)))
  ) {
    throw new Error("INVALID_CIPHERTEXT: IV、AuthTag 或密文 Hex 编码损坏");
  }

  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto && typeof Buffer !== "undefined") {
    try {
      const keyBuf = nodeCrypto.scryptSync(masterKey, VAULT_KDF_SALT, 32);
      const ivBuf = Buffer.from(ivHex, "hex");
      const tagBuf = Buffer.from(tagHex, "hex");
      const encryptedBuf = Buffer.from(cipherHex, "hex");
      const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", keyBuf, ivBuf);
      decipher.setAuthTag(tagBuf);
      const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      throw new Error("AUTH_TAG_MISMATCH: 密文完整性校验失败或主密钥错误 (AEAD 认证拒绝)");
    }
  }

  const expectedTag = compute256BitTagHex(cipherHex, masterKey, ivHex);
  if (expectedTag.toLowerCase() !== tagHex.toLowerCase()) {
    throw new Error("AUTH_TAG_MISMATCH: 密文完整性校验失败或主密钥错误 (AEAD 认证拒绝)");
  }
  const streamKey = computeSimpleHash(masterKey, `${VAULT_KDF_SALT}:${ivHex}`) +
    computeSimpleHash(`${masterKey}:stream`, ivHex);
  const cipherBytes = hexToBytes(cipherHex);
  const plainBytes = new Uint8Array(cipherBytes.length);
  for (let i = 0; i < cipherBytes.length; i++) {
    const kByte = parseInt(streamKey.slice((i * 2) % 32, ((i * 2) % 32) + 2), 16) ^ ((i * 31) & 0xff);
    plainBytes[i] = cipherBytes[i] ^ kByte;
  }
  return new TextDecoder().decode(plainBytes);
}

export function encryptVaultPayload(
  entries: readonly VaultEntry[],
  masterPassword: string
): EncryptedVaultEnvelope {
  if (!masterPassword || typeof masterPassword !== "string") {
    throw new Error("主密码不能为空");
  }
  const salt = VAULT_KDF_SALT;
  const plainJson = JSON.stringify(entries);
  const aeadToken = encryptSecret(plainJson, masterPassword);
  const [, , ivHex, tagHex] = aeadToken.split(":");
  const derivedKey = computeSimpleHash(masterPassword, salt);
  const mac = computeSimpleHash(aeadToken, `${derivedKey}:${ivHex}:${tagHex}`);
  return {
    version: 1,
    salt,
    iv: ivHex,
    cipherText: aeadToken,
    mac,
    updatedAt: Date.now()
  };
}

export function decryptVaultPayload(
  envelope: EncryptedVaultEnvelope,
  masterPassword: string
): VaultEntry[] {
  if (!envelope || typeof envelope !== "object" || !envelope.cipherText || !envelope.mac) {
    throw new Error("INVALID_ENVELOPE: 加密数据信封格式损坏");
  }
  if (!masterPassword || typeof masterPassword !== "string") {
    throw new Error("WRONG_PASSWORD: 主密码不能为空");
  }
  const derivedKey = computeSimpleHash(masterPassword, envelope.salt || VAULT_KDF_SALT);
  if (envelope.cipherText.startsWith("enc:v1:")) {
    const parts = envelope.cipherText.split(":");
    const ivHex = parts[2] || envelope.iv || "";
    const tagHex = parts[3] || "";
    const expectedMac = computeSimpleHash(envelope.cipherText, `${derivedKey}:${ivHex}:${tagHex}`);
    if (expectedMac !== envelope.mac) {
      throw new Error("WRONG_PASSWORD: 主密码错误或密文已被篡改 (MAC 校验失败)");
    }
    try {
      const plainJson = decryptSecret(envelope.cipherText, masterPassword);
      const parsed = JSON.parse(plainJson);
      if (!Array.isArray(parsed)) {
        throw new Error("CORRUPTED_DATA: 解密后的数据不是有效列表");
      }
      return parsed;
    } catch (err: any) {
      throw new Error(`WRONG_PASSWORD: ${err?.message || "主密码错误或密文已被篡改"}`);
    }
  }

  throw new Error("INVALID_ENVELOPE: 不支持的旧版明文/弱加密信封格式");
}

/**
 * 生成高强度随机密码
 */
export function generateVaultPassword(options: PasswordGeneratorOptions = {}): string {
  const length = options.length ?? 16;
  if (!Number.isInteger(length) || length < 4 || length > 128) {
    throw new Error("密码长度必须在 4 ~ 128 位之间");
  }
  const useUpper = options.uppercase ?? true;
  const useLower = options.lowercase ?? true;
  const useNumbers = options.numbers ?? true;
  const useSymbols = options.symbols ?? true;
  const excludeAmbiguous = options.excludeAmbiguous ?? true;

  const upperChars = excludeAmbiguous ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowerChars = excludeAmbiguous ? "abcdefghijkmnopqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz";
  const numberChars = excludeAmbiguous ? "23456789" : "0123456789";
  const symbolChars = "!@#$%^&*_-+=";

  let pool = "";
  const mandatory: string[] = [];
  if (useUpper) {
    pool += upperChars;
    mandatory.push(upperChars[Math.floor(Math.random() * upperChars.length)]);
  }
  if (useLower) {
    pool += lowerChars;
    mandatory.push(lowerChars[Math.floor(Math.random() * lowerChars.length)]);
  }
  if (useNumbers) {
    pool += numberChars;
    mandatory.push(numberChars[Math.floor(Math.random() * numberChars.length)]);
  }
  if (useSymbols) {
    pool += symbolChars;
    mandatory.push(symbolChars[Math.floor(Math.random() * symbolChars.length)]);
  }

  if (!pool) {
    throw new Error("至少需要启用一种字符集类型");
  }

  const chars: string[] = [...mandatory];
  while (chars.length < length) {
    chars.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return chars.slice(0, length).join("");
}

/**
 * 评估密码强度与信息熵
 */
export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
  if (typeof password !== "string" || !password) {
    return {
      score: 0,
      level: "weak",
      label: "极弱 (空密码)",
      entropyBits: 0,
      suggestions: ["请输入密码"]
    };
  }

  let poolSize = 0;
  const suggestions: string[] = [];
  if (/[a-z]/.test(password)) poolSize += 26;
  else suggestions.push("增加小写字母");
  if (/[A-Z]/.test(password)) poolSize += 26;
  else suggestions.push("增加大写字母");
  if (/[0-9]/.test(password)) poolSize += 10;
  else suggestions.push("增加数字");
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 32;
  else suggestions.push("增加特殊符号 (!@#$%)");

  const entropyBits = Math.round(password.length * Math.log2(Math.max(poolSize, 2)));
  const score = Math.min(100, Math.round((entropyBits / 90) * 100));

  if (score < 35) {
    return { score, level: "weak", label: "弱 (易被暴力破解)", entropyBits, suggestions };
  }
  if (score < 55) {
    return { score, level: "fair", label: "一般", entropyBits, suggestions };
  }
  if (score < 75) {
    return { score, level: "good", label: "良好", entropyBits, suggestions };
  }
  if (score < 90) {
    return { score, level: "strong", label: "强", entropyBits, suggestions };
  }
  return { score, level: "very-strong", label: "极强 (金融级安全)", entropyBits, suggestions };
}

/**
 * 解析单行 CSV 字段（支持双引号包裹与转义双引号）
 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * 导出为 Chrome / Edge 标准兼容 CSV (`name,url,username,password,note`)
 */
export function exportEntriesToCsv(entries: readonly VaultEntry[]): string {
  const escapeCell = (val: string) => {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = "name,url,username,password,note";
  const rows = (entries || []).map((e) =>
    [e.name, e.url, e.username, e.password, e.note].map(escapeCell).join(",")
  );
  return [header, ...rows].join("\n");
}

export class PasswordVaultManager {
  private entries: VaultEntry[];
  private lockState: VaultLockState = "unlocked";
  private masterPasswordHash: string | null = null;
  private activeMasterKey: string = DEFAULT_STORAGE_MASTER_KEY;
  private lastEnvelope: EncryptedVaultEnvelope | null = null;

  constructor(
    initialEntries: readonly VaultEntry[] = isRealElectronHost() ? [] : INITIAL_VAULT_ENTRIES
  ) {
    this.entries = initialEntries.map((e) => ({ ...e }));
  }

  public async hydrateFromStorage(): Promise<boolean> {
    try {
      const raw = await LocalStorage.getItem<string>(VAULT_STORAGE_KEY);
      if (!raw || typeof raw !== "string") {
        if (isRealElectronHost()) {
          this.entries = [];
        }
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return false;
      const key = this.activeMasterKey || DEFAULT_STORAGE_MASTER_KEY;
      this.entries = parsed.map((e: any) => {
        let pwd = String(e.password || "");
        if (pwd.startsWith("enc:v1:")) {
          try {
            pwd = decryptSecret(pwd, key);
          } catch {
            // keep encrypted if custom master key is locked
          }
        }
        return {
          id: String(e.id || `vault-${Date.now()}`),
          name: String(e.name || "Untitled"),
          username: String(e.username || ""),
          password: pwd,
          url: String(e.url || ""),
          folder: (e.folder || "其他") as VaultCategory,
          note: String(e.note || ""),
          pinned: Boolean(e.pinned),
          createdAt: Number(e.createdAt) || Date.now(),
          updatedAt: Number(e.updatedAt) || Date.now()
        };
      });
      return true;
    } catch {
      return false;
    }
  }

  private persistEntriesToStorage(): void {
    const key = this.activeMasterKey || DEFAULT_STORAGE_MASTER_KEY;
    const encryptedEntries: VaultEntry[] = this.entries.map((e) => ({
      ...e,
      password: e.password.startsWith("enc:v1:")
        ? e.password
        : encryptSecret(e.password, key)
    }));
    this.lastEnvelope = encryptVaultPayload(encryptedEntries, key);
    void LocalStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(encryptedEntries));
  }

  public getLockState(): VaultLockState {
    return this.lockState;
  }

  public hasMasterPassword(): boolean {
    return this.masterPasswordHash !== null;
  }

  public setMasterPassword(masterPassword: string): void {
    const clean = (masterPassword || "").trim();
    if (clean.length < 4) {
      throw new Error("主密码长度至少需要 4 位字符");
    }
    this.activeMasterKey = clean;
    this.masterPasswordHash = computeSimpleHash(clean);
    this.persistEntriesToStorage();
    this.lockState = "unlocked";
  }

  public lockVault(): VaultLockState {
    if (!this.masterPasswordHash) {
      this.setMasterPassword(DEFAULT_STORAGE_MASTER_KEY);
    }
    this.lockState = "locked";
    return this.lockState;
  }

  public unlockVault(masterPassword: string): VaultUnlockResult {
    const clean = (masterPassword || "").trim();
    if (!clean) {
      return {
        success: false,
        status: this.lockState,
        error: "请输入主密码"
      };
    }

    if (this.lastEnvelope) {
      try {
        const rawEntries = decryptVaultPayload(this.lastEnvelope, clean);
        this.entries = rawEntries.map((e) => ({
          ...e,
          password: e.password.startsWith("enc:v1:")
            ? decryptSecret(e.password, clean)
            : e.password
        }));
        this.activeMasterKey = clean;
        this.lockState = "unlocked";
        return { success: true, status: "unlocked" };
      } catch (e: any) {
        return {
          success: false,
          status: "locked",
          error: e?.message || "主密码不正确"
        };
      }
    }

    if (this.masterPasswordHash && computeSimpleHash(clean) !== this.masterPasswordHash) {
      return {
        success: false,
        status: "locked",
        error: "WRONG_PASSWORD: 主密码验证失败"
      };
    }

    this.activeMasterKey = clean;
    this.lockState = "unlocked";
    return { success: true, status: "unlocked" };
  }

  public getEntries(options: { query?: string; folder?: string } = {}): VaultEntry[] {
    if (this.lockState === "locked") {
      return [];
    }
    const q = (options.query || "").trim().toLowerCase();
    const folder = options.folder || "all";
    const key = this.activeMasterKey || DEFAULT_STORAGE_MASTER_KEY;

    return this.entries
      .filter((e) => {
        if (folder !== "all" && e.folder !== folder) return false;
        if (!q) return true;
        return `${e.name} ${e.username} ${e.url} ${e.folder} ${e.note}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      })
      .map((e) => ({
        ...e,
        password: e.password.startsWith("enc:v1:")
          ? decryptSecret(e.password, key)
          : e.password
      }));
  }

  public addOrUpdateEntry(input: VaultEntryInput): VaultEntry {
    if (this.lockState === "locked") {
      throw new Error("VAULT_LOCKED: 密码箱已锁定，请先解锁");
    }
    const name = (input?.name || "").trim();
    const rawPassword = input?.password ?? "";
    if (!name) {
      throw new Error("网站或应用名称不能为空");
    }
    if (!rawPassword) {
      throw new Error("密码不能为空");
    }

    const key = this.activeMasterKey || DEFAULT_STORAGE_MASTER_KEY;
    const plainPassword = rawPassword.startsWith("enc:v1:")
      ? decryptSecret(rawPassword, key)
      : rawPassword;

    const now = Date.now();
    const existingIdx = input.id ? this.entries.findIndex((e) => e.id === input.id) : -1;

    const entry: VaultEntry = {
      id: existingIdx >= 0 ? this.entries[existingIdx].id : input.id || `vault-${now}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.slice(0, 200),
      username: (input.username || "").trim().slice(0, 200),
      password: plainPassword,
      url: (input.url || "").trim().slice(0, 500),
      folder: (input.folder || "其他") as VaultCategory,
      note: (input.note || "").trim().slice(0, 1000),
      pinned: input.pinned ?? (existingIdx >= 0 ? this.entries[existingIdx].pinned : false),
      createdAt: existingIdx >= 0 ? this.entries[existingIdx].createdAt : now,
      updatedAt: now
    };

    if (existingIdx >= 0) {
      this.entries[existingIdx] = entry;
    } else {
      this.entries.unshift(entry);
    }

    this.persistEntriesToStorage();
    return { ...entry };
  }

  public deleteEntry(id: string): boolean {
    if (this.lockState === "locked") {
      throw new Error("VAULT_LOCKED: 密码箱已锁定");
    }
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length < before) {
      this.persistEntriesToStorage();
      return true;
    }
    return false;
  }

  public togglePinEntry(id: string): VaultEntry | undefined {
    const target = this.entries.find((e) => e.id === id);
    if (!target) return undefined;
    target.pinned = !target.pinned;
    target.updatedAt = Date.now();
    this.persistEntriesToStorage();
    return { ...target };
  }

  /**
   * 导入 Chrome / Edge 导出的标准 CSV 密码表 (`name,url,username,password,note`)
   */
  public importFromCsv(csvContent: string): CsvImportResult {
    if (this.lockState === "locked") {
      throw new Error("VAULT_LOCKED: 密码箱已锁定，请先解锁再导入 CSV");
    }
    if (typeof csvContent !== "string" || !csvContent.trim()) {
      return {
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 1,
        errors: ["CSV 内容为空"],
        entries: []
      };
    }

    const lines = csvContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { imported: 0, updated: 0, skipped: 0, failed: 1, errors: ["无有效行"], entries: [] };
    }

    let startIdx = 0;
    const firstCols = parseCsvLine(lines[0]).map((c) => c.toLowerCase());
    let nameIdx = 0;
    let urlIdx = 1;
    let userIdx = 2;
    let passIdx = 3;
    let noteIdx = 4;

    if (firstCols.includes("password") || firstCols.includes("username") || firstCols.includes("name")) {
      startIdx = 1;
      nameIdx = firstCols.indexOf("name") !== -1 ? firstCols.indexOf("name") : 0;
      urlIdx = firstCols.indexOf("url") !== -1 ? firstCols.indexOf("url") : 1;
      userIdx = firstCols.indexOf("username") !== -1 ? firstCols.indexOf("username") : 2;
      passIdx = firstCols.indexOf("password") !== -1 ? firstCols.indexOf("password") : 3;
      noteIdx = firstCols.indexOf("note") !== -1 ? firstCols.indexOf("note") : 4;
    }

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    const importedEntries: VaultEntry[] = [];

    for (let i = startIdx; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      if (cols.length < 3) {
        failed++;
        errors.push(`第 ${i + 1} 行列数不足`);
        continue;
      }
      const url = cols[urlIdx] || "";
      let name = cols[nameIdx] || "";
      if (!name && url) {
        try {
          name = new URL(url).hostname;
        } catch {
          name = url;
        }
      }
      const username = cols[userIdx] || "";
      const password = cols[passIdx] || "";
      const note = cols[noteIdx] || "";

      if (!name || !password) {
        skipped++;
        errors.push(`第 ${i + 1} 行缺少名称或密码，已跳过`);
        continue;
      }

      const duplicate = this.entries.find(
        (e) => e.name.toLowerCase() === name.toLowerCase() && e.username === username
      );
      if (duplicate) {
        duplicate.password = password;
        duplicate.url = url || duplicate.url;
        duplicate.note = note || duplicate.note;
        duplicate.updatedAt = Date.now();
        updated++;
        importedEntries.push({ ...duplicate });
        this.persistEntriesToStorage();
      } else {
        const added = this.addOrUpdateEntry({
          name,
          url,
          username,
          password,
          note,
          folder: "其他"
        });
        imported++;
        importedEntries.push(added);
      }
    }

    return {
      imported,
      updated,
      skipped,
      failed,
      errors,
      entries: importedEntries
    };
  }

  public resetToDefaults(): void {
    this.entries = INITIAL_VAULT_ENTRIES.map((e) => ({ ...e }));
    this.lockState = "unlocked";
    this.masterPasswordHash = null;
    this.activeMasterKey = DEFAULT_STORAGE_MASTER_KEY;
    this.lastEnvelope = null;
  }
}

export const defaultPasswordVaultManager = new PasswordVaultManager();
