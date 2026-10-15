import { getDeclarativeBridge } from "./bridge.js";
import { showToast } from "./toast.js";
import { ToastStyle } from "../constants/toast.js";

export interface ShowHUDOptions {
  icon?: string;
  durationMs?: number;
}

/**
 * 弹出 HUD 简短提示
 */
export async function showHUD(title: string, options?: ShowHUDOptions | string): Promise<void> {
  const icon = typeof options === 'string' ? options : options?.icon;
  const bridge = getDeclarativeBridge();
  if (bridge?.showHUD) {
    await bridge.showHUD(title, icon);
    return;
  }

  // 默认 fallback 为自动消失的 Success Toast
  const toast = await showToast(ToastStyle.Success, title);
  setTimeout(() => {
    toast.hide();
  }, 1500);
}
