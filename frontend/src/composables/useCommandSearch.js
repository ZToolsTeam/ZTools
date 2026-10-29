/**
 * 悬浮条与工作台共用的命令检索内核
 *
 * 1. 程序列表在窗口打开时取一次，与插件、子命令一起在本地当场匹配，按键后同一帧就有结果；
 * 2. 普通文件走主进程检索，晚到的结果单独排在下面一段，不让已显示的结果跳位；
 * 3. 排序：匹配档（见 pinyinSearch）→ 常用读音 → 名称命中 → 类型（程序 > 插件 > 子命令 > 系统指令）
 *    → 使用频率 → 名称长短；输入同一个词时上次选中的那一项排第一；
 * 4. 连续输入时按请求序号丢弃过期的文件结果。
 */

import { ref, computed, watch, getCurrentScope, onScopeDispose } from 'vue'
import { usePluginsStore } from '@/stores/plugins'
import { MATCH_TIERS, matchItemWithQuery, normalizeSearchQuery, splitHighlightParts } from '@/utils/pinyinSearch'
import { openSettings } from '@/utils/internalPlugins'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
// 与内置计算器插件同一份计算引擎（由 scripts/sync-bundled-plugins.mjs 同步）
import { evaluateCalculatorQuery, addCalculatorHistory } from '@/vendor/calculator-engine.js'

const STORAGE_KEY_FRECENCY = 'ztools_command_frecency'
const STORAGE_KEY_QUERY_CHOICES = 'ztools_command_query_choices'
const MAX_QUERY_CHOICES = 300

/**
 * 复制文本到系统剪贴板（兼容宿主 IPC 与浏览器 Clipboard API）
 */
export async function copyInlineAnswerToClipboard(text) {
  const val = String(text ?? '')
  if (!val) return false
  try {
    if (typeof window !== 'undefined' && window.ztools?.clipboard?.writeText) {
      await window.ztools.clipboard.writeText(val)
      return true
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(val)
      return true
    }
  } catch (err) {
    console.warn("[useCommandSearch] 复制剪贴板失败:", err)
  }
  return false
}

/** 单个数字（可带正负号、小数、科学计数法）：主搜索框里不当作算式 */
const INLINE_PLAIN_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * 1:1 复刻 Raycast calculator & color rootSearch 机制：
 * 当搜索词命中数学算式、单位换算、汇率、日期推算或色值时，生成置顶临时结果项
 * (ephemeral: true, omitFromFrecencyTracking: true)
 */
export function evaluateInlineCommandItem(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string') return null
  const trimmed = rawQuery.trim()
  if (!trimmed) return null

  try {
    const res = evaluateCalculatorQuery(trimmed)
    if (!res || res.type === 'none' || res.error || !res.formattedAnswer) {
      return null
    }
    // 引擎为了让计算器插件「将结果填入输入框」后还有结果行，会把单个数字（42、1e-9）和日期字面量（2026-11-05）
    // 也当作可计算内容；在主搜索框里这只是原样回显，不出即时结果，不抢占搜索位
    if (res.type === 'math' && INLINE_PLAIN_NUMBER_RE.test(trimmed)) return null
    if (res.type === 'date' && res.formattedAnswer === trimmed) return null

    const isColor = res.type === 'color'
    const badgeMap = {
      math: '即时计算',
      unit: '单位换算',
      currency: '汇率换算',
      date: '日期推算',
      color: '色值速查'
    }

    return {
      key: `inline-calc:${res.type}:${res.expression}`,
      type: isColor ? 'inline-color' : 'inline-calculator',
      calcType: res.type,
      ephemeral: true,
      omitFromFrecencyTracking: true,
      expression: res.expression,
      answer: res.formattedAnswer,
      rawAnswer: res.rawAnswer,
      colorResult: res.colorResult || null,
      name: `${res.expression} = ${res.formattedAnswer}`,
      title: `${res.expression} = ${res.formattedAnswer}`,
      description:
        res.details ||
        (isColor
          ? `${res.colorResult?.rgb || ''} · 按 Enter 复制 HEX`
          : '即时计算结果 · 按 Enter 复制结果'),
      subtitle: res.details || '即时计算结果',
      badge: badgeMap[res.type] || '即时计算',
      actionLabel: '复制结果',
      icon: res.colorResult?.svgDataUri || '',
      faIcon: isColor ? 'fa-tint' : 'fa-calculator',
      pluginId: 'calculator',
      action: async () => {
        const ok = await copyInlineAnswerToClipboard(res.formattedAnswer)
        if (!ok) return false
        try {
          await addCalculatorHistory(res.expression, res.formattedAnswer, res.type)
        } catch (err) {
          console.warn("[useCommandSearch] 写入计算历史失败:", err)
        }
        return res.formattedAnswer
      }
    }
  } catch (err) {
    console.warn("[useCommandSearch] 内联计算求值异常:", err)
    return null
  }
}

