import { ToastOptions, ToastStyle, Toast as ToastNamespace } from "../constants/toast.js";
import { getDeclarativeBridge } from "./bridge.js";

export class ToastHandle {
  private _id: string;
  private _title: string;
  private _message?: string;
  private _style: ToastStyle;
  private _hidden = false;
  private _bridgeHandle?: {
    id: string;
    update: (options: Partial<ToastOptions>) => void;
    hide: () => void;
  };

  constructor(options: ToastOptions) {
    this._id = "toast_" + Math.random().toString(36).slice(2, 9);
    this._title = options.title;
    this._message = options.message;
    this._style = options.style;

    const bridge = getDeclarativeBridge();
    if (bridge?.showToast) {
      this._bridgeHandle = bridge.showToast(options);
    }
  }

  get id(): string {
    return this._id;
  }

  get title(): string {
    return this._title;
  }

  set title(val: string) {
    this._title = val;
    this._bridgeHandle?.update({ title: val });
  }

  get message(): string | undefined {
    return this._message;
  }

  set message(val: string | undefined) {
    this._message = val;
    this._bridgeHandle?.update({ message: val });
  }

  get style(): ToastStyle {
    return this._style;
  }

  set style(val: ToastStyle) {
    this._style = val;
    this._bridgeHandle?.update({ style: val });
  }

  async hide(): Promise<void> {
    if (this._hidden) return;
    this._hidden = true;
    this._bridgeHandle?.hide();
  }
}

/**
 * 弹出 Toast 提示
 */
export async function showToast(
  optionsOrStyle: ToastOptions | ToastStyle,
  title?: string,
  message?: string
): Promise<ToastHandle> {
  let opts: ToastOptions;
  if (typeof optionsOrStyle === "string") {
    opts = {
      style: optionsOrStyle,
      title: title || "",
      message
    };
  } else {
    opts = optionsOrStyle;
  }

  const handle = new ToastHandle(opts);
  return handle;
}

export { ToastNamespace as Toast };
