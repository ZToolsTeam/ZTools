import { getDeclarativeBridge } from "./bridge.js";
let memoryClipboard = "";
export const Clipboard = {
    /**
     * 复制内容到剪贴板
     */
    async copy(content) {
        const text = typeof content === "object" && content !== null ? content.text ?? "" : String(content);
        const bridge = getDeclarativeBridge();
        if (bridge?.copyToClipboard) {
            await bridge.copyToClipboard(text);
            memoryClipboard = text;
            return;
        }
        if (typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function") {
            try {
                await navigator.clipboard.writeText(text);
                memoryClipboard = text;
                return;
            }
            catch {
                // fallback to memory
            }
        }
        memoryClipboard = text;
    },
    /**
     * 复制并直接粘贴到当前前台活跃应用程序 (Raycast 原生标准能力)
     */
    async paste(content) {
        const text = typeof content === "object" && content !== null ? content.text ?? "" : String(content);
        await this.copy(text);
        const bridge = getDeclarativeBridge();
        if (bridge?.pasteToActive) {
            await bridge.pasteToActive(text);
            return;
        }
    },
    /**
     * 读取剪贴板文本
     */
    async readText() {
        const bridge = getDeclarativeBridge();
        if (bridge?.readClipboardText) {
            return await bridge.readClipboardText();
        }
        if (typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.readText === "function") {
            try {
                return await navigator.clipboard.readText();
            }
            catch {
                // fallback to memory
            }
        }
        return memoryClipboard;
    },
    /**
     * 清空剪贴板
     */
    async clear() {
        await this.copy("");
    }
};
