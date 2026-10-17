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
  confirmAlert,
  MetricGrid,
  DistributionBar,
  FilterBar,
  SegmentedControl
} from '../../index.js'
import {
  CapabilityActionItem,
  RealVideoFileItem,
  VIDEO_WORKSHOP_MODES,
  formatBytes,
  fetchRealVideoWorkspace,
  invokeNativeCapability,
  openVideoFileLocation
} from './logic.js'

const EXT_COLORS = ['#a855f7', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4']

export default function BatchVideoCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'files' | 'presets' | 'all'>('files')
  const [activeModeId, setActiveModeId] = useState<string>(VIDEO_WORKSHOP_MODES[0].id)
  const [qualityTier, setQualityTier] = useState<'crf23' | 'crf28' | 'lossless' | 'hevc'>('crf23')
  const [files, setFiles] = useState<RealVideoFileItem[]>([])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [presets, setPresets] = useState<CapabilityActionItem[]>(VIDEO_WORKSHOP_MODES)
  const [scannedDirs, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealVideoWorkspace()
      setFiles(ws.files)
      setCheckedIds(ws.files.map(f => f.id))
      setPresets(ws.presets)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '视频工坊已刷新',
          message: `检索到 ${ws.files.length} 个本地视频/媒体文件 · 12 大视频批处理模式就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activePreset = presets.find(p => p.id === activeModeId) || VIDEO_WORKSHOP_MODES[0]
  const ratio =
    qualityTier === 'crf28'
      ? 0.28
      : qualityTier === 'hevc'
      ? 0.32
      : qualityTier === 'lossless'
      ? 0.95
      : activePreset.ratioMultiplier || 0.42

  async function handleRunBatchChecked() {
    const selectedFiles = files.filter(f => checkedIds.includes(f.id))
    if (selectedFiles.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的视频文件' })
      return
    }
    const ok = await confirmAlert({
      title: `🎬 确认对 ${selectedFiles.length} 个文件执行「${activePreset.title}」？`,
      message: `FFmpeg 滤镜管线: ${activePreset.ffmpegArgs || activePreset.method}\n画质档位: ${qualityTier.toUpperCase()}`,
      primaryAction: { title: '开始批量处理', style: 'default' }
    })
    if (!ok) return

    let successCount = 0
    for (const file of selectedFiles) {
      const res = await invokeNativeCapability(activePreset.method, {
        ...activePreset.params,
        qualityTier,
        inputPath: file.path
      })
      if (res.ok) successCount += 1
    }
    showToast({
      style: Toast.Style.Success,
      title: `已提交 ${successCount} 个视频批处理任务`,
      message: `${activePreset.title}`
    })
  }

  async function handleRunPreset(preset: CapabilityActionItem, targetFile?: RealVideoFileItem) {
    try {
      const payload = targetFile ? { ...preset.params, inputPath: targetFile.path } : preset.params
      const res = await invokeNativeCapability(preset.method, payload)
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: '转码任务失败', message: res.error || '原生模块返回错误' })
        return
      }
      showToast({
        style: Toast.Style.Success,
        title: '视频批处理指令已下发',
        message: `${preset.title}${targetFile ? ` (${targetFile.name})` : ''}`
      })
    } catch (err: any) {
      showToast({ style: Toast.Style.Failure, title: '参数拦截', message: err?.message || String(err) })
    }
  }

  const selectedFiles = files.filter(f => checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const estimatedOutBytes = Math.round(totalBytes * ratio)
  const totalSaved = Math.max(0, totalBytes - estimatedOutBytes)

  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(
    p => !q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  )

  // 按扩展名统计体积分布
  const extBytesMap = new Map<string, number>()
  const allTotalBytes = files.reduce((s, f) => s + f.sizeBytes, 0)
  for (const f of files) {
    extBytesMap.set(f.extension, (extBytesMap.get(f.extension) || 0) + f.sizeBytes)
  }
  const extSegments = Array.from(extBytesMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, bytes], idx) => ({
      id: ext,
      label: `${ext.toUpperCase()} (${formatBytes(bytes)})`,
      valueBytes: bytes,
      formattedSize: formatBytes(bytes),
      percentage: allTotalBytes > 0 ? Math.max(5, (bytes / allTotalBytes) * 100) : 25,
      color: EXT_COLORS[idx % EXT_COLORS.length],
      active: true
    }))

  return List({
    searchBarPlaceholder: '搜索本机视频媒体文件、12 大视频工坊模式或输出格式 (MP4 / H.265 / 9:16 / GIF / 水印)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'bv-files',
          label: '已勾选 / 扫描视频数',
          value: `${checkedIds.length} / ${files.length} 个`,
          subValue: `${scannedDirs.length} 个媒体目录已穿透`,
          status: 'normal'
        },
        {
          id: 'bv-size',
          label: '已勾选原始总体积',
          value: formatBytes(totalBytes),
          subValue: `预估输出 ${formatBytes(estimatedOutBytes)}`,
          status: 'normal'
        },
        {
          id: 'bv-saved',
          label: '预计节省磁盘空间',
          value: formatBytes(totalSaved),
          subValue: `压缩比约 ${Math.round((1 - ratio) * 100)}%`,
          status: 'success'
        },
        {
          id: 'bv-presets',
          label: '当前激活工坊模式',
          value: activePreset.tag,
          subValue: `共 ${presets.length} 大批处理模式`,
          status: 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机视频与媒体文件封装格式体积分布',
      totalLabel: `共 ${files.length} 个文件 · ${formatBytes(allTotalBytes)}`,
      segments: extSegments
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 穿透扫描本机视频源', status: 'done' },
        { step: 2, label: '2. 选择 12 大视频工坊模式', status: 'done' },
        { step: 3, label: '3. 配置编码/画幅/水印参数', status: 'active' },
        { step: 4, label: '4. 批量执行/导出脚本', status: 'pending' }
      ],
      summaryText: `当前模式: ${activePreset.title} · 已勾选 ${checkedIds.length} 个文件`,
      groups: [
        {
          id: 'video-mode',
          label: '工坊模式 (12项)',
          value: activeModeId,
          onChange: (v) => setActiveModeId(v),
          options: VIDEO_WORKSHOP_MODES.map((m) => ({
            value: m.id,
            label: m.tag
          }))
        },
        {
          id: 'quality-tier',
          label: '编码与画质档位',
          value: qualityTier,
          onChange: (v) => setQualityTier(v as any),
          options: [
            { value: 'crf23', label: '均衡视觉无损 (H.264 CRF23)' },
            { value: 'crf28', label: '极致体积瘦身 (H.264 CRF28)' },
            { value: 'hevc', label: 'HEVC 高压缩 (H.265 CRF26)' },
            { value: 'lossless', label: '极速流拷贝 (-c copy 无损)' }
          ]
        }
      ],
      actions: [
        {
          id: 'run-batch-video',
          title: `🎬 批量处理已选 (${checkedIds.length})`,
          style: 'primary',
          disabled: checkedIds.length === 0,
          onAction: handleRunBatchChecked
        },
        {
          id: 'rescan-video',
          title: '🔄 刷新视频库',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'files', label: '本机视频批处理队列 (三态勾选)', badge: files.length },
        { value: 'presets', label: '12 大视频工坊模式总览', badge: presets.length },
        { value: 'all', label: '完整混合工作台', badge: files.length + presets.length }
      ]
    }),
    children: [
      ...(tab === 'all' || tab === 'files'
        ? [
            List.Section({
              title: `本机目录视频媒体队列 (${filteredFiles.length})`,
              subtitle: `当前应用模式: ${activePreset.title}`,
              checkable: true,
              checked:
                filteredFiles.length > 0 && filteredFiles.every(f => checkedIds.includes(f.id))
                  ? true
                  : filteredFiles.some(f => checkedIds.includes(f.id))
                  ? 'indeterminate'
                  : false,
              onCheckChange: (checked) => {
                setCheckedIds(checked ? filteredFiles.map(f => f.id) : [])
              },
              children: filteredFiles.map(f => {
                const isChecked = checkedIds.includes(f.id)
                const estOut = Math.round(f.sizeBytes * ratio)
                return List.Item({
                  id: f.id,
                  title: f.name,
                  subtitle: `${f.parentDir} · ${f.extension.toUpperCase()}`,
                  checkable: true,
                  checked: isChecked,
                  onCheckChange: (c) => {
                    if (c) {
                      setCheckedIds(Array.from(new Set([...checkedIds, f.id])))
                    } else {
                      setCheckedIds(checkedIds.filter(id => id !== f.id))
                    }
                  },
                  icon: { source: Icon.Video, tintColor: isChecked ? Color.Purple : Color.SecondaryText },
                  accessories: [
                    { tag: { value: `${activePreset.tag} → ~${formatBytes(estOut)}`, color: Color.Green } },
                    { text: formatBytes(f.sizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 🎬 ${f.name}

**本机真实路径**: \`${f.path}\`

---

### 📊 12 合 1 视频工坊处理预览 (BatchVideoPlugin)
- **当前选中模式**: **${activePreset.title}**
- **原始文件体积**: \`${formatBytes(f.sizeBytes)}\`
- **预计输出体积**: \`${formatBytes(estOut)}\` (节省 \`${formatBytes(Math.max(0, f.sizeBytes - estOut))}\`)
- **FFmpeg 工业级管线指令**:
\`\`\`bash
ffmpeg -i "${f.path}" ${activePreset.ffmpegArgs || ''} "${f.path.replace(/(\.[^.]+)$/, `_ztools_${activePreset.tag}$1`)}"
\`\`\`
`
                  }),
                  actions: ActionPanel({
                    title: f.name,
                    children: [
                      Action({
                        title: `执行「${activePreset.title}」`,
                        icon: Icon.Bolt,
                        onAction: () => handleRunPreset(activePreset, f)
                      }),
                      Action({
                        title: `批量执行全部已选文件 (${checkedIds.length})`,
                        icon: Icon.Play,
                        onAction: handleRunBatchChecked
                      }),
                      Action({
                        title: '复制等效 FFmpeg 命令行',
                        icon: Icon.Terminal,
                        onAction: async () => {
                          const cmd = `ffmpeg -i "${f.path}" ${activePreset.ffmpegArgs || ''} "${f.path.replace(/(\.[^.]+)$/, `_out$1`)}"`
                          await Clipboard.copy(cmd)
                          showToast({ style: Toast.Style.Success, title: '已复制 FFmpeg 命令' })
                        }
                      }),
                      Action({
                        title: '在资源管理器中定位文件',
                        icon: Icon.Folder,
                        onAction: () => {
                          openVideoFileLocation(f.path)
                        }
                      })
                    ]
                  })
                })
              })
            })
          ]
        : []),
      ...(tab === 'all' || tab === 'presets'
        ? [
            List.Section({
              title: `12 大核心视频批处理工坊模式 (${filteredPresets.length})`,
              children: filteredPresets.map(p =>
                List.Item({
                  id: p.id,
                  title: p.title,
                  subtitle: p.subtitle,
                  icon: {
                    source: Icon.Gear,
                    tintColor: p.id === activeModeId ? Color.Green : Color.Blue
                  },
                  accessories: [
                    { tag: { value: p.tag, color: p.id === activeModeId ? Color.Green : Color.Blue } },
                    { text: p.method }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# ⚙️ ${p.title}\n\n${p.subtitle}\n\n### FFmpeg 滤镜与编码参数\n\`\`\`bash\n${p.ffmpegArgs || ''}\n\`\`\`\n\n### Native 调用参数契约\n\`\`\`json\n${JSON.stringify(p.params, null, 2)}\n\`\`\``
                  }),
                  actions: ActionPanel({
                    title: p.title,
                    children: [
                      Action({
                        title: '设为当前激活工坊模式并切换到视频列表',
                        icon: Icon.CheckCircle,
                        onAction: () => {
                          setActiveModeId(p.id)
                          setTab('files')
                        }
                      }),
                      Action({
                        title: '对当前队列立即执行此方案',
                        icon: Icon.Play,
                        onAction: () => handleRunPreset(p, files[0])
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [])
    ]
  })
}
