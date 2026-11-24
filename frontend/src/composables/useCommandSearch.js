/**
 * 悬浮条与工作台共用的命令检索内核
 *
 * 1. 程序列表在窗口打开时取一次，与插件、子命令一起在本地当场匹配，按键后同一帧就有结果；
 * 2. 普通文件走主进程检索，晚到的结果单独排在下面一段，不让已显示的结果跳位；
 * 3. 全局 7 级分类权重：系统原生工具 > 系统已安装软件 > 已安装插件
 *    > 插件子命令 > 本地文件夹 > 本地普通文件 > 宿主内置指令；
 * 4. 连续输入时按请求序号丢弃过期的文件结果。
 */

import { ref, computed, watch, getCurrentScope, onScopeDispose } from 'vue'
import { BUNDLED_VISIBILITY_SIGNAL, usePluginsStore } from '@/stores/plugins'
import { i18n, t, getCurrentLocale } from '@/i18n'
import {
  getLocalizedPluginField,
  getLocalizedPluginName,
  getLocalizedPluginDescription,
  getLocalizedPluginAltNames,
  getLocalizedPluginKeywords,
  getLocalizedFeatureExplain,
  getLocalizedFeatureCmds,
  getLocalizedFeatureAltNames
} from '@/utils/pluginI18n'
import {
  MATCH_TIERS,
  MATCH_TIER_SCORES,
  matchItemWithQuery,
  normalizeSearchQuery,
  splitHighlightParts
} from '@/utils/pinyinSearch'
import { openSettings } from '@/utils/internalPlugins'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { resolveErrorMessage } from '@/utils/errorMessage'
import {
  BUILTIN_COMMAND_ZH_EXTRA_ALT_NAMES,
  BUILTIN_COMMAND_ZH_KEYWORDS,
  COMMAND_FA_ICON_RULES
} from './commandSearch.zh-data'
import { track } from '@edition'
// 与内置计算器插件同一份计算引擎（由 scripts/sync-bundled-plugins.mjs 同步）
import { evaluateCalculatorQuery, addCalculatorHistory } from '@/vendor/calculator-engine.js'

const STORAGE_KEY_FRECENCY = 'ztools_command_frecency'
const STORAGE_KEY_QUERY_CHOICES = 'ztools_command_query_choices'
const MAX_QUERY_CHOICES = 300
/** 每个搜索词最多记住的候选条目数 */
const MAX_CHOICES_PER_QUERY = 5
/** 顶部固定常用磁贴宫格列数（自适应 1 排至 2 排滚动，不限制总数量） */
export const PINNED_GRID_COLUMNS = 9
/** 使用频次的半衰期：30 天前的一次使用只算半次，长期不用的条目自然退场 */
const FREQUENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
/** 搜索态 Frecency 加分上限；空查询直接用不封顶的原始分，避免常用项同时到顶后失去先后 */
const FRECENCY_BOOST_CAP = 180
/** 空查询活跃梯队门槛：低于该分（单次使用约 90 天后）回落到默认推荐梯队 */
const EMPTY_QUERY_ACTIVE_MIN_FRECENCY = 3
/** 空查询热度分档宽度：先分档再比较，分差很小时让分类权重决胜，同时保证比较器满足传递性 */
const EMPTY_QUERY_HEAT_STEP = 5
/** 搜索词选择记忆：每选一次，该词下其它候选的权重乘以该系数（权重上限 1 / (1 - 0.8) = 5） */
const QUERY_CHOICE_DECAY = 0.8
const QUERY_CHOICE_MAX_SCORE = 1 / (1 - QUERY_CHOICE_DECAY)
/** 首选项权重达到该值（约连续选中 2 次）才算稳定习惯；只选过 1 次时要求匹配本身达到开头一致 */
const QUERY_CHOICE_STABLE_SCORE = 1.5

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
    console.warn('[useCommandSearch] 复制剪贴板失败:', err)
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
      math: t('launcher.badges.math'),
      unit: t('launcher.badges.unit'),
      currency: t('launcher.badges.currency'),
      date: t('launcher.badges.date'),
      color: t('launcher.badges.color')
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
          ? t('launcher.inline.colorDesc', { rgb: res.colorResult?.rgb || '' })
          : t('launcher.inline.calcDesc')),
      subtitle: res.details || t('launcher.inline.calcSubtitle'),
      badge: badgeMap[res.type] || t('launcher.badges.math'),
      actionLabel: t('launcher.inline.copyAction'),
      icon: res.colorResult?.svgDataUri || '',
      faIcon: isColor ? 'fa-tint' : 'fa-calculator',
      pluginId: 'calculator',
      action: async () => {
        const ok = await copyInlineAnswerToClipboard(res.formattedAnswer)
        if (!ok) return false
        try {
          await addCalculatorHistory(res.expression, res.formattedAnswer, res.type)
        } catch (err) {
          console.warn('[useCommandSearch] 写入计算历史失败:', err)
        }
        return res.formattedAnswer
      }
    }
  } catch (err) {
    console.warn('[useCommandSearch] 内联计算求值异常:', err)
    return null
  }
}

// 内置快捷工具条目定义（宿主内置指令，处于最低分类权重；按当前 locale 动态生成主显示名，另一语言写入 altNames / keywords）
export function getBuiltinCommandItems(locale = getCurrentLocale()) {
  const isEn = locale === 'en-US'
  const altLocale = isEn ? 'zh-CN' : 'en-US'
  const translate = (key) => (locale === getCurrentLocale() ? t(key) : i18n.global.t(key, {}, { locale }))
  const translateAlt = (key) => i18n.global.t(key, {}, { locale: altLocale })
  return [
    {
      key: 'system-settings',
      name: translate('launcher.builtins.systemSettingsName'),
      altNames: [translateAlt('launcher.builtins.systemSettingsName')],
      keywords: ['settings', 'preferences', 'config', ...BUILTIN_COMMAND_ZH_KEYWORDS['system-settings']],
      description: translate('launcher.builtins.systemSettingsDesc'),
      badge: translate('launcher.badges.system'),
      actionLabel: translate('launcher.builtins.systemSettingsAction'),
      faIcon: 'fa-sliders',
      action: async () => {
        const res = await openSettings()
        if (typeof window === 'undefined' || !window.__ztoolsLauncher?.expandToDashboard) {
          switchWindowMode(WINDOW_MODES.DASHBOARD).catch((err) => console.warn('[useCommandSearch] 切换窗口模式失败:', err))
        }
        return res
      }
    },
    {
      key: 'system-dashboard',
      name: translate('launcher.builtins.dashboardName'),
      altNames: isEn
        ? [translateAlt('launcher.builtins.dashboardName'), ...BUILTIN_COMMAND_ZH_EXTRA_ALT_NAMES['system-dashboard']]
        : ['Open Plugin Hub', 'Workspace'],
      keywords: ['workspace', 'dashboard', 'hub', ...BUILTIN_COMMAND_ZH_KEYWORDS['system-dashboard']],
      description: translate('launcher.builtins.dashboardDesc'),
      badge: translate('launcher.badges.workbench'),
      actionLabel: translate('launcher.builtins.dashboardAction'),
      faIcon: 'fa-th-large',
      action: () => {
        switchWindowMode(WINDOW_MODES.DASHBOARD).catch((err) => console.warn('[useCommandSearch] 切换窗口模式失败:', err))
      }
    },
    {
      key: 'developer-create-extension',
      name: translate('launcher.builtins.createExtensionName'),
      altNames: [translateAlt('launcher.builtins.createExtensionName')],
      keywords: ['extension', 'plugin', 'dev', ...BUILTIN_COMMAND_ZH_KEYWORDS['developer-create-extension']],
      description: translate('launcher.builtins.createExtensionDesc'),
      badge: translate('launcher.badges.developer'),
      actionLabel: translate('launcher.builtins.createExtensionAction'),
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
      name: translate('launcher.builtins.githubRepoName'),
      altNames: isEn ? [translateAlt('launcher.builtins.githubRepoName')] : ['ZTools Extensions'],
      keywords: ['github', 'extensions', 'open source', ...BUILTIN_COMMAND_ZH_KEYWORDS['developer-github-repo']],
      description: translate('launcher.builtins.githubRepoDesc'),
      badge: translate('launcher.badges.openSource'),
      actionLabel: translate('launcher.builtins.githubRepoAction'),
      faIcon: 'fa-github',
      action: () => {
        if (window.ztools?.shell?.openExternal) {
          window.ztools.shell.openExternal('https://github.com/ZToolsTeam/ZTools-extensions')
        } else {
          window.open('https://github.com/ZToolsTeam/ZTools-extensions', '_blank')
        }
      }
    }
  ]
}

const BUILTIN_COMMAND_KEYS = Object.freeze([
  'system-settings',
  'system-dashboard',
  'developer-create-extension',
  'developer-github-repo'
])

const BUILTIN_COMMAND_KEY_SET = new Set(BUILTIN_COMMAND_KEYS)

/**
 * 归一化固定文件路径用于唯一键生成：
 * Windows 路径去掉非根盘符末尾分隔符并转小写；POSIX 路径去掉非根目录末尾斜杠并保持大小写。
 */
function normalizePinFilePath(rawPath) {
  const p = String(rawPath || '').trim()
  if (!p) return ''
  if (/^[a-z]:[\\/]|^\\\\/i.test(p)) {
    const isUnc = p.startsWith('\\\\')
    const slashesUnified = p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
    const winNormalized = isUnc ? `\\${slashesUnified}` : slashesUnified
    const stripped = /^[a-z]:\\+$/i.test(winNormalized)
      ? winNormalized.slice(0, 3)
      : winNormalized.replace(/\\+$/, '')
    return stripped.toLowerCase()
  }
  const posixNormalized = p.replace(/\/{2,}/g, '/')
  return posixNormalized === '/' ? '/' : (posixNormalized.replace(/\/+$/, '') || '/')
}