// 内置快捷工具条目定义
export const BUILTIN_COMMAND_ITEMS = Object.freeze([
  {
    key: 'system-settings',
    name: '系统设置',
    description: '查看或配置全局快捷键、窗口呼出形态偏好',
    badge: '系统',
    actionLabel: '打开设置',
    faIcon: 'fa-sliders',
    action: () => {
      switchWindowMode(WINDOW_MODES.DASHBOARD).catch((err) => console.warn("[useCommandSearch] 切换窗口模式失败:", err))
      openSettings()
    }
  },
  {
    key: 'system-dashboard',
    name: '打开插件中心',
    description: '展开为完整工作台大界面，浏览所有应用卡片',
    badge: '工作台',
    actionLabel: '展开',
    faIcon: 'fa-th-large',
    action: () => {
      switchWindowMode(WINDOW_MODES.DASHBOARD).catch((err) => console.warn("[useCommandSearch] 切换窗口模式失败:", err))
    }
  },
  {
    key: 'developer-create-extension',
    name: '创建新扩展 (Create Extension)',
    description: '基于声明式 UI 标准 5 分钟快速开发你的专属 ZTools 插件',
    badge: '开发者',
    actionLabel: '开发指南',
    faIcon: 'fa-code',
    action: () => {
      if (window.ztools?.shell?.openExternal) {
        window.ztools.shell.openExternal('https://github.com/ZToolsTeam/ZTools-extensions')
      } else {
        window.open('https://github.com/ZToolsTeam/ZTools-extensions', '_blank')
      }
    }
  },
  {
    key: 'developer-github-repo',
    name: '开源插件生态大仓 (ZTools Extensions)',
    description: '在 GitHub 上查看开源插件源码和投稿指南',
    badge: '开源',
    actionLabel: '前往 GitHub',
    faIcon: 'fa-github',
    action: () => {
      if (window.ztools?.shell?.openExternal) {
        window.ztools.shell.openExternal('https://github.com/ZToolsTeam/ZTools-extensions')
      } else {
        window.open('https://github.com/ZToolsTeam/ZTools-extensions', '_blank')
      }
    }
  }
])

// 语义矢量图标智能匹配
export function resolveCommandFaIcon(name, category) {
  const str = `${name || ''} ${category || ''}`.toLowerCase()
  if (str.includes('音频') || str.includes('音乐') || str.includes('music')) return 'fa-music'
  if (str.includes('视频') || str.includes('film') || str.includes('video')) return 'fa-film'
  if (str.includes('重命名') || str.includes('rename')) return 'fa-i-cursor'
  if (str.includes('文本') || str.includes('txt') || str.includes('text')) return 'fa-file-text-o'
  if (str.includes('录屏') || str.includes('录制')) return 'fa-video-camera'
  if (str.includes('截图') || str.includes('剪切')) return 'fa-scissors'
  if (str.includes('搜索') || str.includes('search') || str.includes('everything')) return 'fa-search'
  if (str.includes('清理') || str.includes('垃圾') || str.includes('clean')) return 'fa-trash-o'
  if (str.includes('设置') || str.includes('setting') || str.includes('配置')) return 'fa-cog'
  if (str.includes('剪贴板') || str.includes('clipboard')) return 'fa-clipboard'
  if (str.includes('pdf')) return 'fa-file-pdf-o'
  if (str.includes('图片') || str.includes('图像') || str.includes('image')) return 'fa-picture-o'
  if (str.includes('代码') || str.includes('开发') || str.includes('code')) return 'fa-code'
  return 'fa-cube'
}

