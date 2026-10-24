import { digest, hmac, bytesToHex, bytesToBase64, base64ToBytes, utf8ToBytes, bytesToUtf8 } from "./hash.js";
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
    const clean = (base64Str ?? "").trim();
    if (!clean)
        return { success: true, result: "" };
    let bytes;
    try {
        bytes = base64ToBytes(clean);
    }
    catch (err) {
        return { success: false, error: err?.message || "Base64 解码失败" };
    }
    try {
        return { success: true, result: bytesToUtf8(bytes) };
    }
    catch {
        return { success: false, error: "解码结果不是 UTF-8 文本（可能是图片或其他二进制数据）" };
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
        throw new Error("当前环境不支持 WebCrypto，无法执行 AES 运算");
    return subtle;
}
async function importAesKey(keyBytes, usage) {
    return getSubtle().importKey("raw", keyBytes, { name: "AES-CBC" }, false, [usage]);
}
/**
 * AES-256-CBC 加密（PKCS#7 填充），输出 Base64 密文
 */
export async function aesEncrypt(plaintext, key, options = {}) {
    if (!key)
        return { success: false, error: "请填写加密口令" };
    try {
        const { keyBytes, ivBytes } = deriveKeyAndIv(key, options.iv);
        const cryptoKey = await importAesKey(keyBytes, "encrypt");
        const cipher = await getSubtle().encrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, utf8ToBytes(plaintext ?? ""));
        return { success: true, result: bytesToBase64(new Uint8Array(cipher)), iv: bytesToHex(ivBytes) };
    }
    catch (err) {
        return { success: false, error: `AES 加密失败: ${err?.message || "参数错误"}` };
    }
}
/**
 * AES-256-CBC 解密：口令错误或密文被篡改时，填充校验会失败并返回错误，不会输出乱码
 */
export async function aesDecrypt(ciphertextBase64, key, options = {}) {
    const raw = (ciphertextBase64 ?? "").trim();
    if (!raw)
        return { success: false, error: "密文不能为空" };
    if (!key)
        return { success: false, error: "请填写解密口令" };
    let cipherBytes;
    try {
        cipherBytes = base64ToBytes(raw);
    }
    catch {
        return { success: false, error: "密文不是合法的 Base64" };
    }
    if (cipherBytes.length === 0 || cipherBytes.length % 16 !== 0) {
        return { success: false, error: "密文长度不正确，可能不完整或不是 AES-CBC 密文" };
    }
    try {
        const { keyBytes, ivBytes } = deriveKeyAndIv(key, options.iv);
        const cryptoKey = await importAesKey(keyBytes, "decrypt");
        const plain = await getSubtle().decrypt({ name: "AES-CBC", iv: ivBytes }, cryptoKey, cipherBytes);
        return { success: true, result: bytesToUtf8(new Uint8Array(plain)) };
    }
    catch {
        return { success: false, error: "解密失败：口令或 IV 不正确，或密文已被篡改" };
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
