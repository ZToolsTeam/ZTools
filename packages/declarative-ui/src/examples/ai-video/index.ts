import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  confirmAlert,
  FilterBar
} from '../../index.js'
import {
  AI_VIDEO_MODELS,
  INITIAL_AI_VIDEO_FILES,
  AiVideoFileItem,
  AiVideoModelPreset,
  fetchAiVideoWorkspace,
  formatBytes,
  openAiVideoLocation,
  runAiVideoBatch
} from './logic.js'
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'

const RES_LABEL_MAP: Record<string, string> = {
  '4k_2160p': '4K UHD (3840×2160)',
  '2k_1440p': '2K QHD (2560×1440)',
  '1080p_fhd': '1080P FHD (1920×1080)'
}

const FPS_LABEL_MAP: Record<string, string> = {
  '60fps': '60 FPS 丝滑',
  '120fps': '120 FPS 电竞高刷',
  source: '保持原帧率'
}

export function AiVideoCommand() {
  const [searchText, setSearchText] = useState('')
  const [activeModelId, setActiveModelId] = useState<string>(AI_VIDEO_MODELS[0].id)
  const [targetFps, setTargetFps] = useState<'60fps' | '120fps' | 'source'>('60fps')
  const [targetResolution, setTargetResolution] = useState<'4k_2160p' | '2k_1440p' | '1080p_fhd'>('4k_2160p')
  const [videoEncoder, setVideoEncoder] = useState<'hevc_nvenc' | 'h264' | 'av1'>('hevc_nvenc')
  const [sceneChangeProtection, setSceneChangeProtection] = useState<boolean>(true)
  const isRealHost = isRealElectronHost()
  const initialFiles = isRealHost ? [] : INITIAL_AI_VIDEO_FILES
  const [files, setFiles] = useState<AiVideoFileItem[]>(initialFiles)
  const [checkedIds, setCheckedIds] = useState<string[]>(initialFiles.map(f => f.id))
  const [models, setModels] = useState<AiVideoModelPreset[]>(AI_VIDEO_MODELS)
  const [, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchAiVideoWorkspace()
      setFiles(ws.files)
      setCheckedIds(ws.files.map(f => f.id))
      setModels(ws.models)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'AI 视频工作台已刷新',
          message: `已就绪 ${ws.files.length} 个视频素材 · RIFE / Real-CUGAN 管线就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeModel = models.find(m => m.id === activeModelId) || AI_VIDEO_MODELS[0]

  async function handleRunBatchChecked() {
    const selected = files.filter(f => checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待增强的视频文件' })
      return
    }
    const ok = await confirmAlert({
      title: `确认对 ${selected.length} 个视频执行「${activeModel.title}」？`,
      message: `引擎: ${activeModel.modelEngine} · 帧率: ${FPS_LABEL_MAP[targetFps]} · 分辨率: ${RES_LABEL_MAP[targetResolution]}`,
      primaryAction: { title: '开始批量 AI 视频增强', style: 'default' }
    })
    if (!ok) return

    const res = await runAiVideoBatch(selected, {
      modelId: activeModel.id,
      targetFps,
      targetResolution,
      videoEncoder,
      sceneChangeProtection
    })
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: 'AI 视频增强失败', message: res.error || '推理引擎返回错误' })
      return
    }
    showToast({
      style: Toast.Style.Success,
      title: `已提交 ${res.processedCount} 个 AI 视频增强任务`,
      message: `${activeModel.tag} · ${FPS_LABEL_MAP[targetFps]} · ${RES_LABEL_MAP[targetResolution]}`
    })
  }

  const selectedFiles = files.filter(f => checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )

  const maxVidBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = checkedIds.includes(f.id)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxVidBytes) * 100)))
    const outFpsStr = targetFps === 'source' ? `${f.sourceFps}fps` : targetFps.toUpperCase()
    const outResShort = targetResolution === '4k_2160p' ? '4K' : targetResolution === '2k_1440p' ? '2K' : '1080P'

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.sourceResolution} ${f.sourceFps}fps → ${outResShort} ${outFpsStr}`,
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
        source: Icon.Video
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `→ ${outResShort} · ${outFpsStr}`
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `开始批量 AI 视频增强 (${checkedIds.length}项)`,
            icon: Icon.Bolt,
            onAction: handleRunBatchChecked
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openAiVideoLocation(f.path)
            }
          }),
          Action({
            title: `仅对当前视频执行「${activeModel.tag}」`,
            icon: Icon.Play,
            onAction: async () => {
              const res = await runAiVideoBatch([f], {
                modelId: activeModel.id,
                targetFps,
                targetResolution,
                videoEncoder,
                sceneChangeProtection
              })
              if (!res.ok) {
                showToast({
                  style: Toast.Style.Failure,
                  title: `增强 ${f.name} 失败`,
                  message: res.error || '推理引擎返回异常'
                })
                return
              }
              showToast({
                style: Toast.Style.Success,
                title: `已启动 ${f.name} AI 补帧与超分`,
                message: `${activeModel.tag} (${outResShort} ${outFpsStr})`
              })
            }
          }),
          Action({
            title: '复制等效 RIFE / FFmpeg 管线命令',
            icon: Icon.Terminal,
            onAction: async () => {
              const cmd = `rife-ncnn-vulkan -i "${f.path}" -m ${activeModel.modelEngine} -c ${videoEncoder}`
              await Clipboard.copy(cmd)
              showToast({ style: Toast.Style.Success, title: '已复制 AI 视频推理命令' })
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索待增强视频、目录或 AI 视频模型 (RIFE 60fps / 120fps / Real-CUGAN 4K)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 4 大 AI 视频模型',
      value: activeModelId,
      onChange: val => setActiveModelId(val),
      children: AI_VIDEO_MODELS.map(m =>
        List.Dropdown.Item({
          title: `模型: ${m.tag}`,
          value: m.id
        })
      )
    }),
    filterBar: FilterBar({
      summaryText: `队列已选 ${checkedIds.length}/${files.length} 个视频 (${formatBytes(totalBytes)}) · 模型: ${activeModel.tag} · 输出 ${RES_LABEL_MAP[targetResolution]} @ ${FPS_LABEL_MAP[targetFps]}`,
      actions: [
        {
          id: 'rescan-ai-video',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: 'AI 视频补帧与超分工作台',
      subtitle: `${activeModel.modelEngine} · ${videoEncoder.toUpperCase()}`,
      fields: [
        {
          id: 'wb-target-fps',
          label: '目标帧率',
          type: 'select',
          value: targetFps,
          onChange: val => setTargetFps(val as any),
          options: [
            { label: '60 FPS 丝滑 (2x 光流补帧)', value: '60fps' },
            { label: '120 FPS 电竞高刷 (4x 补帧)', value: '120fps' },
            { label: '保持原帧率 (仅超分降噪)', value: 'source' }
          ]
        },
        {
          id: 'wb-target-res',
          label: '目标分辨率',
          type: 'select',
          value: targetResolution,
          onChange: val => setTargetResolution(val as any),
          options: [
            { label: '4K UHD 2160P (3840×2160)', value: '4k_2160p' },
            { label: '2K 1440P (2560×1440)', value: '2k_1440p' },
            { label: '1080P FHD (1920×1080)', value: '1080p_fhd' }
          ]
        },
        {
          id: 'wb-encoder',
          label: '视频编码器',
          type: 'select',
          value: videoEncoder,
          onChange: val => setVideoEncoder(val as any),
          options: [
            { label: 'HEVC NVENC (H.265 显卡硬编)', value: 'hevc_nvenc' },
            { label: 'H.264 全平台高兼容', value: 'h264' },
            { label: 'AV1 新一代超清编码', value: 'av1' }
          ]
        },
        {
          id: 'wb-scene-protect',
          label: '场景切换防伪影保护',
          type: 'toggle',
          value: sceneChangeProtection,
          onChange: val => setSceneChangeProtection(Boolean(val))
        },
        {
          id: 'wb-outdir',
          label: '输出位置',
          type: 'info',
          value: `源同级目录 (*_${targetFps}_${targetResolution}.mp4)`
        }
      ],
      previewCard: {
        title: '光流补帧与超分产出预估',
        badge: FPS_LABEL_MAP[targetFps] || '60 FPS',
        subtitle: `当前管线: ${activeModel.title}`,
        metrics: [
          { label: '目标帧率', value: FPS_LABEL_MAP[targetFps] || '60 FPS' },
          { label: '目标分辨率', value: RES_LABEL_MAP[targetResolution] || '4K UHD' },
          { label: '硬件编码器', value: videoEncoder.toUpperCase() },
          { label: '已选队列', value: `${checkedIds.length} / ${files.length} 项` }
        ]
      }
    },
    subList: {
      title: '待增强视频文件队列 (按体积降序，勾选或按 ↵ 立即开始 AI 补帧与超分)',
      subtitle: `${filteredFiles.length} 项 · 原始 ${formatBytes(totalBytes)} · 目标 ${RES_LABEL_MAP[targetResolution]} @ ${FPS_LABEL_MAP[targetFps]}`,
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
      emptyText: '当前队列暂无匹配视频',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `本机待增强视频队列 (${filteredFiles.length})`,
        children: rightQueueItems
      })
    ]
  })
}

export default AiVideoCommand

