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
import { getPluginGradient } from '@/composables/usePluginIcon'
import { openSettings } from '@/utils/internalPlugins'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'

const STORAGE_KEY_FRECENCY = 'ztools_command_frecency'

// 内置快捷工具条目定义
export const BUILTIN_COMMAND_ITEMS = Object.freeze([
  {
    key: 'system-settings',
    name: '系统设置',
    description: '查看或配置全局快捷键、窗口呼出形态偏好',
    badge: '系统',
    actionLabel: '打开设置',
    faIcon: 'fa-sliders',
    iconGradient: 'linear-gradient(135deg, #6366f1, #a855f7)',
    action: () => {
      switchWindowMode(WINDOW_MODES.DASHBOARD).catch(() => {})
      openSettings()
    }
  },
  {
    key: 'everything-search',
    name: 'Everything文件搜索',
    description: '自研硬件级 Flat-Trie MFT 索引秒搜，极客全键盘操作与双栏实时预览',
    badge: '工具',
    actionLabel: '启动',
    faIcon: 'fa-search',
    iconGradient: 'linear-gradient(135deg, #0284c7, #38bdf8)',
    pluginId: 'everything-search'
  },
  {
    key: 'system-dashboard',
    name: '打开插件中心',
    description: '展开为完整工作台大界面，浏览所有应用卡片',
    badge: '工作台',
    actionLabel: '展开',
    faIcon: 'fa-th-large',
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
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
    iconGradient: 'linear-gradient(135deg, #10b981, #06b6d4)',
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
    description: '访问 GitHub 插件大仓，查看 34 款开源扩展源码与投稿 PR 指南',
    badge: '开源',
    actionLabel: '前往 GitHub',
    faIcon: 'fa-github',
    iconGradient: 'linear-gradient(135deg, #24292e, #0f172a)',
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

export function getFileGradient(fileName, isDir) {
  if (isDir) return 'linear-gradient(135deg, #f59e0b, #fbbf24)'
  const ext = (fileName.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'linear-gradient(135deg, #10b981, #34d399)'
  if (['pdf'].includes(ext)) return 'linear-gradient(135deg, #ef4444, #f87171)'
  if (['doc', 'docx'].includes(ext)) return 'linear-gradient(135deg, #3b82f6, #60a5fa)'
  if (['xls', 'xlsx'].includes(ext)) return 'linear-gradient(135deg, #059669, #10b981)'
  if (['zip', 'rar', '7z'].includes(ext)) return 'linear-gradient(135deg, #8b5cf6, #a78bfa)'
  if (['exe', 'bat'].includes(ext)) return 'linear-gradient(135deg, #64748b, #94a3b8)'
  return 'linear-gradient(135deg, #0284c7, #38bdf8)'
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
  if (!itemKey) return
  const map = loadFrecencyMap()
  const existing = map[itemKey] || { count: 0, lastUsed: 0 }
  map[itemKey] = {
    count: (existing.count || 0) + 1,
    lastUsed: Date.now()
  }
  saveFrecencyMap(map)
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
          iconGradient: getFileGradient(f.name, f.is_dir),
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
   * 本地插件与内置命令的排序与匹配流
   */
  const matchedPlugins = computed(() => {
    const frecencyMap = loadFrecencyMap()
    const now = Date.now()

    // 1. 组装安装的插件
    const installed = (pluginsStore.installedPlugins || []).map((p) => {
      const key = p.pluginId
      return {
        ...p,
        key,
        type: 'plugin',
        badge: p.badge || '插件',
        faIcon: p.faIcon || resolveCommandFaIcon(p.name, p.category),
        iconGradient: p.iconGradient || getPluginGradient(p.name || p.pluginId),
        actionLabel: '启动'
      }
    })

    // 2. 组装内置系统条目
    const installedKeys = new Set(installed.map((item) => item.key))
    const remainingBuiltins = BUILTIN_COMMAND_ITEMS.filter((item) => !installedKeys.has(item.key))
    const allAvailable = [...installed, ...remainingBuiltins]

    const q = query.value.trim().toLowerCase()

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
    return scored.map((s) => s.item)
  })

  /**
   * 最终呈现的组合列表：高权重应用在前，本地文件在后
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
