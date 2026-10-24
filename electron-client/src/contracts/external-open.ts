export const MACOS_EXTERNAL_OPEN_LIMITS = Object.freeze({
  pendingRequests: 32,
  maxFilePathBytes: 4096,
  maxUrlBytes: 8192
})

export interface MacosFileOpenRequest {
  readonly kind: 'file'
  readonly filePath: string
}

export interface MacosPluginOpenRequest {
  readonly kind: 'plugin-open'
  readonly pluginId: string
}

export type MacosExternalOpenRequest = MacosFileOpenRequest | MacosPluginOpenRequest

export type MacosExternalOpenValidation<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly reason: 'invalid-file-path' | 'file-path-too-long' | 'invalid-url' | 'unsupported-url' | 'url-too-long' }

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const PLUGIN_OPEN_URL_PATTERN = /^ztools:\/\/open\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/

function isAllowedPluginId(value: string): boolean {
  return PLUGIN_ID_PATTERN.test(value) && !value.endsWith('.') && !WINDOWS_DEVICE_PATTERN.test(value)
}

/** Validate an absolute path received from Electron's macOS open-file event without touching the filesystem. */
export function validateMacosOpenFilePath(value: unknown): MacosExternalOpenValidation<string> {
  if (typeof value !== 'string' || value.length === 0 || !value.startsWith('/') || value.includes('\0')) {
    return { valid: false, reason: 'invalid-file-path' }
  }
  if (Buffer.byteLength(value, 'utf8') > MACOS_EXTERNAL_OPEN_LIMITS.maxFilePathBytes) {
    return { valid: false, reason: 'file-path-too-long' }
  }
  if (value !== '/' && value.slice(1).split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { valid: false, reason: 'invalid-file-path' }
  }
  return { valid: true, value }
}

/** Only ztools://open/<plugin-id> is an external URL. No query, fragment, escape, or extra path is accepted. */
export function validateMacosOpenUrl(value: unknown): MacosExternalOpenValidation<MacosPluginOpenRequest> {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return { valid: false, reason: 'invalid-url' }
  }
  if (Buffer.byteLength(value, 'utf8') > MACOS_EXTERNAL_OPEN_LIMITS.maxUrlBytes) {
    return { valid: false, reason: 'url-too-long' }
  }
  if (!value.startsWith('ztools:')) return { valid: false, reason: 'unsupported-url' }

  const match = PLUGIN_OPEN_URL_PATTERN.exec(value)
  const pluginId = match?.[1]
  if (!pluginId || !isAllowedPluginId(pluginId)) return { valid: false, reason: 'invalid-url' }
  return { valid: true, value: Object.freeze({ kind: 'plugin-open', pluginId }) }
}
