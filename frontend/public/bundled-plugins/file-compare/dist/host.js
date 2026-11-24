import { t } from "./i18n.js";
import { resolveErrorMessage } from './error-i18n.js';
/**
 * 调用 ZTools 宿主能力（选择文件、读取文本文件）
 */
let seq = 0;
async function callHost(method, params = {}) {
    const root = globalThis;
    const methods = root.window?.__ztoolsElectron?.transport?.methods ?? root.__ztoolsElectron?.transport?.methods;
    const fn = methods?.[method];
    if (typeof fn !== "function")
        throw new Error(t("hostMethodUnsupported", { method }));
    seq = (seq + 1) % 1_000_000;
    const envelope = await fn({ messageId: `cmp_${Date.now()}_${seq}`, params });
    if (!envelope || typeof envelope !== "object")
        throw new Error(t("hostUnrecognizedResult"));
    if (!envelope.success)
        throw new Error(resolveErrorMessage(envelope.error, t("hostMethodFailed", { method })));
    return envelope.data;
}
/** 单个文本文件读取上限 */
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
/**
 * 按指定路径校验文件大小并以 UTF-8 读取文本
 */
export async function readTextFileByPath(filePath) {
    const sizeRes = await callHost("filesystem_get_file_size", { path: filePath });
    if (Number(sizeRes?.size) > MAX_TEXT_FILE_BYTES)
        throw new Error(t("fileTooLarge"));
    let read;
    try {
        read = await callHost("filesystem_read_file", { path: filePath, encoding: "utf8" });
    }
    catch (err) {
        const errRec = err && typeof err === "object" ? err : null;
        const code = typeof errRec?.code === "string" ? errRec.code : "";
        const hostCode = typeof errRec?.details?.hostCode === "string" ? errRec.details.hostCode : "";
        const msg = err instanceof Error ? err.message : String(err ?? "");
        const isEncodingErr = code === "INVALID_UTF8" ||
            hostCode === "INVALID_UTF8" ||
            /utf|decode/i.test(msg) ||
            // i18n-allow: legacy host fallback
            (!code && !hostCode && /编码/.test(msg));
        throw new Error(isEncodingErr ? t("fileNotUtf8") : msg || t("readFileFailed"));
    }
    return { name: filePath.split(/[\\/]/).pop() || filePath, text: read.content };
}
/**
 * 弹出系统选文件窗口并按 UTF-8 读取；用户取消时返回 null
 */
export async function pickTextFile(title) {
    const picked = await callHost("window_show_open_dialog", { title, properties: ["openFile"] });
    if (!picked || picked.canceled || !picked.filePath)
        return null;
    return readTextFileByPath(picked.filePath);
}
/**
 * 解析宿主拖拽事件 (plugin_files_dropped) 载荷中的文件路径列表
 */
export function extractDroppedFilePaths(envelopeOrPayload) {
    const raw = envelopeOrPayload && typeof envelopeOrPayload === "object"
        ? envelopeOrPayload
        : {};
    const list = Array.isArray(raw.payload?.files) ? raw.payload.files : Array.isArray(raw.files) ? raw.files : [];
    return list
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
}
