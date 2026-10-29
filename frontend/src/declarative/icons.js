/**
 * 声明式插件内置图标库（24x24 线性图标，单色 currentColor）。
 *
 * - 键名与 `@ztools/declarative-ui` 的 `Icon` 枚举值（packages/declarative-ui/src/constants/icons.ts）一一对应，
 *   契约测试会读取该枚举逐个断言这里都有图形，新增枚举值时必须在此补图标；
 * - 普通条目是描边路径（string 或 string[]），以 stroke 渲染；`{ fill }` 条目以实心填充渲染（只用于圆点类）；
 * - 找不到的图标名使用 FALLBACK_ICON（中性圆角方块轮廓），不再显示实心黑点。
 */

// 圆：以 (cx, cy) 为圆心、r 为半径的闭合路径
const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`

// 圆角矩形
const rect = (x, y, w, h, r = 0) => {
  if (!r) return `M${x} ${y}h${w}v${h}h${-w}z`
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`
}

const EYE = ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', circle(12, 12, 3)]
const STAR = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z'
const CHECK = 'M20 6L9 17l-5-5'
const XMARK_CIRCLE = [circle(12, 12, 10), 'M15 9l-6 6M9 9l6 6']
const ROTATE_CW = ['M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5']
const ROTATE_CCW = ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5']
const SPEAKER = 'M11 5L6 9H2v6h4l5 4V5z'
const LOCK_BODY = rect(3, 11, 18, 11, 2)
const MONITOR = [rect(2, 3, 20, 14, 2), 'M8 21h8M12 17v4']
const SIDEBAR_LEFT = [rect(3, 3, 18, 18, 2), 'M9 3v18']

export const FALLBACK_ICON = [rect(4, 4, 16, 16, 3)]