export function resolveFileFaIcon(fileName, isDir) {
  if (isDir) return 'fa-folder'
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'fa-file-image-o'
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'fa-file-audio-o'
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'].includes(ext)) return 'fa-file-video-o'
  if (['pdf'].includes(ext)) return 'fa-file-pdf-o'
  if (['doc', 'docx'].includes(ext)) return 'fa-file-word-o'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'fa-file-excel-o'
  if (['ppt', 'pptx'].includes(ext)) return 'fa-file-powerpoint-o'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'fa-file-archive-o'
  if (['js', 'ts', 'vue', 'html', 'css', 'json', 'py', 'cpp', 'c', 'h', 'rs', 'go', 'java'].includes(ext)) return 'fa-file-code-o'
  if (['exe', 'bat', 'cmd', 'ps1', 'msi'].includes(ext)) return 'fa-terminal'
  return 'fa-file-text-o'
}

export function truncatePath(fullPath) {
  if (!fullPath) return ''
  if (fullPath.length <= 48) return fullPath
  const separator = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(/[\\/]/)
  if (parts.length <= 3) return fullPath
  return `${parts[0]}${separator}…${separator}${parts.slice(-2).join(separator)}`
}

/**
 * 读取本地 frecency 字典
 * @returns {Record<string, { count: number, lastUsed: number }>}
 */
export function loadFrecencyMap() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_FRECENCY) : null
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch (err) {
    console.warn("[useCommandSearch] 读取 Frecency 缓存失败:", err)
    return {}
  }
}

/**
 * 持久化 frecency 字典
 */
export function saveFrecencyMap(map) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_FRECENCY, JSON.stringify(map))
    }
  } catch (err) {
    console.warn("[useCommandSearch] 保存 Frecency 缓存失败:", err)
  }
}

/**
 * 计算单个条目的 Frecency 额外权重分数
 */
export function calculateFrecencyBonus(stats, now = Date.now()) {
  if (!stats || typeof stats.lastUsed !== 'number') return 0

  const ageMs = Math.max(0, now - stats.lastUsed)
  const hours = ageMs / (1000 * 60 * 60)

  let recencyBonus = 5
  if (hours < 1) {
    recencyBonus = 120
  } else if (hours < 24) {
    recencyBonus = 80
  } else if (hours < 72) {
    recencyBonus = 50
  } else if (hours < 168) {
    recencyBonus = 20
  }

  const frequencyBonus = Math.min((stats.count || 1) * 10, 100)
  return recencyBonus + frequencyBonus
}

/**
 * 记录条目使用历史
 * @param {string} itemKey 
 */
export function recordCommandUsage(itemKey) {
  if (!itemKey || String(itemKey).startsWith('inline-calc:')) return
  const map = loadFrecencyMap()
  const existing = map[itemKey] || { count: 0, lastUsed: 0 }
  map[itemKey] = {
    count: (existing.count || 0) + 1,
    lastUsed: Date.now()
  }
  saveFrecencyMap(map)
}

let frecencySnapshot = { raw: null, map: {} }

/** 排序时读取的使用记录：内容没变就复用上次解析的结果（两个窗口共用同一份 localStorage） */
function getFrecencySnapshot() {
  let raw = null
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_FRECENCY) : null
  } catch {
    raw = null
  }
  if (raw !== frecencySnapshot.raw) frecencySnapshot = { raw, map: raw ? loadFrecencyMap() : {} }
  return frecencySnapshot.map
}

let queryChoicesSnapshot = { raw: null, map: {} }

function getQueryChoicesSnapshot() {
  let raw = null
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_QUERY_CHOICES) : null
  } catch {
    raw = null
  }
  if (raw !== queryChoicesSnapshot.raw) queryChoicesSnapshot = { raw, map: raw ? loadQueryChoices() : {} }
  return queryChoicesSnapshot.map
}

/**
 * 读取「搜索词 → 上次选中项」记录
 * @returns {Record<string, { key: string, at: number }>}
 */
export function loadQueryChoices() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_QUERY_CHOICES) : null
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    console.warn('[useCommandSearch] 读取搜索选择记录失败:', err)
    return {}
  }
}

/**
 * 记住这个搜索词最后选中的是哪一项，下次输入同一个词时它排第一；最多保留最近 300 个词
 */
