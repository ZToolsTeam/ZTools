import { hmac, digest, bytesToHex } from "./hash.js";
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/**
 * 清理 Base32 密钥字符串
 */
export function cleanSecret(secret) {
    return (secret || "")
        .toUpperCase()
        .replace(/[\s\-_]/g, "")
        .replace(/=+$/, "");
}
/**
 * 校验 Base32 密钥合法性
 */
export function isValidBase32(secret) {
    const cleaned = cleanSecret(secret);
    if (!cleaned || cleaned.length === 0)
        return false;
    for (let i = 0; i < cleaned.length; i++) {
        if (BASE32_CHARS.indexOf(cleaned[i]) === -1) {
            return false;
        }
    }
    return true;
}
/**
 * 解码 RFC 4648 Base32 字符串为字节数组
 */
export function base32Decode(secret) {
    const cleaned = cleanSecret(secret);
    if (!cleaned) {
        throw new Error("密钥不能为空");
    }
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (let i = 0; i < cleaned.length; i++) {
        const char = cleaned[i];
        const val = BASE32_CHARS.indexOf(char);
        if (val === -1) {
            throw new Error(`密钥格式错误: 包含非法字符 '${char}'，Base32 仅允许 A-Z 和 2-7`);
        }
        value = (value << 5) | val;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(bytes);
}
/**
 * 根据 RFC 6238 标准生成 TOTP 动态口令
 */
export function generateTOTP(secret, options = {}) {
    const period = options.period && options.period > 0 ? options.period : 30;
    const digits = options.digits && options.digits >= 4 && options.digits <= 10 ? options.digits : 6;
    const algorithm = options.algorithm || "SHA1";
    const nowMs = options.nowMs !== undefined ? options.nowMs : Date.now();
    const keyBuffer = base32Decode(secret);
    const counter = Math.floor(nowMs / 1000 / period);
    // 构造 8 字节大端序计数器
    const counterBuffer = new Uint8Array(8);
    let tempCounter = BigInt(counter);
    for (let i = 7; i >= 0; i--) {
        counterBuffer[i] = Number(tempCounter & 0xffn);
        tempCounter >>= 8n;
    }
    // 计算 HMAC
    const algoName = algorithm.toLowerCase();
    const mac = hmac(algoName, keyBuffer, counterBuffer);
    // 动态截断 Dynamic Truncation
    const offset = mac[mac.length - 1] & 0x0f;
    const binary = ((mac[offset] & 0x7f) << 24) |
        ((mac[offset + 1] & 0xff) << 16) |
        ((mac[offset + 2] & 0xff) << 8) |
        (mac[offset + 3] & 0xff);
    const mod = 10 ** digits;
    const token = (binary % mod).toString().padStart(digits, "0");
    return token;
}
/**
 * 格式化口令显示（加空格便于肉眼识别）
 */
export function formatToken(code) {
    if (code.length === 6) {
        return `${code.slice(0, 3)} ${code.slice(3)}`;
    }
    if (code.length === 8) {
        return `${code.slice(0, 4)} ${code.slice(4)}`;
    }
    return code;
}
/**
 * 计算剩余倒计时秒数
 */
export function getRemainingSeconds(period = 30, nowMs = Date.now()) {
    const currentSec = Math.floor(nowMs / 1000);
    const remaining = period - (currentSec % period);
    return remaining === 0 ? period : remaining;
}
/**
 * 解析 otpauth:// 协议 URL
 */
export function parseOTPAuthURL(urlText) {
    const trimmed = (urlText || "").trim();
    if (!trimmed.toLowerCase().startsWith("otpauth://")) {
        throw new Error("链接必须以 otpauth:// 开头");
    }
    try {
        const parsedUrl = new URL(trimmed);
        const type = parsedUrl.hostname.toLowerCase();
        // 本插件只按时间生成口令（TOTP）。HOTP 按计数器生成，若按 TOTP 计算会显示错误口令，必须直接拒绝
        if (type === "hotp") {
            throw new Error("暂不支持 HOTP（计数器型）链接，请使用基于时间的 TOTP 链接");
        }
        if (type !== "totp") {
            throw new Error(`不支持的 OTP 类型: ${type}`);
        }
        const pathname = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ""));
        let issuer = parsedUrl.searchParams.get("issuer") || "";
        let name = pathname;
        if (pathname.includes(":")) {
            const parts = pathname.split(":");
            if (!issuer) {
                issuer = parts[0].trim();
            }
            name = parts.slice(1).join(":").trim();
        }
        const secret = cleanSecret(parsedUrl.searchParams.get("secret") || "");
        if (!secret || !isValidBase32(secret)) {
            throw new Error("链接中缺少有效的 Base32 secret 密钥参数");
        }
        const digits = parseInt(parsedUrl.searchParams.get("digits") || "6", 10) || 6;
        const period = parseInt(parsedUrl.searchParams.get("period") || "30", 10) || 30;
        const rawAlgo = (parsedUrl.searchParams.get("algorithm") || "SHA1").toUpperCase();
        const algorithm = rawAlgo === "SHA256" || rawAlgo === "SHA512" ? rawAlgo : "SHA1";
        return {
            type: "totp",
            secret,
            name: name || issuer || "未命名账号",
            issuer: issuer || "2FA",
            period,
            digits,
            algorithm
        };
    }
    catch (err) {
        throw new Error(`解析 otpauth 链接失败: ${err.message}`);
    }
}
/**
 * 创建新账号
 */
