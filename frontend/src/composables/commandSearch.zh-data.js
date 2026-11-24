/**
 * 命令搜索内核使用的纯静态中文同义词与语义图标关键词表。
 * 仅导出纯静态常量数据（符合 *.zh-data.js 约定），严禁包含函数、UI 渲染逻辑或业务报错。
 */

/** 内置快捷指令的中文附加搜索别名（用于在英文界面下通过中文同义词/拼音召回） */
export const BUILTIN_COMMAND_ZH_EXTRA_ALT_NAMES = Object.freeze({
  'system-dashboard': Object.freeze(['工作台'])
})

/** 内置快捷指令的中文搜索关键词表 */
export const BUILTIN_COMMAND_ZH_KEYWORDS = Object.freeze({
  'system-settings': Object.freeze(['偏好设置']),
  'system-dashboard': Object.freeze(['工作台', '插件中心']),
  'developer-create-extension': Object.freeze(['扩展', '插件开发']),
  'developer-github-repo': Object.freeze(['开源', '插件仓库'])
})

/** 语义矢量图标智能匹配关键词规则（按优先级从高到低匹配） */
export const COMMAND_FA_ICON_RULES = Object.freeze([
  Object.freeze({ keywords: Object.freeze(['音频', '音乐', 'music']), icon: 'fa-music' }),
  Object.freeze({ keywords: Object.freeze(['视频', 'film', 'video']), icon: 'fa-film' }),
  Object.freeze({ keywords: Object.freeze(['重命名', 'rename']), icon: 'fa-i-cursor' }),
  Object.freeze({ keywords: Object.freeze(['文本', 'txt', 'text']), icon: 'fa-file-text-o' }),
  Object.freeze({ keywords: Object.freeze(['录屏', '录制']), icon: 'fa-video-camera' }),
  Object.freeze({ keywords: Object.freeze(['截图', '剪切']), icon: 'fa-scissors' }),
  Object.freeze({ keywords: Object.freeze(['搜索', 'search', 'everything']), icon: 'fa-search' }),
  Object.freeze({ keywords: Object.freeze(['清理', '垃圾', 'clean']), icon: 'fa-trash-o' }),
  Object.freeze({ keywords: Object.freeze(['设置', 'setting', '配置']), icon: 'fa-cog' }),
  Object.freeze({ keywords: Object.freeze(['剪贴板', 'clipboard']), icon: 'fa-clipboard' }),
  Object.freeze({ keywords: Object.freeze(['pdf']), icon: 'fa-file-pdf-o' }),
  Object.freeze({ keywords: Object.freeze(['图片', '图像', 'image']), icon: 'fa-picture-o' }),
  Object.freeze({ keywords: Object.freeze(['代码', '开发', 'code']), icon: 'fa-code' })
])