/**
 * 规范化结构化的 PinnedEntry 描述符（支持 plugin、plugin-feature、builtin、system-tool、file 共 5 类）
 */
function normalizePinEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  switch (raw.kind) {
    case 'plugin': {
      const pluginId = String(raw.pluginId || '').trim()
      return pluginId ? { kind: 'plugin', pluginId } : null
    }
    case 'plugin-feature': {
      const pluginId = String(raw.pluginId || '').trim()
      const featureCode = String(raw.featureCode || '').trim()
      return pluginId && featureCode ? { kind: 'plugin-feature', pluginId, featureCode } : null
    }
    case 'builtin': {
      const commandKey = String(raw.commandKey || '').trim()
      return commandKey ? { kind: 'builtin', commandKey } : null
    }
    case 'system-tool': {
      const toolId = String(raw.toolId || '').trim()
      return toolId ? { kind: 'system-tool', toolId } : null
    }
    case 'file': {
      const path = typeof raw.path === 'string' ? raw.path : ''
      if (!path.trim()) return null
      return {
        kind: 'file',
        path,
        name: String(raw.name || raw.title || raw.fileName || path),
        isDir: Boolean(raw.isDir),
        isApplication: Boolean(raw.isApplication)
      }
    }
    default:
      return null
  }
}

/**
 * 将搜索结果条目或面板条目构建为 5 类可固定 PinnedEntry 描述符；
 * 即时计算、单位换算、色值速查、工作台市场跳转项及旧版残留 local 条目返回 null（不可固定）。
 */
export function buildPinPayload(item) {
  if (!item || typeof item !== 'object') return null
  if (
    item.ephemeral ||
    item.type === 'inline-calculator' ||
    item.type === 'inline-color' ||
    item.type === 'market-search' ||
    item.type === 'local-app' ||
    item.type === 'local' ||
    item.panelItemType === 'local'
  ) {
    return null
  }
  if (typeof item.kind === 'string' && !item.type) {
    return normalizePinEntry(item)
  }
  if (item.type === 'plugin-feature') {
    const pluginId = String(item.pluginId || '').trim()
    const featureCode = String(item.featureCode || '').trim()
    return pluginId && featureCode ? { kind: 'plugin-feature', pluginId, featureCode } : null
  }
  if (item.type === 'builtin-command' || (!item.type && BUILTIN_COMMAND_KEY_SET.has(item.key))) {
    const commandKey = String(item.key || '').trim()
    return commandKey ? { kind: 'builtin', commandKey } : null
  }
  if (item.type === 'system-tool' || item.panelItemType === 'system_tool') {
    const rawTarget =
      item.target ||
      (typeof item.id === 'string' ? item.id.replace(/^system-tool:/, '') : '') ||
      (typeof item.key === 'string' && item.key.startsWith('system-tool:') ? item.key.slice('system-tool:'.length) : '')
    const toolId = String(rawTarget || '').trim()
    return toolId ? { kind: 'system-tool', toolId } : null
  }
  if (item.type === 'file') {
    const path = typeof item.path === 'string' ? item.path : ''
    if (!path.trim()) return null
    return {
      kind: 'file',
      path,
      name: String(item.name || item.title || item.fileName || path),
      isDir: Boolean(item.isDir),
      isApplication: Boolean(item.isApplication)
    }
  }
  if (item.type === 'plugin' || (!item.type && (item.pluginId || item.id))) {
    const pluginId = String(item.pluginId || item.id || '').trim()
    return pluginId ? { kind: 'plugin', pluginId } : null
  }
  if (item.pinEntry && typeof item.pinEntry === 'object') {
    return normalizePinEntry(item.pinEntry)
  }
  return null
}

/**
 * 判断条目是否允许固定到悬浮条首屏
 */
export function canPinItem(item) {
  return Boolean(buildPinPayload(item))
}

/**
 * 计算条目的唯一固定键 pinKey（与主进程规则严格对齐，且与 item.key 保持隔离）
 */
export function resolvePinKey(itemOrEntry) {
  if (!itemOrEntry || typeof itemOrEntry !== 'object') return ''
  const source = itemOrEntry.entry && !itemOrEntry.type && !itemOrEntry.kind
    ? itemOrEntry.entry
    : itemOrEntry
  const entry = typeof source.kind === 'string' && !source.type
    ? normalizePinEntry(source)
    : buildPinPayload(source)
  if (!entry) {
    if (typeof source.kind === 'string') return ''
    const rawPinKey = typeof itemOrEntry.pinKey === 'string' ? itemOrEntry.pinKey.trim() : ''
    return rawPinKey && !rawPinKey.startsWith('local-app:') ? rawPinKey : ''
  }
  switch (entry.kind) {
    case 'plugin':
      return `plugin:${entry.pluginId}`
    case 'plugin-feature':
      return `plugin-feature:${entry.pluginId}:${entry.featureCode}`
    case 'builtin':
      return `builtin:${entry.commandKey}`
    case 'system-tool':
      return `system-tool:${entry.toolId}`
    case 'file': {
      const normalized = normalizePinFilePath(entry.path)
      return normalized ? `file:${normalized}` : ''
    }
    default:
      return ''
  }
}

/**
 * 全局 7 级分类权重顺序（系统原生工具 > 系统已安装软件 > 已安装插件 > 插件子命令 > 本地文件夹 > 本地普通文件 > 宿主内置指令）：
 * 数值越小代表分类优先级越高
 */
export const CATEGORY_RANKS = Object.freeze({
  SYSTEM_TOOL: 1,       // 系统原生工具 (system-tool)
  INSTALLED_APP: 2,     // 系统已安装的软件 (isApplication)
  PLUGIN: 3,            // 已安装插件主入口 (plugin)
  PLUGIN_FEATURE: 4,    // 插件子命令 (plugin-feature)
  FILE_DIRECTORY: 5,    // 本地文件夹 (file && isDir)
  FILE_REGULAR: 6,      // 本地普通文件 (file && !isDir)
  HOST_BUILTIN: 7       // 宿主内置指令 (BUILTIN_COMMAND_ITEMS) — 最低排序位置
})

/** 搜索态各分类对应的附加权重分（CategoryWeight） */
export const CATEGORY_WEIGHTS = Object.freeze({
  [CATEGORY_RANKS.SYSTEM_TOOL]: 70,
  [CATEGORY_RANKS.INSTALLED_APP]: 60,
  [CATEGORY_RANKS.PLUGIN]: 35,
  [CATEGORY_RANKS.PLUGIN_FEATURE]: 20,
  [CATEGORY_RANKS.FILE_DIRECTORY]: 10,
  [CATEGORY_RANKS.FILE_REGULAR]: 5,
  [CATEGORY_RANKS.HOST_BUILTIN]: 0
})

/**
 * 获取条目的全局分类等级（1 ~ 7，越小越优先）
 */
export function getCategoryRank(item) {
  if (!item || typeof item !== 'object') return CATEGORY_RANKS.HOST_BUILTIN
  // 内置指令没有 type 字段，只按登记的 key 识别；同 key 的插件仍按插件归类
  if (item.type === 'builtin-command' || (!item.type && BUILTIN_COMMAND_KEY_SET.has(item.key))) {
    return CATEGORY_RANKS.HOST_BUILTIN
  }
  if (item.type === 'system-tool') {
    return CATEGORY_RANKS.SYSTEM_TOOL
  }
  if (item.isApplication) {
    return CATEGORY_RANKS.INSTALLED_APP
  }
  if (item.type === 'plugin') {
    return CATEGORY_RANKS.PLUGIN
  }
  if (item.type === 'plugin-feature') {
    return CATEGORY_RANKS.PLUGIN_FEATURE
  }
  if (item.type === 'file') {
    return item.isDir ? CATEGORY_RANKS.FILE_DIRECTORY : CATEGORY_RANKS.FILE_REGULAR
  }
  // 未登记的条目类型一律归最低档，新增类型不会悄悄排到最前面
  return CATEGORY_RANKS.HOST_BUILTIN
}

/**
 * 获取条目的分类权重加分（0 ~ 70）
 */
export function getCategoryWeight(item) {
  return CATEGORY_WEIGHTS[getCategoryRank(item)] ?? 0
}

// 语义矢量图标智能匹配（关键词表维护在 commandSearch.zh-data.js）
export function resolveCommandFaIcon(name, category) {
  const str = `${name || ''} ${category || ''}`.toLowerCase()
  for (const rule of COMMAND_FA_ICON_RULES) {
    if (rule.keywords.some((kw) => str.includes(kw))) {
      return rule.icon
    }
  }
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
    console.warn('[useCommandSearch] 读取 Frecency 缓存失败:', err)
    return {}
  }
}

const frecencyVersion = ref(0)

/**
 * 持久化 frecency 字典
 */
export function saveFrecencyMap(map) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_FRECENCY, JSON.stringify(map))
    }
    frecencyVersion.value++
  } catch (err) {
    console.warn('[useCommandSearch] 保存 Frecency 缓存失败:', err)
  }
}

function isValidUsageStats(stats) {
  return Boolean(stats) && typeof stats.lastUsed === 'number' && Number.isFinite(stats.lastUsed) && stats.lastUsed > 0
}

/**
 * 截至 now 的衰减使用次数：每次使用记 1 次，按 30 天半衰期指数衰减。
 * 旧记录没有 score 字段时用累计次数 count 代替。
 */
function decayedUsageScore(stats, now) {
  const stored = Number(stats.score)
  const base = Number.isFinite(stored) ? Math.max(0, stored) : Math.max(1, Number(stats.count) || 1)
  const ageMs = Math.max(0, now - stats.lastUsed)
  return base * Math.pow(0.5, ageMs / FREQUENCY_HALF_LIFE_MS)
}

