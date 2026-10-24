/**
 * 调用 ZTools 宿主能力（选择文件、读文件、读剪贴板文件 / 图片）
 *
 * 宿主通过 preload 暴露 `__ztoolsElectron.transport.methods[method]({ messageId, params })`，
 * 返回 `{ success, data | error }` 信封。宿主不存在（如单元测试）时抛出 HOST_UNAVAILABLE。
 */
let seq = 0;
export class HostError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export async function callHost(method, params = {}) {
    const root = globalThis;
    const methods = root.window?.__ztoolsElectron?.transport?.methods ?? root.__ztoolsElectron?.transport?.methods;
    const fn = methods?.[method];
    if (typeof fn !== "function")
        throw new HostError("HOST_UNAVAILABLE", `当前环境不支持 ${method}`);
    seq = (seq + 1) % 1_000_000;
    const envelope = await fn({ messageId: `b64_${Date.now()}_${seq}`, params });
    if (!envelope || typeof envelope !== "object")
        throw new HostError("HOST_RESPONSE_INVALID", "宿主返回了无法识别的结果");
    if (!envelope.success)
        throw new HostError(envelope.error?.code || "HOST_FAILED", envelope.error?.message || `${method} 调用失败`);
    return envelope.data;
}
/** 单张图片读取上限：宿主 IPC 单次最多 16 MiB，Base64 会膨胀到 4/3，这里留出余量 */
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
/** 保存转换后的文本；文件选择器授予当前会话写入权限，取消不创建文件。 */
export async function saveEncodedText(content, defaultName) {
    const picked = await callHost("window_show_save_dialog", {
        title: "保存 Base64 转换结果", defaultName, filters: "文本文件|txt"
    });
    if (!picked || picked.canceled || !picked.filePath)
        return null;
    await callHost("filesystem_write_file", { path: picked.filePath, content, encoding: "utf8" });
    return picked.filePath;
}
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const IMAGE_FILTER = `图片|${IMAGE_EXTENSIONS.join(";")}`;
const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function baseName(filePath) {
    return filePath.split(/[\\/]/).pop() || filePath;
}
export function hasImageExtension(filePath) {
    const ext = filePath.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
    return Boolean(ext && IMAGE_EXTENSIONS.includes(ext));
}
/** 读取一个图片文件的原始字节（Base64），先检查大小，避免把超大文件整段读进内存 */
async function readImageFile(filePath) {
    const size = await callHost("filesystem_get_file_size", { path: filePath });
    const bytes = typeof size === "number" ? size : Number(size?.size ?? 0);
    if (bytes > MAX_IMAGE_FILE_BYTES) {
        throw new HostError("FILE_TOO_LARGE", `图片超过 10 MB（${formatMb(bytes)}），请先压缩`);
    }
    const read = await callHost("filesystem_read_file", { path: filePath, encoding: "base64" });
    return { name: baseName(filePath), base64: read.content };
}
/**
 * 弹出系统选文件窗口并读取图片；用户取消时返回 null
 */
export async function pickImageFile() {
    const picked = await callHost("window_show_open_dialog", {
        title: "选择要转成 Base64 的图片",
        filters: IMAGE_FILTER,
        properties: ["openFile"]
    });
    if (!picked || picked.canceled || !picked.filePath)
        return null;
    return readImageFile(picked.filePath);
}
/**
 * 读取剪贴板里复制的图片文件（访达 / 资源管理器里 ⌘C 的文件），保留原文件字节与文件名。
 * 剪贴板里没有文件、或宿主读不了文件剪贴板时返回 null，由调用方改读剪贴板图片；
 * 有文件但都不是支持的图片时抛出 NOT_IMAGE_FILE。
 */
export async function readClipboardImageFile() {
    let files;
    try {
        const res = await callHost("clipboard_read_files", {});
        files = Array.isArray(res?.files) ? res.files.filter((f) => typeof f === "string" && f.length > 0) : [];
    }
    catch {
        // 文件剪贴板不可用（旧宿主、开发版缺少原生助手等）不影响读取截图
        return null;
    }
    if (files.length === 0)
        return null;
    const image = files.find(hasImageExtension);
    if (!image) {
        throw new HostError("NOT_IMAGE_FILE", `复制的文件不是支持的图片（${baseName(files[0])}），仅支持 PNG、JPEG、GIF、WebP 与 SVG`);
    }
    return readImageFile(image);
}
/**
 * 读取剪贴板里的图片（截图、复制的图片）；剪贴板没有图片时返回 null
 */
export async function readClipboardImage() {
    const res = await callHost("clipboard_read_image", {});
    if (res?.useTempFile && typeof res.tempFile === "string") {
        const bytes = Number(res.size);
        if (bytes > MAX_IMAGE_FILE_BYTES) {
            throw new HostError("FILE_TOO_LARGE", `剪贴板里的图片超过 10 MB（${formatMb(bytes)}），请先压缩`);
        }
        const read = await callHost("filesystem_read_file", { path: res.tempFile, encoding: "base64" });
        return { name: "剪贴板图片.png", base64: read.content };
    }
    const image = typeof res?.image === "string" ? res.image : "";
    if (!image)
        return null;
    const comma = image.indexOf(",");
    return { name: "剪贴板图片.png", base64: comma >= 0 ? image.slice(comma + 1) : image };
}
