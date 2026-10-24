/**
 * 调用 ZTools 宿主能力（复制图片到剪贴板、另存为文件）
 */
let seq = 0;
async function callHost(method, params = {}) {
    const methods = globalThis.window?.__ztoolsElectron?.transport?.methods ?? globalThis.__ztoolsElectron?.transport?.methods;
    const fn = methods?.[method];
    if (typeof fn !== "function")
        throw new Error(`当前环境不支持 ${method}`);
    seq = (seq + 1) % 1_000_000;
    const envelope = await fn({ messageId: `qr_${Date.now()}_${seq}`, params });
    if (!envelope || typeof envelope !== "object")
        throw new Error("宿主返回了无法识别的结果");
    if (!envelope.success)
        throw new Error(envelope.error?.message || `${method} 调用失败`);
    return envelope.data;
}
export async function copyPngToClipboard(pngBase64) {
    await callHost("clipboard_copy_image", { image: `data:image/png;base64,${pngBase64}` });
}
/** 弹出系统保存窗口并写入 PNG；用户取消时返回 null */
export async function savePngFile(pngBase64, defaultName) {
    const picked = await callHost("window_show_save_dialog", {
        title: "保存二维码图片",
        defaultName,
        filters: "PNG 图片|png"
    });
    if (!picked || picked.canceled || !picked.filePath)
        return null;
    await callHost("filesystem_write_file", { path: picked.filePath, content: pngBase64, encoding: "base64" });
    return picked.filePath;
}
