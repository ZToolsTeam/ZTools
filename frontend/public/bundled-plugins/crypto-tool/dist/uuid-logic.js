import { getLocale } from "@ztools/declarative-ui";
export const UUID_VERSIONS = ["v4", "v7", "v1"];
export const UUID_FORMATS = ["standard", "uppercase", "no-dash", "no-dash-upper"];
export const MAX_UUID_BATCH_COUNT = 1000;
const MAX_ATTEMPTS_PER_UUID = 10;
const UUID_ERRORS = {
    "zh-CN": {
        noSecureRandom: "当前环境不支持安全随机数",
        invalidCount: `数量必须是 1 到 ${MAX_UUID_BATCH_COUNT} 的整数`,
        unsupportedVersion: (v) => `不支持的 UUID 版本: ${v}`,
        invalidTimestamp: "当前系统时间戳超出 UUID 编码范围",
        batchUniqueFailed: "批量生成 UUID 唯一性校验失败"
    },
    "en-US": {
        noSecureRandom: "Secure random generation is not supported in this environment",
        invalidCount: `Count must be an integer between 1 and ${MAX_UUID_BATCH_COUNT}`,
        unsupportedVersion: (v) => `Unsupported UUID version: ${v}`,
        invalidTimestamp: "Timestamp is out of range for UUID encoding",
        batchUniqueFailed: "Failed to guarantee uniqueness in UUID batch"
    }
};
function uuidErrors() {
    const locale = getLocale();
    return UUID_ERRORS[locale] ?? UUID_ERRORS["en-US"];
}
function randomBytes(length) {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
        throw new Error(uuidErrors().noSecureRandom);
    }
    const bytes = new Uint8Array(length);
    cryptoApi.getRandomValues(bytes);
    return bytes;
}
function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function formatHexAsUuid(hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/** 生成标准小写 UUID v4（RFC 9562 随机） */
export function generateUuidV4() {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatHexAsUuid(bytesToHex(bytes));
}
/** 生成标准小写 UUID v7（RFC 9562 Unix 毫秒时间有序） */
export function generateUuidV7(nowMs = Date.now()) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || BigInt(nowMs) > 0xffffffffffffn) {
        throw new Error(uuidErrors().invalidTimestamp);
    }
    const bytes = randomBytes(16);
    let timestamp = BigInt(nowMs);
    for (let i = 5; i >= 0; i -= 1) {
        bytes[i] = Number(timestamp & 0xffn);
        timestamp >>= 8n;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatHexAsUuid(bytesToHex(bytes));
}
/** 生成标准小写 UUID v1（RFC 9562 100ns Gregorian 纪元时间戳 + 随机组播节点） */
export function generateUuidV1(nowMs = Date.now()) {
    const GREGORIAN_OFFSET = 122192928000000000n;
    if (!Number.isSafeInteger(nowMs)) {
        throw new Error(uuidErrors().invalidTimestamp);
    }
    const randomFields = randomBytes(4);
    const subMs = BigInt(((randomFields[0] << 8) | randomFields[1]) % 10000);
    const timestamp = BigInt(nowMs) * 10000n + GREGORIAN_OFFSET + subMs;
    if (timestamp < 0n || timestamp >= 1n << 60n) {
        throw new Error(uuidErrors().invalidTimestamp);
    }
    const timeLow = Number(timestamp & 0xffffffffn);
    const timeMid = Number((timestamp >> 32n) & 0xffffn);
    const timeHi = Number((timestamp >> 48n) & 0x0fffn) | 0x1000;
    const clockSeq = (((randomFields[2] << 8) | randomFields[3]) & 0x3fff) | 0x8000;
    const node = randomBytes(6);
    node[0] = node[0] | 0x01;
    return [
        timeLow.toString(16).padStart(8, "0"),
        timeMid.toString(16).padStart(4, "0"),
        timeHi.toString(16).padStart(4, "0"),
        clockSeq.toString(16).padStart(4, "0"),
        bytesToHex(node)
    ].join("-");
}
/** 将标准 UUID 按指定格式输出 */
export function formatUuid(uuid, format) {
    const raw = uuid.toLowerCase();
    switch (format) {
        case "standard":
            return raw;
        case "uppercase":
            return raw.toUpperCase();
        case "no-dash":
            return raw.replace(/-/g, "");
        case "no-dash-upper":
            return raw.replace(/-/g, "").toUpperCase();
        default:
            return raw;
    }
}
export function isUuidVersion(value) {
    return value === "v4" || value === "v7" || value === "v1";
}
export function isUuidFormat(value) {
    return value === "standard" || value === "uppercase" || value === "no-dash" || value === "no-dash-upper";
}
/** 批量生成去重后的 UUID */
export function generateUuidBatch(options = {}) {
    const errs = uuidErrors();
    const version = options.version ?? "v4";
    const format = options.format ?? "standard";
    const rawCount = options.count ?? 5;
    let count;
    if (typeof rawCount === "string") {
        const trimmed = rawCount.trim();
        if (!/^\d+$/.test(trimmed))
            throw new Error(errs.invalidCount);
        count = Number(trimmed);
    }
    else {
        count = rawCount;
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_UUID_BATCH_COUNT) {
        throw new Error(errs.invalidCount);
    }
    const generators = {
        v4: generateUuidV4,
        v7: generateUuidV7,
        v1: generateUuidV1
    };
    const gen = generators[version];
    if (!gen) {
        throw new Error(errs.unsupportedVersion(String(version)));
    }
    const results = [];
    const seen = new Set();
    const maxAttempts = count * MAX_ATTEMPTS_PER_UUID;
    let attempts = 0;
    while (results.length < count && attempts < maxAttempts) {
        attempts += 1;
        const raw = gen();
        if (seen.has(raw))
            continue;
        seen.add(raw);
        results.push(formatUuid(raw, format));
    }
    if (results.length !== count) {
        throw new Error(errs.batchUniqueFailed);
    }
    return results;
}
