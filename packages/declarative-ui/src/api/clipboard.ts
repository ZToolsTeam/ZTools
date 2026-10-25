import { getDeclarativeBridge } from "./bridge.js";

let memoryClipboard = "";

export const Clipboard = {
  /**
   * 复制内容到剪贴板。宿主写入失败（内容为空、超过上限、系统剪贴板被占用等）时抛出错误，
   * 调用方不要在失败时提示“已复制”。
   */
  async copy(content: string | number | { text?: string }): Promise<void> {
    const text = typeof content === "object" && content !== null ? content.text ?? "" : String(content);

    const bridge = getDeclarativeBridge();
    if (bridge?.copyToClipboard) {
      // 失败直接上抛，不更新内存剪贴板
      await bridge.copyToClipboard(text);
      memoryClipboard = text;
      return;
    }

    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        await navigator.clipboard.writeText(text);
        memoryClipboard = text;
        return;
      } catch (err) {
        console.warn("[Clipboard] navigator.clipboard.writeText 失败，回退内存剪贴板:", err);
      }
    }

    memoryClipboard = text;
  },

  /**
   * 复制并直接粘贴到当前前台活跃应用程序 (Raycast 原生标准能力)
   */
  async paste(content: string | number | { text?: string }): Promise<void> {
    const text = typeof content === "object" && content !== null ? content.text ?? "" : String(content);
    await this.copy(text);

    const bridge = getDeclarativeBridge();
    if (bridge?.pasteToActive) {
      await bridge.pasteToActive(text);
      return;
    }
    if (bridge) {
      // 宿主不支持粘贴到前台应用：内容已复制，但不能让插件以为已经粘贴
      throw Object.assign(new Error("当前宿主不支持粘贴到前台应用，内容已复制到剪贴板"), { code: "NOT_SUPPORTED" });
    }
  },

  /**
   * 读取剪贴板文本
   */
  async readText(): Promise<string> {
    const bridge = getDeclarativeBridge();
    if (bridge?.readClipboardText) {
      return await bridge.readClipboardText();
    }

    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.readText === "function"
    ) {
      try {
        return await navigator.clipboard.readText();
      } catch (err) {
        console.warn("[Clipboard] navigator.clipboard.readText 失败，回退内存剪贴板:", err);
      }
    }

    return memoryClipboard;
  },

  /**
   * 清空剪贴板
   */
  async clear(): Promise<void> {
    const bridge = getDeclarativeBridge();
    if (bridge?.clearClipboard) {
      await bridge.clearClipboard();
      memoryClipboard = "";
      return;
    }
    if (bridge?.copyToClipboard) {
      // 旧宿主没有 clearClipboard：沿用写入空串
      await bridge.copyToClipboard("");
      memoryClipboard = "";
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText("");
      } catch (err) {
        console.warn("[Clipboard] 清空系统剪贴板失败，回退内存剪贴板:", err);
      }
    }
    memoryClipboard = "";
  }
};
