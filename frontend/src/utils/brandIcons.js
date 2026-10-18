/**
 * 积木 Z 品牌图标库：插件 / 分类统一使用 24 网格线性图标 + 大地色底块。
 * 前 16 个图形来自设计稿「插件与分类图标体系」，其余按同一规范补齐
 * （线宽 1.8、圆角端点、避免实心大色块）。
 *
 * 每个图形是 SVG 子元素描述数组：[标签, 属性]，由 BrandGlyph.vue 渲染，
 * 不使用 v-html，避免把字符串当作 HTML 注入。
 */

const p = (d) => ['path', { d }]
const r = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }]
const c = (cx, cy, rr) => ['circle', { cx, cy, r: rr }]

export const GLYPHS = Object.freeze({
  // ===== 设计稿原有图形 =====
  clipboard: [r(5, 4.5, 14, 16.5, 2.5), r(9, 3, 6, 3.5, 1.2), p('M9 11h6M9 15h4')],
  superclip: [p('M8 3.5h9.5A2.5 2.5 0 0 1 20 6v9.5'), r(4, 7, 12.5, 14, 2.5), p('M7.5 12h5.5M7.5 16h3.5')],
  snippet: [r(3, 4.5, 18, 15, 2.5), p('M13 8l-3.5 4.5h5L11 16.5')],
  filesearch: [p('M10.5 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v2.5'), p('M14 3v5h5'), c(15, 15.5, 3), p('m17.2 17.7 2.8 2.8')],
  window: [r(3, 4, 18, 16, 2.5), p('M11 4v16M11 12h10')],
  json: [p('M8.5 4H8a2.5 2.5 0 0 0-2.5 2.5v3L3.5 12l2 2.5v3A2.5 2.5 0 0 0 8 20h.5'), p('M15.5 4h.5a2.5 2.5 0 0 1 2.5 2.5v3l2 2.5-2 2.5v3A2.5 2.5 0 0 1 16 20h-.5')],
  color: [p('M12 3.5s6.5 6.2 6.5 10.8a6.5 6.5 0 0 1-13 0C5.5 9.7 12 3.5 12 3.5z'), p('M9 14.5a3 3 0 0 0 3 3')],
  process: [r(6, 6, 12, 12, 2), r(9.5, 9.5, 5, 5, 1), p('M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3')],
  translate: [p('M3 5.5h10M8 3.5v2M5 8.5c1 2.5 3.2 4.5 6 5.5M11 5.5c-.6 3.6-2.8 6.6-6.5 8.5'), p('m12 21 4-9 4 9M13.4 18h5.2')],
  ocr: [p('M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16'), p('M8 9h8M12 9v7')],
  pdf: [p('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'), p('M14 3v5h5M9 13h6M9 17h4')],
  qr: [r(3.5, 3.5, 6.5, 6.5, 1.5), r(14, 3.5, 6.5, 6.5, 1.5), r(3.5, 14, 6.5, 6.5, 1.5), p('M14 14h2.5v2.5M20.5 14v.01M14 20.5h.01M17.5 20.5h3v-3')],
  crop: [p('M6.5 3v12.5a2 2 0 0 0 2 2H21'), p('M3 6.5h12.5a2 2 0 0 1 2 2V21')],
  trash: [p('M4 6.5h16M9.5 6.5v-2h5v2'), p('m6.5 6.5.9 12.6A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.9l.9-12.6'), p('M10.5 11v5.5M13.5 11v5.5')],
  plaintext: [p('M5 6.5V5h14v1.5'), p('M12 5v14M9 19h6')],

  // ===== 按同一规范补齐 =====
  calculator: [r(5, 3, 14, 18, 2.5), r(8, 6, 8, 3.5, 1), p('M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 17h.01M12 17h.01M15.5 17h.01')],
  power: [p('M12 3v8'), p('M6.6 6.6a7.5 7.5 0 1 0 10.8 0')],
  link: [p('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1'), p('M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1')],
  settings: [p('M4 7h9M17 7h3M4 17h3M11 17h9'), c(15, 7, 2), c(9, 17, 2)],
  update: [p('M20 11.5A8 8 0 0 0 5.6 6.6L4 8.2'), p('M4 4v4.2h4.2'), p('M4 12.5a8 8 0 0 0 14.4 4.9l1.6-1.6'), p('M20 20v-4.2h-4.2')],
  user: [c(12, 8.5, 3.5), p('M5 20a7 7 0 0 1 14 0')],
  team: [c(9, 8.5, 3), p('M3.5 19.5a5.5 5.5 0 0 1 11 0'), p('M15.5 5.8a3 3 0 0 1 0 5.4M17 14.2a5.5 5.5 0 0 1 3.5 5.3')],
  chart: [p('M4 4v16h16'), p('M8 15v-3M12 15V8M16 15v-5')],
  spark: [p('M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z'), p('M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z')],
  terminal: [r(3, 4.5, 18, 15, 2.5), p('m7 9.5 3 2.5-3 2.5M12.5 15h4.5')],
  emoji: [c(12, 12, 8.5), p('M8.5 14.5a4.5 4.5 0 0 0 7 0'), p('M9 9.5h.01M15 9.5h.01')],
  note: [p('M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5V15l-6 6H7.5A2.5 2.5 0 0 1 5 18.5z'), p('M13 21v-4a2 2 0 0 1 2-2h4'), p('M8.5 8h7M8.5 11.5h4')],
  taskbar: [r(3, 4, 18, 16, 2.5), p('M3 16h18M7 18h.01M10 18h.01')],
  apps: [r(3.5, 3.5, 7, 7, 2), r(13.5, 3.5, 7, 7, 2), r(3.5, 13.5, 7, 7, 2), r(13.5, 13.5, 7, 7, 2)],
  book: [p('M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z'), p('M4 20.5A2.5 2.5 0 0 0 6.5 21H20'), p('M8.5 7.5h7')],
  branch: [c(6.5, 5.5, 2), c(6.5, 18.5, 2), c(17.5, 7.5, 2), p('M6.5 7.5v9'), p('M17.5 9.5a6 6 0 0 1-6 6h-3')],
  gauge: [p('M4.5 17a8.5 8.5 0 1 1 15 0'), p('m12 13 4-4.5'), c(12, 13, 1.2)],
  package: [p('M12 3 4 7.2v9.6L12 21l8-4.2V7.2z'), p('M4 7.2 12 11.5l8-4.3M12 11.5V21')],
  currency: [c(12, 12, 8.5), p('M9 7.5l3 4 3-4M12 11.5v5.5M9.5 12.5h5M9.5 15h5')],
  lock: [r(5, 10.5, 14, 10, 2.5), p('M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3'), p('M12 14.5v2.5')],
  wifi: [p('M3 9a13 13 0 0 1 18 0'), p('M6 12.5a8.5 8.5 0 0 1 12 0'), p('M9 16a4 4 0 0 1 6 0'), p('M12 19.5h.01')],
  speaker: [p('M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z'), p('M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11')],
  keyboard: [r(2.5, 6, 19, 12, 2.5), p('M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8')],
  download: [p('M12 4v11'), p('m7.5 10.5 4.5 4.5 4.5-4.5'), p('M5 20h14')],
  pulse: [p('M3 12h4l2.5-6 5 12 2.5-6h4')],
  broom: [p('M14.5 3.5l-4 7'), p('M8 10.5h7.5l1.5 10H6.5z'), p('M10 15v5.5M13 15v5.5')],
  disk: [c(12, 12, 8.5), p('M12 3.5V12h8.5')],
  chat: [p('M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.5A7.5 7.5 0 1 1 20 11.5z')],
  shield: [p('M12 21s7-3.5 7-9V5.5L12 3 5 5.5V12c0 5.5 7 9 7 9z')],
  rename: [p('M4 7.5h10M4 12h7M4 16.5h5'), p('m14.5 19.5 5.5-5.5-2-2-5.5 5.5-.5 2.5z')],
  video: [r(3, 6, 13, 12, 2.5), p('m16 10.5 5-3v9l-5-3')],
  audio: [p('M9 18.5V6l11-2.5V16'), c(6.5, 18.5, 2.5), c(17.5, 16, 2.5)],
  cube: [p('M12 3 4 7.2v9.6L12 21l8-4.2V7.2z'), p('M4 7.2 12 11.5l8-4.3M12 11.5V21')],
  folder: [p('M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z')],
  // 导航图标
  home: [p('M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z'), p('M9.5 20v-5.5h5V20')],
  store: [p('M5 8h14l-1.1 11.1a1 1 0 0 1-1 .9H7.1a1 1 0 0 1-1-.9z'), p('M9 10V6.8a3 3 0 0 1 6 0V10')],
  // 分类图标
  wrench: [p('M14.5 6.5a4 4 0 0 0 5 5L13 18a2.1 2.1 0 0 1-3-3l6.5-6.5'), p('M14.5 6.5 17.5 3.5 20.5 6.5 17.5 9.5'), p('M7.5 13 3.5 17a2.1 2.1 0 0 0 3 3l4-4')],
  briefcase: [r(3, 7, 18, 13, 2.5), p('M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18')],
  image: [r(3, 4, 18, 16, 2.5), c(9, 10, 1.6), p('m21 16-5-5-8 9')],
  grid: [r(3.5, 3.5, 7, 7, 2), r(13.5, 3.5, 7, 7, 2), r(3.5, 13.5, 7, 7, 2), r(13.5, 13.5, 7, 7, 2)]
})

