/**
 * 插件传入颜色（`Color.*` 或任意 CSS 颜色）→ 实际使用的 CSS 颜色。
 *
 * `@ztools/declarative-ui` 的 `Color` 枚举取值是按深色主题写死的（例如 SecondaryText 为
 * rgba(255,255,255,0.60)），直接当 CSS 颜色用时浅色主题下几乎看不见。这里把这些语义值统一映射到
 * 跟随深浅主题切换的变量；图标 tintColor、标签 color 等所有接受 Color 的位置都必须走 resolveThemeColor。
 *
 * - 语义值同时识别枚举取值（忽略空白与大小写，如 "rgba(255,255,255,0.6)"）、枚举键名（"SecondaryText"）
 *   与 Raycast 风格名（"raycast-secondary-text"）；
 * - Purple / Magenta 在两种主题下都可读，且界面规范不鼓励使用，保持原值；
 * - 其他普通颜色（十六进制、rgb()、颜色关键字等）原样返回；非字符串或空值返回空串（由调用方决定回退）。
 */

/** 枚举键名 → 主题变量（键名统一为小写、去掉连字符与下划线）；无原型，"constructor" 之类不会误命中 */
const SEMANTIC_BY_NAME = Object.assign(Object.create(null), {
  primarytext: "var(--rc-text-primary)",
  secondarytext: "var(--rc-text-muted)",
  red: "var(--rc-error)",
  green: "var(--rc-success)",
  yellow: "var(--rc-warning)",
  orange: "var(--rc-h-orange-fg)",
  blue: "var(--rc-h-slate-fg)"
});

/** 枚举取值（packages/declarative-ui/src/constants/colors.ts）→ 枚举键名 */
const SEMANTIC_BY_VALUE = Object.assign(Object.create(null), {
  "rgba(255,255,255,0.95)": "primarytext",
  "rgba(255,255,255,0.60)": "secondarytext",
  "rgba(255,255,255,0.6)": "secondarytext",
  "rgb(255,69,58)": "red",
  "rgb(48,209,88)": "green",
  "rgb(255,214,10)": "yellow",
  "rgb(255,159,10)": "orange",
  "rgb(10,132,255)": "blue"
});

/** 解析出的语义名（"red" 等），不是语义色时返回空串 */
export function semanticColorName(value) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!compact) return "";
  if (SEMANTIC_BY_VALUE[compact]) return SEMANTIC_BY_VALUE[compact];
  const name = compact.replace(/^raycast-/, "").replace(/[-_]/g, "");
  return SEMANTIC_BY_NAME[name] ? name : "";
}

export function resolveThemeColor(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const name = semanticColorName(trimmed);
  return name ? SEMANTIC_BY_NAME[name] : trimmed;
}
