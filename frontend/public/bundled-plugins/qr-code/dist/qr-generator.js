/**
 * 二维码生成：标准编码（qr-encoder）→ SVG 预览 / PNG 图片，以及生成历史的持久化
 */
import { LocalStorage, Icon } from "@ztools/declarative-ui";
import { encodeQr } from "./qr-encoder.js";
const QR_STORAGE_KEY = "ztools_qr_history";
/** 二维码四周的静区宽度（模块数），标准要求至少 4 */
const QUIET_ZONE = 4;
/**
 * 识别二维码内容的业务类型
 */
export function detectQrContentType(content) {
    const trimmed = (content || "").trim();
    if (/^https?:\/\//i.test(trimmed))
        return { type: "url", label: "网址", icon: Icon.Globe };
    if (/^WIFI:/i.test(trimmed) && /(?:^|;|:)S:[^;]+/i.test(trimmed))
        return { type: "wifi", label: "Wi-Fi", icon: Icon.Shield };
    if (/^mailto:/i.test(trimmed) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
        return { type: "email", label: "邮箱", icon: Icon.Pencil };
    if (/^tel:/i.test(trimmed))
        return { type: "tel", label: "电话", icon: Icon.Checkmark };
    if (/^smsto:/i.test(trimmed))
        return { type: "sms", label: "短信", icon: Icon.Text };
    return { type: "text", label: "文本", icon: Icon.Document };
}
/**
 * 生成 Wi-Fi 连接二维码内容（ZXing 约定格式），对 \ ; , : " 做转义
 */
export function buildWifiPayload(ssid, password, security, hidden = false) {
    const esc = (v) => v.replace(/([\\;,:"])/g, "\\$1");
    if (!ssid)
        throw new Error("Wi-Fi 名称不能为空");
    if (security !== "nopass" && !password)
        throw new Error("请填写 Wi-Fi 密码，或把加密方式选为「无密码」");
    return `WIFI:T:${security};S:${esc(ssid)};${security === "nopass" ? "" : `P:${esc(password)};`}${hidden ? "H:true;" : ""};`;
}
export function buildQrMatrix(text, level = "M") {
    return encodeQr(text, level);
}
/**
 * 生成黑白 SVG（深色模块合并为一条 path，体积小、任意缩放不失真）
 */
export function generateQrSvg(text, level = "M") {
    const qr = encodeQr(text, level);
    const dim = qr.size + QUIET_ZONE * 2;
    let d = "";
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.modules[y][x])
                d += `M${x + QUIET_ZONE},${y + QUIET_ZONE}h1v1h-1z`;
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * 8}" height="${dim * 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#FFFFFF"/><path d="${d}" fill="#000000"/></svg>`;
    return { svg, dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, qr };
}
// ---------- PNG 编码（灰度 8 位，zlib 使用不压缩的存储块，避免依赖压缩库） ----------
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function zlibStored(raw) {
    const blocks = Math.max(1, Math.ceil(raw.length / 65535));
    const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
    let o = 0;
    out[o++] = 0x78;
    out[o++] = 0x01;
    for (let i = 0; i < blocks; i++) {
        const start = i * 65535;
        const len = Math.min(65535, raw.length - start);
        out[o++] = i === blocks - 1 ? 1 : 0;
        out[o++] = len & 0xff;
        out[o++] = len >>> 8;
        out[o++] = ~len & 0xff;
        out[o++] = (~len >>> 8) & 0xff;
        out.set(raw.subarray(start, start + len), o);
        o += len;
    }
    let a = 1, b = 0;
    for (let i = 0; i < raw.length; i++) {
        a = (a + raw[i]) % 65521;
        b = (b + a) % 65521;
    }
    const adler = ((b << 16) | a) >>> 0;
    out[o++] = adler >>> 24;
    out[o++] = (adler >>> 16) & 0xff;
    out[o++] = (adler >>> 8) & 0xff;
    out[o++] = adler & 0xff;
    return out.subarray(0, o);
}
function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++)
        out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
/**
 * 生成 PNG 图片的 Base64（用于复制到剪贴板、另存为文件）
 */
export function generateQrPngBase64(text, level = "M", scale = 10) {
    const qr = encodeQr(text, level);
    const dim = (qr.size + QUIET_ZONE * 2) * scale;
    const raw = new Uint8Array((dim + 1) * dim);
    for (let y = 0; y < dim; y++) {
        raw[y * (dim + 1)] = 0;
        const my = Math.floor(y / scale) - QUIET_ZONE;
        for (let x = 0; x < dim; x++) {
            const mx = Math.floor(x / scale) - QUIET_ZONE;
            const dark = my >= 0 && my < qr.size && mx >= 0 && mx < qr.size && qr.modules[my][mx];
            raw[y * (dim + 1) + 1 + x] = dark ? 0 : 255;
        }
    }
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, dim);
    hv.setUint32(4, dim);
    ihdr[8] = 8; // 位深
    ihdr[9] = 0; // 灰度
    const parts = [
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlibStored(raw)),
        pngChunk("IEND", new Uint8Array(0))
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const png = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
        png.set(p, o);
        o += p.length;
    }
    let bin = "";
    for (let i = 0; i < png.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, Array.from(png.subarray(i, i + 0x8000)));
    return btoa(bin);
}
// ---------- 生成历史 ----------
function sanitizeHistory(list) {
    if (list === undefined)
        return [];
    if (!Array.isArray(list) || list.some(it => !it || typeof it.id !== "string" || !it.id || typeof it.title !== "string" ||
        typeof it.content !== "string" || !it.content || typeof it.createdAt !== "string" || !["L", "M", "Q", "H"].includes(it.level) ||
        (it.favorite !== undefined && typeof it.favorite !== "boolean")) || new Set(list.map(it => it.id)).size !== list.length) {
        throw new Error("二维码历史数据损坏，原数据已保留，请先恢复数据后重试");
    }
    return list;
}
async function changeQrHistory(update) {
    if (typeof LocalStorage.updateItem !== "function")
        throw new Error("请升级 ZTools 以安全保存二维码历史");
    return LocalStorage.updateItem(QR_STORAGE_KEY, raw => update(sanitizeHistory(raw)));
}
/** 读取历史；存储读失败时抛错，写入前必须用这个，避免把空列表覆盖回去 */
export async function getQrHistory() {
    return sanitizeHistory(await LocalStorage.getItem(QR_STORAGE_KEY));
}
export async function saveQrItem(item) {
    sanitizeHistory([item]);
    return changeQrHistory(current => {
        const previous = current.find(it => it.content === item.content);
        const merged = previous ? { ...item, favorite: previous.favorite } : item;
        return [merged, ...current.filter(it => it.id !== item.id && it.content !== item.content)].slice(0, 100);
    });
}
export async function toggleFavoriteQrItem(id) {
    return changeQrHistory(current => current.map(it => it.id === id ? { ...it, favorite: !it.favorite } : it));
}
export async function deleteQrItem(id) {
    return changeQrHistory(current => current.filter(it => it.id !== id));
}
export async function clearQrHistory() {
    await changeQrHistory(() => []);
}
