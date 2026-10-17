/**
 * Raycast Core & Account 类型契约
 * 对标 Raycast Core 命令注册树与账户认证管理
 */

export interface ReleaseNoteItem {
  version: string;
  releaseDate: string;
  title: string;
  highlights: string[];
  markdownNotes: string;
  isCurrentVersion?: boolean;
}

export interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  date: string;
  severity: "info" | "warning" | "critical";
  linkUrl?: string;
  dismissed?: boolean;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseNotes?: string;
  sha256?: string;
}

export interface ByokKeyInfo {
  provider: "deepseek" | "openai" | "claude" | "ollama_local";
  name: string;
  configured: boolean;
  model: string;
  status: "valid" | "invalid" | "unconfigured" | "testing";
  maskedKey?: string;
  endpoint?: string;
  latencyMs?: number;
  hasReasoningStream?: boolean; // 原生 DeepSeek R1 思考流
  lastTested?: string;
}

export interface E2eeSyncInfo {
  status: "synced" | "syncing" | "offline" | "conflict" | "error";
  provider: "webdav" | "gist" | "local_only";
  argon2idVerified: boolean;
  aes256GcmVerified: boolean;
  lastSyncedAt: string;
  encryptedChecksum: string;
  pendingChangesCount: number;
}

export interface OfflineLicenseCertificate {
  licenseId: string;
  issuer: string;
  subject: string;
  tier: "Pro Geek" | "Enterprise Team" | "Community Free";
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  algorithm: string;
  signature: string;
  features: string[];
}

export interface GeekAccountProfile {
  userId: string;
  username: string;
  email: string;
  avatarUrl?: string;
  avatarEmoji?: string;
  tier: "Pro" | "Freemium" | "Team";
  hasProFeatures: boolean;
  token?: string;
  tokenExpiresAt?: number;
  isAuthenticated: boolean;
  byokConfigured: boolean;
  syncConnected: boolean;
  sync: E2eeSyncInfo;
  byok: Record<"deepseek" | "openai" | "claude" | "ollama_local", ByokKeyInfo>;
  license: OfflineLicenseCertificate;
}