export function recordQueryChoice(rawQuery, itemKey) {
  const q = normalizeSearchQuery(rawQuery)
  const key = String(itemKey || '')
  if (!q || !key || key.startsWith('inline-calc:')) return
  const choices = loadQueryChoices()
  choices[q] = { key, at: Date.now() }
  const entries = Object.entries(choices)
  if (entries.length > MAX_QUERY_CHOICES) {
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
    for (const [staleQuery] of entries.slice(MAX_QUERY_CHOICES)) delete choices[staleQuery]
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY_QUERY_CHOICES, JSON.stringify(choices))
  } catch (err) {
    console.warn('[useCommandSearch] 保存搜索选择记录失败:', err)
  }
}

/**
 * 判断插件条目是否为可原位渲染/执行的声明式插件
 */
export function isDeclarativePluginItem(plugin) {
  if (!plugin || typeof plugin !== 'object') return false
  const pid = String(plugin.pluginId || plugin.id || '').trim()
  if (pid && getOfficialPlugin(pid)) return true
  if (plugin.isDeclarative === true || plugin.isInstalledDeclarative === true) return true
  if (plugin.channel === 'v2') return true
  const entry = String(plugin.entry || plugin.manifest?.entry || '').trim().toLowerCase()
  return entry.endsWith('.js') || entry.endsWith('.mjs')
}

/**
 * 规范化解析插件声明的 features 子命令列表（防御性校验外部 manifest 数据）
 */
export function normalizePluginFeatures(plugin) {
  if (!plugin || typeof plugin !== 'object') return []
  const rawFeatures = Array.isArray(plugin.features)
    ? plugin.features
    : Array.isArray(plugin.manifest?.features)
      ? plugin.manifest.features
      : []

  const seenCodes = new Set()
  const result = []

  for (const feat of rawFeatures) {
    if (!feat || typeof feat !== 'object') continue
    const code = String(feat.code || '').trim()
    const explain = String(feat.explain || feat.title || feat.name || '').trim()
    if (!code || !explain || seenCodes.has(code)) continue
    seenCodes.add(code)

    const rawMode = String(feat.mode || plugin.mode || plugin.manifest?.mode || 'view').trim()
    const mode = ['view', 'no-view'].includes(rawMode) ? rawMode : 'view'
    const alias = typeof feat.alias === 'string' ? feat.alias.trim() : ''
    const shortcut = typeof feat.shortcut === 'string' ? feat.shortcut.trim() : ''
    const cmds = Array.isArray(feat.cmds) ? feat.cmds : []

    result.push({
      code,
      explain,
      mode,
      alias,
      shortcut,
      icon: typeof feat.icon === 'string' ? feat.icon : '',
      cmds
    })
  }

  return result
}

/** 同一档里的类型先后：程序 > 插件 > 插件子命令 > 系统指令 > 文件夹 > 文件 */
function resultTypeRank(item) {
  if (item?.isApplication) return 0
  if (item?.type === 'plugin') return 1
  if (item?.type === 'plugin-feature') return 2
  if (item?.type === 'file') return item.isDir ? 4 : 5
  return 3
}

/** 上次为同一个搜索词选中的结果排在所有匹配之前，只让位给用户设置的别名 */
const LEARNED_TIER = MATCH_TIERS.EXACT + 0.5
const FILE_SEARCH_DEBOUNCE_MS = 80
const APPLICATION_REFRESH_INTERVAL_MS = 5000
/** 主进程给结果路径的打开授权 30 分钟过期：窗口开着时每 10 分钟刷新一次程序列表（顺带续期），搜索时发现过旧也刷新 */
const APPLICATION_GRANT_REFRESH_MS = 10 * 60 * 1000
const APPLICATION_ICON_BATCH = 24
const MAX_APPLICATION_ICON_CACHE = 512

function compareRanked(a, b) {
  return b.tier - a.tier ||
    a.secondary - b.secondary ||
    a.field - b.field ||
    a.typeRank - b.typeRank ||
    b.frecency - a.frecency ||
    a.length - b.length ||
    a.index - b.index
}