export const ICONS = {
  // 实心圆点（插件用作状态指示）
  'circle-filled': { fill: circle(12, 12, 6) },
  dot: { fill: circle(12, 12, 4) },
  circle: [circle(12, 12, 9)],
  'circle-progress': ['M21 12a9 9 0 1 1-6.22-8.56'],

  document: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6M9 17h6'],
  code: ['M16 18l6-6-6-6M8 6l-6 6 6 6'],
  check: [CHECK],
  checkmark: [CHECK],
  'check-circle': [circle(12, 12, 10), 'M9 12l2 2 4-4'],
  clipboard: [rect(8, 2, 8, 4, 1), 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'],
  'copy-clipboard': [rect(8, 8, 14, 14, 2), 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],
  globe: [circle(12, 12, 10), 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
  'magnifying-glass': [circle(11, 11, 8), 'M21 21l-4.35-4.35'],
  binoculars: [
    circle(6, 16, 4),
    circle(18, 16, 4),
    'M10 16h4',
    'M2 16V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v5M22 16V7a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v5'
  ],
  'qr-code': [rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(3, 14, 7, 7, 1), 'M14 14h3v3M21 14v.01M17 21h4v-4M14 21v-3'],

  'arrow-right': ['M5 12h14M12 5l7 7-7 7'],
  'arrow-left': ['M19 12H5M12 19l-7-7 7-7'],
  'arrow-up': ['M12 19V5M5 12l7-7 7 7'],
  'arrow-down': ['M12 5v14M19 12l-7 7-7-7'],
  'arrow-right-circle': [circle(12, 12, 10), 'M8 12h8M12 16l4-4-4-4'],
  'arrows-expand': ['M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'],
  'arrows-vertical': ['M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4'],
  'arrows-horizontal': ['M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4'],
  'rotate-clockwise': ROTATE_CW,
  'arrow-clockwise': ROTATE_CW,
  'rotate-anti-clockwise': ROTATE_CCW,
  'arrow-counter-clockwise': ROTATE_CCW,
  repeat: ['M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3'],
  forward: ['M15 17l5-5-5-5M4 18v-2a4 4 0 0 1 4-4h12'],

  trash: ['M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6'],
  gear: [
    circle(12, 12, 3),
    circle(12, 12, 7),
    'M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.75 1.75M16.95 16.95l1.75 1.75M5.3 18.7l1.75-1.75M16.95 7.05l1.75-1.75'
  ],
  'wrench-screwdriver': [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'
  ],
  eye: EYE,
  'eye-slash': [...EYE, 'M3 3l18 18'],
  'eye-disabled': [...EYE, 'M3 3l18 18'],
  terminal: ['M4 17l6-6-6-6M12 19h8'],
  star: [STAR],
  'star-disabled': [STAR, 'M3 3l18 18'],
  pin: ['M9 3h6M10 3v7l-3 4h10l-3-4V3M12 14v7'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'],
  'cloud-download': ['M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2', 'M12 13v8M8 17l4 4 4-4'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  'xmark-circle': XMARK_CIRCLE,
  'x-mark-circle': XMARK_CIRCLE,
  'exclamation-mark': [circle(12, 12, 10), 'M12 8v4M12 16h.01'],
  'question-mark': [circle(12, 12, 10), 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01'],
  info: [circle(12, 12, 10), 'M12 16v-4M12 8h.01'],

  folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
  calendar: [rect(3, 4, 18, 18, 2), 'M16 2v4M8 2v4M3 10h18'],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  pencil: ['M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', 'M15 5l4 4'],
  link: [
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'
  ],
  text: ['M4 7V4h16v3M9 20h6M12 4v16'],
  brush: [
    'M18.37 2.63L14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3z',
    'M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7'
  ],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z', circle(12, 13, 3)],
  key: [circle(7.5, 15.5, 5.5), 'M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3'],
  lock: [LOCK_BODY, 'M7 11V7a5 5 0 0 1 10 0v4'],
  unlock: [LOCK_BODY, 'M7 11V7a5 5 0 0 1 9.9-1'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  person: [circle(12, 7, 4), 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2'],
  tag: [
    'M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z',
    'M7.5 7.5h.01'
  ],
  filter: ['M22 3H2l8 9.46V19l4 2v-8.54L22 3z'],
  list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],

  play: ['M6 3l14 9-14 9z'],
  pause: [rect(6, 4, 4, 16, 1), rect(14, 4, 4, 16, 1)],
  stop: [rect(5, 5, 14, 14, 2)],
  power: ['M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10'],
  bolt: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z'],
  'light-bulb': [
    'M9 18h6M10 22h4',
    'M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14'
  ],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
  rocket: [
    'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z',
    'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z',
    'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'
  ],
  wand: ['M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5'],
  broom: ['M19 3l-7 7', 'M8 10l6 6', 'M8 10c-2.5 0-4.5 1.5-6 4l8 8c2.5-1.5 4-3.5 4-6', 'M6 15l-1.5 1.5M9 18l-1.5 1.5'],
  scissors: [circle(6, 6, 3), circle(6, 18, 3), 'M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12'],
  'eye-dropper': [
    'M2 22l1-1h3l9-9M3 21v-3l9-9',
    'M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4z'
  ],

  'hard-drive': [
    'M22 12H2',
    'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
    'M6 16h.01M10 16h.01'
  ],
  database: ['M3 5a9 3 0 1 0 18 0a9 3 0 1 0-18 0z', 'M3 5v14a9 3 0 0 0 18 0V5', 'M3 12a9 3 0 0 0 18 0'],
  cpu: [rect(4, 4, 16, 16, 2), rect(9, 9, 6, 6, 1), 'M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2'],
  'memory-stick': [
    'M6 19v-3M10 19v-3M14 19v-3M18 19v-3M8 11V9M16 11V9M12 11V9M2 15h20',
    'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.84V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.06a2 2 0 0 0 0-3.84z'
  ],
  plug: ['M12 22v-5M9 8V2M15 8V2', 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z'],
  wifi: ['M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0M12 20h.01'],
  'signal-3': ['M2 20h.01M7 20v-4M12 20v-8M17 20V8'],
  'bar-chart': ['M3 3v18h18M18 17V9M13 17V5M8 17v-3'],
  layers: ['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5M2 12l10 5 10-5'],

  image: [rect(3, 3, 18, 18, 2), circle(9, 9, 2), 'M21 15l-5-5L5 21'],
  video: [rect(2, 6, 14, 12, 2), 'M22 8l-6 4 6 4V8z'],
  'film-strip': [rect(2, 2, 20, 20, 2), 'M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5'],
  music: ['M9 18V5l12-2v13', circle(6, 18, 3), circle(18, 16, 3)],
  microphone: [rect(9, 2, 6, 12, 3), 'M19 10v2a7 7 0 0 1-14 0v-2M12 19v3'],
  'speaker-on': [SPEAKER, 'M15.54 8.46a5 5 0 0 1 0 7.07'],
  'speaker-high': [SPEAKER, 'M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14'],
  'speaker-off': [SPEAKER, 'M22 9l-6 6M16 9l6 6'],

  window: [rect(2, 4, 20, 16, 2), 'M2 9h20M6 6.5h.01M9 6.5h.01'],
  'app-window': [rect(2, 4, 20, 16, 2), 'M2 8h20M6 4v4M10 4v4'],
  sidebar: SIDEBAR_LEFT,
  'sidebar-left': SIDEBAR_LEFT,
  'sidebar-right': [rect(3, 3, 18, 18, 2), 'M15 3v18'],
  layout: [rect(3, 3, 18, 18, 2), 'M3 9h18M9 21V9'],
  columns: [rect(3, 3, 18, 18, 2), 'M12 3v18'],
  grid: [rect(3, 3, 7, 7, 1), rect(14, 3, 7, 7, 1), rect(14, 14, 7, 7, 1), rect(3, 14, 7, 7, 1)],
  center: [rect(3, 3, 18, 18, 2), rect(8, 8, 8, 8, 1)],
  maximize: ['M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3'],
  minimize: ['M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3'],
  monitor: MONITOR,
  desktop: [rect(2, 3, 20, 14, 2), 'M2 13h20M8 21h8M12 17v4'],

  // 插件中出现但不在枚举里的常用名
  disc: [circle(12, 12, 10), circle(12, 12, 2)],
  box: [
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    'M3.3 7L12 12l8.7-5M12 22V12'
  ],
  archive: [rect(2, 3, 20, 5, 1), 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4'],
  home: ['M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10']
}

/**
 * 把插件传入的图标名规范成图标库键名：
 * "Icon.CheckCircle" / "CheckCircle" / "check-circle" / "CHECK-CIRCLE" 都得到 "check-circle"。
 */
export function normalizeIconName(name) {
  if (typeof name !== 'string') return ''
  let key = name.trim()
  if (!key) return ''
  key = key.replace(/^Icon\./, '')
  // 驼峰转连字符（全大写或已是连字符的写法不受影响）
  key = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  return key.toLowerCase()
}

/**
 * 解析图标：返回 { strokes: string[], fill: string|null, fallback: boolean }。
 */
export function resolveIconShape(name) {
  const key = normalizeIconName(name)
  const entry = key ? ICONS[key] : undefined
  if (!entry) return { strokes: FALLBACK_ICON, fill: null, fallback: true }
  if (typeof entry === 'object' && !Array.isArray(entry) && entry.fill) {
    return { strokes: [], fill: entry.fill, fallback: false }
  }
  return { strokes: Array.isArray(entry) ? entry : [entry], fill: null, fallback: false }
}
