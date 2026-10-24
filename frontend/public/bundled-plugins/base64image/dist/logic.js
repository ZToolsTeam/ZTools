/**
 * ZTools Base64 图片编解码核心业务逻辑 (纯函数)
 */
export const MAXIMUM_BASE64_BYTES = 16 * 1024 * 1024; // 16 MiB
const MIME_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml"
};
const DATA_URI_REGEX = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i;
export function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
export function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
export function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
export function textToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    return bytesToBase64(bytes);
}
export function detectImageFormat(bytes) {
    if (bytes.length >= 8 &&
        bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71 &&
        bytes[4] === 13 &&
        bytes[5] === 10 &&
        bytes[6] === 26 &&
        bytes[7] === 10) {
        return "png";
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        return "jpg";
    }
    if (bytes.length >= 6) {
        const sig = String.fromCharCode(...bytes.subarray(0, 6));
        if (sig === "GIF87a" || sig === "GIF89a")
            return "gif";
    }
    if (bytes.length >= 12 &&
        String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
        return "webp";
    }
    // 检测 SVG 文本标签
    try {
        if (isSvgSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) {
            return "svg";
        }
    }
    catch {
        // 非 UTF-8 字节不能是 SVG
    }
    return undefined;
}
/** SVG 根元素前允许出现的前导：XML 声明 / 处理指令、注释、DOCTYPE（可带内部子集 [...]） */
const SVG_PROLOG_PART = /(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b[^>[]*(?:\[[\s\S]*?\])?[^>]*>)\s*/iy;
const SVG_ROOT = /<svg[\s/>]/iy;
/**
 * 判断文本是否是 SVG 文档：跳过 BOM、空白、XML 声明、注释与 DOCTYPE 后，以 <svg 根元素开头（忽略大小写）。
 * 选择文件的格式识别与输入框里的 SVG 源码判断共用这一个函数。
 */
export function isSvgSource(text) {
    if (!text)
        return false;
    let pos = 0;
    while (pos < text.length && (text.charCodeAt(pos) === 0xfeff || /\s/.test(text[pos])))
        pos++;
    // 前导部分数量有限，防止异常输入导致长时间循环
    for (let i = 0; i < 64; i++) {
        SVG_PROLOG_PART.lastIndex = pos;
        if (!SVG_PROLOG_PART.test(text))
            break;
        pos = SVG_PROLOG_PART.lastIndex;
    }
    SVG_ROOT.lastIndex = pos;
    return SVG_ROOT.test(text);
}
/**
 * 解析用户输入的 Base64 或 Data URL
 */
export function parseBase64Image(rawInput) {
    const text = (rawInput || "").trim();
    if (!text) {
        return { valid: false, error: "Base64 内容不能为空" };
    }
    if (text.length > MAXIMUM_BASE64_BYTES) {
        return { valid: false, error: `Base64 内容超过 16MiB 上限 (${formatFileSize(text.length)})` };
    }
    // 检查是否包含非 ASCII 字符 (SVG 原始源码输入走专门编码分支)
    if (/[^\u0000-\u007f]/.test(text)) {
        return { valid: false, error: "Base64 编码内容必须仅包含 ASCII 字符" };
    }
    const prefixMatch = text.match(DATA_URI_REGEX);
    if (/^data:/i.test(text) && !prefixMatch) {
        return { valid: false, error: "图片 Data URI 协议头格式不正确，缺少 image/* 前缀" };
    }
    const rawBase64 = prefixMatch ? text.slice(prefixMatch[0].length) : text;
    const cleanBase64 = rawBase64.replace(/[ \t\r\n]/g, "");
    if (!cleanBase64 || cleanBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
        return { valid: false, error: "Base64 字符内容非法或填充位数不正确" };
    }
    let bytes;
    try {
        bytes = base64ToBytes(cleanBase64);
    }
    catch (err) {
        return { valid: false, error: `Base64 解码失败: ${err?.message || "数据损坏"}` };
    }
    const format = detectImageFormat(bytes);
    if (!format) {
        return {
            valid: false,
            error: "未识别出支持的图片格式，仅支持 PNG、JPEG、GIF、WebP 与 SVG"
        };
    }
    const mimeType = MIME_TYPES[format];
    const dataUri = `data:${mimeType};base64,${cleanBase64}`;
    const markdown = `![image](${dataUri})`;
    const html = `<img src="${dataUri}" alt="image" />`;
    const cssBackground = `background-image: url('${dataUri}');`;
    const previewSnippet = cleanBase64.slice(0, 80) + (cleanBase64.length > 80 ? "..." : "");
    return {
        valid: true,
        format,
        mimeType,
        byteLength: bytes.length,
        formattedSize: formatFileSize(bytes.length),
        base64Length: cleanBase64.length,
        encoded: cleanBase64,
        dataUri,
        markdown,
        html,
        cssBackground,
        previewSnippet
    };
}
/**
 * 将 SVG 源码或普通文本转换为 Base64 及 Data URL
 */
export function encodeSvgOrTextToBase64(sourceText) {
    const text = (sourceText || "").trim();
    if (!text) {
        return { valid: false, error: "输入内容不能为空" };
    }
    const isSvg = /<svg[\s/>]/i.test(text);
    const base64 = textToBase64(text);
    const bytes = new TextEncoder().encode(text);
    const mimeType = isSvg ? "image/svg+xml" : "text/plain";
    const dataUri = `data:${mimeType};base64,${base64}`;
    return {
        valid: true,
        format: isSvg ? "svg" : undefined,
        mimeType,
        byteLength: bytes.length,
        formattedSize: formatFileSize(bytes.length),
        base64Length: base64.length,
        encoded: base64,
        dataUri,
        markdown: isSvg ? `![svg](${dataUri})` : `[data](${dataUri})`,
        html: isSvg ? `<img src="${dataUri}" alt="svg" />` : `<a href="${dataUri}">Download</a>`,
        cssBackground: isSvg ? `background-image: url('${dataUri}');` : undefined,
        previewSnippet: base64.slice(0, 80) + (base64.length > 80 ? "..." : "")
    };
}
/** 1x1 绿色透明最小合法 PNG */
export const SAMPLE_PNG_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** 示例 SVG 矢量图标 */
export const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#3b82f6"/><path d="M35 50 L45 60 L65 40" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