/**
 * 计算单个条目不封顶的 Frecency 原始分（0 ~ 220），空查询直接用它排序
 */
export function calculateFrecencyScore(stats, now = Date.now()) {
  if (!isValidUsageStats(stats)) return 0
  const hours = Math.max(0, now - stats.lastUsed) / (1000 * 60 * 60)
  // 近期活跃度分：1 / (1 + t / 4h) 双曲衰减，4 小时时减半，随时间连续下降（消灭 1 小时内同分乱序问题）
  const recencyBonus = 120 / (1 + hours / 4)
  // 历史频次分：对衰减后的使用次数取对数防刷屏（封顶 100 分）
  const frequencyBonus = Math.min(100, 25 * Math.log(1 + decayedUsageScore(stats, now)))
  return recencyBonus + frequencyBonus
}

/**
 * 搜索态的 Frecency 加分（0 ~ 180，取整后封顶）
 */
export function calculateFrecencyBonus(stats, now = Date.now()) {
  return Math.min(FRECENCY_BOOST_CAP, Math.round(calculateFrecencyScore(stats, now)))
}

/**
 * 合并同一程序在多个 key 下的使用记录（如系统工具与开始菜单里的同名程序）
 */
function mergeUsageStats(list) {
  const valid = list.filter(isValidUsageStats)
  if (valid.length <= 1) return valid[0]
  const lastUsed = Math.max(...valid.map((stats) => stats.lastUsed))
  return {
    count: valid.reduce((sum, stats) => sum + (Number(stats.count) || 0), 0),
    score: valid.reduce((sum, stats) => sum + decayedUsageScore(stats, lastUsed), 0),
    lastUsed
  }
}

/** 已安装程序的展示信息：冷启动时程序列表还没返回，空查询先用它显示用过的程序 */
function normalizeUsageMeta(itemKey, item) {
  if (!item || item.type !== 'file' || !item.isApplication) return null
  const path = typeof item.path === 'string' ? item.path.slice(0, 1024) : ''
  const name = String(item.name || item.title || '').slice(0, 256)
  if (!path || !name || itemKey !== 'file:' + path) return null
  return { name, path }
}

/**
 * 记录条目使用历史
 * @param {string} itemKey
 * @param {object} [item] 被打开的条目；已安装程序会顺带记下名称与路径
 */
