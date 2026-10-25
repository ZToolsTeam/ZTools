import type { Quicklink, QuicklinkCategory, QuicklinkItem, QuicklinkResolved } from './types.js'

export const DEFAULT_QUICKLINKS: Quicklink[] = [
  {
    id: 'ql-1',
    title: 'GitHub 代码与仓库搜索',
    link: 'https://github.com/search?q={query}',
    urlPattern: 'https://github.com/search?q={query}',
    keyword: 'gh',
    alias: 'gh',
    category: 'search',
    isGroup: false,
    description: '检索 GitHub 全球开源仓库、代码与 Issue',
    icon: 'code',
    defaultArgument: 'ztools',
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: 'ql-2',
    title: '知乎深度问答检索',
    link: 'https://www.zhihu.com/search?type=content&q={query}',
    urlPattern: 'https://www.zhihu.com/search?type=content&q={query}',
    keyword: 'zh',
    alias: 'zh',
    category: 'search',
    isGroup: false,
    description: '在知乎搜索行业深度技术解析与评测',
    icon: 'globe',
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: 'ql-3',
    title: '哔哩哔哩 (Bilibili) 搜索',
    link: 'https://search.bilibili.com/all?keyword={query}',
    urlPattern: 'https://search.bilibili.com/all?keyword={query}',
    keyword: 'bili',
    alias: 'bili',
    category: 'search',
    isGroup: false,
    description: 'B 站硬核科技视频与教程直达',
    icon: 'play',
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: 'ql-4',
    title: 'DeepSeek 智能对话工作台',
    link: 'https://chat.deepseek.com',
    urlPattern: 'https://chat.deepseek.com',
    keyword: 'ds',
    alias: 'ds',
    category: 'direct',
    isGroup: false,
    description: 'DeepSeek-R1 官方大模型深度思考与对话平台',
    icon: 'globe',
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  },
  {
    id: 'ql-5',
    title: '晨会研发看板与流水线网址组',
    link: 'https://github.com/ZToolsTeam/ZTools',
    urlPattern: 'https://github.com/ZToolsTeam/ZTools',
    keyword: 'morning',
    alias: 'morning',
    category: 'group',
    isGroup: true,
    urls: [
      'https://github.com/ZToolsTeam/ZTools/pulls',
      'https://github.com/ZToolsTeam/ZTools/actions',
      'https://cdn.ztools.cn/plugins-v2/catalog.json'
    ],
    description: '一键并发打开 PR 列表、CI 构建流水线与插件目录大盘 (共 3 个网页)',
    icon: 'window',
    openCount: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  }
]

const STORAGE_KEY = 'ztools:quicklinks:data'

export function validateQuicklinkUrlPattern(rawUrl: string): {
  valid: boolean
  normalizedUrl: string
  error?: string
} {
  const trimmed = String(rawUrl ?? '').trim()
  if (!trimmed) {
    return { valid: false, normalizedUrl: '', error: 'INVALID_URL: 目标网址不能为空' }
  }
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:text/html')
  ) {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'DANGEROUS_PROTOCOL: 严禁使用 javascript: 等危险脚本伪协议'
    }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { valid: true, normalizedUrl: trimmed }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) {
    return { valid: true, normalizedUrl: `https://${trimmed}` }
  }
  return {
    valid: false,
    normalizedUrl: '',
    error: 'INVALID_URL: 请输入合法的 http(s):// 网址或域名'
  }
}

/**
 * 构建目标访问 URL：
 * - 若传入 queryText，进行严格的 encodeURIComponent 替换；
 * - 若未传入 queryText 且模板带 {query}，智能降级返回站点首页 origin
 */
export function buildTargetUrl(pattern: string, queryText?: string): string {
  const check = validateQuicklinkUrlPattern(pattern)
  if (!check.valid) {
    throw new Error(check.error)
  }
  const normalized = check.normalizedUrl
  const hasPlaceholder = /\{(query|argument|arg)(?:\s+[^}]*)?\}/i.test(normalized)
  const cleanQuery = String(queryText ?? '').trim()

  if (!hasPlaceholder) {
    return normalized
  }

  if (cleanQuery) {
    return normalized.replace(
      /\{(query|argument|arg)(?:\s+[^}]*)?\}/gi,
      encodeURIComponent(cleanQuery)
    )
  }

  // 智能降级至站点主页
  try {
    const parsed = new URL(normalized.replace(/\{(query|argument|arg)(?:\s+[^}]*)?\}/gi, ''))
    return parsed.origin
  } catch {
    return normalized.split('?')[0] || normalized
  }
}

export async function launchQuicklink(
  item: QuicklinkItem | Quicklink,
  queryText?: string,
  opener?: (url: string) => Promise<void> | void
): Promise<string[]> {
  const openFn =
    opener ??
    (async (targetUrl: string) => {
      const g = globalThis as Record<string, unknown>
      const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
      const ztools = (win.ztools || g.ztools) as
        | {
            shell?: { openExternal?: (u: string) => Promise<void> }
            invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown>
          }
        | undefined
      const electron = win.__ztoolsElectron as
        | {
            transport?: {
              invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown>
              methods?: Record<string, (p?: Record<string, unknown>) => Promise<unknown>>
            }
          }
        | undefined
      if (typeof ztools?.shell?.openExternal === 'function') {
        await ztools.shell.openExternal(targetUrl)
        return
      }
      if (typeof electron?.transport?.methods?.shell_open_external === 'function') {
        await electron.transport.methods.shell_open_external({ url: targetUrl })
        return
      }
      if (typeof electron?.transport?.invoke === 'function') {
        await electron.transport.invoke('shell_open_external', { url: targetUrl })
        return
      }
      if (typeof ztools?.invoke === 'function') {
        await ztools.invoke('shell_open_external', { url: targetUrl })
      }
    })

  if (item.isGroup && Array.isArray(item.urls) && item.urls.length > 0) {
    const launched: string[] = []
    for (const rawUrl of item.urls) {
      const target = buildTargetUrl(rawUrl, queryText)
      await openFn(target)
      launched.push(target)
    }
    return launched
  }

  const pattern = item.urlPattern || ('link' in item ? item.link : '')
  const target = buildTargetUrl(pattern, queryText)
  await openFn(target)
  return [target]
}