/** 每个图形的底块色调（与 theme.css 中 --rc-h-<hue>-bg / -fg 对应） */
export const GLYPH_HUES = Object.freeze({
  clipboard: 'orange', superclip: 'clay', snippet: 'amber', filesearch: 'slate', window: 'slate',
  json: 'olive', color: 'clay', process: 'neutral', translate: 'olive', ocr: 'amber', pdf: 'clay',
  qr: 'neutral', crop: 'orange', trash: 'neutral', plaintext: 'ochre',
  calculator: 'ochre', power: 'neutral', link: 'slate', settings: 'neutral', update: 'olive',
  user: 'neutral', team: 'slate', chart: 'amber', spark: 'orange', terminal: 'neutral',
  emoji: 'amber', note: 'ochre', taskbar: 'slate', apps: 'neutral', book: 'olive', branch: 'neutral',
  gauge: 'slate', package: 'ochre', currency: 'olive', lock: 'clay', wifi: 'slate', speaker: 'ochre',
  keyboard: 'neutral', download: 'slate', pulse: 'clay', broom: 'olive', disk: 'amber', chat: 'olive',
  shield: 'clay', rename: 'ochre', video: 'clay', audio: 'amber', cube: 'neutral', folder: 'ochre',
  wrench: 'neutral', briefcase: 'neutral', image: 'neutral', grid: 'neutral', home: 'neutral', store: 'neutral'
})

