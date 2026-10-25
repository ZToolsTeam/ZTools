import { callHostTransport } from '../shared/native-ipc.js'
import type {
  BandwidthListItem,
  BandwidthResult,
  ProbeNodeResult,
  ProbeRegion,
  SpeedtestDiagnosticSummary
} from './types.js'

export function mbpsToMBps(mbps: number): number {
  const safe = Number.isFinite(mbps) && mbps > 0 ? mbps : 0
  return Number((safe / 8).toFixed(1))
}

export function normalizeCustomHostInput(raw: string): string | null {
  const trimmed = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
  if (!trimmed) return null
  if (!/^[a-zA-Z0-9.-]+(:\d+)?$/.test(trimmed)) return null
  if (!trimmed.includes('.') && !/^localhost(:\d+)?$/i.test(trimmed)) return null
  return trimmed.toLowerCase()
}

export function buildSpeedtestDiagnosticSummary(
  bandwidth: BandwidthResult | null,
  probes: ProbeNodeResult[]
): SpeedtestDiagnosticSummary {
  const reachableProbes = probes.filter((p) => p.reachable)
  const domesticProbes = probes.filter((p) => p.region === 'domestic')
  const domesticReachable = domesticProbes.filter((p) => p.reachable)
  const globalProbes = probes.filter((p) => p.region === 'global')
  const globalReachable = globalProbes.filter((p) => p.reachable)

  const isOffline =
    probes.length > 0 &&
    reachableProbes.length === 0 &&
    (!bandwidth || (bandwidth.downloadMbps <= 0 && bandwidth.uploadMbps <= 0))

  if (isOffline) {
    return {
      isOffline: true,
      summaryText: '网络已断开：本机无法连接路由器网关或外部互联网，请检查 Wi-Fi 或网线连接',
      bandwidthItems: [
        {
          id: 'bw-offline',
          title: '网络已断开 (ENETUNREACH)',
          subtitle: '路由器网关与外部节点均不可达，无法测算上下行带宽',
          progressRatio: 0,
          gradeTag: '断网',
          valueText: '0.0 Mbps (0.0 MB/s)'
        }
      ],
      fullMarkdown: [
        '# ZTools 网络测速与连通性诊断报告',
        '',
        '- **诊断结论**: 网络已断开 (ENETUNREACH)，所有节点均不可达'
      ].join('\n')
    }
  }

  const dlMbps = Number.isFinite(bandwidth?.downloadMbps) ? Number(bandwidth!.downloadMbps) : 0
  const ulMbps = Number.isFinite(bandwidth?.uploadMbps) ? Number(bandwidth!.uploadMbps) : 0
  const pingMs = Number.isFinite(bandwidth?.pingMs) ? Number(bandwidth!.pingMs) : 0
  const jitterMs = Number.isFinite(bandwidth?.jitterMs) ? Number(bandwidth!.jitterMs) : 0
  const dlMBps = mbpsToMBps(dlMbps)
  const ulMBps = mbpsToMBps(ulMbps)

  const domesticStatus =
    domesticProbes.length === 0
      ? '待检测'
      : domesticReachable.length === domesticProbes.length
        ? '国内节点全部畅通'
        : `国内节点 ${domesticReachable.length}/${domesticProbes.length} 可达`

  const summaryText = bandwidth
    ? `下载 ${dlMbps.toFixed(1)} Mbps (${dlMBps.toFixed(1)} MB/s) · 上传 ${ulMbps.toFixed(1)} Mbps · 抖动 ${jitterMs} ms · ${domesticStatus}`
    : `连通性诊断完成 · ${domesticStatus} · 国际节点 ${globalReachable.length}/${globalProbes.length} 可达`

  const dlGrade =
    dlMbps >= 300 ? '千兆级高速' : dlMbps >= 100 ? '百兆级流畅' : dlMbps > 0 ? '基础宽带' : '未测速'
  const ulGrade =
    ulMbps >= 50 ? '上行充沛' : ulMbps >= 20 ? '上行良好' : ulMbps > 0 ? '标准上行' : '未测速'
  const latencyGrade = pingMs > 0 && pingMs <= 30 ? '低延迟极佳' : pingMs <= 80 ? '延迟正常' : '延迟偏高'

  const bandwidthItems: BandwidthListItem[] = bandwidth
    ? [
        {
          id: 'bw-download',
          title: '下行宽带吞吐量 (Download)',
          subtitle: `等效文件峰值下载速度约 ${dlMBps.toFixed(1)} MB/s · 本机 IP ${bandwidth.localIp || '未知'}`,
          progressRatio: Math.min(1, Math.max(0.05, dlMbps / 1000)),
          gradeTag: dlGrade,
          valueText: `${dlMbps.toFixed(1)} Mbps (${dlMBps.toFixed(1)} MB/s)`
        },
        {
          id: 'bw-upload',
          title: '上行宽带吞吐量 (Upload)',
          subtitle: `等效文件上传速度约 ${ulMBps.toFixed(1)} MB/s · 网关 ${bandwidth.gatewayIp || '未知'}`,
          progressRatio: Math.min(1, Math.max(0.05, ulMbps / 200)),
          gradeTag: ulGrade,
          valueText: `${ulMbps.toFixed(1)} Mbps (${ulMBps.toFixed(1)} MB/s)`
        },
        {
          id: 'bw-latency',
          title: '基准网络延迟与抖动 (Ping & Jitter)',
          subtitle: `平均往返延迟 ${pingMs} ms · 网络抖动 ${jitterMs} ms`,
          progressRatio: Math.min(1, Math.max(0.05, 1 - pingMs / 300)),
          gradeTag: latencyGrade,
          valueText: `${pingMs} ms / 抖动 ${jitterMs} ms`
        }
      ]
    : []

  const mdLines = [
    '# ZTools 网络测速与连通性诊断报告',
    '',
    `- **下载带宽**: ${dlMbps.toFixed(1)} Mbps (${dlMBps.toFixed(1)} MB/s)`,
    `- **上传带宽**: ${ulMbps.toFixed(1)} Mbps (${ulMBps.toFixed(1)} MB/s)`,
    `- **平均延迟 / 抖动**: ${pingMs} ms / ${jitterMs} ms`,
    `- **本机 / 网关 IP**: ${bandwidth?.localIp || '-'} / ${bandwidth?.gatewayIp || '-'}`,
    '',
    '## 节点连通性明细',
    ...probes.map(
      (n) =>
        `- **${n.name} (${n.host})** [${n.regionLabel}]: ${n.reachable ? `${n.latencyMs} ms` : '连接超时'}`
    )
  ]

  return {
    isOffline: false,
    summaryText,
    bandwidthItems,
    fullMarkdown: mdLines.join('\n')
  }
}

