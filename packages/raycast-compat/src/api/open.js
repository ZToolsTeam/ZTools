import { getDeclarativeBridge } from "./bridge.js";
/**
 * 打开外部链接或应用
 */
export async function open(target) {
    const bridge = getDeclarativeBridge();
    if (bridge?.openExternal) {
        await bridge.openExternal(target);
        return;
    }
    if (typeof globalThis.window !== "undefined") {
        const win = globalThis.window;
        if (win.ztools?.shell?.openExternal) {
            await win.ztools.shell.openExternal(target);
            return;
        }
        if (win.open) {
            win.open(target, "_blank");
            return;
        }
    }
    // Node fallback
    console.log(`[RaycastCompat] open called with: ${target}`);
}
