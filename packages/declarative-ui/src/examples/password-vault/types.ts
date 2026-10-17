/**
 * ZTools Password Vault (密码保险箱) 数据模型与类型定义
 * 借鉴 Raycast KeePassXC 插件交互范式，面向本地加密存储与单职责密码管理重构：
 * - 纯粹管理：网站/应用名称、登录账号、密码、网址 URL、分类文件夹、私密备注（不含 2FA TOTP）
 * - 支持 locked / unlocked 状态机与主密码加密保护
 * - 支持 Chrome / Edge 标准 CSV (`name,url,username,password,note`) 导入与导出
 */

export type VaultCategory = "工作" | "社交" | "金融" | "购物" | "开发" | "其他";

export const VAULT_CATEGORIES: readonly VaultCategory[] = Object.freeze([
  "工作",
  "社交",
  "金融",
  "购物",
  "开发",
  "其他"
]);

export type VaultLockState = "locked" | "unlocked";

export type PasswordStrengthLevel = "weak" | "fair" | "good" | "strong" | "very-strong";

export interface PasswordStrengthResult {
  score: number; // 0 ~ 100
  level: PasswordStrengthLevel;
  label: string;
  entropyBits: number;
  suggestions: string[];
}

export interface PasswordGeneratorOptions {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  symbols?: boolean;
  excludeAmbiguous?: boolean;
}

export interface VaultEntry {
  id: string;
  name: string;
  username: string;
  password: string;
  url: string;
  folder: VaultCategory | string;
  note: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface VaultEntryInput {
  id?: string;
  name: string;
  username?: string;
  password: string;
  url?: string;
  folder?: VaultCategory | string;
  note?: string;
  pinned?: boolean;
}

export interface EncryptedVaultEnvelope {
  version: number;
  salt: string;
  iv: string;
  cipherText: string;
  mac: string;
  updatedAt: number;
}

export interface VaultUnlockResult {
  success: boolean;
  status: VaultLockState;
  error?: string;
}

export interface CsvImportResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  entries: VaultEntry[];
}
