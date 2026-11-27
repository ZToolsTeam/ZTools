export type SyncLocale = 'en-US' | 'zh-CN'

export type SyncMessageKey =
  | 'argon2.saltTooShort'
  | 'aesGcm.invalidKeyLength'
  | 'aesGcm.unsupportedAlgorithm'
  | 'aesGcm.invalidIvLength'
  | 'aesGcm.invalidTagLength'
  | 'aesGcm.decryptionFailed'
  | 'aesGcm.missingExpectedAad'
  | 'payload.invalidConfig'
  | 'payload.invalidClipboard'
  | 'webdav.invalidEndpoint'
  | 'webdav.insecureHttpNotAllowed'
  | 'webdav.invalidBasePath'
  | 'webdav.invalidSubPath'
  | 'webdav.propfindFailed'
  | 'webdav.mkcolFailed'
  | 'webdav.getFailed'
  | 'webdav.putConflict'
  | 'webdav.putFailed'
  | 'webdav.deleteFailed'
  | 'webdav.connectionSuccess'
  | 'gist.tokenRequired'
  | 'gist.missingGistId'
  | 'gist.getFailed'
  | 'gist.createFailed'
  | 'gist.conflict'
  | 'gist.updateFailed'
  | 'gist.fetchTruncatedFailed'
  | 'engine.invalidRecordId'
  | 'engine.missingAdapter'
  | 'engine.remoteExistsBaselineMissing'
  | 'engine.remoteGistExistsBaselineMissing'
  | 'engine.gistConfigFileNotFound'
  | 'engine.gistClipboardFileNotFound'
  | 'engine.gistRawUrlFetchFailed'
  | 'engine.gistSyncFileNotFound'
  | 'engine.gistSyncFileEmpty'
  | 'engine.invalidSyncState'
  | 'engine.destroyed'

export type SyncMessageParams = Record<string, string | number>

interface GlobalLocaleHolder {
  __ztoolsLocale?: unknown
}

/**
 * 同步引擎中英双语消息字典
 */
