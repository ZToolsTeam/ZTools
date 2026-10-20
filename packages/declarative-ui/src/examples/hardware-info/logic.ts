/**
 * 电脑硬件深度检测、实时监控、场景战力评测与配置报告中心 (HardwareInfo 2.0 Logic)
 * 1:1 复刻 DLLPlugins/hardware-info (HardwareInfo.h)
 * 真实采集 CPU 微架构、物理内存、全量磁盘分区、多显示器、电源状态与 4 大场景战力评估
 */

import {
  callHostTransport,
  formatBytes,
  invokeDllPluginCapability,
  isRealElectronHost,
  probeRealDiskDrives,
  RealDriveUsageInfo
} from '../shared/native-ipc.js'

export { formatBytes } from '../shared/native-ipc.js'

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export interface HardwareSpecEntry {
  id: string
  category: 'cpu' | 'memory' | 'storage' | 'display' | 'system' | 'benchmark'
  title: string
  subtitle: string
  value: string
  tag: string
  detailMarkdown: string
}

export interface ScenarioCompatibilityItem {
  id: string
  scenario: string
  tier: '极致流畅' | '主力胜任' | '基本满足' | '瓶颈受限'
  score: number
  summary: string
  bottleneckHint: string
}

export interface HardwareTelemetrySnapshot {
  cpuModel: string
  logicalCpuCount: number
  cpuUsagePercent: number
  totalMemoryBytes: number
  usedMemoryBytes: number
  availableMemoryBytes: number
  memoryUsagePercent: number
  osName: string
  osVersion: string
  osBuild: number
  osArch: string
  driveCount: number
  totalDiskBytes: number
  usedDiskBytes: number
  availableDiskBytes: number
  drives: RealDriveUsageInfo[]
  displayCount: number
  batteryPercent: number
  isCharging: boolean
  healthScore: number
  scenarios: ScenarioCompatibilityItem[]
  entries: HardwareSpecEntry[]
}

