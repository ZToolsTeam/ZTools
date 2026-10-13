import { Toast as ToastNamespace } from "../constants/toast.js";
import { getDeclarativeBridge } from "./bridge.js";
export class ToastHandle {
    _id;
    _title;
    _message;
    _style;
    _hidden = false;
    _bridgeHandle;
    constructor(options) {
        this._id = "toast_" + Math.random().toString(36).slice(2, 9);
        this._title = options.title;
        this._message = options.message;
        this._style = options.style;
        const bridge = getDeclarativeBridge();
        if (bridge?.showToast) {
            this._bridgeHandle = bridge.showToast(options);
        }
    }
    get id() {
        return this._id;
    }
    get title() {
        return this._title;
    }
    set title(val) {
        this._title = val;
        this._bridgeHandle?.update({ title: val });
    }
    get message() {
        return this._message;
    }
    set message(val) {
        this._message = val;
        this._bridgeHandle?.update({ message: val });
    }
    get style() {
        return this._style;
    }
    set style(val) {
        this._style = val;
        this._bridgeHandle?.update({ style: val });
    }
    async hide() {
        if (this._hidden)
            return;
        this._hidden = true;
        this._bridgeHandle?.hide();
    }
}
/**
 * 弹出 Toast 提示
 */
export async function showToast(optionsOrStyle, title, message) {
    let opts;
    if (typeof optionsOrStyle === "string") {
        opts = {
            style: optionsOrStyle,
            title: title || "",
            message
        };
    }
    else {
        opts = optionsOrStyle;
    }
    const handle = new ToastHandle(opts);
    return handle;
}
export { ToastNamespace as Toast };
