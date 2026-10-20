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
  AI_IMAGE_ENGINES,
  INITIAL_AI_IMAGE_FILES,
  AiImageEnginePreset,
  AiImageFileItem,
  estimateTargetResolution,
  fetchAiImageWorkspace,
  formatBytes,
  openAiImageLocation,
  runAiImageBatch
} from './logic.js'
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'

export function AiImageCommand() {
  const [searchText, setSearchText] = useState('')
  const [activeEngineId, setActiveEngineId] = useState<string>(AI_IMAGE_ENGINES[0].id)
  const [scaleFactor, setScaleFactor] = useState<'1x' | '2x' | '4x'>('2x')
  const [denoiseStrength, setDenoiseStrength] = useState<'light' | 'standard' | 'strong'>('standard')
  const [outputFormat, setOutputFormat] = useState<'png' | 'webp' | 'jpg'>('png')
  const [gpuAccel, setGpuAccel] = useState<boolean>(true)
  const isRealHost = isRealElectronHost()
  const initialFiles = isRealHost ? [] : INITIAL_AI_IMAGE_FILES
  const [files, setFiles] = useState<AiImageFileItem[]>(initialFiles)
  const [checkedIds, setCheckedIds] = useState<string[]>(initialFiles.map(f => f.id))
  const [engines, setEngines] = useState<AiImageEnginePreset[]>(AI_IMAGE_ENGINES)
  const [, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchAiImageWorkspace()
      setFiles(ws.files)
      setCheckedIds(ws.files.map(f => f.id))
      setEngines(ws.engines)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'AI 图像工作台已刷新',
          message: `已就绪 ${ws.files.length} 张本机图片 · 5 大 AI 视觉引擎就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeEngine = engines.find(e => e.id === activeEngineId) || AI_IMAGE_ENGINES[0]

  async function handleRunBatchChecked() {
    const selected = files.filter(f => checkedIds.includes(f.id))
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
      message: `${activeEngine.tag} → ${res.targetResolution} (.${res.outputFormat})`
    })
  }

  const selectedFiles = files.filter(f => checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )

  const sampleWidth = selectedFiles[0]?.width || 1920
  const sampleHeight = selectedFiles[0]?.height || 1080
  const previewOutResolution = estimateTargetResolution(sampleWidth, sampleHeight, scaleFactor)

  const maxImgBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = checkedIds.includes(f.id)
    const outRes = estimateTargetResolution(f.width, f.height, scaleFactor)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxImgBytes) * 100)))

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.width}×${f.height} → ${outRes} (.${outputFormat.toUpperCase()})`,
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
        source: Icon.Image
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `${f.width}×${f.height} → ${outRes}`
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `开始批量 AI 处理 (${checkedIds.length}项)`,
            icon: Icon.Bolt,
            onAction: handleRunBatchChecked
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openAiImageLocation(f.path)
            }
          }),
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
                showToast({
                  style: Toast.Style.Failure,
                  title: `处理 ${f.name} 失败`,
                  message: res.error || '推理引擎返回异常'
                })
                return
              }
              showToast({
                style: Toast.Style.Success,
                title: `已处理 ${f.name}`,
                message: `输出分辨率 ${res.targetResolution}`
              })
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
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索队列图片文件、目录或 AI 视觉模型 (Real-ESRGAN / Anime4K / RMBG 抠图)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 5 大 AI 视觉引擎',
      value: activeEngineId,
      onChange: val => setActiveEngineId(val),
      children: AI_IMAGE_ENGINES.map(e =>
        List.Dropdown.Item({
          title: `引擎: ${e.tag}`,
          value: e.id
        })
      )
    }),
    filterBar: FilterBar({
      summaryText: `队列已选 ${checkedIds.length}/${files.length} 张图片 (${formatBytes(totalBytes)}) · 引擎: ${activeEngine.tag} · 预计输出分辨率 ${previewOutResolution}`,
      actions: [
        {
          id: 'rescan-ai-image',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: 'AI 图像超分与抠图参数工作台',
      subtitle: gpuAccel ? 'Vulkan / CUDA 硬件加速' : 'CPU 本地离线推理',
      fields: [
        {
          id: 'wb-scale-factor',
          label: '超分放大倍率',
          type: 'select',
          value: scaleFactor,
          onChange: val => setScaleFactor(val as any),
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
          onChange: val => setDenoiseStrength(val as any),
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
          onChange: val => setOutputFormat(val as any),
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
          { label: '队列图片数', value: `${checkedIds.length} / ${files.length} 张` },
          { label: '显存加速状态', value: gpuAccel ? 'Vulkan 已启用' : 'CPU 模式' },
          { label: '原始总体积', value: formatBytes(totalBytes) }
        ]
      }
    },
    subList: {
      title: '待处理图片文件队列 (按体积降序，勾选或按 ↵ 立即开始批量 AI 增强)',
      subtitle: `${filteredFiles.length} 张图片 · 目标规格: ${previewOutResolution} (.${outputFormat.toUpperCase()})`,
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
      emptyText: '当前未找到匹配的图片文件',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `本机待处理图片队列 (${filteredFiles.length})`,
        children: rightQueueItems
      })
    ]
  })
}

export default AiImageCommand