/** 官方插件 → 图形。第三方插件不在此表中，保留作者自己的图标 */
export const OFFICIAL_PLUGIN_GLYPHS = Object.freeze({
  'clipboard-history': 'clipboard',
  snippets: 'snippet',
  'window-management': 'window',
  'everything-file-search': 'filesearch',
  calculator: 'calculator',
  system: 'power',
  quicklinks: 'link',
  'kill-process': 'process',
  'json-format': 'json',
  'qr-code': 'qr',
  'color-picker': 'color',
  'google-translate': 'translate',
  'raycast-settings': 'settings',
  'raycast-core': 'update',
  'raycast-account': 'user',
  organizations: 'team',
  'raycast-wrapped': 'chart',
  'trial-nudges': 'spark',
  'windows-shortcuts': 'terminal',
  'emoji-picker': 'emoji',
  translator: 'translate',
  notes: 'note',
  'windows-run': 'terminal',
  'windows-taskbar': 'taskbar',
  screenshots: 'crop',
  applications: 'apps',
  dictionary: 'book',
  github: 'branch',
  obsidian: 'note',
  speedtest: 'gauge',
  winget: 'package',
  'currency-exchange': 'currency',
  'password-vault': 'lock',
  'wifi-password-reveal': 'wifi',
  'audio-device': 'speaker',
  'clean-keyboard': 'keyboard',
  'downloads-manager': 'download',
  'process-monitor': 'pulse',
  'software-manager': 'package',
  cleaner: 'broom',
  'disk-analyzer': 'disk',
  'wechat-cleaner': 'chat',
  'qq-cleaner': 'chat',
  'flow-guard': 'shield',
  'hardware-info': 'process',
  boost: 'gauge',
  'batch-rename': 'rename',
  'batch-video': 'video',
  'batch-audio': 'audio',
  pdf: 'pdf',
  'multi-download': 'download',
  'video-downloader': 'video',
  ocr: 'ocr',
  'apple-shortcuts': 'spark',
  navigation: 'window',
  homebrew: 'package',
  'script-commands': 'terminal',
  'raycast-focus': 'gauge',
  calendar: 'note',
  'web-searches': 'link',
  'network-adapter': 'wifi',
  'network-rescue': 'shield',
  'context-menu': 'window',
  'wechat-multi': 'chat',
  'lan-share': 'qr',
  mover: 'folder',
  'data-recovery': 'update',
  shredder: 'trash',
  'system-backup': 'package',
  'sqlite-plugin': 'disk',
  'ai-image': 'image',
  'ai-video': 'video',
  record: 'video',
  'file-compare': 'json'
})

