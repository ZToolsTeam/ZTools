import { callHostTransport } from '../shared/native-ipc.js'
import type { ProxyStatus, SshHostEntry } from './types.js'

/**
 * 解析 `~/.ssh/config` 文本，跳过通配符 `Host *` 默认块，提取独立主机及其 `HostName`、`User`、`Port`、`IdentityFile`、`ProxyJump`
 */
export function parseSshConfigText(rawConfig: string): SshHostEntry[] {
  const lines = String(rawConfig ?? '').replace(/\r\n/g, '\n').split('\n')
  const entries: SshHostEntry[] = []
  let currentHosts: string[] = []
  let currentProps: Partial<SshHostEntry> = {}

  const flushCurrent = () => {
    for (const h of currentHosts) {
      if (!h || h.includes('*') || h.includes('?')) continue
      const identityFile = currentProps.identityFile
      const identityFileShort = identityFile
        ? identityFile.split(/[\\/]/).filter(Boolean).pop()
        : undefined
      entries.push({
        host: h,
        hostName: currentProps.hostName || h,
        user: currentProps.user,
        port: currentProps.port ?? 22,
        identityFile,
        identityFileShort,
        proxyJump: currentProps.proxyJump,
        localForwards: currentProps.localForwards
      })
    }
    currentHosts = []
    currentProps = {}
  }

  for (const rawLine of lines) {
    const cleanLine = rawLine.replace(/#.*$/, '').trim()
    if (!cleanLine) continue

    const m = cleanLine.match(/^([a-zA-Z0-9]+)\s*(?:=|\s+)\s*(.+)$/)
    if (!m?.[1] || !m[2]) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim().replace(/^"|"$/g, '')

    if (key === 'host') {
      flushCurrent()
      currentHosts = val.split(/\s+/).filter(Boolean)
    } else if (key === 'hostname') {
      currentProps.hostName = val
    } else if (key === 'user') {
      currentProps.user = val
    } else if (key === 'port') {
      const p = Number(val)
      if (Number.isInteger(p) && p > 0 && p <= 65535) {
        currentProps.port = p
      }
    } else if (key === 'identityfile') {
      currentProps.identityFile = val
    } else if (key === 'proxyjump') {
      currentProps.proxyJump = val
    } else if (key === 'localforward') {
      currentProps.localForwards = [...(currentProps.localForwards ?? []), val]
    }
  }

  flushCurrent()
  return entries
}

export async function parseSshConfigFile(
  customConfigPath?: string,
  hostOverride?: unknown
): Promise<SshHostEntry[]> {
  const res = await callHostTransport<{ exists?: boolean; content?: string }>(
    'dllplugin_call',
    {
      plugin: 'SshProxyHelperPlugin',
      func: 'parseSshConfigFile',
      params: customConfigPath ? { customConfigPath } : {}
    },
    hostOverride
  )
  if (!res.ok || !res.data?.exists || !res.data.content) {
    return []
  }
  return parseSshConfigText(res.data.content)
}

export async function getProxyStatus(
  options?: { mockListeningPorts?: number[]; skipPortProbe?: boolean },
  hostOverride?: unknown
): Promise<ProxyStatus> {
  const res = await callHostTransport<ProxyStatus>(
    'dllplugin_call',
    {
      plugin: 'SshProxyHelperPlugin',
      func: 'getProxyStatus',
      params: options || {}
    },
    hostOverride
  )
  return {
    isEnabled: Boolean(res.data?.isEnabled),
    port: Number(res.data?.port || 7890),
    isGitSet: Boolean(res.data?.isGitSet),
    isNpmSet: Boolean(res.data?.isNpmSet),
    detectedPorts: Array.isArray(res.data?.detectedPorts) ? res.data.detectedPorts : []
  }
}

export async function setDevToolsProxy(
  port: number,
  options?: { requireListening?: boolean; mockListeningPorts?: number[]; applySystemGit?: boolean },
  hostOverride?: unknown
): Promise<ProxyStatus> {
  const res = await callHostTransport<ProxyStatus & { errorCode?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'SshProxyHelperPlugin',
      func: 'setDevToolsProxy',
      params: { port, ...options }
    },
    hostOverride
  )
  if (!res.ok) {
    throw new Error(res.error || res.data?.error || `本地端口 ${port} 未处于监听状态`)
  }
  return {
    isEnabled: true,
    port,
    isGitSet: true,
    isNpmSet: true,
    detectedPorts: res.data?.detectedPorts ?? [port]
  }
}

export async function unsetDevToolsProxy(
  options?: { applySystemGit?: boolean },
  hostOverride?: unknown
): Promise<ProxyStatus> {
  const res = await callHostTransport<ProxyStatus>(
    'dllplugin_call',
    {
      plugin: 'SshProxyHelperPlugin',
      func: 'unsetDevToolsProxy',
      params: options || {}
    },
    hostOverride
  )
  return {
    isEnabled: false,
    port: Number(res.data?.port || 7890),
    isGitSet: false,
    isNpmSet: false,
    detectedPorts: []
  }
}
