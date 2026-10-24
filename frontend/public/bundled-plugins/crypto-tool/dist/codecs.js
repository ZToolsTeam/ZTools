export function encodeText(text, mode) {
    if (mode === "url")
        return encodeURIComponent(text);
    if (mode === "hex")
        return [...new TextEncoder().encode(text)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return text.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
}
export function decodeText(text, mode) {
    if (mode === "url")
        return decodeURIComponent(text);
    if (mode === "unicode") {
        if (!/^(?:\\u[0-9a-f]{4})*$/i.test(text))
            throw new Error("请输入完整的 \\uXXXX 序列");
        return text.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    const compact = text.replace(/\s/g, "");
    if (!/^(?:[0-9a-f]{2})*$/i.test(compact))
        throw new Error("Hex 必须由完整的两位十六进制字节组成");
    const bytes = new Uint8Array(compact.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function generateUuids(input) {
    if (!/^\d+$/.test(input.trim()))
        throw new Error("数量必须是 1 到 1000 的整数");
    const count = Number(input.trim());
    if (count < 1 || count > 1000)
        throw new Error("数量必须是 1 到 1000 的整数");
    if (!globalThis.crypto?.getRandomValues)
        throw new Error("当前环境不支持安全随机数");
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(count * 16));
    return Array.from({ length: count }, (_, index) => {
        const uuid = bytes.subarray(index * 16, index * 16 + 16);
        uuid[6] = (uuid[6] & 0x0f) | 0x40;
        uuid[8] = (uuid[8] & 0x3f) | 0x80;
        const hex = [...uuid].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
}