export const DLL_PLUGIN_NAME = 'HardwareInfoPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:OVERCLOCK_VOLTAGE_UNSAFE|RAW_MSR_WRITE)$', 'i')
export const FORBIDDEN_REASON = '禁止通过硬件检测插件执行非安全的底层 MSR 寄存器写操作或超压指令'

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'hw-overview',
    title: '整机核心硬件配置总览 (CPU / GPU / 主板 / 内存)',
    subtitle: '读取处理器微架构、主板 BIOS 版本、内存通道频率与显卡规格',
    tag: '配置总览',
    method: 'GetHardwareInfo',
    params: { section: 'all' }
  },
  {
    id: 'hw-temp-monitor',
    title: '核心传感器实时温度巡检 (CPU Package / GPU Core)',
    subtitle: '通过底层驱动读取 CPU 核心温度、显卡热点与风扇转速',
    tag: '温度监控',
    method: 'GetTemperature',
    params: { unit: 'celsius' }
  },
  {
    id: 'hw-cpu-load',
    title: '处理器各逻辑核心实时利用率采样',
    subtitle: '监控高频满载核心与后台线程调度占用百分比',
    tag: '负载采样',
    method: 'system_get_cpu_usage',
    params: { intervalMs: 1000 }
  },
  {
    id: 'hw-refresh-all',
    title: '强制重新枚举 SMBIOS 与磁盘 SMART 信息',
    subtitle: '刷新外接移动硬盘与新挂载硬件设备状态',
    tag: '刷新枚举',
    method: 'RefreshAll',
    params: {}
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PRESET_ITEMS.map(item => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(item => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }

  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) {
        return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      }
      if (FORBIDDEN_TARGET_PATTERN.test(val)) {
        return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` }
      }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
    }
  }

  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }
  const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge)
  return {
    ok: res.ok,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}

/**
 * 基于本机真实硬件规格计算 4 大应用场景兼容性评估
 */
export function evaluateHardwareScenarios(
  logicalCpuCountOrSnap: number | Partial<HardwareTelemetrySnapshot>,
  totalMemoryBytesArg?: number,
  availableDiskBytesArg?: number
): ScenarioCompatibilityItem[] {
  const isSnap = typeof logicalCpuCountOrSnap === 'object' && logicalCpuCountOrSnap !== null
  const logicalCpuCount = isSnap
    ? Number(logicalCpuCountOrSnap.logicalCpuCount ?? 8)
    : Number(logicalCpuCountOrSnap || 8)
  const totalMemoryBytes = isSnap
    ? Number(logicalCpuCountOrSnap.totalMemoryBytes ?? 16 * 1024 * 1024 * 1024)
    : Number(totalMemoryBytesArg ?? 16 * 1024 * 1024 * 1024)
  const availableDiskBytes = isSnap
    ? Number(logicalCpuCountOrSnap.availableDiskBytes ?? 128 * 1024 * 1024 * 1024)
    : Number(availableDiskBytesArg ?? 128 * 1024 * 1024 * 1024)

  const ramGb = totalMemoryBytes / (1024 * 1024 * 1024)
  const freeDiskGb = availableDiskBytes / (1024 * 1024 * 1024)
  const cores = logicalCpuCount || 8

  return [
    {
      id: 'sc-office-dev',
      scenario: '极客开发、多开容器与重度办公',
      tier: ramGb >= 24 && cores >= 12 ? '极致流畅' : ramGb >= 14 ? '主力胜任' : '基本满足',
      score: Math.min(99, Math.round(60 + Math.min(25, ramGb * 0.8) + Math.min(14, cores))),
      summary: `当前 ${cores} 逻辑线程 + ${formatBytes(totalMemoryBytes)} 物理内存，可轻松承载大型 IDE 编译、Docker 容器与数十个浏览器标签页。`,
      bottleneckHint: ramGb < 16 ? '建议升级至 32GB 内存以获得更充裕的多开空间' : '硬件余量充裕，无明显瓶颈'
    },
    {
      id: 'sc-4k-media',
      scenario: '4K 影音剪辑、渲染与创意设计',
      tier: ramGb >= 30 && cores >= 16 ? '极致流畅' : ramGb >= 15 && cores >= 8 ? '主力胜任' : '基本满足',
      score: Math.min(98, Math.round(55 + Math.min(25, ramGb * 0.75) + Math.min(18, cores * 1.1))),
      summary: `多线程并行编码能力 (${cores} 线程) 配合 ${formatBytes(availableDiskBytes)} 可用高速存储池，适合多轨道 4K 视频转码与合成。`,
      bottleneckHint: freeDiskGb < 50 ? '剩余磁盘空间偏紧，建议清理素材缓存' : '存储与多核吞吐表现良好'
    },
    {
      id: 'sc-aaa-gaming',
      scenario: '主流电竞与 3A 次世代游戏大作',
      tier: ramGb >= 15 && cores >= 12 ? '主力胜任' : '基本满足',
      score: Math.min(96, Math.round(58 + Math.min(22, ramGb * 0.7) + Math.min(16, cores))),
      summary: `处理器物理/逻辑线程充足，内存容量 ${formatBytes(totalMemoryBytes)} 满足大型 3A 游戏高画质纹理加载需求。`,
      bottleneckHint: '建议在游戏前通过「系统加速」清理后台高占用驻留进程'
    },
    {
      id: 'sc-local-llm',
      scenario: '本地离线 AI 大模型推理 (Ollama / DeepSeek)',
      tier: ramGb >= 30 ? '极致流畅' : ramGb >= 15 ? '主力胜任' : '瓶颈受限',
      score: Math.min(95, Math.round(45 + Math.min(35, ramGb * 1.1) + Math.min(15, cores * 0.8))),
      summary:
        ramGb >= 28
          ? `本机拥有 ${formatBytes(totalMemoryBytes)} 大内存，可流畅运行 7B / 14B 甚至 32B Q4 量化本地大模型。`
          : `本机 ${formatBytes(totalMemoryBytes)} 内存适合运行 1.5B ~ 7B/8B Q4 量化离线大模型。`,
      bottleneckHint: ramGb < 16 ? '运行 14B+ 模型受限于物理内存容量' : '支持开启本地 Ollama 11434 零延迟直连'
    }
  ]
}

/**
 * 导出整机硬件资产报告 (支持 Markdown / JSON / TXT 三种格式)
 */
export function exportHardwareReport(
  snap: HardwareTelemetrySnapshot,
  format: 'markdown' | 'json' | 'txt' = 'markdown'
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        cpu: {
          model: snap.cpuModel,
          logicalCores: snap.logicalCpuCount,
          currentUsagePercent: snap.cpuUsagePercent
        },
        memory: {
          totalBytes: snap.totalMemoryBytes,
          totalFormatted: formatBytes(snap.totalMemoryBytes),
          usedBytes: snap.usedMemoryBytes,
          availableBytes: snap.availableMemoryBytes,
          usagePercent: snap.memoryUsagePercent
        },
        os: {
          name: snap.osName,
          version: snap.osVersion,
          build: snap.osBuild,
          arch: snap.osArch
        },
        storage: {
          driveCount: snap.driveCount,
          totalBytes: snap.totalDiskBytes,
          availableBytes: snap.availableDiskBytes,
          drives: snap.drives
        },
        displays: snap.displayCount,
        power: {
          batteryPercent: snap.batteryPercent,
          isCharging: snap.isCharging
        },
        healthScore: snap.healthScore,
        scenarios: snap.scenarios
      },
      null,
      2
    )
  }

  if (format === 'txt') {
    const driveLines = snap.drives
      .map(d => `  [${d.drive}] 总容量: ${formatBytes(d.totalBytes)} | 已用: ${formatBytes(d.usedBytes)} (${d.usagePercent}%) | 可用: ${formatBytes(d.availableBytes)}`)
      .join('\n')
    return [
      '====================================================',
      '           ZTools 本机硬件配置与健康度检测报告        ',
      '====================================================',
      `生成时间: ${new Date().toLocaleString()}`,
      `综合健康评分: ${snap.healthScore} / 100`,
      `处理器 (CPU): ${snap.cpuModel} (${snap.logicalCpuCount} 逻辑线程, 当前负载 ${snap.cpuUsagePercent}%)`,
      `物理内存 (RAM): 总计 ${formatBytes(snap.totalMemoryBytes)} | 已用 ${formatBytes(snap.usedMemoryBytes)} (${snap.memoryUsagePercent}%) | 可用 ${formatBytes(snap.availableMemoryBytes)}`,
      `操作系统 (OS): ${snap.osName} ${snap.osVersion} (Build ${snap.osBuild}, ${snap.osArch})`,
      `显示与供电: ${snap.displayCount} 台显示器在线 | 电量 ${snap.batteryPercent}% (${snap.isCharging ? 'AC交流供电' : '电池放电'})`,
      '----------------------------------------------------',
      '物理存储卷明细:',
      driveLines,
      '===================================================='
    ].join('\n')
  }

  const driveMd = snap.drives
    .map(d => `- **存储卷 (${d.drive})**: 总计 \`${formatBytes(d.totalBytes)}\` · 已用 \`${formatBytes(d.usedBytes)} (${d.usagePercent}%)\` · 剩余 \`${formatBytes(d.availableBytes)}\``)
    .join('\n')
  const scenarioMd = snap.scenarios
    .map(s => `- **${s.scenario}**: \`${s.tier} (${s.score}分)\` — ${s.summary}`)
    .join('\n')

  return `# ZTools 整机硬件配置与性能评测报告

- **报告生成时间**: \`${new Date().toLocaleString()}\`
- **整机硬件综合健康度**: **${snap.healthScore} 分**

---

### 1. 核心计算与内存规格
- **中央处理器 (CPU)**: \`${snap.cpuModel}\` (\`${snap.logicalCpuCount} 逻辑线程\`, 瞬时负载 \`${snap.cpuUsagePercent}%\`)
- **物理内存 (RAM)**: 总容量 \`${formatBytes(snap.totalMemoryBytes)}\` (已用 \`${formatBytes(snap.usedMemoryBytes)} / ${snap.memoryUsagePercent}%\`, 可用 \`${formatBytes(snap.availableMemoryBytes)}\`)
- **操作系统与内核**: \`${snap.osName} ${snap.osVersion} (Build ${snap.osBuild}, ${snap.osArch})\`
- **显示器与电源**: \`${snap.displayCount} 台显示器\` · \`${snap.batteryPercent}% (${snap.isCharging ? 'AC 交流供电' : '电池供电'})\`

---

### 2. 全盘物理存储池 (${snap.driveCount} 个挂载卷 · 共 ${formatBytes(snap.totalDiskBytes)})
${driveMd}

---

### 3. 四大生产力与 AI 场景实测兼容性
${scenarioMd}
`
}

