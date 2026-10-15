import { getDeclarativeBridge } from "./bridge.js";
/**
 * 弹出确认警告对话框，返回用户是否点击了 primaryAction
 */
export async function confirmAlert(options) {
    const bridge = getDeclarativeBridge();
    if (bridge?.confirmAlert) {
        return await bridge.confirmAlert(options);
    }
    if (typeof globalThis.window !== "undefined" && typeof globalThis.window.confirm === "function") {
        const text = options.message ? `${options.title}\n\n${options.message}` : options.title;
        const ok = globalThis.window.confirm(text);
        if (ok) {
            options.primaryAction?.onAction?.();
        }
        else {
            options.dismissAction?.onAction?.();
        }
        return ok;
    }
    // 默认测试 fallback
    options.primaryAction?.onAction?.();
    return true;
}
