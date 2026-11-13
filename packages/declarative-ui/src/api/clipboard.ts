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
   * 复制并向原输入位置发送粘贴请求。返回只表示按键已发送，不代表目标应用已接收文本。
   * 需要出队或删除内容的插件应保留可恢复记录；发送结果未确认时不要自动重试。
   */
  async paste(content: string | number | { text?: string }): Promise<void> {
    const text = typeof content === "object" && content !== null ? content.text ?? "" : String(content);
    const bridge = getDeclarativeBridge();
    if (bridge?.pasteToActive) {
      // 宿主负责复制与粘贴的完整操作；提前复制会覆盖另一窗口仍在粘贴的内容。
      await bridge.pasteToActive(text);
      memoryClipboard = text;
      return;
    }
    await this.copy(text);
    // 宿主不支持粘贴到前台应用：内容已复制，但不能让插件以为已经粘贴。
    throw Object.assign(new Error("当前宿主不支持粘贴到前台应用，内容已复制到剪贴板"), { code: "NOT_SUPPORTED" });
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
   * 读取剪贴板中的文件路径列表（经宿主安全校验与授权后返回）
   */
  async readFiles(): Promise<string[]> {
    const bridge = getDeclarativeBridge();
    if (bridge?.readClipboardFiles) {
      const files = await bridge.readClipboardFiles();
      return Array.isArray(files) ? files.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
    }
    return [];
  },

  /**
   * 读取剪贴板中的图片（支持 Base64 dataUrl 或宿主生成的临时缓存文件路径）
   */
  async readImage(): Promise<{
    image?: string;
    useTempFile?: boolean;
    tempFile?: string;
    size?: number;
    width?: number;
    height?: number;
  } | null> {
    const bridge = getDeclarativeBridge();
    if (bridge?.readClipboardImage) {
      return await bridge.readClipboardImage();
    }
    return null;
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
