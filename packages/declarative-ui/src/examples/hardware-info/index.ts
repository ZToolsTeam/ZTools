import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast
} from '../../index.js'
import {
  HardwareSpecEntry,
  HardwareTelemetrySnapshot,
  formatBytes,
  fetchHardwareTelemetrySnapshot,
  exportHardwareReport
} from './logic.js'

export * from './logic.js'

type HardwareDropdownFilter = 'all' | 'cpu-mem' | 'storage' | 'display' | 'benchmark' | 'report'

export default function HardwareInfoCommand() {
  const [searchText, setSearchText] = useState('')
  const [dropdownFilter, setDropdownFilter] = useState<HardwareDropdownFilter>('all')
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
    void refreshTelemetry(false)
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
  const filtered = entries.filter((e) => {
    if (dropdownFilter === 'cpu-mem' && e.category !== 'cpu' && e.category !== 'memory' && e.category !== 'system') {
      return false
    }
    if (dropdownFilter === 'storage' && e.category !== 'storage') return false
    if (dropdownFilter === 'display' && e.category !== 'display') return false
    if (dropdownFilter === 'benchmark' && e.category !== 'benchmark') return false
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

  return List({
    searchBarPlaceholder: '搜索本机 CPU 型号、内存、磁盘分区、显示器分辨率、AI 大模型兼容性或导出报告...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换硬件模块或导出报告',
      value: dropdownFilter,
      onChange: (val: string) => setDropdownFilter(val as HardwareDropdownFilter),
      children: [
        List.Dropdown.Item({ title: '全部硬件模块 (All Modules)', value: 'all' }),
        List.Dropdown.Item({ title: '处理器与内存 (CPU & RAM)', value: 'cpu-mem' }),
        List.Dropdown.Item({ title: '磁盘存储卷 (Storage Volumes)', value: 'storage' }),
        List.Dropdown.Item({ title: '显卡与显示器 (Display & GPU)', value: 'display' }),
        List.Dropdown.Item({ title: '4大场景性能评测 (Benchmarks)', value: 'benchmark' }),
        List.Dropdown.Item({ title: '导出硬件报告 (Export Report)', value: 'report' })
      ]
    }),
    filterBar: {
      summaryText: snapshot
        ? `整机健康度 ${snapshot.healthScore} 分 · CPU ${snapshot.logicalCpuCount} 线程 (${cpuPct}%) · 物理内存 ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPct}%) · 存储池 ${formatBytes(totalDisk)} (${drives.length} 个分区，可用 ${formatBytes(availDisk)})`
        : '硬件传感器采集中...',
      actions: [
        {
          id: 'refresh-hw',
          label: '刷新传感器',
          title: '刷新传感器',
          style: 'secondary',
          onAction: () => void refreshTelemetry(true)
        },
        {
          id: 'export-md',
          label: '复制Markdown报告',
          title: '复制Markdown报告',
          style: 'secondary',
          onAction: () => void handleCopyReport('markdown')
        }
      ]
    },
    children:
      dropdownFilter === 'report' && snapshot
        ? [
            List.Section({
              title: '多格式整机硬件配置与健康度报告导出',
              children: [
                List.Item({
                  id: 'report-md',
                  title: '导出 Markdown 格式整机硬件评测报告',
                  subtitle: '适合粘贴至 GitHub Issue、Notion、Obsidian 或技术文档',
                  icon: Icon.Document,
                  accessories: [{ tag: { value: 'Markdown' } }],
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
                  icon: Icon.Terminal,
                  accessories: [{ tag: { value: 'JSON Schema' } }],
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
                  subtitle: '适合直接发送至即时通讯窗口快速分享本机配置',
                  icon: Icon.Clipboard,
                  accessories: [{ tag: { value: 'Plain Text' } }],
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
              children: filtered.map((item) =>
                List.Item({
                  id: item.id,
                  title: item.title,
                  subtitle: item.subtitle,
                  icon:
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
                  accessories: [
                    { tag: { value: item.tag } },
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
                        shortcut: { modifiers: ['ctrl'], key: 'return' },
                        onAction: () => handleCopyReport('json')
                      }),
                      Action({
                        title: '复制当前硬件规格摘要',
                        icon: Icon.Clipboard,
                        shortcut: { modifiers: ['ctrl'], key: 'c' },
                        onAction: async () => {
                          const text = `${item.title} | ${item.subtitle} | ${item.value}`
                          await Clipboard.copy(text)
                          showToast({ style: Toast.Style.Success, title: '已复制硬件规格', message: item.title })
                        }
                      }),
                      Action({
                        title: '刷新硬件传感器遥测',
                        icon: Icon.ArrowClockwise,
                        shortcut: { modifiers: ['ctrl'], key: 'r' },
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
