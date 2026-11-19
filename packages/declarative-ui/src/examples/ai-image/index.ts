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
  AI_IMAGE_ENGINES,
  AI_IMAGE_IMPORT_RULES,
  AI_IMAGE_SUPPORTED_TEXT,
  AiImageFileItem,
  estimateTargetResolution,
  formatBytes,
  openAiImageLocation,
  runAiImageBatch,
  toAiImageFileItem
} from './logic.js'

export * from './logic.js'

export function AiImageCommand() {
  const [searchText, setSearchText] = useState('')
  const [activeEngineId, setActiveEngineId] = useState<string>(AI_IMAGE_ENGINES[0].id)
  const [scaleFactor, setScaleFactor] = useState<'1x' | '2x' | '4x'>('2x')
  const [denoiseStrength, setDenoiseStrength] = useState<'light' | 'standard' | 'strong'>('standard')
  const [outputFormat, setOutputFormat] = useState<'png' | 'webp' | 'jpg'>('png')
  const [gpuAccel, setGpuAccel] = useState<boolean>(true)
  const [isRunning, setIsRunning] = useState(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<AiImageFileItem>({
    rules: AI_IMAGE_IMPORT_RULES,
    toItem: (file, idx) => toAiImageFileItem(file, idx),
    pathOf: f => f.path,
    idOf: f => f.id,
    fileTitle: '选择要处理的图片文件',
    folderTitle: '选择包含图片的文件夹',
    filterName: '图片文件',
    supportedText: AI_IMAGE_SUPPORTED_TEXT,
    defaultChecked: true,
    isBusy: () => runningRef.current,
    dropTitle: '拖入图片或文件夹',
    dropSubtitle: '文件夹内 5 层以内的图片会自动导入'
  })

  const engines = AI_IMAGE_ENGINES
  const activeEngine = engines.find(e => e.id === activeEngineId) || AI_IMAGE_ENGINES[0]

  async function handleRunBatchChecked() {
    const selected = queue.items.filter(f => queue.checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的图片文件' })
      return
    }
    const sampleOutRes = estimateTargetResolution(selected[0].width, selected[0].height, scaleFactor)
    const ok = await confirmAlert({
      title: `确认对 ${selected.length} 张图片执行「${activeEngine.title}」？`,
      message: `模型: ${activeEngine.modelName} · 倍率: ${scaleFactor} (${sampleOutRes}) · 格式: .${outputFormat}`,
      primaryAction: { title: '开始批量 AI 增强', style: 'default' }
    })
    if (!ok) return

    runningRef.current = true
    setIsRunning(true)
    try {
      const res = await runAiImageBatch(selected, {
        engineId: activeEngine.id,
        scaleFactor,
        denoiseStrength,
        outputFormat,
        gpuAccel
      })
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: 'AI 图像处理失败', message: res.error || '推理引擎返回异常' })
        return
      }
      showToast({
        style: Toast.Style.Success,
        title: `已完成 ${res.processedCount} 张图片 AI 推理任务`,
        message: `${activeEngine.tag} -> ${res.targetResolution} (.${res.outputFormat})`
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

  const sampleWidth = selectedFiles[0]?.width || 1920
  const sampleHeight = selectedFiles[0]?.height || 1080
  const previewOutResolution = estimateTargetResolution(sampleWidth, sampleHeight, scaleFactor)

  const maxImgBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = queue.checkedIds.includes(f.id)
    const outRes = estimateTargetResolution(f.width, f.height, scaleFactor)
    const volRatio = f.sizeBytes > 0 ? Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxImgBytes) * 100))) : 0

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.width}×${f.height} -> ${outRes} (.${outputFormat.toUpperCase()})`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => queue.toggleCheck(f.id, c),
      icon: { source: Icon.Image },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: `${f.width}×${f.height} -> ${outRes}` } },
        { text: f.sizeBytes > 0 ? formatBytes(f.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({ title: `开始批量 AI 处理 (${selectedFiles.length}项)`, icon: Icon.Bolt, onAction: handleRunBatchChecked }),
          Action({ title: '在资源管理器定位', icon: Icon.Folder, onAction: () => { void openAiImageLocation(f.path) } }),
          Action({
            title: `仅对当前图片执行「${activeEngine.tag}」`,
            icon: Icon.Play,
            onAction: async () => {
              const res = await runAiImageBatch([f], {
                engineId: activeEngine.id,
                scaleFactor,
                denoiseStrength,
                outputFormat,
                gpuAccel
              })
              if (!res.ok) {
                showToast({ style: Toast.Style.Failure, title: `处理 ${f.name} 失败`, message: res.error || '推理引擎返回异常' })
                return
              }
              showToast({ style: Toast.Style.Success, title: `已处理 ${f.name}`, message: `输出分辨率 ${res.targetResolution}` })
            }
          }),
          Action({
            title: '复制等效 ONNX 推理命令行',
            icon: Icon.Terminal,
            onAction: async () => {
              const cmd = `realesrgan-ncnn-vulkan -i "${f.path}" -o "${f.path.replace(/(\.[^.]+)$/, `_${scaleFactor}.${outputFormat}`)}" -n ${activeEngine.modelName}`
              await Clipboard.copy(cmd)
              showToast({ style: Toast.Style.Success, title: '已复制 AI 推理命令' })
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
      ? '尚未添加图片 · 可选择文件、文件夹，或直接拖入'
      : `已选 ${selectedFiles.length}/${queue.items.length} 张图片 (${formatBytes(totalBytes)}) · 引擎: ${activeEngine.tag} · 输出 ${previewOutResolution} · 清空列表 Ctrl+Shift+Backspace`

  return List({
    ...queue.fileInputProps,
    searchBarPlaceholder: '搜索队列图片文件、目录或 AI 视觉模型 (Real-ESRGAN / Anime4K / RMBG 抠图)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading: isRunning || queue.isImporting,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 5 大 AI 视觉引擎',
      value: activeEngineId,
      onChange: val => setActiveEngineId(val),
      children: AI_IMAGE_ENGINES.map(e => List.Dropdown.Item({ title: `引擎: ${e.tag}`, value: e.id }))
    }),
    filterBar: FilterBar({ summaryText, actions: queue.topBarActions }),
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    workbenchPanel: {
      title: 'AI 图像超分与抠图参数工作台',
      subtitle: gpuAccel ? 'Vulkan / CUDA 硬件加速' : 'CPU 本地离线推理',
      fields: [
        {
          id: 'wb-scale-factor',
          label: '超分放大倍率',
          type: 'select',
          value: scaleFactor,
          onChange: val => setScaleFactor(val as typeof scaleFactor),
          options: [
            { label: '2x 双倍放大 (标准超分)', value: '2x' },
            { label: '4x 四倍超清 (4K/8K 印刷级)', value: '4x' },
            { label: '1x 原尺寸修复 / 去背景', value: '1x' }
          ]
        },
        {
          id: 'wb-denoise',
          label: '边缘抗锯齿与降噪强度',
          type: 'select',
          value: denoiseStrength,
          onChange: val => setDenoiseStrength(val as typeof denoiseStrength),
          options: [
            { label: '轻度 (保留胶片颗粒感)', value: 'light' },
            { label: '标准 (平衡纹理与平滑度)', value: 'standard' },
            { label: '强力 (消除重度 JPEG 噪点)', value: 'strong' }
          ]
        },
        {
          id: 'wb-output-format',
          label: '输出图像格式',
          type: 'select',
          value: outputFormat,
          onChange: val => setOutputFormat(val as typeof outputFormat),
          options: [
            { label: 'PNG 透明通道 (无损 Alpha)', value: 'png' },
            { label: 'WebP 高清 (体积省 65%)', value: 'webp' },
            { label: 'JPG 标准兼容 (95% 质量)', value: 'jpg' }
          ]
        },
        {
          id: 'wb-gpu-accel',
          label: 'GPU Vulkan/CUDA 加速',
          type: 'toggle',
          value: gpuAccel,
          onChange: val => setGpuAccel(Boolean(val))
        },
        {
          id: 'wb-outdir',
          label: '输出位置',
          type: 'info',
          value: `源同级目录 (*_${scaleFactor}.${outputFormat})`
        }
      ],
      previewCard: {
        title: 'AI 视觉推理产出预估',
        badge: `${scaleFactor} 超分`,
        subtitle: `当前模型: ${activeEngine.modelName}`,
        metrics: [
          { label: '预计输出分辨率', value: previewOutResolution },
          { label: '队列图片数', value: `${selectedFiles.length} / ${queue.items.length} 张` },
          { label: '显存加速状态', value: gpuAccel ? 'Vulkan 已启用' : 'CPU 模式' },
          { label: '原始总体积', value: formatBytes(totalBytes) }
        ]
      }
    },
    subList: {
      title: '待处理图片文件队列 (勾选或按 Enter 立即开始批量 AI 增强)',
      subtitle: `${filteredFiles.length} 张图片 · 目标规格: ${previewOutResolution} (.${outputFormat.toUpperCase()})`,
      checkable: filteredFiles.length > 0,
      checked: allVisibleChecked ? true : filteredFiles.some(f => queue.checkedIds.includes(f.id)) ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(filteredFiles),
      emptyText: '尚未添加图片，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      items: rightQueueItems
    },
    children: rightQueueItems.length > 0 ? [List.Section({ title: `待处理图片队列 (${filteredFiles.length})`, children: rightQueueItems })] : []
  })
}

export default AiImageCommand