export function recordCommandUsage(itemKey, item) {
  if (!itemKey || String(itemKey).startsWith('inline-calc:')) return
  const now = Date.now()
  const map = loadFrecencyMap()
  const existing = map[itemKey] && typeof map[itemKey] === 'object' ? map[itemKey] : null
  const previousScore = isValidUsageStats(existing) ? decayedUsageScore(existing, now) : 0
  const next = {
    count: (Number(existing?.count) || 0) + 1,
    score: Math.round((previousScore + 1) * 1000) / 1000,
    lastUsed: now
  }
  const meta = normalizeUsageMeta(itemKey, item) || existing?.meta
  if (meta) next.meta = meta
  map[itemKey] = next
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
 * 读取「搜索词 → 选中项」记录
 * @returns {Record<string, { key: string, at: number, counts?: Record<string, { score?: number, count?: number, at: number }> }>}
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

/** 单个候选的选择权重；旧记录只有累计次数，按权重上限折算，避免历史大次数让习惯永远无法迁移 */
function readChoiceScore(entry) {
  if (!entry || typeof entry !== 'object') return 0
  const stored = Number(entry.score)
  const value = Number.isFinite(stored) ? stored : Number(entry.count) || 0
  return Math.max(0, Math.min(QUERY_CHOICE_MAX_SCORE, value))
}

function readChoiceCounts(record) {
  const counts = record?.counts
  return counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : null
}

/**
 * 某个搜索词的首选项：权重最高的候选，同权重取最近选中的
 * @returns {{ key: string, score: number } | null}
 */
export function resolveQueryChoice(record) {
  if (!record || typeof record !== 'object') return null
  const counts = readChoiceCounts(record)
  // 最早的记录只存了一个 key，相当于只选过 1 次
  if (!counts) return record.key ? { key: String(record.key), score: 1 } : null
  let best = null
  for (const [itemKey, entry] of Object.entries(counts)) {
    const score = readChoiceScore(entry)
    const at = Number(entry?.at) || 0
    if (score <= 0) continue
    if (!best || score > best.score || (score === best.score && at > best.at)) best = { key: itemKey, score, at }
  }
  return best ? { key: best.key, score: best.score } : null
}

/**
 * 记住这个搜索词选中的是哪一项。
 * 每选一次，该词下其它候选的权重乘以 0.8、选中项加 1（权重上限 5）：
 * 偶发误点 1 次压不过旧习惯，连续改选 2~4 次即可完成习惯迁移，用得再久的旧习惯也不会永远锁死。
 */
export function recordQueryChoice(rawQuery, itemKey) {
  const q = normalizeSearchQuery(rawQuery)
  const key = String(itemKey || '')
  if (!q || !key || key.startsWith('inline-calc:')) return
  const now = Date.now()
  const choices = loadQueryChoices()
  const prev = choices[q] && typeof choices[q] === 'object' ? choices[q] : null
  const prevCounts = readChoiceCounts(prev) || (prev?.key ? { [prev.key]: { score: 1, at: Number(prev.at) || now } } : {})

  const counts = {}
  for (const [entryKey, entry] of Object.entries(prevCounts)) {
    counts[entryKey] = {
      score: Math.round(readChoiceScore(entry) * QUERY_CHOICE_DECAY * 1000) / 1000,
      at: Number(entry?.at) || 0
    }
  }
  counts[key] = { score: Math.round(((counts[key]?.score || 0) + 1) * 1000) / 1000, at: now }

  // 只保留权重最高的几项；刚选中的这一项始终保留，否则新习惯永远攒不起来
  const others = Object.entries(counts)
    .filter(([entryKey]) => entryKey !== key)
    .sort((a, b) => b[1].score - a[1].score || b[1].at - a[1].at)
  for (const [staleKey] of others.slice(MAX_CHOICES_PER_QUERY - 1)) delete counts[staleKey]

  choices[q] = { key: resolveQueryChoice({ counts })?.key || key, at: now, counts }
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
 * 收集以当前查询词 q 为前缀、且已形成稳定习惯的历史首选项（用于前缀意图继承加分）
 */
function collectPrefixLearnedKeys(choices, q) {
  if (!q || q.length < 2 || !choices || typeof choices !== 'object') return new Set()
  const set = new Set()
  for (const [savedQuery, record] of Object.entries(choices)) {
    if (savedQuery.length <= q.length || !savedQuery.startsWith(q)) continue
    const choice = resolveQueryChoice(record)
    if (choice && choice.score >= QUERY_CHOICE_STABLE_SCORE) set.add(choice.key)
  }
  return set
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
export function normalizePluginFeatures(plugin, locale = getCurrentLocale()) {
  if (!plugin || typeof plugin !== 'object') return []
  const rawFeatures = Array.isArray(plugin.features)
    ? plugin.features
    : Array.isArray(plugin.manifest?.features)
      ? plugin.manifest.features
      : []

  const seenCodes = new Set()
  const result = []

  const hasText = (val) => typeof val === 'string' && val.trim().length > 0
  const pickFeatureMeta = (p, code) =>
    p?.i18n?.[locale]?.features?.[code] || p?.manifest?.i18n?.[locale]?.features?.[code] || null

  for (const feat of rawFeatures) {
    if (!feat || typeof feat !== 'object') continue
    const code = String(feat.code || '').trim()
    if (!code || seenCodes.has(code)) continue

    const localizedEntry = pickFeatureMeta(plugin, code)
    const hasExplicitExplain =
      hasText(localizedEntry?.explain) ||
      hasText(localizedEntry?.title) ||
      hasText(localizedEntry?.name) ||
      hasText(localizedEntry?.label) ||
      hasText(feat.i18n?.[locale]?.explain) ||
      hasText(feat.i18n?.[locale]?.title) ||
      hasText(feat.i18n?.[locale]?.name) ||
      hasText(feat.i18n?.[locale]?.label) ||
      hasText(feat.explain) ||
      hasText(feat.title) ||
      hasText(feat.name) ||
      hasText(feat.label)
    if (!hasExplicitExplain) continue

    const localizedExplain = getLocalizedFeatureExplain(plugin, feat, locale)
    const explain =
      localizedExplain && localizedExplain !== code
        ? localizedExplain
        : (
            (hasText(localizedEntry?.title) ? localizedEntry.title.trim() : '') ||
            (hasText(localizedEntry?.name) ? localizedEntry.name.trim() : '') ||
            getLocalizedPluginField(feat, 'title', locale) ||
            getLocalizedPluginField(feat, 'name', locale) ||
            localizedExplain
          )
    if (!explain) continue
    seenCodes.add(code)

    const rawMode = String(feat.mode || plugin.mode || plugin.manifest?.mode || 'view').trim()
    const mode = ['view', 'no-view'].includes(rawMode) ? rawMode : 'view'
    const alias = typeof feat.alias === 'string' ? feat.alias.trim() : ''
    const shortcut = typeof feat.shortcut === 'string' ? feat.shortcut.trim() : ''
    const cmds = getLocalizedFeatureCmds(plugin, feat, locale)
    const altNames = getLocalizedFeatureAltNames(plugin, feat, explain)

    result.push({
      code,
      explain,
      mode,
      alias,
      shortcut,
      icon: typeof feat.icon === 'string' ? feat.icon : '',
      cmds,
      altNames
    })
  }

  return result
}

const FILE_SEARCH_DEBOUNCE_MS = 80
const APPLICATION_REFRESH_INTERVAL_MS = 5000
/** 主进程给结果路径的打开授权 30 分钟过期：窗口开着时每 10 分钟刷新一次程序列表（顺带续期），搜索时发现过旧也刷新 */
const APPLICATION_GRANT_REFRESH_MS = 10 * 60 * 1000
const APPLICATION_ICON_BATCH = 24
const MAX_APPLICATION_ICON_CACHE = 512

const USER_PRIORITY_DIR_RE = /(?:^|[\\/])(?:Desktop|Documents|Downloads|桌面|文档|下载)(?:[\\/]|$)/i
const SYSTEM_NOISE_DIR_RE = /(?:^|[\\/])(?:node_modules|\.git|AppData|Library[\\/]Caches)(?:[\\/]|$)/i

function computeUserDirBoost(filePath) {
  const p = String(filePath || '')
  if (!p) return 0
  if (SYSTEM_NOISE_DIR_RE.test(p)) return -1
  if (USER_PRIORITY_DIR_RE.test(p)) return 1
  return 0
}

function normalizeAppName(name) {
  return String(name || '').trim().toLowerCase()
}

/**
 * 去掉与「系统工具」同名的已安装程序，
 * 保留优先级更高的系统工具，并记下被合并程序的使用记录 key，排序时合并到保留的条目上。
 * @returns {{ apps: object[], aliases: Map<string, string[]> }}
 */
function dedupeInstalledApps(apps, ownerItems) {
  const aliases = new Map()
  if (!apps.length || !ownerItems.length) return { apps, aliases }
  const byName = new Map()
  for (const owner of ownerItems) {
    const name = normalizeAppName(owner.name)
    if (name && !byName.has(name)) byName.set(name, owner.key)
  }
  const kept = []
  for (const app of apps) {
    const ownerKey = byName.get(normalizeAppName(app.name))
    if (!ownerKey) {
      kept.push(app)
      continue
    }
    const list = aliases.get(ownerKey) || []
    list.push(app.key)
    aliases.set(ownerKey, list)
  }
  return { apps: kept, aliases }
}

/** 冷启动时程序列表还没返回：用使用记录里存下的名称与路径先显示用过的程序（打开前要等列表返回拿到授权） */
function buildPendingApplicationItems(frecencyMap) {
  const items = []
  for (const [key, stats] of Object.entries(frecencyMap)) {
    const meta = stats?.meta
    if (!meta || typeof meta.path !== 'string' || typeof meta.name !== 'string') continue
    if (key !== 'file:' + meta.path) continue
    const fileName = meta.path.split(/[\\/]/).filter(Boolean).pop() || meta.path
    items.push(Object.assign(
      toFileItem({ path: meta.path, name: fileName, display_name: meta.name, kind: 'application', is_dir: false, size: 0, mtime: 0 }),
      { pendingGrant: true }
    ))
  }
  return items
}

/**
 * 空查询（Zero-Query）排序比较器：
 * 1. 梯队优先级：活跃未固定项 (0) > 未使用默认推荐项 (1) > 已在顶部固定宫格展示的项 (2)
 * 2. 热度档：不封顶的 Frecency 原始分按 5 分一档取整后比较（先分档再比，保证比较器满足传递性）
 * 3. 同一热度档内按全局分类等级决胜：系统工具(1) > 已安装软件(2) > 插件(3) > 子命令(4) > 宿主内置指令(7)
 * 4. 最后使用时间戳决胜（确保刚用过的排在前面），再保持原始顺序
 */
export function compareEmptyQuery(a, b) {
  return a.emptyBucket - b.emptyBucket ||
    b.heatTier - a.heatTier ||
    a.categoryRank - b.categoryRank ||
    b.lastUsed - a.lastUsed ||
    a.index - b.index
}

/**
 * 搜索态主候选段排序比较器：
 * 1. 综合得分 CompositeScore = TierScore + CategoryWeight + MatchQualityScore + FrecencyBoost + QueryPrefixBoost
 * 2. 同分时严格按全局分类等级决胜：系统工具(1) > 已安装软件(2) > 插件(3) > 子命令(4) > 宿主内置指令(7)
 * 3. 最后使用时间决胜，再按名称紧凑度与原始顺序稳定排列
 */
function compareRanked(a, b) {
  return b.compositeScore - a.compositeScore ||
    a.categoryRank - b.categoryRank ||
    b.lastUsed - a.lastUsed ||
    a.length - b.length ||
    a.index - b.index
}

/**
 * 本地文件段排序比较器（本地文件夹(5) > 本地普通文件(6)）
 */
function compareFiles(a, b) {
  return b.tierScore - a.tierScore ||
    b.tier - a.tier ||
    a.secondary - b.secondary ||
    b.frecency - a.frecency ||
    a.categoryRank - b.categoryRank ||
    b.userDirBoost - a.userDirBoost ||
    b.mtime - a.mtime ||
    a.depth - b.depth ||
    a.index - b.index
}

function isFileRecord(f) {
  return Boolean(f) && typeof f.path === 'string' && typeof f.name === 'string'
}

/** 按当前应用语言重新计算文件/应用条目的展示 badge 与 actionLabel，保留图标、固定态等缓存字段 */
function localizeFileItem(item) {
  if (!item || typeof item !== 'object') return item
  const nextBadge = item.isApplication
    ? t('launcher.badges.app')
    : item.isDir
      ? t('launcher.badges.folder')
      : t('launcher.badges.file')
  const nextActionLabel = t('launcher.commandActions.open')
  if (item.badge === nextBadge && item.actionLabel === nextActionLabel) return item
  return {
    ...item,
    badge: nextBadge,
    actionLabel: nextActionLabel
  }
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
    badge: isApplication ? t('launcher.badges.app') : f.is_dir ? t('launcher.badges.folder') : t('launcher.badges.file'),
    faIcon: isApplication ? 'fa-th-large' : resolveFileFaIcon(f.name, f.is_dir),
    description: truncatePath(parentPath),
    subtitle: truncatePath(parentPath),
    actionLabel: t('launcher.commandActions.open'),
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
    if (p.revoked === true || p.enabled === false || pluginsStore.isRevoked?.(key) || pluginsStore.isBundledHidden?.(key)) {
      continue
    }

    const rawMode = String(p.mode || p.manifest?.mode || 'view').trim()
    const mode = ['view', 'no-view'].includes(rawMode) ? rawMode : 'view'
    const alias = String(p.alias || p.manifest?.alias || '').trim()
    const locale = getCurrentLocale()
    const features = normalizePluginFeatures(p, locale)
    const isDeclarative = isDeclarativePluginItem(p)
    const pluginName = getLocalizedPluginName(p, locale) || p.name || p.title || key
    const pluginDesc = getLocalizedPluginDescription(p, locale) || p.description || ''
    const altNames = getLocalizedPluginAltNames(p, pluginName)
    const keywords = getLocalizedPluginKeywords(p, locale)

    installed.push({
      ...p,
      key,
      pluginId: key,
      type: 'plugin',
      name: pluginName,
      title: pluginName,
      description: pluginDesc,
      altNames,
      keywords,
      mode,
      alias,
      features,
      isDeclarative,
      badge: p.badge || (mode === 'no-view' ? t('launcher.badges.quickAction') : t('launcher.badges.plugin')),
      faIcon: p.faIcon || resolveCommandFaIcon(p.name || pluginName, p.category),
      actionLabel: mode === 'no-view' ? t('launcher.commandActions.run') : t('launcher.commandActions.launch')
    })

    features.forEach((feat, index) => {
      // 与插件同名的默认子命令只保留插件这一条，避免结果里出现两条一样的名字
      if (index === 0 && feat.mode === mode && sameText(feat.explain, pluginName)) return
      const featureKeywords = feat.cmds
        .map((cmd) => (typeof cmd === 'string' ? cmd : (cmd && typeof cmd === 'object' ? String(cmd.label || cmd.value || cmd.name || '').trim() : '')))
        .filter(Boolean)
      featureItems.push({
        key: `${key}:${feat.code}`,
        type: 'plugin-feature',
        pluginId: key,
        pluginName,
        featureCode: feat.code,
        name: feat.explain,
        title: feat.explain,
        altNames: feat.altNames,
        keywords: featureKeywords,
        description: `${pluginName || key}${feat.alias ? t('launcher.commandActions.aliasSuffix', { alias: feat.alias }) : ''}`,
        subtitle: pluginName || key,
        alias: feat.alias,
        mode: feat.mode,
        shortcut: feat.shortcut,
        cmds: feat.cmds,
        icon: feat.icon || p.icon,
        faIcon: p.faIcon || resolveCommandFaIcon(feat.explain, p.category),
        badge: feat.mode === 'no-view' ? t('launcher.badges.quickAction') : (pluginName || t('launcher.badges.subcommand')),
        // 子命令行的标签是所属插件名（来源），不是类型；悬浮条据此把它显示得比类型标签弱一档
        badgeKind: feat.mode === 'no-view' ? 'type' : 'source',
        actionLabel: feat.mode === 'no-view' ? t('launcher.commandActions.run') : t('launcher.commandActions.open'),
        isDeclarative
      })
    })
  }

  const installedKeys = new Set(installed.map((item) => item.key))
  const remainingBuiltins = getBuiltinCommandItems().filter((item) => !installedKeys.has(item.key))
  return [...installed, ...featureItems, ...remainingBuiltins]
}

/**
 * 规范化主进程返回的 pinnedEntries 列表
 */
function normalizePinnedEntriesList(rawList) {
  if (!Array.isArray(rawList)) return []
  const result = []
  const seen = new Set()
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw.entry && typeof raw.entry === 'object' ? normalizePinEntry(raw.entry) : null
    if (!entry) continue
    const pinKey = typeof raw.pinKey === 'string' && raw.pinKey.trim()
      ? raw.pinKey.trim()
      : resolvePinKey(entry)
    if (!pinKey || seen.has(pinKey)) continue
    seen.add(pinKey)
    result.push({
      pinKey,
      entry,
      available: raw.available !== false,
      iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : ''
    })
  }
  return result
}

/**
 * 兼容旧版 getPanelData 仅返回 items（含 pinned: true 的插件与系统工具）时的结构转换；
 * 旧缓存中残留的 type: 'local' 条目直接安全忽略。
 */
function buildLegacyPinnedEntries(rawItems) {
  if (!Array.isArray(rawItems)) return []
  const result = []
  const seen = new Set()
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || !raw.pinned || !raw.id) continue
    const entry = raw.type === 'system_tool'
      ? { kind: 'system-tool', toolId: String(raw.id).trim() }
      : raw.type === 'plugin' || !raw.type
        ? { kind: 'plugin', pluginId: String(raw.id).trim() }
        : null
    if (!entry) continue
    const pinKey = resolvePinKey(entry)
    if (!pinKey || seen.has(pinKey)) continue
    seen.add(pinKey)
    result.push({
      pinKey,
      entry,
      available: raw.available !== false,
      iconUrl: typeof raw.iconUrl === 'string' ? raw.iconUrl : ''
    })
  }
  return result
}