/** 文件段：同档时最近修改的、路径浅的在前 */
function compareFiles(a, b) {
  return b.tier - a.tier ||
    a.secondary - b.secondary ||
    a.typeRank - b.typeRank ||
    b.frecency - a.frecency ||
    b.mtime - a.mtime ||
    a.depth - b.depth ||
    a.index - b.index
}

function isFileRecord(f) {
  return Boolean(f) && typeof f.path === 'string' && typeof f.name === 'string'
}

/** 主进程返回的文件记录转成列表条目；程序带上英文原名、文件带上去掉扩展名的名字，都参与匹配 */
function toFileItem(f) {
  const isApplication = f.kind === 'application'
  const name = f.display_name || f.name
  const rawStem = isApplication
    ? String(f.name || '').replace(/\.(app|lnk)$/i, '')
    : f.is_dir ? '' : String(f.name || '').replace(/\.[^.\s]{1,16}$/, '')
  const parentPath = f.path.replace(/[\\/][^\\/]+$/, '')
  return {
    key: 'file:' + f.path,
    type: 'file',
    name,
    title: name,
    fileName: f.name,
    path: f.path,
    isDir: f.is_dir,
    isApplication,
    altNames: rawStem && rawStem !== name ? [rawStem] : [],
    size: f.size,
    mtime: f.mtime,
    badge: isApplication ? '应用' : f.is_dir ? '文件夹' : '文件',
    faIcon: isApplication ? 'fa-th-large' : resolveFileFaIcon(f.name, f.is_dir),
    description: truncatePath(parentPath),
    subtitle: truncatePath(parentPath),
    actionLabel: '打开',
    icon: ''
  }
}

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
}

/** 已安装插件（过滤已下架或已禁用）、全部子命令与内置命令；只随插件列表变化重建 */
function buildCommandCandidates(pluginsStore) {
  const installed = []
  const featureItems = []

  for (const p of pluginsStore.installedPlugins || []) {
    if (!p || typeof p !== 'object') continue
    const key = String(p.pluginId || p.id || '').trim()
    if (!key) continue
    if (p.revoked === true || p.enabled === false || pluginsStore.isRevoked?.(key)) {
      continue
    }

    const rawMode = String(p.mode || p.manifest?.mode || 'view').trim()
    const mode = ['view', 'no-view'].includes(rawMode) ? rawMode : 'view'
    const alias = String(p.alias || p.manifest?.alias || '').trim()
    const features = normalizePluginFeatures(p)
    const isDeclarative = isDeclarativePluginItem(p)
    const pluginName = p.name || p.title || key

    installed.push({
      ...p,
      key,
      pluginId: key,
      type: 'plugin',
      mode,
      alias,
      features,
      isDeclarative,
      badge: p.badge || (mode === 'no-view' ? '极速动作' : '插件'),
      faIcon: p.faIcon || resolveCommandFaIcon(p.name, p.category),
      actionLabel: mode === 'no-view' ? '执行' : '启动'
    })

    features.forEach((feat, index) => {
      // 与插件同名的默认子命令只保留插件这一条，避免结果里出现两条一样的名字
      if (index === 0 && feat.mode === mode && sameText(feat.explain, pluginName)) return
      featureItems.push({
        key: `${key}:${feat.code}`,
        type: 'plugin-feature',
        pluginId: key,
        pluginName,
        featureCode: feat.code,
        name: feat.explain,
        title: feat.explain,
        description: `${p.name || key}${feat.alias ? ` · 别名 ${feat.alias}` : ''}`,
        subtitle: p.name || key,
        alias: feat.alias,
        mode: feat.mode,
        shortcut: feat.shortcut,
        cmds: feat.cmds,
        icon: feat.icon || p.icon,
        faIcon: p.faIcon || resolveCommandFaIcon(feat.explain, p.category),
        badge: feat.mode === 'no-view' ? '极速动作' : (p.name || '子命令'),
        actionLabel: feat.mode === 'no-view' ? '执行' : '打开',
        isDeclarative
      })
    })
  }

  const installedKeys = new Set(installed.map((item) => item.key))
  const remainingBuiltins = BUILTIN_COMMAND_ITEMS.filter((item) => !installedKeys.has(item.key))
  return [...installed, ...featureItems, ...remainingBuiltins]
}

