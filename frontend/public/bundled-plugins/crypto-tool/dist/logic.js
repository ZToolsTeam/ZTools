import { getLocale } from "@ztools/declarative-ui";
import { digest, hmac, bytesToHex, bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } from "./hash.js";
const CRYPTO_LOGIC_MESSAGES = {
    "zh-CN": {
        clientUnsupported: (method) => `当前客户端不支持 ${method}`,
        methodFailed: (method) => `${method} 调用失败`,
        filePathEmpty: "文件路径不能为空",
        fileReadHashFailed: "无法读取文件内容计算哈希",
        base64DecodeFailed: "Base64 解码失败",
        decodedNotUtf8: "解码结果不是 UTF-8 文本（可能是图片或其他二进制数据）",
        noWebCrypto: "当前环境不支持 WebCrypto，无法执行 AES 运算",
        encryptKeyRequired: "请填写加密口令",
        aesEncryptFailed: (reason) => `AES 加密失败: ${reason}`,
        invalidParam: "参数错误",
        ciphertextEmpty: "密文不能为空",
        decryptKeyRequired: "请填写解密口令",
        ciphertextInvalidBase64: "密文不是合法的 Base64",
        ciphertextInvalidLength: "密文长度不正确，可能不完整或不是 AES-CBC 密文",
        decryptFailed: "解密失败：口令或 IV 不正确，或密文已被篡改"
    },
    "en-US": {
        clientUnsupported: (method) => `Current client does not support ${method}`,
        methodFailed: (method) => `${method} call failed`,
        filePathEmpty: "File path cannot be empty",
        fileReadHashFailed: "Failed to read file content for hashing",
        base64DecodeFailed: "Base64 decoding failed",
        decodedNotUtf8: "Decoded result is not valid UTF-8 text (may be an image or binary data)",
        noWebCrypto: "WebCrypto is not supported in this environment; AES cannot run",
        encryptKeyRequired: "Please enter an encryption key",
        aesEncryptFailed: (reason) => `AES encryption failed: ${reason}`,
        invalidParam: "Invalid parameters",
        ciphertextEmpty: "Ciphertext cannot be empty",
        decryptKeyRequired: "Please enter a decryption key",
        ciphertextInvalidBase64: "Ciphertext is not valid Base64",
        ciphertextInvalidLength: "Invalid ciphertext length; data may be truncated or not AES-CBC",
        decryptFailed: "Decryption failed: incorrect key/IV, or ciphertext has been tampered with"
    }
};
function cryptoLogicStrings() {
    const locale = getLocale();
    return CRYPTO_LOGIC_MESSAGES[locale] ?? CRYPTO_LOGIC_MESSAGES["en-US"];
}
let fileHashSeq = 0;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function callHostMethod(method, params) {
    const s = cryptoLogicStrings();
    const g = globalThis;
    const methods = g.window?.__ztoolsElectron?.transport?.methods ?? g.__ztoolsElectron?.transport?.methods;
    const fn = methods?.[method];
    if (typeof fn !== "function") {
        throw new Error(s.clientUnsupported(method));
    }
    fileHashSeq = (fileHashSeq + 1) % 1_000_000;
    const raw = (await fn({
        messageId: `crypto_file_${Date.now()}_${fileHashSeq}`,
        params
    }));
    if (isRecord(raw) && raw.success === false) {
        const err = raw.error;
        const msg = isRecord(err) ? String(err.message || err.code || s.methodFailed(method)) : String(err || s.methodFailed(method));
        throw new Error(msg);
    }
    if (isRecord(raw) && "data" in raw && raw.data !== undefined) {
        const outer = raw.data;
        return isRecord(outer) && "data" in outer && outer.data !== undefined ? outer.data : outer;
    }
    return raw;
}
/**
 * 读取本地文件真实字节计算哈希摘要（或调用宿主 filesearch_sha256），绝不将路径字符串当文本计算
 */
export async function calculateFileHash(filePath) {
    const s = cryptoLogicStrings();
    const normalizedPath = (filePath ?? "").trim();
    if (!normalizedPath) {
        throw new Error(s.filePathEmpty);
    }
    const fileName = normalizedPath.split(/[\\/]/).filter(Boolean).pop() || normalizedPath;
    let readError;
    try {
        const data = await callHostMethod("filesystem_read_file", {
            path: normalizedPath,
            encoding: "base64"
        });
        const base64Content = typeof data === "string"
            ? data
            : isRecord(data) && typeof data.content === "string"
                ? data.content
                : isRecord(data) && typeof data.base64 === "string"
                    ? data.base64
                    : undefined;
        if (typeof base64Content === "string") {
            const bytes = base64ToBytes(base64Content);
            const md5 = bytesToHex(digest("md5", bytes));
            return {
                fileName,
                filePath: normalizedPath,
                byteLength: bytes.byteLength,
                md5,
                md5Upper: md5.toUpperCase(),
                sha1: bytesToHex(digest("sha1", bytes)),
                sha256: bytesToHex(digest("sha256", bytes)),
                sha512: bytesToHex(digest("sha512", bytes))
            };
        }
    }
    catch (err) {
        readError = err instanceof Error ? err : new Error(String(err));
    }
    try {
        const shaData = await callHostMethod("filesearch_sha256", { fullPath: normalizedPath, path: normalizedPath });
        const sha256 = typeof shaData === "string"
            ? shaData.trim().toLowerCase()
            : isRecord(shaData) && typeof shaData.sha256 === "string"
                ? shaData.sha256.trim().toLowerCase()
                : isRecord(shaData) && typeof shaData.hash === "string"
                    ? shaData.hash.trim().toLowerCase()
                    : "";
        if (/^[0-9a-f]{64}$/i.test(sha256)) {
            return {
                fileName,
                filePath: normalizedPath,
                sha256: sha256.toLowerCase()
            };
        }
    }
    catch (err) {
        if (!readError) {
            readError = err instanceof Error ? err : new Error(String(err));
        }
    }
    throw readError ?? new Error(s.fileReadHashFailed);
}
/**
 * 实时计算所有常用哈希与编码对比（UTF-8 输入）
 */