/**
 * 按 pinnedKeySet 对条目独立染色，不改变条目的原始 item.key
 */
function withPinState(item, pinKeySet) {
  if (!item || typeof item !== 'object') return item
  const pinKey = resolvePinKey(item)
  const pinned = Boolean(pinKey && pinKeySet.has(pinKey))
  if (item.pinned === pinned && (!pinKey || item.pinKey === pinKey)) return item
  return {
    ...item,
    ...(pinKey ? { pinKey } : {}),
    pinned
  }
}

/**
 * 判断固定条目关联插件是否因用户隐藏、官方下架、被禁用或平台不支持而暂不展示（保留原位置，恢复后重现）
 */
function shouldHidePinnedPlugin(pluginId, rawPlugin, pluginsStore) {
  const pid = String(pluginId || '').trim()
  if (!pid) return false
  if (pluginsStore.isBundledHidden?.(pid)) return true
  if (rawPlugin?.revoked === true || pluginsStore.isRevoked?.(pid)) return true
  if (rawPlugin && rawPlugin.enabled === false) return true
  if (rawPlugin && !isPluginSupportedOnCurrentPlatform(rawPlugin)) return true
  if (!rawPlugin && !isPluginSupportedOnCurrentPlatform(pid)) return true
  return false
}

/**
 * 按单个 PinnedEntry 记录还原展示条目；返回 null 表示暂时隐藏不显示，available: false 表示已失效需灰显保留
 */
