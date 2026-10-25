import { callHostTransport } from '../shared/native-ipc.js'
import type { ContainerSummary } from './types.js'

const WEB_CANDIDATE_PORTS = new Set([80, 443, 3000, 3001, 4000, 5000, 5173, 8000, 8080, 8081, 8888, 9000])

/**
 * 清洗日志中的 ANSI 颜色与退格控制字符，确保 Markdown 代码块纯净渲染
 */
export function cleanContainerLogText(rawText: string): string {
  return String(rawText ?? '')
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
}

/**
 * 解析 Docker Engine REST API 或 `docker ps --format json` 的端口映射并智能推导 Web URL
 */
export function parseDockerPortMappings(portsInput: unknown): {
  primaryPort?: string
  webUrl?: string
  portsDisplay: string
} {
  const mappings: Array<{ hostPort: number; containerPort: number; protocol: string }> = []

  if (Array.isArray(portsInput)) {
    for (const p of portsInput) {
      if (p && typeof p === 'object') {
        const rec = p as { PublicPort?: number; PrivatePort?: number; Type?: string }
        if (typeof rec.PublicPort === 'number' && typeof rec.PrivatePort === 'number') {
          mappings.push({
            hostPort: rec.PublicPort,
            containerPort: rec.PrivatePort,
            protocol: rec.Type || 'tcp'
          })
        }
      }
    }
  } else if (typeof portsInput === 'string' && portsInput.trim()) {
    // e.g. "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
    const regex = /(?:[\d.:]+):(\d+)->(\d+)\/(tcp|udp)/gi
    const seen = new Set<string>()
    for (const m of portsInput.matchAll(regex)) {
      const hostPort = Number(m[1])
      const containerPort = Number(m[2])
      const protocol = (m[3] || 'tcp').toLowerCase()
      const key = `${hostPort}->${containerPort}/${protocol}`
      if (!seen.has(key)) {
        seen.add(key)
        mappings.push({ hostPort, containerPort, protocol })
      }
    }
  }

  if (mappings.length === 0) {
    return { portsDisplay: '无端口映射' }
  }

  const first = mappings[0]!
  const primaryPort = `${first.hostPort}->${first.containerPort}`
  const portsDisplay = mappings
    .map((m) => `0.0.0.0:${m.hostPort}->${m.containerPort}/${m.protocol}`)
    .join(', ')

  const webCandidate =
    mappings.find(
      (m) => WEB_CANDIDATE_PORTS.has(m.hostPort) || WEB_CANDIDATE_PORTS.has(m.containerPort)
    ) || mappings.find((m) => m.protocol === 'tcp')

  let webUrl: string | undefined
  if (webCandidate) {
    const scheme = webCandidate.hostPort === 443 || webCandidate.containerPort === 443 ? 'https' : 'http'
    webUrl = `${scheme}://localhost:${webCandidate.hostPort}`
  }

  return {
    primaryPort,
    webUrl,
    portsDisplay
  }
}

export function normalizeDockerContainerRecord(raw: Record<string, unknown>): ContainerSummary {
  const id = String(raw.Id || raw.ID || raw.id || '').trim()
  const rawNames = raw.Names || raw.name || ''
  const name = Array.isArray(rawNames)
    ? String(rawNames[0] || id.slice(0, 12)).replace(/^\//, '')
    : String(rawNames || id.slice(0, 12)).replace(/^\//, '')
  const image = String(raw.Image || raw.image || 'unknown:latest')
  const stateStr = String(raw.State || raw.Status || raw.statusDisplay || 'exited').toLowerCase()
  const isRunning =
    typeof raw.isRunning === 'boolean'
      ? raw.isRunning
      : stateStr.includes('running') || stateStr.startsWith('up ')

  const statusDisplay = String(raw.Status || raw.statusDisplay || (isRunning ? 'Up (Running)' : 'Exited'))
  const portInfo = parseDockerPortMappings(raw.Ports ?? raw.portsDisplay ?? '')
  const createdFormatted = String(raw.CreatedAt || raw.createdFormatted || '2026-10-25 10:00:00')
  const tailLogs = typeof raw.tailLogs === 'string' ? cleanContainerLogText(raw.tailLogs) : undefined

  return {
    id,
    name,
    image,
    statusDisplay,
    isRunning,
    primaryPort: typeof raw.primaryPort === 'string' ? raw.primaryPort : portInfo.primaryPort,
    webUrl: typeof raw.webUrl === 'string' ? raw.webUrl : portInfo.webUrl,
    portsDisplay:
      typeof raw.portsDisplay === 'string' && raw.portsDisplay
        ? raw.portsDisplay
        : portInfo.portsDisplay,
    createdFormatted,
    tailLogs
  }
}

export async function listContainers(
  options?: { rawContainers?: Array<Record<string, unknown>>; simulateDaemonOffline?: boolean },
  hostOverride?: unknown
): Promise<ContainerSummary[]> {
  const res = await callHostTransport<{
    containers?: Array<Record<string, unknown>>
    errorCode?: string
    error?: string
  }>(
    'dllplugin_call',
    {
      plugin: 'DockerManagerPlugin',
      func: 'listContainers',
      params: options || {}
    },
    hostOverride
  )
  if (!res.ok) {
    const code = res.data?.errorCode || 'DAEMON_OFFLINE'
    throw new Error(`${code}: ${res.error || res.data?.error || 'Docker 守护进程未启动'}`)
  }
  const list = res.data?.containers ?? []
  return list.map(normalizeDockerContainerRecord)
}

export async function controlContainer(
  id: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
  options?: { dryRun?: boolean },
  hostOverride?: unknown
): Promise<{ ok: boolean; command?: string; error?: string }> {
  const res = await callHostTransport<{ command?: string; error?: string }>(
    'dllplugin_call',
    {
      plugin: 'DockerManagerPlugin',
      func: 'controlContainer',
      params: { id, action, ...options }
    },
    hostOverride
  )
  if (!res.ok) {
    return { ok: false, error: res.error || res.data?.error || '容器操作失败' }
  }
  return { ok: true, command: res.data?.command }
}

export async function getContainerTailLogs(
  id: string,
  lines = 100,
  rawLogs?: string,
  hostOverride?: unknown
): Promise<string> {
  const res = await callHostTransport<{ logs?: string }>(
    'dllplugin_call',
    {
      plugin: 'DockerManagerPlugin',
      func: 'getContainerTailLogs',
      params: { id, lines, ...(rawLogs !== undefined ? { rawLogs } : {}) }
    },
    hostOverride
  )
  return cleanContainerLogText(res.data?.logs ?? '')
}