/** 侧边栏 / 市场分类 → 图形 */
export const CATEGORY_GLYPHS = Object.freeze({
  全部: 'grid',
  系统工具: 'wrench',
  办公效率: 'briefcase',
  媒体处理: 'image',
  图像视频: 'image',
  安全工具: 'shield',
  安全隐私: 'shield',
  网络工具: 'wifi',
  开发工具: 'terminal',
  金融理财: 'currency'
})

export function isGlyph(kind) {
  return typeof kind === 'string' && Object.hasOwn(GLYPHS, kind)
}

/**
 * 解析插件应使用的品牌图形；不是官方插件（或未登记）时返回空字符串，由调用方回退到插件自带图标。
 * @param {object|string|null|undefined} plugin
 */
export function resolvePluginGlyph(plugin) {
  const id = typeof plugin === 'string' ? plugin : (plugin?.pluginId || plugin?.id || '')
  const key = String(id).trim().toLowerCase()
  return Object.hasOwn(OFFICIAL_PLUGIN_GLYPHS, key) ? OFFICIAL_PLUGIN_GLYPHS[key] : ''
}

export function glyphHue(kind) {
  return Object.hasOwn(GLYPH_HUES, kind) ? GLYPH_HUES[kind] : 'neutral'
}

/** 内置命令（useCommandSearch 中的静态条目）→ 图形 */
export const COMMAND_GLYPHS = Object.freeze({
  'system-settings': 'settings',
  'everything-search': 'filesearch',
  'system-dashboard': 'apps',
  'developer-create-extension': 'terminal',
  'developer-github-repo': 'branch'
})

/**
 * 搜索结果条目（插件 / 命令 / 文件）应使用的图形：官方插件 > 内置命令 > 文件夹 / 文件；其余返回空字符串。
 * @param {object|null|undefined} item
 */
export function resolveItemGlyph(item) {
  if (!item || typeof item !== 'object') return ''
  const fromPlugin = resolvePluginGlyph(item.pluginId || '')
  if (fromPlugin) return fromPlugin
  const key = typeof item.key === 'string' ? item.key : ''
  if (Object.hasOwn(COMMAND_GLYPHS, key)) return COMMAND_GLYPHS[key]
  // 文件结果：文件夹 / 通用文档（pdf 图形即带折角的文档轮廓）
  if (item.type === 'file') return item.isDir ? 'folder' : 'pdf'
  return ''
}
