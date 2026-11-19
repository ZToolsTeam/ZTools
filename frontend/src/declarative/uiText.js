/**
 * 声明式渲染器共用的文案与快捷键工具：各 Renderer、底栏与动作面板统一从这里取，
 * 避免同一规则散落多份、改一处漏一处。
 */
import { isMacOS } from "@/utils/platform.js";
import { normalizeActionShortcutCombo, resolveActionKeyBindings } from "@/utils/actionKeyBindings.js";

/** 解析动作标题；插件未显式传 title 时按内置动作类型返回规范中文名称 */
export function resolveActionTitle(action, mac = isMacOS()) {
  const explicit = cleanUiText(action?.props?.title);
  if (explicit) return explicit;
  switch (action?.type) {
    case "Action.ShowInFinder":
      return mac ? "在访达中显示" : "在资源管理器中显示";
    case "Action.OpenInBrowser":
      return "在浏览器中打开";
    case "Action.CopyToClipboard":
      return "复制到剪贴板";
    case "Action.Paste":
      return "粘贴";
    case "Action.SubmitForm":
      return "提交";
    case "Action.Open":
    case "Action.OpenWith":
      return "打开";
    case "Action.Push":
      return "打开详情";
    default:
      return "执行";
  }
}

/** 插件固定界面文案（分组标题、按钮、动作标题等）：去掉彩色 Emoji 并压缩空白 */
export function cleanUiText(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 条目标题 / 元数据取值等可能是用户数据：原样显示，不删任何字符；
 * 单行内放不下换行，换行显示为 ⏎、制表符显示为空格。
 */
export function displayText(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/\r\n|\r|\n/g, "⏎").replace(/\t/g, " ");
}

/** 插件声明的修饰键 → 统一写法（ShortcutKeys 按平台显示：Ctrl 在 macOS 上显示为 ⌘） */
export const MODIFIER_COMBO = Object.freeze({
  cmd: "Ctrl",
  command: "Ctrl",
  meta: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  opt: "Alt",
  option: "Alt",
  alt: "Alt",
  shift: "Shift"
});

/** 把插件声明的 { modifiers: ['cmd'], key: 'c' } 或字符串 'space' 转为统一规范写法（如 'Ctrl+C'、'Space'）；无法识别时返回空串 */
export function formatActionShortcut(action) {
  return normalizeActionShortcutCombo(action?.props?.shortcut);
}

/** Action.Style.Destructive：危险动作在底栏与动作面板用错误色显示，不能显示成余烬橙主按钮 */
export function isDestructiveAction(action) {
  return String(action?.props?.style || "").toLowerCase() === "destructive";
}

/**
 * 某个动作在当前视图里的固定键位提示：插件自己声明的快捷键优先；
 * 否则按它在「可直接触发的动作」里的原始下标与视图类型给出 Enter / ⌘Enter。
 * 列表 / 详情：第 1 个 Enter、第 2 个 ⌘Enter；表单：第 1 个 ⌘Enter（Enter 在多行输入里是换行）。
 */
export function actionKeyHint(action, directIndex, viewType) {
  if (!action || typeof action !== "object") return "";
  if (action._fromSubmenu || typeof directIndex !== "number" || directIndex < 0) {
    // 子菜单或无有效下标的动作仍走统一解析器过滤保留键并格式化显式快捷键
    const target = action._fromSubmenu ? action : { ...action, _fromSubmenu: true };
    return resolveActionKeyBindings([target], { viewType }).hintOf(target);
  }
  const prefixCount = Math.min(directIndex, 2);
  const slots = Array.from({ length: prefixCount }, (_, idx) => ({ _slot: idx }));
  slots.push(action);
  return resolveActionKeyBindings(slots, { viewType }).hintOf(action);
}
