import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  MetricGrid,
  DistributionBar,
  FilterBar,
  SegmentedControl
} from '../../index.js'
import {
  HardwareSpecEntry,
  HardwareTelemetrySnapshot,
  formatBytes,
  fetchHardwareTelemetrySnapshot,
  exportHardwareReport
} from './logic.js'

const DRIVE_COLORS = ['#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4']

export default function HardwareInfoCommand() {
  const [searchText, setSearchText] = useState('')
  const [viewMode, setViewMode] = useState<'all' | 'storage' | 'benchmark' | 'report'>('all')
  const [moduleFilter, setModuleFilter] = useState<'all' | 'cpu' | 'memory' | 'storage' | 'display' | 'system' | 'benchmark'>('all')
  const [snapshot, setSnapshot] = useState<HardwareTelemetrySnapshot | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshTelemetry(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const snap = await fetchHardwareTelemetrySnapshot()
      setSnapshot(snap)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '本机硬件传感器遥测已刷新',
          message: `${snap.cpuModel} · 内存 ${snap.memoryUsagePercent}% · 存储池 ${formatBytes(snap.totalDiskBytes)}`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshTelemetry(false)
  }, [])

  async function handleCopyReport(format: 'markdown' | 'json' | 'txt') {
    if (!snapshot) return
    const content = exportHardwareReport(snapshot, format)
    await Clipboard.copy(content)
    showToast({
      style: Toast.Style.Success,
      title: `已导出 ${format.toUpperCase()} 硬件配置报告至剪贴板`,
      message: `${snapshot.cpuModel} · ${formatBytes(snapshot.totalMemoryBytes)} RAM`
    })
  }

  const entries: HardwareSpecEntry[] = snapshot?.entries || []
  const q = searchText.trim().toLowerCase()
  const filtered = entries.filter(e => {
    if (viewMode === 'storage' && e.category !== 'storage' && e.category !== 'display') return false
    if (viewMode === 'benchmark' && e.category !== 'benchmark') return false
    if (moduleFilter !== 'all' && e.category !== moduleFilter) return false
    if (!q) return true
    return (
      e.title.toLowerCase().includes(q) ||
      e.subtitle.toLowerCase().includes(q) ||
      e.value.toLowerCase().includes(q) ||
      e.tag.toLowerCase().includes(q)
    )
  })

  const cpuPct = snapshot?.cpuUsagePercent || 0
  const memPct = snapshot?.memoryUsagePercent || 0
  const totalMem = snapshot?.totalMemoryBytes || 0
  const usedMem = snapshot?.usedMemoryBytes || 0
  const totalDisk = snapshot?.totalDiskBytes || 0
  const availDisk = snapshot?.availableDiskBytes || 0
  const drives = snapshot?.drives || []

  const driveSegments = drives.map((d, idx) => ({
    id: d.drive,
    label: `${d.drive} 已用 ${formatBytes(d.usedBytes)} (${d.usagePercent}%)`,
    valueBytes: d.usedBytes,
    formattedSize: `${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)}`,
    percentage: totalDisk > 0 ? Math.max(5, (d.totalBytes / totalDisk) * 100) : 25,
    color: DRIVE_COLORS[idx % DRIVE_COLORS.length],
    active: true
  }))

  return List({
    searchBarPlaceholder: '搜索本机 CPU 型号、内存、磁盘分区、显示器分辨率、AI 大模型兼容性或导出报告...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'hw-m-cpu',
          label: '处理器实时利用率',
          value: `${cpuPct}%`,
          subValue: snapshot ? `${snapshot.logicalCpuCount} 逻辑线程 · 评分 ${snapshot.healthScore}` : '采集中...',
          progress: cpuPct,
          status: cpuPct > 85 ? 'danger' : cpuPct > 60 ? 'warning' : 'success'
        },
        {
          id: 'hw-m-mem',
          label: '物理内存工作集',
          value: `${memPct}%`,
          subValue: `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
          progress: memPct,
          status: memPct > 85 ? 'danger' : memPct > 70 ? 'warning' : 'normal'
        },
        {
          id: 'hw-m-drives',
          label: '全盘存储池汇总',
          value: formatBytes(totalDisk),
          subValue: `${drives.length} 个分区 · 可用 ${formatBytes(availDisk)}`,
          status: 'normal'
        },
        {
          id: 'hw-m-disp',
          label: '多屏显示与供电',
          value: `${snapshot?.displayCount || 1} 台显示器`,
          subValue: snapshot?.isCharging ? `⚡ AC供电 (${snapshot.batteryPercent}%)` : `🔋 电池 (${snapshot?.batteryPercent || 100}%)`,
          status: 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机物理存储卷容量分布 (NTFS 硬件分区实测)',
      totalLabel: `总计 ${formatBytes(totalDisk)} · 剩余可用 ${formatBytes(availDisk)}`,
      segments: driveSegments,
      onSegmentClick: () => {
        setModuleFilter(moduleFilter === 'storage' ? 'all' : 'storage')
      }
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. CPU/RAM 内核遥测', status: 'done' },
        { step: 2, label: '2. 全盘分区与多屏测绘', status: 'done' },
        { step: 3, label: '3. 生产力与AI战力评估', status: 'active' },
        { step: 4, label: '4. 多格式资产报告导出', status: 'pending' }
      ],
      summaryText: snapshot ? `整机健康度 ${snapshot.healthScore} 分 · ${entries.length} 项硬件指标` : '硬件采集中...',
      groups: [
        {
          id: 'hw-module',
          label: '硬件模块',
          value: moduleFilter,
          onChange: (v) => setModuleFilter(v as any),
          options: [
            { value: 'all', label: '全部模块', badge: entries.length },
            { value: 'cpu', label: '🖥️ 处理器 CPU', badge: entries.filter(e => e.category === 'cpu').length },
            { value: 'memory', label: '🧠 物理内存 RAM', badge: entries.filter(e => e.category === 'memory').length },
            { value: 'storage', label: '💽 磁盘存储卷', badge: entries.filter(e => e.category === 'storage').length },
            { value: 'display', label: '🖥️ 显示器/显卡', badge: entries.filter(e => e.category === 'display').length },
            { value: 'system', label: '🪟 系统与电源', badge: entries.filter(e => e.category === 'system').length },
            { value: 'benchmark', label: '🏆 场景兼容性评测', badge: entries.filter(e => e.category === 'benchmark').length }
          ]
        }
      ],
      actions: [
        {
          id: 'export-md',
          title: '📋 复制 Markdown 报告',
          style: 'primary',
          onAction: () => handleCopyReport('markdown')
        },
        {
          id: 'export-json',
          title: '📦 复制 JSON 清单',
          style: 'secondary',
          onAction: () => handleCopyReport('json')
        },
        {
          id: 'refresh-hw',
          title: '🔄 刷新传感器',
          style: 'secondary',
          onAction: () => refreshTelemetry(true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: viewMode,
      onChange: v => setViewMode(v as any),
      options: [
        { value: 'all', label: '整机硬件全景', badge: entries.length },
        { value: 'storage', label: '存储卷与多屏矩阵', badge: entries.filter(e => e.category === 'storage' || e.category === 'display').length },
        { value: 'benchmark', label: '生产力与本地AI评测', badge: entries.filter(e => e.category === 'benchmark').length },
        { value: 'report', label: '📤 导出硬件报告', badge: 3 }
      ]
    }),
    children:
      viewMode === 'report' && snapshot
        ? [
            List.Section({
              title: '多格式整机硬件配置与健康度报告导出 (PRD 3.1 [📤 导出报告])',
              children: [
                List.Item({
                  id: 'report-md',
                  title: '导出 Markdown 格式整机硬件评测报告',
                  subtitle: '适合粘贴至 GitHub Issue、Notion、Obsidian 或技术文档',
                  icon: { source: Icon.Document, tintColor: Color.Blue },
                  accessories: [{ tag: { value: 'Markdown', color: Color.Blue } }],
                  detail: List.Item.Detail({
                    markdown: exportHardwareReport(snapshot, 'markdown')
                  }),
                  actions: ActionPanel({
                    title: 'Markdown 报告',
                    children: [
                      Action({
                        title: '复制 Markdown 硬件报告到剪贴板',
                        icon: Icon.Clipboard,
                        onAction: () => handleCopyReport('markdown')
                      })
                    ]
                  })
                }),
                List.Item({
                  id: 'report-json',
                  title: '导出 JSON 结构化硬件资产清单',
                  subtitle: '适合企业 IT 资产盘点、自动化运维脚本与 API 对接',
                  icon: { source: Icon.Terminal, tintColor: Color.Green },
                  accessories: [{ tag: { value: 'JSON Schema', color: Color.Green } }],
                  detail: List.Item.Detail({
                    markdown: '```json\n' + exportHardwareReport(snapshot, 'json') + '\n```'
                  }),
                  actions: ActionPanel({
                    title: 'JSON 资产清单',
                    children: [
                      Action({
                        title: '复制 JSON 硬件清单到剪贴板',
                        icon: Icon.Clipboard,
                        onAction: () => handleCopyReport('json')
                      })
                    ]
                  })
                }),
                List.Item({
                  id: 'report-txt',
                  title: '导出纯文本 (TXT) 极简配置单',
                  subtitle: '适合直接发送至微信/QQ/飞书聊天窗口快速分享本机配置',
                  icon: { source: Icon.Clipboard, tintColor: Color.Orange },
                  accessories: [{ tag: { value: 'Plain Text', color: Color.Orange } }],
                  detail: List.Item.Detail({
                    markdown: '```text\n' + exportHardwareReport(snapshot, 'txt') + '\n```'
                  }),
                  actions: ActionPanel({
                    title: '纯文本配置单',
                    children: [
                      Action({
                        title: '复制纯文本配置单到剪贴板',
                        icon: Icon.Clipboard,
                        onAction: () => handleCopyReport('txt')
                      })
                    ]
                  })
                })
              ]
            })
          ]
        : [
            List.Section({
              title: `本机真实硬件与传感器规格清单 (${filtered.length})`,
              children: filtered.map(item =>
                List.Item({
                  id: item.id,
                  title: item.title,
                  subtitle: item.subtitle,
                  icon: {
                    source:
                      item.category === 'cpu'
                        ? Icon.Bolt
                        : item.category === 'memory'
                        ? Icon.Gear
                        : item.category === 'storage'
                        ? Icon.HardDrive
                        : item.category === 'display'
                        ? Icon.Monitor
                        : item.category === 'benchmark'
                        ? Icon.Star
                        : Icon.Desktop,
                    tintColor: item.category === 'benchmark' ? Color.Green : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value: item.tag,
                        color: item.category === 'benchmark' ? Color.Green : Color.SecondaryText
                      }
                    },
                    { text: item.value }
                  ],
                  detail: List.Item.Detail({
                    markdown: item.detailMarkdown
                  }),
                  actions: ActionPanel({
                    title: item.title,
                    children: [
                      Action({
                        title: '复制 Markdown 整机硬件报告',
                        icon: Icon.Document,
                        onAction: () => handleCopyReport('markdown')
                      }),
                      Action({
                        title: '复制 JSON 结构化资产清单',
                        icon: Icon.Terminal,
                        onAction: () => handleCopyReport('json')
                      }),
                      Action({
                        title: '复制当前硬件规格摘要',
                        icon: Icon.Clipboard,
                        onAction: async () => {
                          const text = `${item.title} | ${item.subtitle} | ${item.value}`
                          await Clipboard.copy(text)
                          showToast({ style: Toast.Style.Success, title: '已复制硬件规格', message: item.title })
                        }
                      }),
                      Action({
                        title: '刷新硬件传感器遥测',
                        icon: Icon.ArrowClockwise,
                        onAction: () => refreshTelemetry(true)
                      })
                    ]
                  })
                })
              )
            })
          ]
  })
}
