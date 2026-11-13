import { setDeclarativeBridge } from "@ztools/declarative-ui";
import { getHostMethods } from "./hostMethods.js";

/**
 * 校验要写入剪贴板 / 粘贴的文本：只接受字符串或数字，空内容直接报错（不能提示“已复制”却什么也没写）。
 */
export function assertClipboardText(content) {
  if (typeof content === "number" && Number.isFinite(content)) return String(content);
  if (typeof content !== "string") {
    throw Object.assign(new Error("要复制的内容不是文本"), { code: "INVALID_PARAMS" });
  }
  if (content.length === 0) {
    throw Object.assign(new Error("没有可复制的内容"), { code: "EMPTY_CONTENT" });
  }
  return content;
}

/** 读剪贴板失败时返回空文本（与页面 Bridge 一直以来的行为一致） */
async function readTextOrEmpty(callPromise) {
  try {
    const res = await callPromise;
    if (res && typeof res === "object") {
      if (res.ok === false) return "";
      if ("success" in res && "data" in res) return res.success ? res.data : "";
    }
    return res ?? "";
  } catch (err) {
    console.warn("[DeclarativeStack] IPC 调用失败:", err);
    return "";
  }
}

/** 插件剪贴板的宿主实现：页面 Bridge 和无界面命令共用（宿主调用失败时 getHostMethods 会抛错） */
export function createHostClipboardBridge(getMethods = getHostMethods) {
  return {
    // 写剪贴板失败（宿主拒绝、超过上限、系统剪贴板被占用）必须抛给插件，插件才不会提示“已复制”
    copyToClipboard: async (text) => {
      const content = assertClipboardText(text);
      const methods = getMethods();
      if (methods?.clipboard_copy_text) {
        await methods.clipboard_copy_text({ text: content });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        return;
      }
      throw Object.assign(new Error("当前环境不支持写入剪贴板"), { code: "NOT_SUPPORTED" });
    },
    clearClipboard: async () => {
      const methods = getMethods();
      if (methods?.clipboard_clear) {
        await methods.clipboard_clear({});
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText("");
        return;
      }
      throw Object.assign(new Error("当前环境不支持清空剪贴板"), { code: "NOT_SUPPORTED" });
    },
    readClipboardText: async () => {
      const methods = getMethods();
      if (methods?.clipboard_read_text) {
        const res = await readTextOrEmpty(methods.clipboard_read_text({}));
        return typeof res === "string" ? res : String(res?.text ?? "");
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return "";
    },
    readClipboardFiles: async () => {
      const methods = getMethods();
      if (methods?.clipboard_read_files) {
        try {
          const res = await methods.clipboard_read_files({});
          const data = res && typeof res === "object" && "data" in res ? res.data : res;
          return Array.isArray(data?.files) ? data.files : Array.isArray(data) ? data : [];
        } catch (err) {
          console.warn("[DeclarativeStack] clipboard_read_files 调用失败:", err);
          return [];
        }
      }
      return [];
    },
    readClipboardImage: async () => {
      const methods = getMethods();
      if (methods?.clipboard_read_image) {
        try {
          const res = await methods.clipboard_read_image({});
          const data = res && typeof res === "object" && "data" in res ? res.data : res;
          if (!data || typeof data !== "object") return null;
          if (!data.useTempFile && !data.image) return null;
          return data;
        } catch (err) {
          console.warn("[DeclarativeStack] clipboard_read_image 调用失败:", err);
          return null;
        }
      }
      return null;
    },
    pasteToActive: async (text) => {
      const methods = getMethods();
      if (methods?.clipboard_hide_and_paste_text) {
        // 粘贴失败（如 macOS 未授权辅助功能）必须抛给插件，不能吞掉后让插件提示“已粘贴”
        await methods.clipboard_hide_and_paste_text({ text: String(text) });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(text));
        throw Object.assign(new Error("当前宿主不支持自动粘贴，内容已复制，请手动粘贴"), { code: "NOT_SUPPORTED" });
      }
      throw Object.assign(new Error("当前宿主不支持自动粘贴"), { code: "NOT_SUPPORTED" });
    }
  };
}

let pageBridgeInstalled = false;

/** 页面注册了完整 Bridge（含剪贴板）后调用，之后无界面命令不再覆盖它 */
export function markPageBridgeInstalled() {
  pageBridgeInstalled = true;
}

/**
 * 无界面命令不挂载页面；本窗口还没打开过插件页面时 SDK 没有 Bridge，
 * Clipboard.copy 会退回内存剪贴板并“成功”返回，插件随即提示“已复制”而系统剪贴板没变。
 * 执行前补上宿主剪贴板 Bridge；页面已注册完整 Bridge 时不覆盖。
 */
export function ensureHostBridge() {
  if (pageBridgeInstalled) return;
  setDeclarativeBridge(createHostClipboardBridge());
}
