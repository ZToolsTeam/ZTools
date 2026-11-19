import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useRef,
  showToast,
  Toast,
  confirmAlert,
  FilterBar
} from '../../index.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  AI_VIDEO_IMPORT_RULES,
  AI_VIDEO_MODELS,
  AI_VIDEO_SUPPORTED_TEXT,
  AiVideoFileItem,
  formatBytes,
  openAiVideoLocation,
  runAiVideoBatch,
  toAiVideoFileItem
} from './logic.js'

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
  const [isRunning, setIsRunning] = useState(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<AiVideoFileItem>({
    rules: AI_VIDEO_IMPORT_RULES,
    toItem: (file, idx) => toAiVideoFileItem(file, idx),
    pathOf: f => f.path,
    idOf: f => f.id,
    fileTitle: '选择要增强的视频文件',
    folderTitle: '选择包含视频的文件夹',
    filterName: '视频文件',
    supportedText: AI_VIDEO_SUPPORTED_TEXT,
    defaultChecked: true,
    isBusy: () => runningRef.current,
    dropTitle: '拖入视频或文件夹',
    dropSubtitle: '文件夹内 5 层以内的视频会自动导入'
  })

  const models = AI_VIDEO_MODELS
  const activeModel = models.find(m => m.id === activeModelId) || AI_VIDEO_MODELS[0]

  async function handleRunBatchChecked() {
    const selected = queue.items.filter(f => queue.checkedIds.includes(f.id))
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

    runningRef.current = true
    setIsRunning(true)
    try {
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
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  const selectedFiles = queue.items.filter(f => queue.checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = queue.items.filter(f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
  const allVisibleChecked = filteredFiles.length > 0 && filteredFiles.every(f => queue.checkedIds.includes(f.id))

  const maxVidBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = queue.checkedIds.includes(f.id)
    const volRatio = f.sizeBytes > 0 ? Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxVidBytes) * 100))) : 0
    const outFpsStr = targetFps === 'source' ? `${f.sourceFps}fps` : targetFps.toUpperCase()
    const outResShort = targetResolution === '4k_2160p' ? '4K' : targetResolution === '2k_1440p' ? '2K' : '1080P'

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.sourceResolution} ${f.sourceFps}fps -> ${outResShort} ${outFpsStr}`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => queue.toggleCheck(f.id, c),
      icon: { source: Icon.Video },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: `-> ${outResShort} · ${outFpsStr}` } },
        { text: f.sizeBytes > 0 ? formatBytes(f.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({ title: `开始批量 AI 视频增强 (${selectedFiles.length}项)`, icon: Icon.Bolt, onAction: handleRunBatchChecked }),
          Action({ title: '在资源管理器定位', icon: Icon.Folder, onAction: () => { void openAiVideoLocation(f.path) } }),
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
                showToast({ style: Toast.Style.Failure, title: `增强 ${f.name} 失败`, message: res.error || '推理引擎返回异常' })
                return
              }
              showToast({ style: Toast.Style.Success, title: `已启动 ${f.name} AI 补帧与超分`, message: `${activeModel.tag} (${outResShort} ${outFpsStr})` })
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
          }),
          buildListManagementSection({
            canRemove: !isRunning,
            onRemove: () => queue.removeItem(f.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(filteredFiles),
            allSelected: allVisibleChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加视频 · 可选择文件、文件夹，或直接拖入'
      : `已选 ${selectedFiles.length}/${queue.items.length} 个视频 (${formatBytes(totalBytes)}) · 模型: ${activeModel.tag} · 清空列表 Ctrl+Shift+Backspace`

  return List({
    ...queue.fileInputProps,
    searchBarPlaceholder: '搜索待增强视频、目录或 AI 视频模型 (RIFE 60fps / 120fps / Real-CUGAN 4K)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading: isRunning || queue.isImporting,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 4 大 AI 视频模型',
      value: activeModelId,
      onChange: val => setActiveModelId(val),
      children: AI_VIDEO_MODELS.map(m => List.Dropdown.Item({ title: `模型: ${m.tag}`, value: m.id }))
    }),
    filterBar: FilterBar({ summaryText, actions: queue.topBarActions }),
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    workbenchPanel: {
      title: 'AI 视频补帧与超分工作台',
      subtitle: `${activeModel.modelEngine} · ${videoEncoder.toUpperCase()}`,
      fields: [
        {
          id: 'wb-target-fps',
          label: '目标帧率',
          type: 'select',
          value: targetFps,
          onChange: val => setTargetFps(val as typeof targetFps),
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
          onChange: val => setTargetResolution(val as typeof targetResolution),
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
          onChange: val => setVideoEncoder(val as typeof videoEncoder),
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
          { label: '已选队列', value: `${selectedFiles.length} / ${queue.items.length} 项` }
        ]
      }
    },
    subList: {
      title: '待增强视频文件队列 (勾选或按 Enter 立即开始 AI 补帧与超分)',
      subtitle: `${filteredFiles.length} 项 · 原始 ${formatBytes(totalBytes)} · 目标 ${RES_LABEL_MAP[targetResolution]} @ ${FPS_LABEL_MAP[targetFps]}`,
      checkable: filteredFiles.length > 0,
      checked: allVisibleChecked ? true : filteredFiles.some(f => queue.checkedIds.includes(f.id)) ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(filteredFiles),
      emptyText: '尚未添加视频，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      items: rightQueueItems
    },
    children: rightQueueItems.length > 0 ? [List.Section({ title: `待增强视频队列 (${filteredFiles.length})`, children: rightQueueItems })] : []
  })
}

export default AiVideoCommand