/**
 * 统一搜索内核 Composable
 * @param {object} [options]
 * @param {boolean} [options.enableFileSearch=true] 是否启用本地文件搜索
 * @param {boolean} [options.enableApplications] 是否在本地匹配程序列表，默认与文件搜索一致
 * @param {number} [options.fileSearchLimit=12] 文件搜索候选条数上限
 */
export function useCommandSearch(options = {}) {
  const enableFileSearch = options.enableFileSearch !== false
  const enableApplications = options.enableApplications ?? enableFileSearch
  const fileSearchLimit = options.fileSearchLimit || 12

  const pluginsStore = usePluginsStore()
  const query = ref('')
  const fileResults = ref([])
  const applicationResults = ref([])
  // 主进程能按范围检索时程序在本地匹配；旧版主进程不认识范围，程序随文件结果一起返回
  const applicationsAvailable = ref(false)
  const isSearching = ref(false)
  const fileSearchError = ref('')
  const fileSearchDegraded = ref(false)
  const applicationIcons = new Map()
  const failedIconPaths = new Set()

  let searchRequestId = 0
  let fileSearchDebounceTimer = null
  let applicationsRequest = null
  let applicationsLoadedAt = 0
  let disposed = false

  function launcherBridge() {
    if (typeof window === 'undefined') return null
    return typeof window.__ztoolsLauncher?.searchFiles === 'function' ? window.__ztoolsLauncher : null
  }

  /**
   * 记录使用：使用频率，以及「当前搜索词 → 选中项」
   */
  function recordUsage(itemKey) {
    recordCommandUsage(itemKey)
    recordQueryChoice(query.value, itemKey)
  }

  /** 读取程序列表（主进程有缓存，过期时先返回旧列表再后台刷新），窗口获得焦点时节流刷新 */
  function refreshApplications({ force = false } = {}) {
    if (!enableApplications || disposed) return Promise.resolve()
    const bridge = launcherBridge()
    if (!bridge) return Promise.resolve()
    if (applicationsRequest) return applicationsRequest
    if (!force && applicationsLoadedAt && Date.now() - applicationsLoadedAt < APPLICATION_REFRESH_INTERVAL_MS) {
      return Promise.resolve()
    }
    applicationsRequest = (async () => {
      try {
        const res = await bridge.searchFiles('', fileSearchLimit, { scope: 'applications' })
        if (disposed) return
        if (res?.success === false) throw new Error(res.error?.message || '读取程序列表失败')
        const data = res?.data ?? res
        if (data?.scope !== 'applications' || !Array.isArray(data.files)) return
        const previousIcons = new Map(applicationResults.value.map((item) => [item.path, item.icon]))
        applicationResults.value = data.files
          .filter((f) => isFileRecord(f) && f.kind === 'application')
          .map((f) => Object.assign(toFileItem(f), { icon: previousIcons.get(f.path) || '' }))
        applicationsAvailable.value = true
        applicationsLoadedAt = Date.now()
        failedIconPaths.clear()
      } catch (err) {
        console.warn('[useCommandSearch] 读取程序列表失败:', err)
      } finally {
        applicationsRequest = null
      }
    })()
    return applicationsRequest
  }

  /**
   * 执行防乱序本地文件检索；程序已在本地匹配时只请求文件
   */
  async function searchFilesLocally(text, currentReq) {
    const trimmed = text.trim()
    try {
      const bridge = launcherBridge()
      if (!bridge) throw new Error('当前客户端没有可用的文件搜索接口')
      const res = applicationsAvailable.value
        ? await bridge.searchFiles(trimmed, fileSearchLimit, { scope: 'files' })
        : await bridge.searchFiles(trimmed, fileSearchLimit)

      // 防乱序检查：如果当前请求已过时，坚决丢弃结果
      if (currentReq !== searchRequestId) return

      if (res?.success === false) throw new Error(res.error?.message || '本地文件搜索失败')
      const data = res?.data ?? res
      const rawFiles = Array.isArray(data?.files) ? data.files : []
      fileSearchDegraded.value = data?.degraded === true
      fileResults.value = rawFiles.filter(isFileRecord).map(toFileItem)
    } catch (err) {
      if (currentReq === searchRequestId) {
        fileResults.value = []
        fileSearchError.value = '文件搜索暂不可用，请重试'
      }
      console.warn('[useCommandSearch] 本地文件检索异常:', err)
    } finally {
      if (currentReq === searchRequestId) {
        isSearching.value = false
      }
    }
  }

  async function loadApplicationIcons(items) {
    const api = typeof window !== 'undefined' ? window.ztools?.sys : null
    if (!api?.getFileIcon) return
    const targets = items.filter((item) => item?.isApplication && !item.icon && !failedIconPaths.has(item.path))
    await Promise.all(targets.map(async (item) => {
      try {
        let pending = applicationIcons.get(item.path)
        if (!pending) {
          pending = Promise.resolve(api.getFileIcon(item.path))
          if (applicationIcons.size >= MAX_APPLICATION_ICON_CACHE) applicationIcons.delete(applicationIcons.keys().next().value)
          applicationIcons.set(item.path, pending)
        }
        const icon = await pending
        if (disposed) return
        if (typeof icon === 'string' && icon.startsWith('data:image/')) {
          item.icon = icon
        } else {
          failedIconPaths.add(item.path)
        }
      } catch (error) {
        applicationIcons.delete(item.path)
        failedIconPaths.add(item.path)
        console.warn('[useCommandSearch] 应用图标读取失败:', error)
      }
    }))
  }

  /**
   * 触发搜索更新：插件与程序随 query 同步重排，文件检索防抖后发出
   */
  function search(text) {
    query.value = typeof text === 'string' ? text : ''
    const requestId = ++searchRequestId
    fileSearchError.value = ''
    fileSearchDegraded.value = false

    if (fileSearchDebounceTimer) {
      clearTimeout(fileSearchDebounceTimer)
      fileSearchDebounceTimer = null
    }
    if (applicationsAvailable.value && Date.now() - applicationsLoadedAt > APPLICATION_GRANT_REFRESH_MS) {
      void refreshApplications()
    }

    const trimmed = query.value.trim()
    // 只输入一个英文字母或数字时文件检索最慢、结果几乎都是噪声，只出程序与插件
    if (!trimmed || !enableFileSearch || /^[a-z0-9]$/i.test(trimmed)) {
      fileResults.value = []
      isSearching.value = false
      return
    }

    // 新结果到达前保留上一轮里文件名仍包含搜索词的文件，避免列表一缩一涨
    const lower = trimmed.toLowerCase()
    fileResults.value = fileResults.value.filter((item) =>
      String(item?.fileName || item?.name || '').toLowerCase().includes(lower)
    )
    isSearching.value = true
    fileSearchDebounceTimer = setTimeout(() => {
      fileSearchDebounceTimer = null
      searchFilesLocally(query.value, requestId)
    }, FILE_SEARCH_DEBOUNCE_MS)
  }

  function clearSearch() {
    searchRequestId++
    if (fileSearchDebounceTimer) clearTimeout(fileSearchDebounceTimer)
    fileSearchDebounceTimer = null
    query.value = ''
    fileResults.value = []
    fileSearchError.value = ''
    fileSearchDegraded.value = false
    isSearching.value = false
  }

  const onWindowFocus = () => {
    void refreshApplications()
  }
  let grantRefreshTimer = null
  if (getCurrentScope()) {
    if (typeof window !== 'undefined') window.addEventListener('focus', onWindowFocus)
    if (enableApplications) {
      grantRefreshTimer = setInterval(() => { void refreshApplications() }, APPLICATION_GRANT_REFRESH_MS)
    }
    onScopeDispose(() => {
      disposed = true
      searchRequestId++
      if (fileSearchDebounceTimer) clearTimeout(fileSearchDebounceTimer)
      if (grantRefreshTimer) clearInterval(grantRefreshTimer)
      if (typeof window !== 'undefined') window.removeEventListener('focus', onWindowFocus)
      applicationIcons.clear()
    })
  }
  void refreshApplications({ force: true })

  const commandCandidates = computed(() => buildCommandCandidates(pluginsStore))

  /**
   * 排序结果：上段是即时计算、插件、子命令、内置命令与程序的混排，下段是普通文件
   */
  const ranking = computed(() => {
    const rawQuery = query.value
    const q = normalizeSearchQuery(rawQuery)
    const frecencyMap = getFrecencySnapshot()
    const now = Date.now()
    const candidates = commandCandidates.value
    const ranges = new Map()

    if (!q) {
      // 空查询：按使用频率排，子命令只展示用过的，保持首屏清爽
      const commands = candidates
        .filter((item) => item.type !== 'plugin-feature' || frecencyMap[item.key])
        .map((item, index) => ({ item, frecency: calculateFrecencyBonus(frecencyMap[item.key], now), index }))
        .sort((a, b) => b.frecency - a.frecency || a.index - b.index)
        .map((entry) => entry.item)
      return { commands, top: commands, files: [], ranges }
    }

    const learnedKey = getQueryChoicesSnapshot()[q]?.key || ''
    const toEntry = (item, index, match) => {
      if (match.range && item.key) ranges.set(item.key, match.range)
      const learned = learnedKey !== '' && item.key === learnedKey && match.tier < MATCH_TIERS.ALIAS
      return {
        item,
        tier: learned ? LEARNED_TIER : match.tier,
        secondary: match.secondary ? 1 : 0,
        field: match.field,
        typeRank: resultTypeRank(item),
        frecency: calculateFrecencyBonus(frecencyMap[item.key], now),
        length: String(item.name || item.title || '').length,
        index
      }
    }

    const entries = []
    const localApps = applicationsAvailable.value
      ? applicationResults.value
      : fileResults.value.filter((item) => item?.isApplication)
    ;[...candidates, ...localApps].forEach((item, index) => {
      const match = matchItemWithQuery(item, q)
      if (match.matched) entries.push(toEntry(item, index, match))
    })
    entries.sort(compareRanked)

    const appPaths = new Set(localApps.map((item) => item.path))
    const fileEntries = []
    fileResults.value.forEach((item, index) => {
      if (!item || appPaths.has(item.path)) return
      // 主进程按文件名命中、前端规则没认出来的（如只命中扩展名）排在文件段最后，不丢弃
      const match = matchItemWithQuery(item, q)
      fileEntries.push({
        ...toEntry(item, index, match.matched ? match : { tier: MATCH_TIERS.NONE, secondary: false, field: 3, range: null }),
        mtime: Number(item.mtime) || 0,
        depth: String(item.path).split(/[\\/]/).length
      })
    })
    fileEntries.sort(compareFiles)

    const ranked = entries.map((entry) => entry.item)
    const commands = ranked.filter((item) => !item.isApplication)
    // Raycast rootSearch: 当输入命中有效算式/单位换算/汇率/日期/色值时，置顶展示临时结果卡片
    const inlineItem = evaluateInlineCommandItem(rawQuery)
    return {
      commands: inlineItem ? [inlineItem, ...commands] : commands,
      top: inlineItem ? [inlineItem, ...ranked] : ranked,
      files: fileEntries.map((entry) => entry.item),
      ranges
    }
  })

  /** 即时计算 + 插件、子命令与内置命令（不含程序与文件） */
  const matchedPlugins = computed(() => ranking.value.commands)

  /**
   * 最终呈现的组合列表：即时计算置顶，程序与插件命令按匹配档统一混排，普通文件在后
   */
  const filteredItems = computed(() => [...ranking.value.top, ...ranking.value.files])

  /** 名称的高亮片段，命中区间在排序时已算好，渲染时不再重复匹配 */
  function highlightParts(item) {
    const text = String(item?.name || item?.title || '')
    return splitHighlightParts(text, item?.key ? ranking.value.ranges.get(item.key) : null)
  }

  // 排在前面的程序按需取图标（主进程有缓存），取不到的本次不再重试
  watch(
    () => filteredItems.value
      .slice(0, APPLICATION_ICON_BATCH)
      .filter((item) => item?.isApplication && !item.icon && !failedIconPaths.has(item.path))
      .map((item) => item.path)
      .join('\n'),
    (pending) => {
      if (pending) void loadApplicationIcons(filteredItems.value.slice(0, APPLICATION_ICON_BATCH))
    }
  )

  return {
    query,
    matchedPlugins,
    fileResults,
    filteredItems,
    isSearching,
    fileSearchError,
    fileSearchDegraded,
    search,
    clearSearch,
    recordUsage,
    highlightParts,
    refreshApplications,
    builtinSystemItems: BUILTIN_COMMAND_ITEMS
  }
}