export const SYNC_MESSAGES: Record<SyncLocale, Record<SyncMessageKey, string>> = {
  'en-US': {
    'argon2.saltTooShort': 'Argon2id salt must be at least 8 bytes',
    'aesGcm.invalidKeyLength': 'AES-256-GCM key must be 32 bytes, received {length} bytes',
    'aesGcm.unsupportedAlgorithm': 'Unsupported encryption algorithm or payload version: {algorithm} v{version}',
    'aesGcm.invalidIvLength': 'Invalid IV length: {length} bytes',
    'aesGcm.invalidTagLength': 'Invalid authentication tag length: {length} bytes',
    'aesGcm.decryptionFailed': 'AES-256-GCM authenticated decryption failed: ciphertext tampered, key mismatch, or corrupted data',
    'aesGcm.missingExpectedAad': 'AES-256-GCM decryption failed: expected AAD prefix "{prefix}" is missing or does not match',
    'payload.invalidConfig': 'Decrypted configuration payload format is invalid',
    'payload.invalidClipboard': 'Decrypted clipboard payload format is invalid',
    'webdav.invalidEndpoint': 'Invalid WebDAV endpoint URL: "{endpoint}"',
    'webdav.insecureHttpNotAllowed': 'WebDAV endpoint must use HTTPS by default; set allowInsecureHttp: true to allow HTTP explicitly',
    'webdav.invalidBasePath': 'Invalid WebDAV basePath (path traversal or illegal characters detected): "{basePath}"',
    'webdav.invalidSubPath': 'Invalid WebDAV path (absolute URL, path traversal, or illegal characters detected): "{subPath}"',
    'webdav.propfindFailed': 'PROPFIND failed [{status} {statusText}]: {remotePath}',
    'webdav.mkcolFailed': 'MKCOL failed to create directory [{status} {statusText}]: {remotePath}',
    'webdav.getFailed': 'GET failed to download file [{status} {statusText}]: {remotePath}',
    'webdav.putConflict': 'PUT conflict (412 Precondition Failed): remote version does not match If-Match',
    'webdav.putFailed': 'PUT failed to upload file [{status} {statusText}]: {remotePath}',
    'webdav.deleteFailed': 'DELETE failed [{status} {statusText}]: {remotePath}',
    'webdav.connectionSuccess': 'Connection succeeded ({count} resources detected)',
    'gist.tokenRequired': 'GitHub Gist adapter requires a valid Personal Access Token',
    'gist.missingGistId': 'Target Gist ID is not specified',
    'gist.getFailed': 'Failed to fetch Gist [{status} {statusText}]',
    'gist.createFailed': 'Failed to create private Gist [{status} {statusText}]',
    'gist.conflict': 'Gist sync conflict detected: remote was updated at {remoteUpdatedAt}, local expected {expectedUpdatedAt}',
    'gist.updateFailed': 'Failed to update Gist [{status} {statusText}]',
    'gist.fetchTruncatedFailed': 'Failed to fetch truncated raw Gist file [{status} {statusText}]: {rawUrl}',
    'engine.invalidRecordId': 'Sync record ID must be a non-empty string',
    'engine.missingAdapter': 'Sync adapter is not configured (WebDavSyncAdapter or GistSyncAdapter)',
    'engine.remoteExistsBaselineMissing': 'Remote sync data already exists, but local has no baseline version; run pull() or sync() to merge remote data before pushing',
    'engine.remoteGistExistsBaselineMissing': 'Remote Gist already contains a sync file, but local has no baseline version; run pull() or sync() to merge remote data before pushing',
    'engine.gistConfigFileNotFound': 'Encrypted config file not found in Gist [{gistId}]: {filename}',
    'engine.gistClipboardFileNotFound': 'Encrypted clipboard file not found in Gist [{gistId}]: {filename}',
    'engine.gistRawUrlFetchFailed': 'Failed to fetch truncated ciphertext via raw_url [{status} {statusText}]',
    'engine.gistSyncFileNotFound': 'Encrypted sync file not found in Gist [{gistId}]: {filename}',
    'engine.gistSyncFileEmpty': 'Sync file content is empty in Gist [{gistId}]: {filename}',
    'engine.invalidSyncState': 'Decrypted sync state payload format is invalid',
    'engine.destroyed': 'E2eeSyncEngine has been destroyed and its derived key has been zeroed'
  },
  'zh-CN': {
    'argon2.saltTooShort': 'Argon2id 盐值长度至少需要 8 字节',
    'aesGcm.invalidKeyLength': 'AES-256-GCM 密钥长度必须为 32 字节，当前为 {length} 字节',
    'aesGcm.unsupportedAlgorithm': '不支持的加密算法或封包版本: {algorithm} v{version}',
    'aesGcm.invalidIvLength': '无效的 IV 长度: {length} 字节',
    'aesGcm.invalidTagLength': '无效的认证标签 Tag 长度: {length} 字节',
    'aesGcm.decryptionFailed': 'AES-256-GCM 认证解密失败：密文被篡改、密钥不匹配或数据损坏',
    'aesGcm.missingExpectedAad': 'AES-256-GCM 解密失败：缺少预期的 AAD 前缀 "{prefix}" 或业务上下文不匹配',
    'payload.invalidConfig': '解密后的配置数据格式无效',
    'payload.invalidClipboard': '解密后的剪贴板数据格式无效',
    'webdav.invalidEndpoint': '无效的 WebDAV 服务端点 URL: "{endpoint}"',
    'webdav.insecureHttpNotAllowed': 'WebDAV 端点默认强制使用 HTTPS；如需允许明文 HTTP 请显式设置 allowInsecureHttp: true',
    'webdav.invalidBasePath': '无效的 WebDAV basePath（检测到路径穿越或非法字符）: "{basePath}"',
    'webdav.invalidSubPath': '无效的 WebDAV 路径（检测到绝对 URL、路径穿越或非法字符）: "{subPath}"',
    'webdav.propfindFailed': 'PROPFIND 失败 [{status} {statusText}]: {remotePath}',
    'webdav.mkcolFailed': 'MKCOL 创建目录失败 [{status} {statusText}]: {remotePath}',
    'webdav.getFailed': 'GET 下载文件失败 [{status} {statusText}]: {remotePath}',
    'webdav.putConflict': 'PUT 发生并发冲突（412 Precondition Failed）：远程版本与 If-Match 不符',
    'webdav.putFailed': 'PUT 上传文件失败 [{status} {statusText}]: {remotePath}',
    'webdav.deleteFailed': 'DELETE 删除失败 [{status} {statusText}]: {remotePath}',
    'webdav.connectionSuccess': '连接成功 (检测到 {count} 个资源)',
    'gist.tokenRequired': 'GitHub Gist 适配器需要有效的 Personal Access Token',
    'gist.missingGistId': '未指定目标 Gist ID',
    'gist.getFailed': '获取 Gist 失败 [{status} {statusText}]',
    'gist.createFailed': '创建私有 Gist 失败 [{status} {statusText}]',
    'gist.conflict': '检测到 Gist 同步冲突：远程版本已在 {remoteUpdatedAt} 被更新，本地预期为 {expectedUpdatedAt}',
    'gist.updateFailed': '更新 Gist 失败 [{status} {statusText}]',
    'gist.fetchTruncatedFailed': '拉取截断 Gist 原始文件失败 [{status} {statusText}]: {rawUrl}',
    'engine.invalidRecordId': '同步记录 ID 必须为非空字符串',
    'engine.missingAdapter': '未配置同步适配器 (WebDavSyncAdapter 或 GistSyncAdapter)',
    'engine.remoteExistsBaselineMissing': '检测到远端已存在同步数据，而本地尚无同步基线版本号；请先执行 pull() 或 sync() 合并远端数据后再推送',
    'engine.remoteGistExistsBaselineMissing': '检测到远端 Gist 已存在同步文件，而本地尚无同步基线版本号；请先执行 pull() 或 sync() 合并远端数据后再推送',
    'engine.gistConfigFileNotFound': 'Gist [{gistId}] 中未找到加密配置文件: {filename}',
    'engine.gistClipboardFileNotFound': 'Gist [{gistId}] 中未找到加密剪贴板文件: {filename}',
    'engine.gistRawUrlFetchFailed': '通过 raw_url 拉取截断密文失败 [{status} {statusText}]',
    'engine.gistSyncFileNotFound': 'Gist [{gistId}] 中未找到加密同步文件: {filename}',
    'engine.gistSyncFileEmpty': 'Gist [{gistId}] 中同步文件内容为空: {filename}',
    'engine.invalidSyncState': '解密后的同步状态数据格式无效',
    'engine.destroyed': 'E2eeSyncEngine 已销毁且派生密钥已清零，无法继续操作'
  }
}