export function calculateMultiHash(text) {
    const bytes = utf8ToBytes(text ?? "");
    const md5 = bytesToHex(digest("md5", bytes));
    return {
        md5,
        md5Upper: md5.toUpperCase(),
        md5_16: md5.substring(8, 24),
        md5_16Upper: md5.substring(8, 24).toUpperCase(),
        sha1: bytesToHex(digest("sha1", bytes)),
        sha256: bytesToHex(digest("sha256", bytes)),
        sha512: bytesToHex(digest("sha512", bytes)),
        base64: bytesToBase64(bytes),
        urlEncoded: encodeURIComponent(text ?? "")
    };
}
/**
 * Base64 编解码
 */
export function encodeBase64(text) {
    return bytesToBase64(utf8ToBytes(text ?? ""));
}
export function decodeBase64(base64Str) {
    const s = cryptoLogicStrings();
    const clean = (base64Str ?? "").trim();
    if (!clean)
        return { success: true, result: "" };
    let bytes;
    try {
        bytes = base64ToBytes(clean);
    }
    catch (err) {
        return { success: false, error: err instanceof Error ? err.message : s.base64DecodeFailed };
    }
    try {
        return { success: true, result: bytesToUtf8(bytes) };
    }
    catch {
        return { success: false, error: s.decodedNotUtf8 };
    }
}
/**
 * 派生 AES-256 密钥与 IV：密钥 = SHA-256(口令)；IV = MD5(IV 文本)，未填写时取密钥前 16 字节。
 * 与 Node `crypto.createCipheriv("aes-256-cbc", key, iv)` 的输出逐字节一致，旧版本加密的数据可以继续解密。
 */
function deriveKeyAndIv(key, ivStr) {
    const keyBytes = digest("sha256", key);
    const ivBytes = ivStr ? digest("md5", ivStr) : keyBytes.slice(0, 16);
    return { keyBytes, ivBytes };
}
function getSubtle() {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
        throw new Error(cryptoLogicStrings().noWebCrypto);
    return subtle;
}
async function importAesKey(keyBytes, usage) {
    return getSubtle().importKey("raw", keyBytes, { name: "AES-CBC" }, false, [usage]);
}
/**
 * AES-256-CBC 加密（PKCS#7 填充），输出 Base64 密文
 */
export async function aesEncrypt(plaintext, key, options = {}) {
    const s = cryptoLogicStrings();
    if (!key)
        return { success: false, error: s.encryptKeyRequired };
    try {
        const { keyBytes, ivBytes } = deriveKeyAndIv(key, options.iv);
        const cryptoKey = await importAesKey(keyBytes, "encrypt");
        const cipher = await getSubtle().encrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, utf8ToBytes(plaintext ?? ""));
        return { success: true, result: bytesToBase64(new Uint8Array(cipher)), iv: bytesToHex(ivBytes) };
    }
    catch (err) {
        return { success: false, error: s.aesEncryptFailed(err instanceof Error ? err.message : s.invalidParam) };
    }
}
/**
 * AES-256-CBC 解密：口令错误或密文被篡改时，填充校验会失败并返回错误，不会输出乱码
 */
export async function aesDecrypt(ciphertextBase64, key, options = {}) {
    const s = cryptoLogicStrings();
    const raw = (ciphertextBase64 ?? "").trim();
    if (!raw)
        return { success: false, error: s.ciphertextEmpty };
    if (!key)
        return { success: false, error: s.decryptKeyRequired };
    let cipherBytes;
    try {
        cipherBytes = base64ToBytes(raw);
    }
    catch {
        return { success: false, error: s.ciphertextInvalidBase64 };
    }
    if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) {
        return { success: false, error: s.ciphertextInvalidLength };
    }
    try {
        const { keyBytes, ivBytes } = deriveKeyAndIv(key, options.iv);
        const cryptoKey = await importAesKey(keyBytes, "decrypt");
        const plain = await getSubtle().decrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, cipherBytes);
        return { success: true, result: bytesToUtf8(new Uint8Array(plain)) };
    }
    catch {
        return { success: false, error: s.decryptFailed };
    }
}
/**
 * 计算 HMAC（十六进制小写）
 */
export function calculateHmac(algorithm, text, key) {
    return bytesToHex(hmac(algorithm, key ?? "", text ?? ""));
}
/**
 * 围栏代码块：内容原样显示（保留换行、缩进与 Markdown 符号）。
 * 围栏比内容里最长的反引号串多一个，内容里的 ``` 不会让代码块提前结束。
 */
export function codeBlockMarkdown(text) {
    const body = text ?? "";
    let longest = 0;
    for (const run of body.match(/`+/g) || [])
        longest = Math.max(longest, run.length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}\n${body}\n${fence}`;
}
/**
 * 结果预览：单行、不含反引号、不含会被 HTML 折叠的空白（制表符、连续空格、首尾空白）时用行内代码，
 * 所在段落会自动折行，SHA-512、长 Base64、单行 JSON 不需要横向滚动，Markdown 符号也不会被解释；
 * 其余情况（多行文本等）退回围栏代码块，保证原样显示。
 */
export function valueMarkdown(value) {
    const text = value ?? "";
    const inlineSafe = text !== "" && !/[`\r\n\t]|\s{2,}|^\s|\s$/.test(text);
    return inlineSafe ? `\`${text}\`` : codeBlockMarkdown(text);
}
