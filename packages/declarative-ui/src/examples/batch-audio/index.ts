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
  AUDIO_WORKSHOP_MODES,
  CapabilityActionItem,
  RealAudioFileItem,
  formatBytes,
  fetchRealAudioWorkspace,
  invokeNativeCapability,
  openAudioFileLocation
} from './logic.js'

const EXT_COLORS = ['#10b981', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4']

export default function BatchAudioCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'files' | 'presets' | 'all'>('files')
  const [activeModeId, setActiveModeId] = useState<string>(AUDIO_WORKSHOP_MODES[0].id)
  const [audioProfile, setAudioProfile] = useState<'studio_48k' | 'cd_44k' | 'podcast_mono' | 'lossless_flac'>('studio_48k')
  const [files, setFiles] = useState<RealAudioFileItem[]>([])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [presets, setPresets] = useState<CapabilityActionItem[]>(AUDIO_WORKSHOP_MODES)
  const [scannedDirs, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealAudioWorkspace()
      setFiles(ws.files)
      setCheckedIds(ws.files.map(f => f.id))
      setPresets(ws.presets)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '音频工坊已刷新',
          message: `检索到 ${ws.files.length} 个本地音频/媒体文件 · 12 大音效引擎就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activePreset = presets.find(p => p.id === activeModeId) || AUDIO_WORKSHOP_MODES[0]

  async function handleRunBatchChecked() {
    const selected = files.filter(f => checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的音频文件' })
      return
    }
    const ok = await confirmAlert({
      title: `🎵 确认对 ${selected.length} 首音频执行「${activePreset.title}」？`,
      message: `声学滤镜管线: ${activePreset.ffmpegFilter || activePreset.method}\n采样档位: ${audioProfile}`,
      primaryAction: { title: '开始批量处理', style: 'default' }
    })
    if (!ok) return

    let count = 0
    for (const f of selected) {
      const res = await invokeNativeCapability(activePreset.method, {
        ...activePreset.params,
        audioProfile,
        inputPath: f.path
      })
      if (res.ok) count += 1
    }
    showToast({
      style: Toast.Style.Success,
      title: `已提交 ${count} 首音频批处理任务`,
      message: activePreset.title
    })
  }

  async function handleRunPreset(preset: CapabilityActionItem, targetFile?: RealAudioFileItem) {
    try {
      const payload = targetFile ? { ...preset.params, inputPath: targetFile.path } : preset.params
      const res = await invokeNativeCapability(preset.method, payload)
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: '音频处理失败', message: res.error || '原生模块返回错误' })
        return
      }
      showToast({
        style: Toast.Style.Success,
        title: '音频批处理指令已下发',
        message: `${preset.title}${targetFile ? ` (${targetFile.name})` : ''}`
      })
    } catch (err: any) {
      showToast({ style: Toast.Style.Failure, title: '参数拦截', message: err?.message || String(err) })
    }
  }

  const selectedFiles = files.filter(f => checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const allTotalBytes = files.reduce((s, f) => s + f.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(
    p => !q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  )

  const extBytesMap = new Map<string, number>()
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
    searchBarPlaceholder: '搜索本机音频文件、12 大声学处理模式或输出格式 (MP3 / FLAC / -16 LUFS / 静音切除 / 降噪)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'ba-files',
          label: '已勾选 / 扫描音轨',
          value: `${checkedIds.length} / ${files.length} 首`,
          subValue: `${scannedDirs.length} 个本机目录已扫描`,
          status: 'normal'
        },
        {
          id: 'ba-size',
          label: '已勾选音频总大小',
          value: formatBytes(totalBytes),
          subValue: `总音频池 ${formatBytes(allTotalBytes)}`,
          status: 'normal'
        },
        {
          id: 'ba-lufs',
          label: '广播级响度基准',
          value: '-16 LUFS',
          subValue: 'EBU R128 防爆音保护',
          status: 'success'
        },
        {
          id: 'ba-presets',
          label: '当前激活音效引擎',
          value: activePreset.tag,
          subValue: `共 ${presets.length} 大声学工坊模式`,
          status: 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机音频与媒体文件格式体积分布',
      totalLabel: `共 ${files.length} 首 · ${formatBytes(allTotalBytes)}`,
      segments: extSegments
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 扫描本机音频目录', status: 'done' },
        { step: 2, label: '2. 选择 12 大声学处理引擎', status: 'done' },
        { step: 3, label: '3. 配置采样率与LUFS响度', status: 'active' },
        { step: 4, label: '4. 批量声学处理导出', status: 'pending' }
      ],
      summaryText: `当前引擎: ${activePreset.title} · 已勾选 ${checkedIds.length} 首音频`,
      groups: [
        {
          id: 'audio-mode',
          label: '声学引擎 (12项)',
          value: activeModeId,
          onChange: (v) => setActiveModeId(v),
          options: AUDIO_WORKSHOP_MODES.map((m) => ({
            value: m.id,
            label: m.tag
          }))
        },
        {
          id: 'audio-profile',
          label: '采样率与音质档位',
          value: audioProfile,
          onChange: (v) => setAudioProfile(v as any),
          options: [
            { value: 'studio_48k', label: '录音室级 (48kHz / 320kbps)' },
            { value: 'cd_44k', label: '标准 CD 级 (44.1kHz / 256kbps)' },
            { value: 'lossless_flac', label: '母带无损 (FLAC 24-bit)' },
            { value: 'podcast_mono', label: '播客语音优化 (单声道 -16 LUFS)' }
          ]
        }
      ],
      actions: [
        {
          id: 'run-batch-audio',
          title: `🎵 批量处理已选 (${checkedIds.length})`,
          style: 'primary',
          disabled: checkedIds.length === 0,
          onAction: handleRunBatchChecked
        },
        {
          id: 'rescan-audio',
          title: '🔄 刷新音频库',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'files', label: '本机音轨批处理队列 (三态勾选)', badge: files.length },
        { value: 'presets', label: '12 大声学与音效引擎总览', badge: presets.length },
        { value: 'all', label: '完整混合工作台', badge: files.length + presets.length }
      ]
    }),
    children: [
      ...(tab === 'all' || tab === 'files'
        ? [
            List.Section({
              title: `本机目录音频与媒体队列 (${filteredFiles.length})`,
              subtitle: `当前应用引擎: ${activePreset.title}`,
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
                  icon: { source: Icon.Music, tintColor: isChecked ? Color.Green : Color.SecondaryText },
                  accessories: [
                    { tag: { value: activePreset.tag, color: Color.Blue } },
                    { text: formatBytes(f.sizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 🎵 ${f.name}

**本机真实路径**: \`${f.path}\`

---

### 🎚️ 12 合 1 声学工坊处理预览 (BatchAudioPlugin)
- **当前激活声学模式**: **${activePreset.title}**
- **原始文件体积**: \`${formatBytes(f.sizeBytes)}\`
- **目标音质档位**: \`${audioProfile}\`
- **FFmpeg 声学滤镜管线**:
\`\`\`bash
ffmpeg -i "${f.path}" ${activePreset.ffmpegFilter || ''} "${f.path.replace(/(\.[^.]+)$/, `_ztools_${activePreset.tag}.mp3`)}"
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
                        title: `批量处理全部已选音轨 (${checkedIds.length})`,
                        icon: Icon.Play,
                        onAction: handleRunBatchChecked
                      }),
                      Action({
                        title: '复制等效 FFmpeg 声学命令',
                        icon: Icon.Terminal,
                        onAction: async () => {
                          const cmd = `ffmpeg -i "${f.path}" ${activePreset.ffmpegFilter || ''} "${f.path.replace(/(\.[^.]+)$/, `_out.mp3`)}"`
                          await Clipboard.copy(cmd)
                          showToast({ style: Toast.Style.Success, title: '已复制 FFmpeg 音频命令' })
                        }
                      }),
                      Action({
                        title: '在资源管理器中定位文件',
                        icon: Icon.Folder,
                        onAction: () => {
                          openAudioFileLocation(f.path)
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
              title: `12 大核心音频处理与声学工坊模式 (${filteredPresets.length})`,
              children: filteredPresets.map(p =>
                List.Item({
                  id: p.id,
                  title: p.title,
                  subtitle: p.subtitle,
                  icon: {
                    source: Icon.SpeakerHigh,
                    tintColor: p.id === activeModeId ? Color.Green : Color.Blue
                  },
                  accessories: [
                    { tag: { value: p.tag, color: p.id === activeModeId ? Color.Green : Color.Blue } },
                    { text: p.method }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 🎚️ ${p.title}\n\n${p.subtitle}\n\n### 声学滤镜参数\n\`\`\`bash\n${p.ffmpegFilter || ''}\n\`\`\`\n\n### Native 调用参数契约\n\`\`\`json\n${JSON.stringify(p.params, null, 2)}\n\`\`\``
                  }),
                  actions: ActionPanel({
                    title: p.title,
                    children: [
                      Action({
                        title: '设为当前激活声学模式并切换到音轨队列',
                        icon: Icon.CheckCircle,
                        onAction: () => {
                          setActiveModeId(p.id)
                          setTab('files')
                        }
                      }),
                      Action({
                        title: '对当前音轨执行此处理方案',
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
