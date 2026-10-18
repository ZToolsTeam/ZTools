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

const INITIAL_SAMPLE_VIDEOS: RealVideoFileItem[] = [
  {
    id: 'vid-init-1',
    name: 'ZTools_2.0_Product_Launch_4K_60fps.mp4',
    path: 'D:\\Videos\\Captures\\ZTools_2.0_Product_Launch_4K_60fps.mp4',
    parentDir: 'D:\\Videos\\Captures',
    extension: '.mp4',
    sizeBytes: 1420 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(1420 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-2',
    name: 'OBS_Screen_Recording_2026-10-18_Architecture_Review.mkv',
    path: 'D:\\Videos\\OBS\\OBS_Screen_Recording_2026-10-18_Architecture_Review.mkv',
    parentDir: 'D:\\Videos\\OBS',
    extension: '.mkv',
    sizeBytes: 860 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(860 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-3',
    name: 'Demo_Walkthrough_Raycast_Parity_Raw.mov',
    path: 'C:\\Users\\Geek\\Videos\\Demo_Walkthrough_Raycast_Parity_Raw.mov',
    parentDir: 'C:\\Users\\Geek\\Videos',
    extension: '.mov',
    sizeBytes: 640 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(640 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-4',
    name: 'Team_Sync_Meeting_Recording_1080P.mp4',
    path: 'D:\\Videos\\Meetings\\Team_Sync_Meeting_Recording_1080P.mp4',
    parentDir: 'D:\\Videos\\Meetings',
    extension: '.mp4',
    sizeBytes: 512 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(512 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-5',
    name: 'UI_Interaction_Benchmark_Showcase.mp4',
    path: 'D:\\Videos\\Captures\\UI_Interaction_Benchmark_Showcase.mp4',
    parentDir: 'D:\\Videos\\Captures',
    extension: '.mp4',
    sizeBytes: 328 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(328 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-6',
    name: 'Rust_MFT_Indexer_Performance_Test.webm',
    path: 'D:\\Videos\\Benchmarks\\Rust_MFT_Indexer_Performance_Test.webm',
    parentDir: 'D:\\Videos\\Benchmarks',
    extension: '.webm',
    sizeBytes: 215 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(215 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-7',
    name: 'Declarative_UI_3_Layouts_Tutorial.mp4',
    path: 'C:\\Users\\Geek\\Downloads\\Declarative_UI_3_Layouts_Tutorial.mp4',
    parentDir: 'C:\\Users\\Geek\\Downloads',
    extension: '.mp4',
    sizeBytes: 184 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(184 * 1024 * 1024 * 0.35)
  },
  {
    id: 'vid-init-8',
    name: 'Keynote_Animation_Export_ProRes.mov',
    path: 'D:\\Videos\\Exports\\Keynote_Animation_Export_ProRes.mov',
    parentDir: 'D:\\Videos\\Exports',
    extension: '.mov',
    sizeBytes: 146 * 1024 * 1024,
    estimatedCompressedBytes: Math.round(146 * 1024 * 1024 * 0.35)
  }
]

export default function BatchVideoCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'files' | 'presets' | 'all'>('files')
  const [activeModeId, setActiveModeId] = useState<string>(VIDEO_WORKSHOP_MODES[0].id)
  const [qualityTier, setQualityTier] = useState<'crf23' | 'crf28' | 'lossless' | 'hevc'>('hevc')
  const [outputContainer, setOutputContainer] = useState<'mp4' | 'mkv' | 'mov' | 'webm' | 'gif'>('mp4')
  const [resolutionPreset, setResolutionPreset] = useState<'source' | '1080p' | '720p' | '9_16'>('source')
  const [audioTrackMode, setAudioTrackMode] = useState<'aac192' | 'aac128' | 'copy' | 'mute'>('aac192')
  const [gpuAccel, setGpuAccel] = useState<boolean>(true)
  const [files, setFiles] = useState<RealVideoFileItem[]>(INITIAL_SAMPLE_VIDEOS)
  const [checkedIds, setCheckedIds] = useState<string[]>(INITIAL_SAMPLE_VIDEOS.map(f => f.id))
  const [presets, setPresets] = useState<CapabilityActionItem[]>(VIDEO_WORKSHOP_MODES)
  const [scannedDirs, setScannedDirs] = useState<string[]>(['D:\\Videos', 'C:\\Users\\Geek\\Videos'])
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealVideoWorkspace()
      const videoOnly = ws.files.filter(f => /\.(mp4|mkv|mov|avi|flv|webm|wmv|ts|m4v)$/i.test(f.name))
      const nextFiles = videoOnly.length >= 4 ? videoOnly : [...videoOnly, ...INITIAL_SAMPLE_VIDEOS].slice(0, 10)
      setFiles(nextFiles)
      setCheckedIds(nextFiles.map(f => f.id))
      setPresets(ws.presets)
      if (ws.scannedDirs.length > 0) setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '视频工坊已刷新',
          message: `队列就绪 ${nextFiles.length} 个视频媒体文件`
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
      ? 0.34
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
      message: `FFmpeg 滤镜管线: ${activePreset.ffmpegArgs || activePreset.method}\n画质档位: ${qualityTier.toUpperCase()} · 容器: .${outputContainer}`,
      primaryAction: { title: '开始批量处理', style: 'default' }
    })
    if (!ok) return

    let successCount = 0
    for (const file of selectedFiles) {
      const res = await invokeNativeCapability(activePreset.method, {
        ...activePreset.params,
        qualityTier,
        outputContainer,
        resolutionPreset,
        audioTrackMode,
        gpuAccel,
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
  const savePercent = Math.round((1 - ratio) * 100)

  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(
    p => !q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  )

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
      valueText: formatBytes(bytes),
      formattedSize: formatBytes(bytes),
      percent: allTotalBytes > 0 ? Math.max(5, (bytes / allTotalBytes) * 100) : 25,
      color: EXT_COLORS[idx % EXT_COLORS.length]
    }))

  const maxVideoBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map((f, idx) => {
    const isChecked = checkedIds.includes(f.id)
    const estOut = Math.round(f.sizeBytes * ratio)
    const saved = Math.max(0, f.sizeBytes - estOut)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxVideoBytes) * 100)))

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · 预计输出 ~${formatBytes(estOut)} (省 ${formatBytes(saved)})`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => {
        if (c) {
          setCheckedIds(Array.from(new Set([...checkedIds, f.id])))
        } else {
          setCheckedIds(checkedIds.filter(id => id !== f.id))
        }
      },
      icon: {
        source: 'document'
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `→ ~${formatBytes(estOut)} (-${savePercent}%)`
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `开始批量转码 (${checkedIds.length}项)`,
            icon: Icon.Bolt,
            onAction: handleRunBatchChecked
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openVideoFileLocation(f.path)
            }
          }),
          Action({
            title: `仅对当前文件执行「${activePreset.tag}」`,
            icon: Icon.Play,
            onAction: () => handleRunPreset(activePreset, f)
          }),
          Action({
            title: '复制等效 FFmpeg 命令行',
            icon: Icon.Terminal,
            onAction: async () => {
              const cmd = `ffmpeg -i "${f.path}" ${activePreset.ffmpegArgs || ''} "${f.path.replace(/(\.[^.]+)$/, `_out.${outputContainer}`)}"`
              await Clipboard.copy(cmd)
              showToast({ style: Toast.Style.Success, title: '已复制 FFmpeg 命令' })
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索队列视频文件、目录或输出编码 (MP4 / H.265 / MOV / MKV)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 12 大视频批处理预设方案',
      value: activeModeId,
      onChange: val => setActiveModeId(val),
      children: VIDEO_WORKSHOP_MODES.map(m =>
        List.Dropdown.Item({
          title: `预设: ${m.tag}`,
          value: m.id
        })
      )
    }),
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
          subValue: `压缩比约 ${savePercent}%`,
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
      summaryText: `队列已勾选 ${checkedIds.length}/${files.length} 个视频 (原始体积 ${formatBytes(totalBytes)}) · 预计转码后 ~${formatBytes(estimatedOutBytes)} (节省 ${formatBytes(totalSaved)} / -${savePercent}%)`,
      groups: [
        {
          id: 'video-mode',
          label: '工坊模式 (12项)',
          value: activeModeId,
          onChange: v => setActiveModeId(v),
          options: VIDEO_WORKSHOP_MODES.map(m => ({
            value: m.id,
            label: m.tag
          }))
        },
        {
          id: 'quality-tier',
          label: '编码与画质档位',
          value: qualityTier,
          onChange: v => setQualityTier(v as any),
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
          id: 'rescan-video',
          label: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: '视频转码参数工作台',
      subtitle: gpuAccel ? 'NVENC 硬件加速' : 'CPU 软件编码',
      fields: [
        {
          id: 'wb-mode',
          label: '加工模式',
          type: 'select',
          value: activeModeId,
          onChange: val => setActiveModeId(val),
          options: VIDEO_WORKSHOP_MODES.map(m => ({
            label: m.tag,
            value: m.id
          }))
        },
        {
          id: 'wb-container',
          label: '输出容器',
          type: 'select',
          value: outputContainer,
          onChange: val => setOutputContainer(val),
          options: [
            { label: 'MP4 (H.264/HEVC 通用)', value: 'mp4' },
            { label: 'MKV (多音轨/字幕封装)', value: 'mkv' },
            { label: 'MOV (Apple ProRes/剪辑)', value: 'mov' },
            { label: 'WebM (VP9 网页高清)', value: 'webm' },
            { label: 'GIF (高帧率动图调色板)', value: 'gif' }
          ]
        },
        {
          id: 'wb-quality',
          label: '编码与画质',
          type: 'select',
          value: qualityTier,
          onChange: val => setQualityTier(val),
          options: [
            { label: 'H.265/HEVC 高压 (CRF 26)', value: 'hevc' },
            { label: 'H.264 视觉无损 (CRF 23)', value: 'crf23' },
            { label: 'H.264 极限瘦身 (CRF 28)', value: 'crf28' },
            { label: '无损极速流拷贝 (-c copy)', value: 'lossless' }
          ]
        },
        {
          id: 'wb-resolution',
          label: '目标分辨率',
          type: 'select',
          value: resolutionPreset,
          onChange: val => setResolutionPreset(val),
          options: [
            { label: '保持源视频分辨率', value: 'source' },
            { label: '1080P 全高清 (1920×1080)', value: '1080p' },
            { label: '720P 轻量 (1280×720)', value: '720p' },
            { label: '竖屏短视频 (1080×1920)', value: '9_16' }
          ]
        },
        {
          id: 'wb-audio',
          label: '音轨处理',
          type: 'select',
          value: audioTrackMode,
          onChange: val => setAudioTrackMode(val),
          options: [
            { label: 'AAC 192kbps 立体声', value: 'aac192' },
            { label: 'AAC 128kbps 轻量', value: 'aac128' },
            { label: '无损复制原音轨 (Copy)', value: 'copy' },
            { label: '剔除音轨静音输出 (-an)', value: 'mute' }
          ]
        },
        {
          id: 'wb-gpu',
          label: 'GPU 硬件加速',
          type: 'toggle',
          value: gpuAccel,
          onChange: val => setGpuAccel(Boolean(val))
        },
        {
          id: 'wb-outdir',
          label: '输出位置',
          type: 'info',
          value: `源同级目录 (*_ztools.${outputContainer})`
        }
      ],
      previewCard: {
        title: '批量转码体积与收益预估',
        badge: `预计省 ${savePercent}%`,
        subtitle: `当前管线: ${activePreset.title}`,
        metrics: [
          { label: '原始总体积', value: formatBytes(totalBytes) },
          { label: '预计输出体积', value: `~${formatBytes(estimatedOutBytes)}` },
          { label: '预计释放空间', value: formatBytes(totalSaved) },
          { label: '已选待处理', value: `${checkedIds.length} / ${files.length} 项` }
        ]
      }
    },
    subList: {
      title: `待处理视频文件队列 (按体积降序，勾选或按 ↵ 立即开始批量转码)`,
      subtitle: `${filteredFiles.length} 项 · 原始 ${formatBytes(allTotalBytes)} → 预计 ~${formatBytes(estimatedOutBytes)}`,
      checkable: filteredFiles.length > 0,
      checked:
        filteredFiles.length > 0 && filteredFiles.every(f => checkedIds.includes(f.id))
          ? true
          : filteredFiles.some(f => checkedIds.includes(f.id))
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        setCheckedIds(checked ? filteredFiles.map(f => f.id) : [])
      },
      emptyText: '当前未找到匹配的视频文件',
      items: rightQueueItems
    },
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
      List.Section({
        title: `本机目录视频媒体队列 (${filteredFiles.length})`,
        children: rightQueueItems
      }),
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
            actions: ActionPanel({
              title: p.title,
              children: [
                Action({
                  title: '设为当前激活工坊模式',
                  icon: Icon.CheckCircle,
                  onAction: () => {
                    setActiveModeId(p.id)
                  }
                })
              ]
            })
          })
        )
      })
    ]
  })
}