export function createAccount(params) {
    const trimmedName = (params.name || "").trim();
    if (!trimmedName) {
        throw new Error("账号名称不能为空");
    }
    const cleaned = cleanSecret(params.secret);
    if (!cleaned) {
        throw new Error("密钥不能为空");
    }
    if (!isValidBase32(cleaned)) {
        throw new Error("密钥不是合法的 Base32 编码（仅支持 A-Z 与 2-7）");
    }
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new Error('无法生成唯一标识，请重启客户端后重试');
    }
    return {
        id: "auth_" + Date.now().toString(36) + "_" + globalThis.crypto.randomUUID(),
        name: trimmedName,
        issuer: (params.issuer || "").trim() || "2FA",
        secret: cleaned,
        period: params.period && params.period > 0 ? params.period : 30,
        digits: params.digits && params.digits >= 4 && params.digits <= 10 ? params.digits : 6,
        algorithm: params.algorithm || "SHA1",
        createdAt: Date.now()
    };
}
/**
 * 账号列表过滤与检索
 */
export function filterAccounts(accounts, query) {
    const q = (query || "").trim().toLowerCase();
    if (!q)
        return accounts;
    return accounts.filter((item) => {
        return item.name.toLowerCase().includes(q) || item.issuer.toLowerCase().includes(q);
    });
}
/**
 * 校验从存储读回的账号列表：结构不对的条目直接丢弃，不让损坏数据导致整个列表崩溃
 */
export function sanitizeStoredAccounts(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const a = item;
        if (typeof a.id !== "string" || typeof a.name !== "string" || typeof a.secret !== "string")
            continue;
        if (!isValidBase32(a.secret))
            continue;
        const algorithm = a.algorithm === "SHA256" || a.algorithm === "SHA512" ? a.algorithm : "SHA1";
        const period = typeof a.period === "number" && a.period > 0 ? a.period : 30;
        const digits = typeof a.digits === "number" && a.digits >= 4 && a.digits <= 10 ? a.digits : 6;
        out.push({
            id: a.id,
            name: a.name,
            issuer: typeof a.issuer === "string" ? a.issuer : "2FA",
            secret: cleanSecret(a.secret),
            period,
            digits,
            algorithm,
            createdAt: typeof a.createdAt === "number" ? a.createdAt : 0
        });
    }
    return out;
}
export const ACCOUNTS_STORAGE_KEY = "google-auth.accounts.v1";
/**
 * 检查存储读回的原始值：区分「没有数据」「整体损坏」「部分条目损坏」，
 * 让界面在覆盖写入前能提示用户并先备份原值，而不是把损坏数据当成空列表
 */
export function inspectStoredAccounts(raw) {
    if (raw === undefined || raw === null)
        return { accounts: [], corrupt: false, dropped: 0 };
    if (!Array.isArray(raw))
        return { accounts: [], corrupt: true, dropped: 0 };
    const accounts = sanitizeStoredAccounts(raw);
    return { accounts, corrupt: false, dropped: raw.length - accounts.length };
}
/**
 * 损坏原值的备份键：按内容取摘要，同一份损坏数据多次打开只备份到同一个键
 */
export function corruptBackupKey(raw) {
    let text;
    try {
        text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? String(raw);
    }
    catch {
        text = String(raw);
    }
    return `${ACCOUNTS_STORAGE_KEY}.corrupt-${bytesToHex(digest("sha1", text)).slice(0, 12)}`;
}
/** 损坏原值备份键的格式（corruptBackupKey 的输出），迁移时只认这种键 */
export const CORRUPT_BACKUP_KEY_PATTERN = /^google-auth\.accounts\.v1\.corrupt-[0-9a-f]{12}$/;
/** 账号去重键：同一服务商、同一名称、同一密钥视为同一个账号 */
function accountIdentity(account) {
    return JSON.stringify([cleanSecret(account.secret), account.issuer, account.name]);
}
/**
 * 把旧版明文里的账号合并进加密存储的账号列表：加密存储的原始条目（含读不出的损坏条目）原样保留在前，
 * 明文里新出现的账号追加在后，按 (secret, issuer, name) 去重
 */
export function mergeLegacyAccounts(secureRaw, legacy) {
    const seen = new Set(sanitizeStoredAccounts(secureRaw).map(accountIdentity));
    const merged = [...secureRaw];
    let added = 0;
    for (const account of legacy) {
        const id = accountIdentity(account);
        if (seen.has(id))
            continue;
        seen.add(id);
        merged.push(account);
        added++;
    }
    return { merged, added };
}
/** SecureStorage.status() 不可用原因的说明 */
export function describeSecureStorageUnavailable(reason) {
    switch (reason) {
        case "encryption-unavailable":
            return "系统加密存储不可用（钥匙串被拒绝访问或尚未解锁）";
        case "insecure-backend":
            return "系统只提供不安全的明文加密后端";
        case "backend-unknown":
            return "无法确认系统加密后端是否安全";
        case "host-unsupported":
            return "当前 ZTools 版本不支持加密存储，请升级 ZTools";
        case "identity-required":
            return "无法确认插件身份，请关闭后重新打开插件";
        default:
            return `系统加密存储不可用（${reason}）`;
    }
}
