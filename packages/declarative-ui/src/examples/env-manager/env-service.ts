import { callHostTransport } from '../shared/native-ipc.js'
import type { EnvFilterCategory, EnvItem, EnvScope } from './types.js'

export function expandEnvVariablesInString(
  rawValue: string,
  envMap: Record<string, string>
): string {
  return String(rawValue ?? '').replace(/%([^%]+)%/g, (full, varName: string) => {
    const found = envMap[varName] ?? envMap[varName.toUpperCase()] ?? envMap[varName.toLowerCase()]
    return typeof found === 'string' && found ? found : full
  })
}

export async function loadAllEnvVariables(
  customEnv?: Record<string, string>,
  hostOverride?: unknown
): Promise<EnvItem[]> {
  const res = await callHostTransport<{ items?: EnvItem[] }>(
    'dllplugin_call',
    {
      plugin: 'EnvManagerPlugin',
      func: 'loadAllEnvVariables',
      params: customEnv ? { customEnv } : {}
    },
    hostOverride
  )
  return res.data?.items ?? []
}

export async function cleanInvalidPathEntries(
  options?: { rawPath?: string; customEnv?: Record<string, string>; scope?: EnvScope },
  hostOverride?: unknown
): Promise<{
  removedCount: number
  cleanedPath: string
  remainingEntries: string[]
}> {
  const res = await callHostTransport<{
    removedCount?: number
    cleanedPath?: string
    remainingEntries?: string[]
  }>(
    'dllplugin_call',
    {
      plugin: 'EnvManagerPlugin',
      func: 'cleanInvalidPathEntries',
      params: options || {}
    },
    hostOverride
  )
  return {
    removedCount: res.data?.removedCount ?? 0,
    cleanedPath: res.data?.cleanedPath ?? '',
    remainingEntries: res.data?.remainingEntries ?? []
  }
}

export async function writeEnvVariable(
  key: string,
  value: string,
  scope: EnvScope = 'user',
  options?: { simulateNoAdmin?: boolean },
  hostOverride?: unknown
): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const res = await callHostTransport<{ errorCode?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'EnvManagerPlugin',
      func: 'writeEnvVariable',
      params: { key, value, scope, ...options }
    },
    hostOverride
  )
  if (!res.ok) {
    return {
      ok: false,
      errorCode: res.data?.errorCode || 'ADMIN_REQUIRED',
      error: res.error || res.data?.error || '写入环境变量失败'
    }
  }
  return { ok: true }
}

export function exportEnvSnapshot(items: EnvItem[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      count: items.length,
      items
    },
    null,
    2
  )
}

export function filterEnvItems(
  items: EnvItem[],
  searchText: string,
  category: EnvFilterCategory
): EnvItem[] {
  const byCat = items.filter((item) => {
    if (category === 'path') return item.isPathItem
    if (category === 'path-invalid') return item.isPathItem && item.isInvalid
    if (category === 'user') return !item.isPathItem && item.scope === 'user'
    if (category === 'system') return !item.isPathItem && item.scope === 'system'
    return true
  })

  const q = String(searchText ?? '').trim().toLowerCase()
  if (!q) return byCat
  return byCat.filter(
    (item) =>
      item.key.toLowerCase().includes(q) ||
      item.value.toLowerCase().includes(q) ||
      (item.expandedValue && item.expandedValue.toLowerCase().includes(q))
  )
}
