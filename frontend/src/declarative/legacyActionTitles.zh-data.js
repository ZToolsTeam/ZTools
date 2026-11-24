/**
 * 声明式视图向后兼容历史第三方插件的中文/英文动作标题识别表。
 * 仅导出纯静态常量数据（符合 *.zh-data.js 约定），严禁包含函数、UI 渲染逻辑或业务报错。
 */

/** 历史「切换详情分栏」动作精确标题表 */
export const DETAIL_TOGGLE_LEGACY_TITLES = Object.freeze([
  '显示详情',
  '隐藏详情',
  'Show Details',
  'Hide Details'
])

/** 历史「切换详情分栏」动作模糊匹配正则 */
export const DETAIL_TOGGLE_TITLE_PATTERN = /详情预览分栏|预览分栏|详情分栏|Toggle Details?/i

/** 历史「即时预览（Quick Look）」动作标题子串表（小写匹配） */
export const QUICK_LOOK_LEGACY_TITLE_TOKENS = Object.freeze([
  'quick look',
  '即时预览'
])