function restorePinnedEntryRecord(record, ctx) {
  const { pinKey, entry } = record
  const { candidateByPinKey, installedPluginMap, installedAppsByPinKey, pluginsStore, resolvedApplicationIcons } = ctx

  switch (entry.kind) {
    case 'plugin': {
      const rawPlugin = installedPluginMap.get(entry.pluginId) || installedPluginMap.get(entry.pluginId.toLowerCase())
      if (shouldHidePinnedPlugin(entry.pluginId, rawPlugin, pluginsStore)) return null
      const candidate = candidateByPinKey.get(pinKey)
      if (candidate) {
        return {
          ...candidate,
          icon: candidate.icon || record.iconUrl || '',
          pinned: true,
          pinKey,
          pinEntry: entry,
          available: true
        }
      }
      return {
        key: entry.pluginId,
        id: entry.pluginId,
        pluginId: entry.pluginId,
        type: 'plugin',
        name: entry.pluginId,
        title: entry.pluginId,
        description: t('launcher.pinnedErrors.pluginUnavailableDesc'),
        subtitle: t('launcher.pinnedErrors.pluginUnavailableDesc'),
        badge: t('launcher.unavailableTag'),
        faIcon: 'fa-cube',
        icon: record.iconUrl || '',
        pinned: true,
        pinKey,
        pinEntry: entry,
        available: false,
        unavailableReason: t('launcher.pinnedErrors.pluginUnavailableReason', { id: entry.pluginId })
      }
    }

    case 'plugin-feature': {
      const rawPlugin = installedPluginMap.get(entry.pluginId) || installedPluginMap.get(entry.pluginId.toLowerCase())
      if (shouldHidePinnedPlugin(entry.pluginId, rawPlugin, pluginsStore)) return null
      const candidate = candidateByPinKey.get(pinKey)
      if (candidate) {
        return {
          ...candidate,
          icon: candidate.icon || record.iconUrl || '',
          pinned: true,
          pinKey,
          pinEntry: entry,
          available: true
        }
      }
      const featureKey = `${entry.pluginId}:${entry.featureCode}`
      const reason = rawPlugin
        ? t('launcher.pinnedErrors.featureMissingReason', { code: entry.featureCode })
        : t('launcher.pinnedErrors.pluginUnavailableReason', { id: entry.pluginId })
      const featureDesc = rawPlugin
        ? t('launcher.pinnedErrors.featureMissingDesc')
        : t('launcher.pinnedErrors.featurePluginUninstalledDesc')
      return {
        key: featureKey,
        id: featureKey,
        pluginId: entry.pluginId,
        featureCode: entry.featureCode,
        type: 'plugin-feature',
        name: entry.featureCode,
        title: entry.featureCode,
        description: featureDesc,
        subtitle: featureDesc,
        badge: t('launcher.unavailableTag'),
        faIcon: 'fa-cube',
        icon: record.iconUrl || rawPlugin?.icon || '',
        pinned: true,
        pinKey,
        pinEntry: entry,
        available: false,
        unavailableReason: reason
      }
    }

    case 'builtin': {
      const candidate = candidateByPinKey.get(pinKey)
      if (candidate) {
        return {
          ...candidate,
          pinned: true,
          pinKey,
          pinEntry: entry,
          available: true
        }
      }
      return {
        key: entry.commandKey,
        id: entry.commandKey,
        type: 'builtin-command',
        name: entry.commandKey,
        title: entry.commandKey,
        description: t('launcher.pinnedErrors.builtinUnavailableDesc'),
        subtitle: t('launcher.pinnedErrors.builtinUnavailableDesc'),
        badge: t('launcher.unavailableTag'),
        faIcon: 'fa-sliders',
        icon: record.iconUrl || '',
        pinned: true,
        pinKey,
        pinEntry: entry,
        available: false,
        unavailableReason: t('launcher.pinnedErrors.builtinUnavailableReason', { key: entry.commandKey })
      }
    }

    case 'system-tool': {
      const candidate = candidateByPinKey.get(pinKey)
      if (candidate && record.available !== false) {
        return {
          ...candidate,
          icon: candidate.icon || record.iconUrl || '',
          pinned: true,
          pinKey,
          pinEntry: entry,
          available: true
        }
      }
      return {
        key: `system-tool:${entry.toolId}`,
        id: entry.toolId,
        type: 'system-tool',
        panelItemType: 'system_tool',
        name: candidate?.name || entry.toolId,
        title: candidate?.title || candidate?.name || entry.toolId,
        description: t('launcher.pinnedErrors.systemToolUnavailableDesc'),
        subtitle: t('launcher.pinnedErrors.systemToolUnavailableDesc'),
        badge: t('launcher.unavailableTag'),
        faIcon: 'fa-cog',
        icon: record.iconUrl || candidate?.icon || '',
        pinned: true,
        pinKey,
        pinEntry: entry,
        available: false,
        unavailableReason: t('launcher.pinnedErrors.systemToolUnavailableReason', { name: candidate?.name || entry.toolId })
      }
    }

    case 'file': {
      const matchedApp = installedAppsByPinKey.get(pinKey)
      const available = record.available !== false
      const fileName = entry.path.split(/[\\/]/).filter(Boolean).pop() || entry.path
      const displayName = entry.name || matchedApp?.name || fileName
      const parentPath = entry.path.replace(/[\\/][^\\/]+$/, '')
      const cachedIcon = entry.isApplication && available ? (resolvedApplicationIcons.get(entry.path) || '') : ''
      const icon = record.iconUrl || matchedApp?.icon || cachedIcon
      const kindLabel = entry.isApplication ? t('launcher.badges.app') : entry.isDir ? t('launcher.badges.folder') : t('launcher.badges.file')
      return {
        ...(matchedApp || {}),
        key: 'file:' + (matchedApp?.path || entry.path),
        type: 'file',
        name: displayName,
        title: displayName,
        fileName: matchedApp?.fileName || fileName,
        path: entry.path,
        isDir: Boolean(entry.isDir),
        isApplication: Boolean(entry.isApplication),
        badge: available ? kindLabel : t('launcher.unavailableTag'),
        faIcon: entry.isApplication ? 'fa-th-large' : resolveFileFaIcon(fileName, Boolean(entry.isDir)),
        description: available ? truncatePath(parentPath) : t('launcher.pinnedErrors.fileMissingDesc'),
        subtitle: available ? truncatePath(parentPath) : t('launcher.pinnedErrors.fileMissingDesc'),
        actionLabel: t('launcher.commandActions.open'),
        icon,
        pinned: true,
        pinKey,
        pinEntry: entry,
        isPinnedTile: true,
        available,
        ...(available ? {} : { unavailableReason: t('launcher.pinnedErrors.fileMissingReason', { kind: kindLabel, name: displayName }) })
      }
    }

    default:
      return null
  }
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
  // 第一次读取程序列表是否已结束（成功或失败）；结束前空查询用使用记录里的程序信息占位
  const applicationsSettled = ref(!enableApplications)
  const isSearching = ref(false)
  const fileSearchError = ref('')
  const fileSearchDegraded = ref(false)
  const panelRawItems = ref([])
  const pinnedEntries = ref([])
  const hasStructuredPinnedEntries = ref(false)
  const iconVersion = ref(0)
  const applicationIcons = new Map()
  const resolvedApplicationIcons = new Map()
  const failedIconPaths = new Set()

  let searchRequestId = 0
  let fileSearchDebounceTimer = null
  let applicationsRequest = null
  let applicationsLoadedAt = 0
  let panelDataRequest = null
  let disposed = false

  function launcherBridge() {
    if (typeof window === 'undefined') return null
    return typeof window.__ztoolsLauncher?.searchFiles === 'function' ? window.__ztoolsLauncher : null
  }

  function panelBridge() {
    if (typeof window === 'undefined') return null
    return window.__ztoolsLauncher || null
  }

  /** 将最新读取到的 panel 数据应用到本地状态 */
  function applyPanelPayload(data) {
    if (!data || typeof data !== 'object') return
    if (Array.isArray(data.items)) {
      panelRawItems.value = data.items
    }
    if (Array.isArray(data.pinnedEntries)) {
      hasStructuredPinnedEntries.value = true
      pinnedEntries.value = normalizePinnedEntriesList(data.pinnedEntries)
    } else if (Array.isArray(data.items)) {
      hasStructuredPinnedEntries.value = false
      pinnedEntries.value = buildLegacyPinnedEntries(data.items)
    }
  }

  /** 读取悬浮条首屏数据（固定项与系统工具） */
  function refreshPanelData({ force = false } = {}) {
    if (disposed) return Promise.resolve()
    const bridge = panelBridge()
    if (typeof bridge?.getPanelData !== 'function') return Promise.resolve()
    if (panelDataRequest && !force) return panelDataRequest
    panelDataRequest = (async () => {
      try {
        const res = await bridge.getPanelData()
        if (disposed) return
        applyPanelPayload(res?.data ?? res)
      } catch (err) {
        console.warn('[useCommandSearch] 读取悬浮条首屏数据失败:', err)
      } finally {
        panelDataRequest = null
      }
    })()
    return panelDataRequest
  }

  /** 同步兼容旧版 panelRawItems 中的固定状态 */
  function syncLegacyRawItemPinned(entry, targetPinned) {
    if (entry.kind !== 'plugin') return
    const targetId = entry.pluginId
    const idx = panelRawItems.value.findIndex((raw) => raw?.id === targetId && raw?.type === 'plugin')
    if (idx >= 0) {
      const updated = [...panelRawItems.value]
      updated[idx] = { ...updated[idx], pinned: targetPinned }
      panelRawItems.value = updated
    } else if (targetPinned) {
      panelRawItems.value = [
        ...panelRawItems.value,
        { id: targetId, name: targetId, type: 'plugin', pinned: true, recent: true }
      ]
    }
  }

  /** 幂等设置条目的固定/取消固定状态，并以主进程返回的最新列表刷新状态 */
  async function setItemPinned(item, pinned) {
    if (!item || typeof item !== 'object') return { success: false }
    const entry = buildPinPayload(item)
    if (!entry) return { success: false }
    const pinKey = resolvePinKey(entry)
    if (!pinKey) return { success: false }

    const targetPinned = Boolean(pinned)
    const prevEntries = [...pinnedEntries.value]
    const prevRawItems = [...panelRawItems.value]
    const prevStructured = hasStructuredPinnedEntries.value

    // 本地乐观更新
    if (targetPinned) {
      if (!pinnedEntries.value.some((record) => record.pinKey === pinKey)) {
        pinnedEntries.value = [
          ...pinnedEntries.value,
          {
            pinKey,
            entry,
            available: item.available !== false,
            iconUrl: typeof item.icon === 'string' ? item.icon : ''
          }
        ]
      }
    } else {
      pinnedEntries.value = pinnedEntries.value.filter((record) => record.pinKey !== pinKey)
    }
    syncLegacyRawItemPinned(entry, targetPinned)

    const bridge = panelBridge()
    if (typeof bridge?.setPin === 'function') {
      try {
        const res = await bridge.setPin(entry, targetPinned)
        const data = res?.data ?? res
        if (res?.success === false || data?.success === false) {
          pinnedEntries.value = prevEntries
          panelRawItems.value = prevRawItems
          hasStructuredPinnedEntries.value = prevStructured
          return {
            success: false,
            error: resolveErrorMessage(data?.error ? data : res, 'launcher.pinnedErrors.togglePinFailed')
          }
        }
        if (Array.isArray(data?.pinnedEntries)) {
          hasStructuredPinnedEntries.value = true
          pinnedEntries.value = normalizePinnedEntriesList(data.pinnedEntries)
        }
        track('launcher_pin', '', { kind: entry.kind, action: targetPinned ? 'pin' : 'unpin' })
        return {
          success: true,
          pinned: typeof data?.pinned === 'boolean' ? data.pinned : targetPinned,
          pinKey: data?.pinKey || pinKey
        }
      } catch (err) {
        pinnedEntries.value = prevEntries
        panelRawItems.value = prevRawItems
        hasStructuredPinnedEntries.value = prevStructured
        console.warn('[useCommandSearch] 设置固定状态失败:', err)
        return { success: false, error: resolveErrorMessage(err, 'launcher.pinnedErrors.togglePinFailed') }
      }
    }

    // 兼容仅提供旧 togglePin 接口的测试替身
    if (typeof bridge?.togglePin === 'function' && entry.kind === 'plugin') {
      try {
        await bridge.togglePin(entry.pluginId, 'plugin')
        await refreshPanelData({ force: true })
        track('launcher_pin', '', { kind: entry.kind, action: targetPinned ? 'pin' : 'unpin' })
        return { success: true, pinned: targetPinned, pinKey }
      } catch (err) {
        pinnedEntries.value = prevEntries
        panelRawItems.value = prevRawItems
        hasStructuredPinnedEntries.value = prevStructured
        console.warn('[useCommandSearch] 切换固定状态失败:', err)
        return { success: false, error: resolveErrorMessage(err, 'launcher.pinnedErrors.togglePinFailed') }
      }
    }

    hasStructuredPinnedEntries.value = true
    track('launcher_pin', '', { kind: entry.kind, action: targetPinned ? 'pin' : 'unpin' })
    return { success: true, pinned: targetPinned, pinKey }
  }

  /** 切换条目在悬浮条首屏的固定状态 */
  async function toggleItemPin(item) {
    if (!item || typeof item !== 'object') return { success: false }
    return setItemPinned(item, !item.pinned)
  }

  /** 本地交换两个可见固定项在完整存储数组中的位置，保持被隐藏项的下标不动 */
  function swapPinnedKeys(keyA, keyB) {
    if (!keyA || !keyB || keyA === keyB) return null
    const list = [...pinnedEntries.value]
    const idxA = list.findIndex((record) => record.pinKey === keyA)
    const idxB = list.findIndex((record) => record.pinKey === keyB)
    if (idxA < 0 || idxB < 0) return null
    const temp = list[idxA]
    list[idxA] = list[idxB]
    list[idxB] = temp
    pinnedEntries.value = list
    return list.map((record) => record.pinKey)
  }

  /** 将完整的 pinnedEntries 列表回滚为指定快照 */
  function restorePinnedEntries(snapshot) {
    if (Array.isArray(snapshot)) {
      pinnedEntries.value = normalizePinnedEntriesList(snapshot)
    }
  }

  /** 提交完整 pinKey 数组到主进程并同步最新顺序，遇到 stale 或失败时回滚 */
  async function reorderPinned(order, reorderOptions = {}) {
    if (!Array.isArray(order) || order.length === 0) {
      return { success: false, error: t('launcher.pinnedErrors.invalidOrder') }
    }
    const normalizedOrder = order.map((k) => String(k || '').trim()).filter(Boolean)
    const prevEntries = Array.isArray(reorderOptions.baselineEntries)
      ? reorderOptions.baselineEntries
      : [...pinnedEntries.value]
    const prevMap = new Map(pinnedEntries.value.map((record) => [record.pinKey, record]))
    const reordered = []
    const used = new Set()
    for (const key of normalizedOrder) {
      if (used.has(key)) continue
      const rec = prevMap.get(key)
      if (rec) {
        used.add(key)
        reordered.push(rec)
      }
    }
    for (const rec of pinnedEntries.value) {
      if (!used.has(rec.pinKey)) {
        used.add(rec.pinKey)
        reordered.push(rec)
      }
    }
    pinnedEntries.value = reordered
    const fullOrder = reordered.map((record) => record.pinKey)
    const kind = reorderOptions.kind || reordered[0]?.entry?.kind || 'unknown'

    const bridge = panelBridge()
    if (typeof bridge?.reorderPins === 'function') {
      try {
        const res = await bridge.reorderPins(fullOrder)
        const data = res?.data ?? res
        if (res?.success === false || data?.success === false || data?.stale) {
          if (Array.isArray(data?.pinnedEntries)) {
            hasStructuredPinnedEntries.value = true
            pinnedEntries.value = normalizePinnedEntriesList(data.pinnedEntries)
          } else {
            pinnedEntries.value = prevEntries
          }
          return {
            success: false,
            stale: Boolean(data?.stale),
            error: resolveErrorMessage(
              data?.error ? data : res,
              data?.stale ? 'launcher.pinnedErrors.orderStale' : 'launcher.pinnedErrors.reorderFailed'
            ),
            pinnedEntries: pinnedEntries.value
          }
        }
        if (Array.isArray(data?.pinnedEntries)) {
          hasStructuredPinnedEntries.value = true
          pinnedEntries.value = normalizePinnedEntriesList(data.pinnedEntries)
        }
        track('launcher_pin', '', { kind, action: 'reorder' })
        return { success: true, pinnedEntries: pinnedEntries.value }
      } catch (err) {
        pinnedEntries.value = prevEntries
        console.warn('[useCommandSearch] 调整固定排序失败:', err)
        return { success: false, error: resolveErrorMessage(err, 'launcher.pinnedErrors.reorderFailed'), pinnedEntries: pinnedEntries.value }
      }
    }

    track('launcher_pin', '', { kind, action: 'reorder' })
    return { success: true, pinnedEntries: pinnedEntries.value }
  }

  /**
   * 记录使用：使用频率，以及「当前搜索词 → 选中项」
   * @param {string} itemKey
   * @param {object} [item] 被打开的条目，已安装程序会记下名称与路径供冷启动显示
   */
  function recordUsage(itemKey, item) {
    recordCommandUsage(itemKey, item)
    recordQueryChoice(query.value, itemKey)
  }

  /** 读取程序列表（主进程有缓存，过期时先返回旧列表再后台刷新），窗口获得焦点时节流刷新 */
  function refreshApplications({ force = false } = {}) {
    if (!enableApplications || disposed) return Promise.resolve()
    const bridge = launcherBridge()
    if (!bridge) {
      applicationsSettled.value = true
      return Promise.resolve()
    }
    if (applicationsRequest) return applicationsRequest
    if (!force && applicationsLoadedAt && Date.now() - applicationsLoadedAt < APPLICATION_REFRESH_INTERVAL_MS) {
      return Promise.resolve()
    }
    applicationsRequest = (async () => {
      try {
        const res = await bridge.searchFiles('', fileSearchLimit, { scope: 'applications' })
        if (disposed) return
        if (res?.success === false) throw new Error(res.error?.message || 'Failed to read application list')
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
        if (!disposed) applicationsSettled.value = true
      }
    })()
    return applicationsRequest
  }

  /**
   * 打开前的准备：冷启动占位的程序条目没有打开授权（主进程只放行程序列表里返回过的路径），
   * 先等程序列表返回，再换成列表里的真实条目；程序已卸载或列表读取失败时返回 null。
   */
  async function prepareItemForLaunch(item) {
    if (!item?.pendingGrant) return item
    await refreshApplications({ force: !applicationsAvailable.value })
    return applicationResults.value.find((app) => app.path === item.path) || null
  }

  /**
   * 执行防乱序本地文件检索；程序已在本地匹配时只请求文件
   */
  async function searchFilesLocally(text, currentReq) {
    const trimmed = text.trim()
    try {
      const bridge = launcherBridge()
      if (!bridge) throw new Error('File search bridge is unavailable in current host')
      const res = applicationsAvailable.value
        ? await bridge.searchFiles(trimmed, fileSearchLimit, { scope: 'files' })
        : await bridge.searchFiles(trimmed, fileSearchLimit)

      // 防乱序检查：如果当前请求已过时，坚决丢弃结果
      if (currentReq !== searchRequestId) return

      if (res?.success === false) throw new Error(res.error?.message || 'Local file search failed')
      const data = res?.data ?? res
      const rawFiles = Array.isArray(data?.files) ? data.files : []
      fileSearchDegraded.value = data?.degraded === true
      fileResults.value = rawFiles
        .filter(isFileRecord)
        .map((f) => withPinState(toFileItem(f), pinnedKeySet.value))
    } catch (err) {
      if (currentReq === searchRequestId) {
        fileResults.value = []
        fileSearchError.value = t('launcher.pinnedErrors.fileSearchUnavailable')
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
    const targets = items.filter(
      (item) => item?.isApplication && item.available !== false && !item.icon && item.path && !failedIconPaths.has(item.path)
    )
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
          if (resolvedApplicationIcons.size >= MAX_APPLICATION_ICON_CACHE) {
            resolvedApplicationIcons.delete(resolvedApplicationIcons.keys().next().value)
          }
          resolvedApplicationIcons.set(item.path, icon)
          iconVersion.value++
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
    if (!pluginsStore._hiddenBundledLoaded && typeof window.ztools?.config?.get === 'function') {
      void pluginsStore.fetchInstalledPlugins()
    }
    // 重新取当前时间计算衰减分，并读取另一个窗口期间写入的使用记录
    frecencyVersion.value++
    void refreshApplications()
    void refreshPanelData()
  }
  // 悬浮条与工作台是两个窗口，共用同一份 localStorage：另一个窗口写入使用记录时重新排序
  const onStorage = (event) => {
    if (event.key === BUNDLED_VISIBILITY_SIGNAL && typeof window.ztools?.config?.get === 'function') {
      void pluginsStore.fetchInstalledPlugins(true)
    }
    if (event.key === null || event.key === STORAGE_KEY_FRECENCY || event.key === STORAGE_KEY_QUERY_CHOICES) {
      frecencyVersion.value++
    }
  }
  // 悬浮条与工作台跨窗口同步固定面板变化
  const onSuperPanelChanged = (envelope) => {
    if (disposed) return
    const payload = envelope?.payload ?? envelope
    if (payload && typeof payload === 'object') {
      applyPanelPayload(payload)
    }
    if (!Array.isArray(payload?.pinnedEntries)) {
      void refreshPanelData({ force: true })
    }
  }
  let grantRefreshTimer = null
  if (getCurrentScope()) {
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onWindowFocus)
      window.addEventListener('storage', onStorage)
    }
    const eventsApi = typeof window !== 'undefined' ? window.ztools?.events : null
    if (eventsApi) {
      if (typeof eventsApi.subscribe === 'function') {
        Promise.resolve(eventsApi.subscribe('super_panel_changed')).catch((err) => {
          console.warn('[useCommandSearch] 订阅 super_panel_changed 失败:', err)
        })
      }
      if (typeof eventsApi.on === 'function') {
        eventsApi.on('super_panel_changed', onSuperPanelChanged)
      }
    }
    if (enableApplications) {
      grantRefreshTimer = setInterval(() => { void refreshApplications() }, APPLICATION_GRANT_REFRESH_MS)
    }
    onScopeDispose(() => {
      disposed = true
      searchRequestId++
      if (fileSearchDebounceTimer) clearTimeout(fileSearchDebounceTimer)
      if (grantRefreshTimer) clearInterval(grantRefreshTimer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWindowFocus)
        window.removeEventListener('storage', onStorage)
      }
      if (eventsApi && typeof eventsApi.off === 'function') {
        eventsApi.off('super_panel_changed', onSuperPanelChanged)
      }
      applicationIcons.clear()
      resolvedApplicationIcons.clear()
      failedIconPaths.clear()
    })
  }
  void refreshApplications({ force: true })
  void refreshPanelData({ force: true })

  const pinnedKeySet = computed(() => {
    const set = new Set()
    for (const record of pinnedEntries.value) {
      if (record?.pinKey) set.add(record.pinKey)
    }
    return set
  })

  watch(pinnedKeySet, (nextSet) => {
    if (fileResults.value.length > 0) {
      fileResults.value = fileResults.value.map((item) => withPinState(item, nextSet))
    }
  })

  // 语言热切换时立即重算缓存的本地应用/文件条目展示文案，并向主进程重新拉取本地化的系统工具列表
  watch(
    () => i18n.global.locale.value,
    () => {
      if (applicationResults.value.length > 0) {
        applicationResults.value = applicationResults.value.map(localizeFileItem)
      }
      if (fileResults.value.length > 0) {
        fileResults.value = fileResults.value.map(localizeFileItem)
      }
      if (fileSearchError.value) {
        fileSearchError.value = t('launcher.pinnedErrors.fileSearchUnavailable')
      }
      void refreshPanelData({ force: true })
    }
  )

  const builtinSystemItems = computed(() => {
    void i18n.global.locale.value
    return getBuiltinCommandItems(getCurrentLocale())
  })

  const panelSystemToolItems = computed(() => {
    void i18n.global.locale.value
    return panelRawItems.value
      .filter((item) => item?.type === 'system_tool' && item.id)
      .map((item) => {
        const rawId = String(item.id)
        const target = item.target ? String(item.target) : rawId.replace(/^system-tool:/, '')
        const key = rawId.startsWith('system-tool:') ? rawId : `system-tool:${rawId}`
        return {
          key,
          id: rawId,
          target,
          type: 'system-tool',
          panelItemType: 'system_tool',
          name: String(item.name || rawId),
          title: String(item.name || rawId),
          description: String(item.description || t('launcher.systemToolDefaultDesc')),
          subtitle: String(item.description || t('launcher.systemToolDefaultDesc')),
          icon: String(item.iconUrl || ''),
          faIcon: resolveCommandFaIcon(item.name || rawId, 'system'),
          keywords: Array.isArray(item.keywords) ? item.keywords : [],
          cmds: Array.isArray(item.keywords) ? item.keywords : [],
          badge: t('launcher.badges.systemTool'),
          actionLabel: t('launcher.commandActions.open')
        }
      })
  })

  const commandCandidates = computed(() => {
    void i18n.global.locale.value
    const base = buildCommandCandidates(pluginsStore)
    const pinKeys = pinnedKeySet.value
    return [...base, ...panelSystemToolItems.value]
      .map((item) => withPinState(item, pinKeys))
  })

  /** 已安装程序：去掉与系统工具同名的那一份，并独立染色 */
  const installedApps = computed(() => {
    void i18n.global.locale.value
    const deduped = dedupeInstalledApps(
      applicationsAvailable.value ? applicationResults.value : [],
      panelSystemToolItems.value
    )
    const pinKeys = pinnedKeySet.value
    return {
      apps: deduped.apps.map((app) => withPinState(localizeFileItem(app), pinKeys)),
      aliases: deduped.aliases
    }
  })

  /** 首屏置顶磁贴列表（严格按 pinnedEntries 顺序还原 5 类条目并过滤隐藏/禁用/下架/不支持平台项） */
  const pinnedItems = computed(() => {
    void i18n.global.locale.value
    void iconVersion.value
    const candidateByPinKey = new Map()
    for (const candidate of commandCandidates.value) {
      const pk = candidate.pinKey || resolvePinKey(candidate)
      if (pk && !candidateByPinKey.has(pk)) {
        candidateByPinKey.set(pk, candidate)
      }
    }

    const installedPluginMap = new Map()
    for (const p of pluginsStore.installedPlugins || []) {
      if (!p || typeof p !== 'object') continue
      const pid = String(p.pluginId || p.id || '').trim()
      if (!pid) continue
      if (!installedPluginMap.has(pid)) installedPluginMap.set(pid, p)
      const lower = pid.toLowerCase()
      if (!installedPluginMap.has(lower)) installedPluginMap.set(lower, p)
    }

    const installedAppsByPinKey = new Map()
    for (const app of applicationResults.value) {
      const pk = resolvePinKey(app)
      if (pk && !installedAppsByPinKey.has(pk)) {
        installedAppsByPinKey.set(pk, app)
      }
    }

    const ctx = {
      candidateByPinKey,
      installedPluginMap,
      installedAppsByPinKey,
      pluginsStore,
      resolvedApplicationIcons
    }

    const result = []
    for (const record of pinnedEntries.value) {
      const restored = restorePinnedEntryRecord(record, ctx)
      if (restored) {
        result.push(restored)
      }
    }
    return result
  })

  /**
   * 排序结果：上段是即时计算、插件、子命令、内置命令与程序的混排，下段是普通文件
   */
  const ranking = computed(() => {
    void i18n.global.locale.value
    void frecencyVersion.value
    const rawQuery = query.value
    const q = normalizeSearchQuery(rawQuery)
    const frecencyMap = getFrecencySnapshot()
    const now = Date.now()
    const candidates = commandCandidates.value
    const ranges = new Map()
    const appOwners = panelSystemToolItems.value

    /** 条目的使用记录：被去重合并掉的同一程序的记录一并算上 */
    const usageStatsOf = (item, aliases) => {
      const own = frecencyMap[item.key]
      const merged = aliases?.get(item.key)
      return merged ? mergeUsageStats([own, ...merged.map((key) => frecencyMap[key])]) : own
    }

    const pinKeys = pinnedKeySet.value

    if (!q) {
      // 顶部固定宫格已展示的全部条目集合：在下方列表中归入第 3 梯队后置沉底，避免首屏上下两处重复显示
      const topPinnedKeys = new Set(
        pinnedItems.value
          .map((item) => item.key || item.pluginId || item.id)
          .filter(Boolean)
      )
      const topPinnedPinKeys = new Set(
        pinnedItems.value
          .map((item) => item.pinKey || resolvePinKey(item))
          .filter(Boolean)
      )

      // 空查询纳入用过的本机已安装软件；未曾打开过的本机系统软件不塞入空查询，保持首屏清爽。
      // 程序列表第一次返回前，用使用记录里存下的名称与路径占位，避免列表返回后用过的程序突然插到前面
      let apps
      let aliases
      if (applicationsAvailable.value || applicationsSettled.value) {
        ({ apps, aliases } = installedApps.value)
      } else {
        const pending = dedupeInstalledApps(buildPendingApplicationItems(frecencyMap), appOwners)
        apps = pending.apps.map((app) => withPinState(app, pinKeys))
        aliases = pending.aliases
      }
      const usedSystemApps = apps.filter((app) => Boolean(frecencyMap[app.key]))

      const emptyPool = [
        ...candidates.filter((item) => item.type !== 'plugin-feature' || Boolean(frecencyMap[item.key])),
        ...usedSystemApps
      ]

      const scoredEmpty = emptyPool
        .map((item, index) => {
          const stats = usageStatsOf(item, aliases)
          // 空查询用不封顶的原始分：常用项不会同时到顶而失去先后
          const frecency = calculateFrecencyScore(stats, now)
          const lastUsed = Number(stats?.lastUsed) || 0
          const categoryRank = getCategoryRank(item)
          const itemKey = item.key || item.pluginId || item.id
          const itemPinKey = item.pinKey || resolvePinKey(item)
          const isTopPinned = itemPinKey
            ? topPinnedPinKeys.has(itemPinKey)
            : Boolean(itemKey && topPinnedKeys.has(itemKey))
          // 梯队 0：活跃未固定项；梯队 1：未使用或长期未用的默认推荐项（按分类权重排列，宿主内置指令垫底）；梯队 2：顶部已展示固定项
          const emptyBucket = isTopPinned ? 2 : (frecency >= EMPTY_QUERY_ACTIVE_MIN_FRECENCY ? 0 : 1)
          return {
            item,
            emptyBucket,
            heatTier: emptyBucket === 0 ? Math.floor(frecency / EMPTY_QUERY_HEAT_STEP) : 0,
            lastUsed,
            categoryRank,
            index
          }
        })
        .sort(compareEmptyQuery)

      const top = scoredEmpty.map((entry) => entry.item)
      const commands = top.filter((item) => !item.isApplication)
      return { commands, top, files: [], ranges }
    }

    const choicesSnapshot = getQueryChoicesSnapshot()
    const choice = resolveQueryChoice(choicesSnapshot[q])
    const learnedKey = choice?.key || ''
    // 抗噪：首选项已形成稳定习惯（约选中 2 次以上），或只选过 1 次但匹配本身达到开头一致，才按 LEARNED 档置顶
    const learnedStable = (choice?.score || 0) >= QUERY_CHOICE_STABLE_SCORE
    const prefixLearnedKeys = collectPrefixLearnedKeys(choicesSnapshot, q)

    const rawApps = applicationsAvailable.value
      ? applicationResults.value
      : fileResults.value.filter((item) => item?.isApplication)
    let matchedApps
    let aliases
    if (applicationsAvailable.value) {
      ({ apps: matchedApps, aliases } = installedApps.value)
    } else {
      const legacyApps = dedupeInstalledApps(rawApps, appOwners)
      matchedApps = legacyApps.apps.map((app) => withPinState(app, pinKeys))
      aliases = legacyApps.aliases
    }

    const toEntry = (item, index, match) => {
      if (match.range && item.key) ranges.set(item.key, match.range)
      const categoryRank = getCategoryRank(item)
      const categoryWeight = CATEGORY_WEIGHTS[categoryRank] ?? 0
      const stats = usageStatsOf(item, aliases)
      const frecency = calculateFrecencyBonus(stats, now)
      const lastUsed = Number(stats?.lastUsed) || 0
      const learned = learnedKey !== '' &&
        item.key === learnedKey &&
        match.tier < MATCH_TIERS.ALIAS &&
        (learnedStable || match.tier >= MATCH_TIERS.PREFIX)
      const prefixBonus = !learned && item.key && prefixLearnedKeys.has(item.key) ? 60 : 0
      const tierScore = learned
        ? MATCH_TIER_SCORES.LEARNED
        : (match.tierScore ?? (match.tier * 100))
      const qualityScore = match.qualityScore ?? ((match.secondary ? 0 : 30) + (3 - match.field) * 10)
      const compositeScore = tierScore + categoryWeight + qualityScore + frecency + prefixBonus

      return {
        item,
        compositeScore,
        categoryRank,
        lastUsed,
        length: String(item.name || item.title || '').length,
        index
      }
    }

    const entries = []
    ;[...candidates, ...matchedApps].forEach((item, index) => {
      const match = matchItemWithQuery(item, q)
      if (match.matched) entries.push(toEntry(item, index, match))
    })
    entries.sort(compareRanked)

    // 文件段只按匹配档、使用记录与路径排序，不需要综合分
    const appPaths = new Set(rawApps.map((item) => item.path))
    const fileEntries = []
    fileResults.value.forEach((item, index) => {
      if (!item || appPaths.has(item.path)) return
      // 主进程按文件名命中、前端规则没认出来的（如只命中扩展名）排在文件段最后，不丢弃
      const match = matchItemWithQuery(item, q)
      if (match.matched && match.range && item.key) ranges.set(item.key, match.range)
      const stats = frecencyMap[item.key]
      fileEntries.push({
        item,
        tierScore: match.matched ? (match.tierScore ?? match.tier * 100) : 0,
        tier: match.matched ? match.tier : MATCH_TIERS.NONE,
        secondary: match.matched && match.secondary ? 1 : 0,
        frecency: calculateFrecencyBonus(stats, now),
        categoryRank: getCategoryRank(item),
        userDirBoost: computeUserDirBoost(item.path),
        mtime: Number(item.mtime) || 0,
        depth: String(item.path).split(/[\\/]/).length,
        index
      })
    })
    fileEntries.sort(compareFiles)

    const ranked = entries.map((entry) => entry.item)
    const commands = ranked.filter((item) => !item.isApplication)
    // Raycast rootSearch: 当输入命中有效算式/单位换算/汇率/日期/色值时，置顶展示临时结果卡片
    const inlineItem = evaluateInlineCommandItem(rawQuery)
    const prefixItems = inlineItem ? [inlineItem] : []
    return {
      commands: [...prefixItems, ...commands],
      top: [...prefixItems, ...ranked],
      files: fileEntries.map((entry) => withPinState(localizeFileItem(entry.item), pinKeys)),
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
    () => [
      ...filteredItems.value.slice(0, APPLICATION_ICON_BATCH),
      ...pinnedItems.value
    ]
      .filter((item) => item?.isApplication && item.available !== false && !item.icon && item.path && !failedIconPaths.has(item.path))
      .map((item) => item.path)
      .join('\n'),
    (pending) => {
      if (pending) {
        void loadApplicationIcons([
          ...filteredItems.value.slice(0, APPLICATION_ICON_BATCH),
          ...pinnedItems.value
        ])
      }
    },
    { immediate: true }
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
    prepareItemForLaunch,
    highlightParts,
    refreshApplications,
    refreshPanelData,
    pinnedEntries,
    pinnedItems,
    setItemPinned,
    toggleItemPin,
    reorderPinned,
    swapPinnedKeys,
    restorePinnedEntries,
    builtinSystemItems
  }
}