export async function probeSpeedtestNodes(
  options?: {
    customHost?: string
    signal?: AbortSignal
  },
  hostOverride?: unknown
): Promise<ProbeNodeResult[]> {
  if (options?.signal?.aborted) {
    throw new Error('SPEEDTEST_ABORTED: 用户已停止网络测速')
  }

  const res = await callHostTransport<{ nodes?: ProbeNodeResult[] }>(
    'dllplugin_call',
    {
      plugin: 'SpeedtestPlugin',
      func: 'probeNodes',
      params: {
        customHost: options?.customHost
      }
    },
    hostOverride
  )

  if (options?.signal?.aborted) {
    throw new Error('SPEEDTEST_ABORTED: 用户已停止网络测速')
  }

  if (!res.ok || !res.data || !Array.isArray(res.data.nodes)) {
    throw new Error(res.error || 'SPEEDTEST_PROBE_FAILED: 无法执行多节点网络探测')
  }

  return res.data.nodes.map((node) => ({
    ...node,
    region: (node.region || 'domestic') as ProbeRegion,
    latencyMs: Number.isFinite(node.latencyMs) ? Number(node.latencyMs) : -1
  }))
}

export async function runSpeedtestBandwidth(
  options?: {
    signal?: AbortSignal
  },
  hostOverride?: unknown
): Promise<BandwidthResult> {
  if (options?.signal?.aborted) {
    throw new Error('SPEEDTEST_ABORTED: 用户已停止网络测速')
  }

  const res = await callHostTransport<BandwidthResult>(
    'dllplugin_call',
    {
      plugin: 'SpeedtestPlugin',
      func: 'runBandwidthTest',
      params: {}
    },
    hostOverride
  )

  if (options?.signal?.aborted) {
    throw new Error('SPEEDTEST_ABORTED: 用户已停止网络测速')
  }

  if (!res.ok || !res.data) {
    throw new Error(res.error || 'SPEEDTEST_BANDWIDTH_FAILED: 宽带吞吐量测速失败')
  }

  return {
    downloadMbps: Number.isFinite(res.data.downloadMbps) ? Number(res.data.downloadMbps) : 0,
    uploadMbps: Number.isFinite(res.data.uploadMbps) ? Number(res.data.uploadMbps) : 0,
    pingMs: Number.isFinite(res.data.pingMs) ? Number(res.data.pingMs) : 0,
    jitterMs: Number.isFinite(res.data.jitterMs) ? Number(res.data.jitterMs) : 0,
    localIp: String(res.data.localIp || '0.0.0.0'),
    gatewayIp: String(res.data.gatewayIp || '0.0.0.0')
  }
}
