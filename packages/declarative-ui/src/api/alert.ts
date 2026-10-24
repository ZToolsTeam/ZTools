import { getDeclarativeBridge } from "./bridge.js";

export interface ConfirmAlertOptions {
  title: string;
  message?: string;
  primaryActionTitle?: string;
  dismissActionTitle?: string;
  primaryAction?: {
    title: string;
    style?: "default" | "destructive";
    onAction?: () => void;
  };
  dismissAction?: {
    title?: string;
    onAction?: () => void;
  };
}

/**
 * 弹出确认警告对话框，返回用户是否点击了 primaryAction
 */
export async function confirmAlert(options: ConfirmAlertOptions): Promise<boolean> {
  const normalized: ConfirmAlertOptions = {
    ...options,
    primaryAction:
      options.primaryAction ||
      (options.primaryActionTitle ? { title: options.primaryActionTitle, style: "destructive" } : undefined),
    dismissAction:
      options.dismissAction ||
      (options.dismissActionTitle ? { title: options.dismissActionTitle } : undefined)
  };
  const bridge = getDeclarativeBridge();
  if (bridge?.confirmAlert) {
    return await bridge.confirmAlert(normalized);
  }

  // 没有宿主就无法让用户确认：按取消处理。不弹系统原生对话框，也不擅自替用户确认（多为删除、清空等危险操作）
  options.dismissAction?.onAction?.();
  return false;
}
