/**
 * 声明式渲染器共用的文案与快捷键工具：各 Renderer、底栏与动作面板统一从这里取，
 * 避免同一规则散落多份、改一处漏一处。
 */

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

/** 把插件声明的 { modifiers: ['cmd'], key: 'c' } 转为统一写法 'Ctrl+c'；无法识别时返回空串 */
export function formatActionShortcut(action) {
  const shortcut = action?.props?.shortcut;
  if (!shortcut || typeof shortcut !== "object" || typeof shortcut.key !== "string" || !shortcut.key.trim()) return "";
  const modifiers = Array.isArray(shortcut.modifiers) ? shortcut.modifiers : [];
  const parts = [];
  for (const mod of modifiers) {
    const name = MODIFIER_COMBO[String(mod).toLowerCase()];
    if (name && !parts.includes(name)) parts.push(name);
  }
  parts.push(shortcut.key.trim());
  return parts.join("+");
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
  const declared = formatActionShortcut(action);
  if (declared) return declared;
  if (action?._fromSubmenu || typeof directIndex !== "number" || directIndex < 0) return "";
  if (viewType === "Form") return directIndex === 0 ? "Ctrl+Enter" : "";
  if (directIndex === 0) return "Enter";
  if (directIndex === 1) return "Ctrl+Enter";
  return "";
}
