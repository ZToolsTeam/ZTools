import { getLocale } from "@ztools/declarative-ui";
const CODEC_MESSAGES = {
    "zh-CN": {
        loneSurrogateUtf8: "输入包含不成对的 Unicode 代理项，无法按 UTF-8 编码",
        invalidUrlEncoding: "不是合法的 URL 编码：% 后须是两位十六进制，且字节序列必须是 UTF-8",
        invalidUnicodeSeq: "请输入完整的 \\uXXXX 序列",
        loneSurrogatePair: "代理项不成对：Emoji 等字符需要高低两个 \\uXXXX 连续出现",
        invalidHexBytes: "Hex 必须由完整的两位十六进制字节组成",
        invalidUuidCount: "数量必须是 1 到 1000 的整数",
        noSecureRandom: "当前环境不支持安全随机数"
    },
    "en-US": {
        loneSurrogateUtf8: "Input contains an unpaired Unicode surrogate and cannot be UTF-8 encoded",
        invalidUrlEncoding: "Invalid URL encoding: % must be followed by two hex digits forming valid UTF-8",
        invalidUnicodeSeq: "Please enter complete \\uXXXX escape sequences",
        loneSurrogatePair: "Unpaired surrogate: characters like Emoji require a consecutive high and low \\uXXXX pair",
        invalidHexBytes: "Hex input must consist of complete two-digit hex bytes",
        invalidUuidCount: "Count must be an integer between 1 and 1000",
        noSecureRandom: "Secure random generation is not supported in this environment"
    }
};
function codecStrings() {
    const locale = getLocale();
    return CODEC_MESSAGES[locale] ?? CODEC_MESSAGES["en-US"];
}
export function encodeText(text, mode) {
    if (mode !== "unicode" && hasLoneSurrogate(text))
        throw new Error(codecStrings().loneSurrogateUtf8);
    if (mode === "url")
        return encodeURIComponent(text);
    if (mode === "hex")
        return [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return text.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}
/** 不成对的 UTF-16 代理项：不是合法的 Unicode 文本，复制出去会变成乱码或被替换为 U+FFFD */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function hasLoneSurrogate(text) {
    return LONE_SURROGATE.test(text);
}
export function decodeText(text, mode) {
    const s = codecStrings();
    if (mode === "url") {
        try {
            return decodeURIComponent(text);
        }
        catch {
            throw new Error(s.invalidUrlEncoding);
        }
    }
    if (mode === "unicode") {
        if (!/^(?:\\u[0-9a-f]{4})*$/i.test(text))
            throw new Error(s.invalidUnicodeSeq);
        const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        if (hasLoneSurrogate(decoded))
            throw new Error(s.loneSurrogatePair);
        return decoded;
    }
    const compact = text.replace(/\s/g, "");
    if (!/^(?:[0-9a-f]{2})*$/i.test(compact))
        throw new Error(s.invalidHexBytes);
    const bytes = new Uint8Array(compact.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function generateUuids(input) {
    const s = codecStrings();
    if (!/^\d+$/.test(input.trim()))
        throw new Error(s.invalidUuidCount);
    const count = Number(input.trim());
    if (count < 1 || count > 1000)
        throw new Error(s.invalidUuidCount);
    if (!globalThis.crypto?.getRandomValues)
        throw new Error(s.noSecureRandom);
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(count * 16));
    return Array.from({ length: count }, (_, index) => {
        const uuid = bytes.subarray(index * 16, index * 16 + 16);
        uuid[6] = (uuid[6] & 0x0f) | 0x40;
        uuid[8] = (uuid[8] & 0x3f) | 0x80;
        const hex = [...uuid].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
}
