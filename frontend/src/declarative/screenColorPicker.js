import { t } from "@/i18n";

/** 宿主提供交互式取色；必须在用户点击或按键时调用，取消时不返回颜色。 */
export function createScreenColorPicker(getEyeDropper = () => globalThis.EyeDropper) {
  let active = null;
  return {
    async pick() {
      if (active) throw new Error(t("declarative.colorPicker.inProgress"));
      const EyeDropper = getEyeDropper();
      if (typeof EyeDropper !== "function") throw new Error(t("declarative.colorPicker.unsupported"));
      const controller = new AbortController();
      active = controller;
      try {
        const result = await new EyeDropper().open({ signal: controller.signal });
        if (typeof result?.sRGBHex !== "string" || !/^#[0-9a-f]{6}$/i.test(result.sRGBHex)) {
          throw new Error(t("declarative.colorPicker.invalidColor"));
        }
        return { hex: result.sRGBHex.toUpperCase() };
      } finally {
        if (active === controller) active = null;
      }
    },
    cancel() { active?.abort(); }
  };
}
