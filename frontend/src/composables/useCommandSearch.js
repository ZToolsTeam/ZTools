/**
 * ZTools 统一命令检索与 Frecency 排序内核 (Command Search Composable)
 *
 * 核心特性：
 * 1. 100% 本地无网络阻塞检索（本地插件 + 内置系统应用 + MFT/USN 硬件级文件秒搜）；
 * 2. 智能拼音全拼与首字母模糊匹配 (pinyinSearch)；
 * 3. Frecency 频度+时间衰减综合排序 (Frequency + Recency)；
 * 4. 连续快速输入高频防乱序机制 (Cancellation Token / RequestId 机制)。
 */

import { ref, computed } from 'vue'
import { usePluginsStore } from '@/stores/plugins'
import { matchItemWithQuery } from '@/utils/pinyinSearch'
import { openSettings } from '@/utils/internalPlugins'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { evaluateCalculatorQuery, addCalculatorHistory } from '@ztools/declarative-ui'

const STORAGE_KEY_FRECENCY = 'ztools_command_frecency'

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
  } catch {
    // 忽略异常
  }
  return false
}

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
        await copyInlineAnswerToClipboard(res.formattedAnswer)
        try {
          await addCalculatorHistory(res.expression, res.formattedAnswer, res.type)
        } catch {
          // 忽略历史写入异常
        }
        return res.formattedAnswer
      }
    }
  } catch {
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
      switchWindowMode(WINDOW_MODES.DASHBOARD).catch(() => {})
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
      switchWindowMode(WINDOW_MODES.DASHBOARD).catch(() => {})
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
        window.ztools.shell.openExternal('https://github.com/codingmuse/ZTools-extensions')
      } else {
        window.open('https://github.com/codingmuse/ZTools-extensions', '_blank')
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
        window.ztools.shell.openExternal('https://github.com/codingmuse/ZTools-extensions')
      } else {
        window.open('https://github.com/codingmuse/ZTools-extensions', '_blank')
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
  const parts = fullPath.split(/[\\/]/)
  if (parts.length <= 3) return fullPath
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
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
  } catch {
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
  } catch {
    // 忽略异常
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
    const mode = ['view', 'no-view', 'menu-bar'].includes(rawMode) ? rawMode : 'view'
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

/**
 * 统一搜索内核 Composable
 * @param {object} [options]
 * @param {boolean} [options.enableFileSearch=true] 是否启用本地硬件级文件搜索
 * @param {number} [options.fileSearchLimit=12] 文件搜索候选条数上限
 */
export function useCommandSearch(options = {}) {
  const enableFileSearch = options.enableFileSearch !== false
  const fileSearchLimit = options.fileSearchLimit || 12

  const pluginsStore = usePluginsStore()
  const query = ref('')
  const fileResults = ref([])
  const isSearching = ref(false)

  let searchRequestId = 0
  let fileSearchDebounceTimer = null

  /**
   * 记录使用
   */
  function recordUsage(itemKey) {
    recordCommandUsage(itemKey)
  }

  /**
   * 执行防乱序本地文件秒搜
   */
  async function searchFilesLocally(text) {
    const trimmed = text.trim()
    if (!trimmed || !enableFileSearch) {
      fileResults.value = []
      return
    }

    const currentReq = ++searchRequestId
    isSearching.value = true

    try {
      let res = null
      if (typeof window !== 'undefined') {
        if (window.__ztoolsLauncher?.searchFiles) {
          res = await window.__ztoolsLauncher.searchFiles(trimmed, fileSearchLimit)
        } else if (window.ztools?.system?.searchFiles) {
          res = await window.ztools.system.searchFiles(trimmed, fileSearchLimit)
        }
      }

      // 防乱序检查：如果当前请求已过时，坚决丢弃结果
      if (currentReq !== searchRequestId) return

      const rawFiles = Array.isArray(res?.files)
        ? res.files
        : Array.isArray(res?.data?.files)
          ? res.data.files
          : []

      if (rawFiles.length > 0) {
        fileResults.value = rawFiles.map((f) => ({
          key: 'file:' + f.path,
          type: 'file',
          name: f.name,
          title: f.name,
          path: f.path,
          isDir: f.is_dir,
          size: f.size,
          mtime: f.mtime,
          badge: f.is_dir ? '文件夹' : '文件',
          faIcon: resolveFileFaIcon(f.name, f.is_dir),
          description: truncatePath(f.path),
          subtitle: truncatePath(f.path),
          actionLabel: '打开'
        }))
      } else {
        fileResults.value = []
      }
    } catch (err) {
      console.warn('[useCommandSearch] 本地文件检索异常:', err)
    } finally {
      if (currentReq === searchRequestId) {
        isSearching.value = false
      }
    }
  }

  /**
   * 触发搜索更新
   */
  function search(text) {
    query.value = typeof text === 'string' ? text : ''

    if (fileSearchDebounceTimer) {
      clearTimeout(fileSearchDebounceTimer)
    }

    if (!query.value.trim()) {
      searchRequestId++
      fileResults.value = []
      isSearching.value = false
      return
    }

    if (enableFileSearch) {
      fileSearchDebounceTimer = setTimeout(() => {
        searchFilesLocally(query.value)
      }, 40)
    }
  }

  function clearSearch() {
    searchRequestId++
    if (fileSearchDebounceTimer) clearTimeout(fileSearchDebounceTimer)
    query.value = ''
    fileResults.value = []
    isSearching.value = false
  }

  /**
   * 本地插件、子命令 (features) 与内置命令的排序与匹配流
   */
  const matchedPlugins = computed(() => {
    const frecencyMap = loadFrecencyMap()
    const now = Date.now()
    const q = query.value.trim().toLowerCase()

    // 1. 组装安装的插件及其 features 子命令（过滤已下架或已禁用插件）
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
      const mode = ['view', 'no-view', 'menu-bar'].includes(rawMode) ? rawMode : 'view'
      const alias = String(p.alias || p.manifest?.alias || '').trim()
      const features = normalizePluginFeatures(p)
      const isDeclarative = isDeclarativePluginItem(p)

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

      for (const feat of features) {
        const featKey = `${key}:${feat.code}`
        // 空查询时仅展示曾经使用过的子命令以保持首屏清爽；有查询词时全量参与匹配
        if (!q && !frecencyMap[featKey]) continue

        featureItems.push({
          key: featKey,
          type: 'plugin-feature',
          pluginId: key,
          pluginName: p.name || p.title || key,
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
      }
    }

    // 2. 组装内置系统条目
    const installedKeys = new Set(installed.map((item) => item.key))
    const remainingBuiltins = BUILTIN_COMMAND_ITEMS.filter((item) => !installedKeys.has(item.key))
    const allAvailable = [...installed, ...featureItems, ...remainingBuiltins]

    // 3. 计算打分（匹配得分 + Frecency 额外权重）
    const scored = []
    for (const item of allAvailable) {
      const { matched, score: matchScore } = matchItemWithQuery(item, q)
      if (matched) {
        const stats = frecencyMap[item.key]
        const frecencyBonus = calculateFrecencyBonus(stats, now)
        const totalScore = matchScore + frecencyBonus
        scored.push({ item, totalScore })
      }
    }

    scored.sort((a, b) => b.totalScore - a.totalScore)
    const ranked = scored.map((s) => s.item)

    // 4. Raycast rootSearch: 当输入命中有效算式/单位换算/汇率/日期/色值时，置顶展示临时结果卡片
    const inlineItem = evaluateInlineCommandItem(query.value)
    if (inlineItem) {
      return [inlineItem, ...ranked]
    }
    return ranked
  })

  /**
   * 最终呈现的组合列表：高权重应用（含内联计算结果）在前，本地文件在后
   */
  const filteredItems = computed(() => {
    if (!query.value.trim()) {
      return matchedPlugins.value
    }
    return [...matchedPlugins.value, ...fileResults.value]
  })

  return {
    query,
    matchedPlugins,
    fileResults,
    filteredItems,
    isSearching,
    search,
    clearSearch,
    recordUsage,
    builtinSystemItems: BUILTIN_COMMAND_ITEMS
  }
}
