/**
 * manifest.ts
 * uTools Manifest normalization and validation engine
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { NormalizedManifest, TriggerItem } from './types.ts'

const CHINESE_TOOL_SEMANTICS: Array<[string, string]> = [
  ['格式化', 'formatter'],
  ['美化', 'beautifier'],
  ['转换器', 'converter'],
  ['转换', 'converter'],
  ['计算器', 'calculator'],
  ['计算', 'calc'],
  ['生成器', 'generator'],
  ['生成', 'generator'],
  ['管理器', 'manager'],
  ['管理', 'manager'],
  ['助手', 'helper'],
  ['工具箱', 'toolbox'],
  ['工具', 'tool'],
  ['剪贴板', 'clipboard'],
  ['二维码', 'qrcode'],
  ['时间戳', 'timestamp'],
  ['时间', 'time'],
  ['日期', 'date'],
  ['正则', 'regex'],
  ['编码', 'encoder'],
  ['解码', 'decoder'],
  ['加解密', 'crypto'],
  ['加密', 'encryptor'],
  ['解密', 'decryptor'],
  ['文本', 'text'],
  ['代码', 'code'],
  ['字符串', 'string'],
  ['统计', 'stat'],
  ['比对', 'diff'],
  ['压缩', 'minify'],
  ['解压', 'decompress'],
  ['图片', 'image'],
  ['图床', 'img-host'],
  ['取色', 'color-picker'],
  ['颜色', 'color'],
  ['截图', 'screenshot'],
  ['录屏', 'record'],
  ['音频', 'audio'],
  ['视频', 'video'],
  ['文件', 'file'],
  ['重命名', 'rename'],
  ['备忘录', 'memo'],
  ['笔记', 'notes'],
  ['搜索', 'search'],
  ['翻译', 'translator'],
  ['便签', 'sticky-notes'],
  ['查杀', 'cleaner'],
  ['清理', 'cleaner'],
  ['加速', 'booster'],
  ['硬件', 'hardware'],
  ['网络', 'network']
]

const WINDOWS_EXCLUSIVE_KEYWORDS = new Set([
  'regedit', 'winreg', 'node-winreg', 'windows-shortcuts', 'node-ffi',
  'ffi-napi', 'activex', 'wscript', 'wmi', 'win32-display', 'edge-js',
  'boost', 'flow-guard', 'network-adapter', 'network-rescue', 'hardware-info'
])

export function normalizeRelativePath(p: any): string {
  if (typeof p !== 'string') return ''
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

export function isSafeRelativePath(p: any): boolean {
  if (typeof p !== 'string' || p.trim() === '') return false
  const normalized = p.trim().replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/i.test(normalized)) return false
  const segments = normalized.split('/')
  return !segments.includes('..') && !segments.some(seg => seg.includes(':'))
}

export function normalizeSemVer(version: any): string {
  if (typeof version !== 'string' || !version.trim()) return '1.0.0'
  const v = version.trim().replace(/^v/i, '')
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    return v
  }
  const parts = v.split('.')
  if (parts.length === 1 && /^\d+$/.test(parts[0])) {
    return `${parts[0]}.0.0`
  }
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return `${parts[0]}.${parts[1]}.0`
  }
  return '1.0.0'
}

export function generateStablePluginId(
  candidateSources: { id?: string; name?: string; pluginName?: string; packageName?: string },
  options: { customId?: string | null; author?: string } = {}
): { id: string; source: string; coerced: boolean } {
  const { customId, author = '' } = options
  const ID_PATTERN = /^[a-z][a-z0-9-]*$/

  if (customId && typeof customId === 'string') {
    const trimmed = customId.trim().toLowerCase()
    if (ID_PATTERN.test(trimmed)) {
      return { id: trimmed, source: 'custom', coerced: false }
    }
    throw new Error(`指定的自定义插件 ID "${customId}" 不符合规范：必须以小写字母开头，仅包含小写字母、数字和连字符 (^[a-z][a-z0-9-]*$)`)
  }

  // 1. 已有合规 ID
  if (candidateSources.id && ID_PATTERN.test(candidateSources.id.trim().toLowerCase())) {
    return { id: candidateSources.id.trim().toLowerCase(), source: 'manifest.id', coerced: false }
  }

  // 2. 选择候选字符串
  const candidate = (
    candidateSources.name ||
    candidateSources.packageName ||
    candidateSources.pluginName ||
    ''
  ).trim()

  if (!candidate) {
    const hash = crypto.createHash('sha256').update(author || 'ztools-utools-plugin').digest('hex').slice(0, 8)
    return { id: `utools-plugin-${hash}`, source: 'fallback-hash', coerced: true }
  }

  // 3. 中文语义替换
  let transformed = candidate
  for (const [cn, en] of CHINESE_TOOL_SEMANTICS) {
    transformed = transformed.replaceAll(cn, `-${en}-`)
  }

  // 4. 清洗字符
  let cleaned = transformed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  if (!cleaned) {
    const hash = crypto.createHash('sha256').update(candidate + (author || '')).digest('hex').slice(0, 8)
    return { id: `utools-plugin-${hash}`, source: 'hash-of-name', coerced: true }
  }

  // 5. 首字符必须为小写字母
  if (!/^[a-z]/.test(cleaned)) {
    cleaned = `p-${cleaned}`
  }

  if (cleaned.length > 64) {
    cleaned = cleaned.slice(0, 64).replace(/-$/, '')
  }

  return { id: cleaned, source: 'auto-sanitized', coerced: cleaned !== candidate }
}

export function extractKeywords(manifest: Record<string, any>): { keywords: string[]; keyword: string } {
  const wordsSet = new Set<string>()

  function addWord(text: any) {
    if (typeof text !== 'string') return
    const trimmed = text.trim()
    if (!trimmed) return
    const tokens = trimmed.split(/[\s,，;；|]+/g)
    for (const token of tokens) {
      const clean = token.trim()
      if (clean && clean.length >= 2 && !/^[^\w\u4e00-\u9fa5]+$/.test(clean)) {
        wordsSet.add(clean)
      }
    }
  }

  if (manifest.pluginName) addWord(manifest.pluginName)
  if (manifest.name) addWord(manifest.name)

  const features = Array.isArray(manifest.features) ? manifest.features : []
  for (const feat of features) {
    if (feat.code) addWord(feat.code)
    if (feat.explain) addWord(feat.explain)

    const cmds = Array.isArray(feat.cmds) ? feat.cmds : []
    for (const cmd of cmds) {
      if (typeof cmd === 'string') {
        addWord(cmd)
      } else if (cmd && typeof cmd === 'object') {
        if (cmd.label) addWord(cmd.label)
        if (typeof cmd.match === 'string' && !cmd.match.startsWith('/')) {
          addWord(cmd.match)
        }
      }
    }
  }

  const keywordsArray = Array.from(wordsSet)
  return { keywords: keywordsArray, keyword: keywordsArray.join(' ') }
}

export function mapCommandsToTriggers(features: any[]): TriggerItem[] {
  const triggers: TriggerItem[] = []
  if (!Array.isArray(features)) return triggers

  for (const feat of features) {
    const featureCode = feat.code || ''
    const cmds = Array.isArray(feat.cmds) ? feat.cmds : []

    for (const cmd of cmds) {
      if (typeof cmd === 'string') {
        triggers.push({
          type: 'keyword',
          featureCode,
          keyword: cmd
        })
      } else if (cmd && typeof cmd === 'object') {
        const cmdType = cmd.type || 'text'
        const label = cmd.label || feat.explain || featureCode

        switch (cmdType) {
          case 'text':
            triggers.push({
              type: 'keyword',
              featureCode,
              keyword: label,
              minLength: cmd.minLength,
              maxLength: cmd.maxLength
            })
            break
          case 'regex':
            triggers.push({
              type: 'clipboard-regex',
              featureCode,
              label,
              pattern: typeof cmd.match === 'string' ? cmd.match : String(cmd.match),
              minLength: cmd.minLength,
              maxLength: cmd.maxLength
            })
            break
          case 'over':
            triggers.push({
              type: 'clipboard-text-over',
              featureCode,
              label,
              minLength: typeof cmd.minLength === 'number' ? cmd.minLength : 1,
              maxLength: cmd.maxLength,
              exclude: cmd.exclude
            })
            break
          case 'img':
            triggers.push({
              type: 'clipboard-image',
              featureCode,
              label
            })
            break
          case 'files':
            triggers.push({
              type: 'file-context',
              featureCode,
              label,
              fileType: cmd.fileType || 'file',
              extensions: Array.isArray(cmd.extensions)
                ? cmd.extensions.map(ext => String(ext).replace(/^\./, '').toLowerCase())
                : [],
              minLength: cmd.minLength,
              maxLength: cmd.maxLength
            })
            break
          case 'window':
            triggers.push({
              type: 'window-context',
              featureCode,
              label,
              match: typeof cmd.match === 'object' && cmd.match !== null ? cmd.match : {}
            })
            break
          default:
            triggers.push({
              type: `custom-${cmdType}`,
              featureCode,
              label,
              raw: cmd
            })
            break
        }
      }
    }
  }

  return triggers
}

export function detectTier4WindowsExclusive(manifest: Record<string, any>, pluginDir: string | null = null): { isTier4: boolean; reason: string | null } {
  const textToCheck = `${manifest.name || ''} ${manifest.pluginName || ''} ${manifest.description || ''}`.toLowerCase()
  for (const kw of WINDOWS_EXCLUSIVE_KEYWORDS) {
    if (textToCheck.includes(kw)) {
      return { isTier4: true, reason: `名称或描述包含 Windows 独占关键词: ${kw}` }
    }
  }

  if (pluginDir && fs.existsSync(path.join(pluginDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
      for (const dep of Object.keys(allDeps)) {
        if (WINDOWS_EXCLUSIVE_KEYWORDS.has(dep.toLowerCase())) {
          return { isTier4: true, reason: `package.json 引入了 Windows 独占 npm 模块: ${dep}` }
        }
      }
    } catch {}
  }

  return { isTier4: false, reason: null }
}

export function normalizeManifest(
  raw: any,
  options: { pluginDir?: string | null; customId?: string | null; strictTargets?: boolean } = {}
): { manifest: NormalizedManifest | null; diagnostics: { errors: string[]; warnings: string[]; info: string[] } } {
  const { pluginDir = null, customId = null, strictTargets = false } = options
  const diagnostics = {
    errors: [] as string[],
    warnings: [] as string[],
    info: [] as string[]
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.errors.push('plugin.json 根节点必须是一个有效的 JSON 对象')
    return { manifest: null, diagnostics }
  }

  let packageName = ''
  if (pluginDir && fs.existsSync(path.join(pluginDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
      packageName = pkg.name || ''
    } catch {}
  }

  let idResult
  try {
    idResult = generateStablePluginId(
      { id: raw.id, name: raw.name, pluginName: raw.pluginName, packageName },
      { customId, author: typeof raw.author === 'string' ? raw.author : raw.author?.name }
    )
    if (idResult.coerced) {
      diagnostics.info.push(`[ID_GENERATED] 插件 ID 自动生成为 "${idResult.id}" (依据: ${idResult.source})`)
    }
  } catch (err: any) {
    diagnostics.errors.push(err.message)
    return { manifest: null, diagnostics }
  }

  const pluginId = idResult.id
  let name = (raw.pluginName || raw.name || pluginId).trim()
  if (!name) {
    name = pluginId
    diagnostics.warnings.push('未提供插件展示名称 (pluginName/name)，默认回退至插件 ID')
  }

  const rawVersion = raw.version
  const version = normalizeSemVer(rawVersion)
  if (rawVersion && rawVersion !== version) {
    diagnostics.warnings.push(`[VERSION_COERCED] 版本号 "${rawVersion}" 不满足标准 SemVer，已自动规范化为 "${version}"`)
  }

  let description = (raw.description || raw.explain || '').trim()
  if (!description) {
    description = name
    diagnostics.warnings.push('未提供插件描述 (description)，已使用名称填充占位')
  }

  let author = 'Unknown'
  if (typeof raw.author === 'string' && raw.author.trim()) {
    author = raw.author.trim()
  } else if (raw.author && typeof raw.author === 'object') {
    author = raw.author.name || 'Unknown'
    if (raw.author.email) {
      author = `${author} <${raw.author.email}>`
    }
  } else {
    diagnostics.warnings.push('未声明插件作者 (author)，已默认填充 "Unknown"')
  }

  const rawMain = normalizeRelativePath(raw.main)
  const rawPreload = normalizeRelativePath(raw.preload)
  let entry = rawMain
  let templateMode = false

  if (rawMain) {
    if (!isSafeRelativePath(rawMain) && !/^https?:\/\//i.test(rawMain)) {
      diagnostics.errors.push(`main 页面路径 "${rawMain}" 不合法：必须是插件内的相对路径`)
    }
  } else if (rawPreload) {
    templateMode = true
    entry = 'index.html'
    diagnostics.info.push('[TEMPLATE_MODE] 检测到 uTools 模板插件模式（无 main，有 preload），已指派通用模板入口 index.html')
  } else {
    diagnostics.errors.push('uTools 插件必须至少声明 main (UI入口) 或 preload (脚本入口) 其中之一')
  }

  let icon = normalizeRelativePath(raw.logo || raw.icon || 'icon.png')
  if (!icon) icon = 'icon.png'
  if (!isSafeRelativePath(icon)) {
    diagnostics.errors.push(`logo/icon 图标路径 "${icon}" 不合法：必须是安全相对路径`)
  }

  const pluginSetting = typeof raw.pluginSetting === 'object' && raw.pluginSetting !== null ? raw.pluginSetting : {}
  const hasFixedFixedHeight = typeof pluginSetting.height === 'number' && pluginSetting.height > 0
  const windowConfig = {
    width: 900,
    height: hasFixedFixedHeight ? Math.round(pluginSetting.height) : 640,
    minWidth: 480,
    minHeight: 360,
    resizable: !hasFixedFixedHeight,
    singleInstance: pluginSetting.single !== false,
    controls: {
      minimize: true,
      maximize: !hasFixedFixedHeight
    }
  }

  const rawFeatures = Array.isArray(raw.features) ? raw.features : []
  const standardFeatures = rawFeatures.map(f => ({
    code: String(f.code || '').trim() || 'main',
    explain: String(f.explain || f.code || name).trim()
  }))

  const { keywords, keyword } = extractKeywords(raw)
  const triggers = mapCommandsToTriggers(rawFeatures)

  const tier4Check = detectTier4WindowsExclusive(raw, pluginDir)
  let platforms = ['win32', 'darwin']
  let targets = [
    {
      id: 'windows-electron-x64',
      platform: 'windows',
      runtime: 'electron',
      arch: 'x64'
    },
    {
      id: 'macos-electron-universal',
      platform: 'macos',
      runtime: 'electron',
      arch: 'universal'
    }
  ]

  if (tier4Check.isTier4) {
    platforms = ['win32']
    targets = [
      {
        id: 'windows-electron-x64',
        platform: 'windows',
        runtime: 'electron',
        arch: 'x64'
      }
    ]
    diagnostics.warnings.push(`[TIER4_PRUNED] 检测到 Windows 专属特征 (${tier4Check.reason})，已自动剪枝 macOS 平台支持 (Tier 4)`)
  }

  const normalized: NormalizedManifest = {
    id: pluginId,
    name,
    version,
    description,
    category: Array.isArray(raw.category) ? raw.category : ['效率工具'],
    author,
    entry,
    icon,
    targets,
    nativeComponents: [],
    features: standardFeatures,
    triggers,
    platforms,
    keywords,
    keyword,
    window: windowConfig
  }

  if (rawPreload) {
    normalized.preload = rawPreload
  }

  return { manifest: normalized, diagnostics }
}