/**
 * 清理语言标签：去首尾空白、剥离 POSIX `.UTF-8` / `@...` 后缀并将 `_` 转为 `-`。
 * 与 `packages/ztools-plugins-spec/src/locale.js` 保持 100% 行为等价。
 */
export function stripSyncLocaleSuffix(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutPosix = trimmed.split(/[.@]/)[0] || ''
  return withoutPosix.trim().replace(/_/g, '-')
}

/**
 * 严格匹配受支持语言标签（zh-CN / en-US）。
 * 遇到空值、`'system'`/`'auto'`/`'default'` 或第三语种（如 `ja-JP`/`fr-FR`）返回 `null`。
 */
export function matchSyncSupportedLocale(raw?: unknown): SyncLocale | null {
  const cleaned = stripSyncLocaleSuffix(raw)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  if (lower === 'system' || lower === 'auto' || lower === 'default') {
    return null
  }
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh-CN'
  }
  if (lower === 'en' || lower.startsWith('en-')) {
    return 'en-US'
  }
  return null
}

/**
 * 解析同步模块运行语言：
 * 支持单值或候选数组；自动剥离 `.UTF-8`/`@...` 并跳过 `'system'`、空值与第三语种；
 * 优先级：显式参数 > `globalThis.__ztoolsLocale` > `process.env.ZTOOLS_LOCALE` > 默认 `'en-US'`。
 */