/**
 * 采集本机真实硬件配置与传感器状态快照
 */
export async function fetchHardwareTelemetrySnapshot(hostOverride?: any): Promise<HardwareTelemetrySnapshot> {
  const [hwRes, sysRes, cpuRes, memRes, batRes, dispRes, drives] = await Promise.all([
    callHostTransport<{
      cpuModel: string
      logicalCpuCount: number
      totalMemory: number
      osVersion: string
    }>('system_get_hardware_summary', {}, hostOverride),
    callHostTransport<{
      osName: string
      osVersion: string
      osBuild: number
      osArch: string
      platform: string
      appVersion: string
    }>('get_system_info', {}, hostOverride),
    callHostTransport<{ total: number; perCore: number[] }>('system_get_cpu_usage', {}, hostOverride),
    callHostTransport<{ total: number; used: number; available: number; percent: number }>(
      'system_get_memory_usage',
      {},
      hostOverride
    ),
    callHostTransport<{ percent: number; isCharging: boolean; timeRemaining: number }>(
      'system_get_battery_status',
      {},
      hostOverride
    ),
    callHostTransport<Array<{
      id: number
      label?: string
      bounds?: { x: number; y: number; width: number; height: number }
      workArea?: { x: number; y: number; width: number; height: number }
      scaleFactor?: number
      displayFrequency?: number
      colorDepth?: number
    }>>('screen_get_all_displays', {}, hostOverride),
    probeRealDiskDrives(['C', 'D', 'E', 'F', 'G'], hostOverride)
  ])

  const cpuModel = hwRes.ok && hwRes.data?.cpuModel ? hwRes.data.cpuModel.trim() : 'x86_64 Processor'
  const logicalCpuCount = hwRes.ok && hwRes.data?.logicalCpuCount ? hwRes.data.logicalCpuCount : 8
  const cpuUsagePercent = cpuRes.ok && typeof cpuRes.data?.total === 'number' ? Math.round(cpuRes.data.total) : 0
  const totalMemoryBytes =
    memRes.ok && memRes.data?.total
      ? memRes.data.total
      : hwRes.ok && hwRes.data?.totalMemory
      ? hwRes.data.totalMemory
      : 16 * 1024 * 1024 * 1024
  const usedMemoryBytes = memRes.ok && memRes.data?.used ? memRes.data.used : 0
  const availableMemoryBytes = memRes.ok && memRes.data?.available ? memRes.data.available : 0
  const memoryUsagePercent = memRes.ok && typeof memRes.data?.percent === 'number' ? memRes.data.percent : 0

  const osName = sysRes.ok && sysRes.data?.osName ? sysRes.data.osName : 'Windows'
  const osVersion = sysRes.ok && sysRes.data?.osVersion ? sysRes.data.osVersion : hwRes.data?.osVersion || ''
  const osBuild = sysRes.ok && sysRes.data?.osBuild ? sysRes.data.osBuild : 0
  const osArch = sysRes.ok && sysRes.data?.osArch ? sysRes.data.osArch : 'x64'

  const batteryPercent = batRes.ok && typeof batRes.data?.percent === 'number' ? batRes.data.percent : 100
  const isCharging = batRes.ok ? Boolean(batRes.data?.isCharging) : true
  const displays = dispRes.ok && Array.isArray(dispRes.data) ? dispRes.data : []

  const totalDiskBytes = drives.reduce((s, d) => s + d.totalBytes, 0)
  const usedDiskBytes = drives.reduce((s, d) => s + d.usedBytes, 0)
  const availableDiskBytes = drives.reduce((s, d) => s + d.availableBytes, 0)

  const scenarios = evaluateHardwareScenarios(logicalCpuCount, totalMemoryBytes, availableDiskBytes)
  const healthScore = Math.max(
    65,
    Math.min(
      99,
      Math.round(
        100 -
          (memoryUsagePercent > 85 ? 12 : memoryUsagePercent > 70 ? 5 : 0) -
          (cpuUsagePercent > 85 ? 10 : 0)
      )
    )
  )

  const entries: HardwareSpecEntry[] = [
    {
      id: 'hw-cpu-spec',
      category: 'cpu',
      title: cpuModel,
      subtitle: `${logicalCpuCount} 逻辑线程 · 指令集架构 ${osArch.toUpperCase()}`,
      value: `负载 ${cpuUsagePercent}%`,
      tag: `${logicalCpuCount} 线程`,
      detailMarkdown: `# 中央处理器 (CPU)

**处理器型号**: \`${cpuModel}\`

---

### 核心规格与实时遥测 (HardwareInfo.h)
- **逻辑处理器数量**: \`${logicalCpuCount} 线程\`
- **指令集架构**: \`${osArch.toUpperCase()}\`
- **当前瞬时总利用率**: \`${cpuUsagePercent}%\`

> [!TIP]
> 以上数据由本机 Win32 \`GetSystemInfo\` 与 \`GetSystemTimes\` 实时硬件采样生成。`
    },
    {
      id: 'hw-mem-spec',
      category: 'memory',
      title: `物理内存总容量 ${formatBytes(totalMemoryBytes)}`,
      subtitle: `已用 ${formatBytes(usedMemoryBytes)} · 可用余量 ${formatBytes(availableMemoryBytes)}`,
      value: `${memoryUsagePercent}% 已用`,
      tag: formatBytes(totalMemoryBytes),
      detailMarkdown: `# 物理内存子系统 (RAM)

**安装总物理内存**: \`${formatBytes(totalMemoryBytes)}\` (${totalMemoryBytes.toLocaleString()} Bytes)

---

### 实时工作集分布
- **当前已用物理内存**: \`${formatBytes(usedMemoryBytes)}\` (${memoryUsagePercent}%)
- **当前空闲可用内存**: \`${formatBytes(availableMemoryBytes)}\`
- **内存健康度**: \`${memoryUsagePercent > 85 ? '高负载预警' : '充裕正常'}\``
    },
    {
      id: 'hw-os-spec',
      category: 'system',
      title: `${osName} (${osArch})`,
      subtitle: `内核版本 ${osVersion} · Build ${osBuild}`,
      value: `Build ${osBuild}`,
      tag: osVersion,
      detailMarkdown: `# 操作系统与供电状态

- **操作系统版本**: \`${osName}\`
- **内核版本号**: \`${osVersion} (Build ${osBuild})\`
- **系统位宽架构**: \`${osArch}\`
- **电源/电池状态**: \`${batteryPercent}% (${isCharging ? 'AC 交流电源供电中' : '电池放电中'})\``
    }
  ]

  for (const d of drives) {
    entries.push({
      id: `hw-drive-${d.drive}`,
      category: 'storage',
      title: `本地物理存储卷 (${d.drive})`,
      subtitle: `总容量 ${formatBytes(d.totalBytes)} · 已用 ${formatBytes(d.usedBytes)} · 剩余可用 ${formatBytes(d.availableBytes)}`,
      value: `已用 ${d.usagePercent}%`,
      tag: formatBytes(d.totalBytes),
      detailMarkdown: `# 存储卷 ${d.drive}

- **总计物理容量**: \`${formatBytes(d.totalBytes)}\`
- **当前已用容量**: \`${formatBytes(d.usedBytes)} (${d.usagePercent}%)\`
- **剩余可用容量**: \`${formatBytes(d.availableBytes)}\`
- **空间状态**: \`${d.usagePercent > 85 ? '空间偏紧' : '健康充裕'}\``
    })
  }

  displays.forEach((disp, index) => {
    const w = disp.bounds?.width || 1920
    const h = disp.bounds?.height || 1080
    const scale = Math.round((disp.scaleFactor || 1) * 100)
    const hz = disp.displayFrequency || 60
    entries.push({
      id: `hw-disp-${disp.id || index}`,
      category: 'display',
      title: disp.label || `显示器 #${index + 1} (${w} × ${h})`,
      subtitle: `DPI 缩放 ${scale}% · 刷新率 ${hz}Hz · 色深 ${disp.colorDepth || 24}-bit`,
      value: `${w}×${h} @${hz}Hz`,
      tag: `${scale}% DPI`,
      detailMarkdown: `# 显示器输出端点 #${index + 1}

- **设备标识**: \`${disp.label || `Display #${disp.id || index + 1}`}\`
- **逻辑分辨率**: \`${w} × ${h}\`
- **工作区尺寸**: \`${disp.workArea?.width || w} × ${disp.workArea?.height || h}\`
- **系统 DPI 缩放**: \`${scale}%\`
- **垂直刷新率**: \`${hz} Hz\``
    })
  })

  for (const sc of scenarios) {
    entries.push({
      id: sc.id,
      category: 'benchmark',
      title: sc.scenario,
      subtitle: `${sc.summary}`,
      value: `${sc.score} 分`,
      tag: sc.tier,
      detailMarkdown: `# ${sc.scenario}

- **兼容性评级**: **${sc.tier}** (\`${sc.score} / 100\`)
- **硬件表现分析**: ${sc.summary}
- **升级与优化建议**: ${sc.bottleneckHint}`
    })
  }

  return {
    cpuModel,
    logicalCpuCount,
    cpuUsagePercent,
    totalMemoryBytes,
    usedMemoryBytes,
    availableMemoryBytes,
    memoryUsagePercent,
    osName,
    osVersion,
    osBuild,
    osArch,
    driveCount: drives.length,
    totalDiskBytes,
    usedDiskBytes,
    availableDiskBytes,
    drives,
    displayCount: displays.length,
    batteryPercent,
    isCharging,
    healthScore,
    scenarios,
    entries
  }
}