export async function getQuicklinks(): Promise<Quicklink[]> {
  if (typeof localStorage !== 'undefined') {
    try {
      const data = localStorage.getItem(STORAGE_KEY)
      if (data) {
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
        }
      }
    } catch {
      // Fallback to defaults
    }
  }
  return [...DEFAULT_QUICKLINKS]
}

export async function saveQuicklinks(quicklinks: Quicklink[]): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(quicklinks))
      localStorage.setItem(`${STORAGE_KEY}:backup`, JSON.stringify(quicklinks))
    } catch {
      // Ignore storage quota error
    }
  }
}

export function resolveQuicklinkUrl(
  linkTemplate: string,
  queryParam?: string,
  defaultParam?: string
): QuicklinkResolved {
  if (!linkTemplate || typeof linkTemplate !== 'string') {
    return { url: '', hasQuery: false, needsArgument: false }
  }
  const placeholderRegex =
    /\{(query|argument|arg)(?:\s+name="([^"]*)")?(?:\s+default="([^"]*)")?\}/gi
  const hasQuery = placeholderRegex.test(linkTemplate)
  if (!hasQuery) {
    return { url: linkTemplate.trim(), hasQuery: false, needsArgument: false }
  }
  placeholderRegex.lastIndex = 0
  const rawArg = queryParam !== undefined && queryParam !== null ? String(queryParam).trim() : ''
  let missingArgument = false
  const resolved = linkTemplate.replace(placeholderRegex, (_m, _t, _n, defaultAttr) => {
    if (rawArg) return encodeURIComponent(rawArg)
    if (defaultAttr !== undefined && defaultAttr !== null) return encodeURIComponent(defaultAttr)
    if (defaultParam) return encodeURIComponent(defaultParam)
    missingArgument = true
    return ''
  })
  return {
    url: resolved,
    hasQuery: true,
    queryParam: rawArg,
    needsArgument: missingArgument && !rawArg
  }
}

export function filterQuicklinks(
  quicklinks: Quicklink[],
  searchQuery: string,
  categoryFilter: 'all' | QuicklinkCategory = 'all'
): { matches: Quicklink[]; directMatch?: { quicklink: Quicklink; queryArg: string } } {
  const byCategory = quicklinks.filter((ql) => {
    if (categoryFilter === 'all') return true
    const cat: QuicklinkCategory =
      ql.category ||
      (ql.isGroup ? 'group' : /\{(query|argument|arg)\}/i.test(ql.link) ? 'search' : 'direct')
    return cat === categoryFilter
  })

  if (!searchQuery || !searchQuery.trim()) {
    return { matches: byCategory }
  }

  const query = searchQuery.trim()
  const parts = query.split(/\s+/)
  const firstWord = (parts[0] || '').toLowerCase()
  const restArg = parts.slice(1).join(' ')

  const directQuicklink = byCategory.find(
    (ql) => (ql.alias || ql.keyword || '').toLowerCase() === firstWord
  )

  if (directQuicklink && restArg) {
    return {
      matches: [directQuicklink],
      directMatch: {
        quicklink: directQuicklink,
        queryArg: restArg
      }
    }
  }

  const qLower = query.toLowerCase()
  const matches = byCategory.filter(
    (ql) =>
      ql.title.toLowerCase().includes(qLower) ||
      ql.link.toLowerCase().includes(qLower) ||
      (ql.keyword && ql.keyword.toLowerCase().includes(qLower)) ||
      (ql.alias && ql.alias.toLowerCase().includes(qLower)) ||
      (ql.description && ql.description.toLowerCase().includes(qLower))
  )

  return { matches }
}

export function exportQuicklinksJson(quicklinks: Quicklink[]): string {
  return JSON.stringify(quicklinks, null, 2)
}

export function importQuicklinksJson(
  jsonStr: string,
  existing: Quicklink[]
): { success: boolean; importedCount: number; result: Quicklink[]; error?: string } {
  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) {
      return {
        success: false,
        importedCount: 0,
        result: existing,
        error: '导入内容必须为 Quicklink 数组 JSON'
      }
    }
    const existingMap = new Map<string, Quicklink>()
    existing.forEach((item) => existingMap.set(item.id, item))
    let importedCount = 0
    const merged = [...existing]

    for (const item of parsed) {
      if (item && typeof item === 'object' && item.title && item.link) {
        const check = validateQuicklinkUrlPattern(String(item.link))
        if (!check.valid) continue
        importedCount++
        const id = item.id || `ql-import-${Date.now()}-${importedCount}`
        if (!existingMap.has(id)) {
          merged.push({
            id,
            title: String(item.title).trim(),
            link: check.normalizedUrl,
            urlPattern: check.normalizedUrl,
            keyword: item.keyword ? String(item.keyword).trim() : undefined,
            alias: item.alias ? String(item.alias).trim() : undefined,
            description: item.description ? String(item.description).trim() : undefined,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
          existingMap.set(id, merged[merged.length - 1]!)
        }
      }
    }
    return { success: true, importedCount, result: merged }
  } catch (err) {
    return {
      success: false,
      importedCount: 0,
      result: existing,
      error: err instanceof Error ? err.message : 'JSON 解析失败'
    }
  }
}
