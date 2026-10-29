/** 宿主提供交互式取色；必须在用户点击或按键时调用，取消时不返回颜色。 */
export function createScreenColorPicker(getEyeDropper = () => globalThis.EyeDropper) {
  let active = null;
  return {
    async pick() {
      if (active) throw new Error("屏幕取色正在进行，请先完成或按 Esc 取消");
      const EyeDropper = getEyeDropper();
      if (typeof EyeDropper !== "function") throw new Error("当前客户端不支持交互式屏幕取色");
      const controller = new AbortController();
      active = controller;
      try {
        const result = await new EyeDropper().open({ signal: controller.signal });
        if (typeof result?.sRGBHex !== "string" || !/^#[0-9a-f]{6}$/i.test(result.sRGBHex)) {
          throw new Error("屏幕取色未返回有效颜色");
        }
        return { hex: result.sRGBHex.toUpperCase() };
      } finally {
        if (active === controller) active = null;
      }
    },
    cancel() { active?.abort(); }
  };
}