export function resolveSyncLocale(locale?: unknown | readonly unknown[]): SyncLocale {
  const explicitList = Array.isArray(locale) ? locale : [locale]
  const globalLocale = (globalThis as GlobalLocaleHolder).__ztoolsLocale
  const envLocale = typeof process !== 'undefined' && process.env ? process.env.ZTOOLS_LOCALE : undefined

  const candidates: unknown[] = [...explicitList, globalLocale, envLocale]
  for (const candidate of candidates) {
    const matched = matchSyncSupportedLocale(candidate)
    if (matched) {
      return matched
    }
  }
  return 'en-US'
}

const ESCAPED_PIPE_SENTINEL = '\uE000SYNC_PIPE\uE001'
const ESCAPED_BRACE_PREFIX = '\uE000SYNC_LBRACE:'
const ESCAPED_BRACE_SUFFIX = ':SYNC_RBRACE\uE001'

function selectPluralForm(forms: string[], count: number): string {
  if (forms.length <= 1) return forms[0] ?? ''
  if (forms.length === 2) return Math.abs(count) === 1 ? forms[0] : forms[1]
  if (count === 0) return forms[0]
  return Math.abs(count) === 1 ? forms[1] : forms[2]
}

function splitTopLevelPipeForms(template: string): string[] {
  const parts: string[] = []
  let current = ''
  let inInlinePlural = false

  for (let i = 0; i < template.length; i += 1) {
    if (!inInlinePlural && template[i] === '[' && template[i + 1] === '[') {
      inInlinePlural = true
      current += '[['
      i += 1
      continue
    }
    if (inInlinePlural && template[i] === ']' && template[i + 1] === ']') {
      inInlinePlural = false
      current += ']]'
      i += 1
      continue
    }
    if (!inInlinePlural && template[i] === '|') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += template[i]
  }

  parts.push(parts.length > 0 ? current.trim() : current)
  return parts
}

/**
 * 格式化同步消息模板：支持 `{param}` 插值（安全处理 0 值）、`[[count:singular|plural]]` 内联复数、
 * 整串 `|` 分段复数、`\|` 与 `{{var}}` 字面量转义。
 */
export function formatSyncTemplate(template: string, params?: SyncMessageParams): string {
  let working = template
    .replace(/\\\|/g, ESCAPED_PIPE_SENTINEL)
    .replace(
      /\{\{([A-Za-z0-9_.-]+)\}\}/g,
      (_match, token: string) => `${ESCAPED_BRACE_PREFIX}${token}${ESCAPED_BRACE_SUFFIX}`
    )

  const rawCount = params && Object.prototype.hasOwnProperty.call(params, 'count') ? params.count : undefined
  if (typeof rawCount === 'number' && Number.isFinite(rawCount) && working.includes('|')) {
    const topForms = splitTopLevelPipeForms(working)
    if (topForms.length > 1) {
      working = selectPluralForm(topForms, rawCount)
    }
  }

  if (params && working.includes('[[')) {
    working = working.replace(
      /\[\[([A-Za-z0-9_.-]+):([^\]]+)\]\]/g,
      (match, token: string, body: string) => {
        if (!Object.prototype.hasOwnProperty.call(params, token)) return match
        const value = params[token]
        if (typeof value !== 'number' || !Number.isFinite(value)) return match
        return selectPluralForm(body.split('|'), value)
      }
    )
  }

  if (params) {
    working = working.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, token: string) => {
      if (!Object.prototype.hasOwnProperty.call(params, token)) return match
      const value = params[token]
      return value !== undefined ? String(value) : match
    })
  }

  return working
    .replace(
      new RegExp(`${ESCAPED_BRACE_PREFIX}([A-Za-z0-9_.-]+)${ESCAPED_BRACE_SUFFIX}`, 'g'),
      (_match, token: string) => `{${token}}`
    )
    .replace(new RegExp(ESCAPED_PIPE_SENTINEL, 'g'), '|')
}

/**
 * 按解析后的语言格式化同步模块消息，支持 {param} 插值（安全处理 0 值）、复数与转义
 */
export function tSync(
  key: SyncMessageKey,
  params?: SyncMessageParams,
  locale?: string
): string {
  const resolved = resolveSyncLocale(locale)
  const template = SYNC_MESSAGES[resolved][key]
  return formatSyncTemplate(template, params)
}
