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
  FilterBar
} from '../../index.js'
import {
  INITIAL_RECORDED_VIDEOS,
  RECORD_SOURCE_MODES,
  RecordSourcePreset,
  RecordedVideoItem,
  estimateMbPerMinute,
  fetchRecordWorkspace,
  formatBytes,
  openRecordFileLocation,
  openRecordedVideo,
  startScreenRecording,
  stopScreenRecording
} from './logic.js'
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'

export function RecordCommand() {
  const [searchText, setSearchText] = useState('')
  const [sourceModeId, setSourceModeId] = useState<string>(RECORD_SOURCE_MODES[0].id)
  const [fps, setFps] = useState<'60' | '30' | '15'>('60')
  const [codecContainer, setCodecContainer] = useState<'mp4_h264' | 'mp4_hevc' | 'gif_hd'>('mp4_h264')
  const [wasapiLoopback, setWasapiLoopback] = useState<boolean>(true)
  const [micMix, setMicMix] = useState<boolean>(false)
  const [cursorHighlight, setCursorHighlight] = useState<boolean>(true)
  const [isRecording, setIsRecording] = useState<boolean>(false)
  const isRealHost = isRealElectronHost()
  const initialRecordings = isRealHost ? [] : INITIAL_RECORDED_VIDEOS
  const [recordings, setRecordings] = useState<RecordedVideoItem[]>(initialRecordings)
  const [checkedIds, setCheckedIds] = useState<string[]>(initialRecordings.map(r => r.id))
  const [sourceModes, setSourceModes] = useState<RecordSourcePreset[]>(RECORD_SOURCE_MODES)
  const [scannedDirs, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRecordWorkspace()
      setRecordings(ws.recordings)
      setCheckedIds(ws.recordings.map(r => r.id))
      setSourceModes(ws.sourceModes)
      setScannedDirs(ws.scannedDirs)
      if (typeof ws.isRecording === 'boolean') {
        setIsRecording(ws.isRecording)
      }
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '录屏工作台已刷新',
          message: `已扫描 ${ws.recordings.length} 个本机录像文件`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeSource = sourceModes.find(s => s.id === sourceModeId) || RECORD_SOURCE_MODES[0]
  const estMbPerMin = estimateMbPerMinute(fps, codecContainer)
  const saveDir = scannedDirs[0] || ''

  async function handleStartRecording() {
    const res = await startScreenRecording({
      sourceModeId,
      fps,
      codecContainer,
      wasapiLoopback,
      micMix,
      cursorHighlight,
      saveDir
    })
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '录制启动失败', message: res.error || res.message })
      return
    }
    setIsRecording(true)
    showToast({
      style: Toast.Style.Success,
      title: res.message,
      message: `保存目录: ${res.saveDir}`
    })
  }

  async function handleStopRecording() {
    const res = await stopScreenRecording()
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '停止录制失败', message: res.error || res.message })
      return
    }
    setIsRecording(false)
    await refreshWorkspace(false)
    showToast({
      style: Toast.Style.Success,
      title: res.message,
      message: res.outputPath || saveDir
    })
  }

  const totalBytes = recordings.reduce((s, r) => s + r.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredRecordings = recordings.filter(
    r => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
  )

  const maxRecBytes = Math.max(1, filteredRecordings[0]?.sizeBytes || 1)
  const rightQueueItems = filteredRecordings.map(item => {
    const isChecked = checkedIds.includes(item.id)
    const volRatio = Math.max(10, Math.min(100, Math.round((item.sizeBytes / maxRecBytes) * 100)))

    return List.Item({
      id: item.id,
      title: item.name,
      subtitle: `${item.parentDir} · 时长 ${item.durationText} · ${item.resolutionText} @ ${item.fps}fps`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => {
        if (c) {
          setCheckedIds(Array.from(new Set([...checkedIds, item.id])))
        } else {
          setCheckedIds(checkedIds.filter(id => id !== item.id))
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
            value: `${item.durationText} · ${item.resolutionText}`
          }
        },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        title: item.name,
        children: [
          isRecording
            ? Action({
                title: '停止屏幕录制并保存',
                icon: Icon.Stop,
                onAction: handleStopRecording
              })
            : Action({
                title: '开始新屏幕录制 / 播放选中录像',
                icon: Icon.Play,
                onAction: handleStartRecording
              }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openRecordFileLocation(item.path)
            }
          }),
          Action({
            title: isRecording ? '重新启动新屏幕录制' : '停止当前屏幕录制并保存',
            icon: isRecording ? Icon.Play : Icon.Stop,
            onAction: () => {
              if (isRecording) {
                return handleStartRecording()
              }
              return handleStopRecording()
            }
          }),
          Action({
            title: '使用默认播放器打开当前录像',
            icon: Icon.Eye,
            onAction: () => {
              openRecordedVideo(item.path)
            }
          }),
          Action({
            title: '复制录像文件完整路径',
            icon: Icon.CopyClipboard,
            onAction: async () => {
              await Clipboard.copy(item.path)
              showToast({ style: Toast.Style.Success, title: '已复制录像文件路径' })
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索已录制视频文件、目录或录制源模式 (60fps / WASAPI 内录 / GIF 直出)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择录制源模式',
      value: sourceModeId,
      onChange: val => setSourceModeId(val),
      children: RECORD_SOURCE_MODES.map(s =>
        List.Dropdown.Item({
          title: `录制源: ${s.tag}`,
          value: s.id
        })
      )
    }),
    filterBar: FilterBar({
      summaryText: `${isRecording ? '正在录制中 · ' : ''}捕获源: ${activeSource.tag} (${activeSource.defaultResolution} @ ${fps}FPS) · 预计 ~${estMbPerMin} MB/分钟 · 已录制队列 ${recordings.length} 项 (${formatBytes(totalBytes)})`,
      actions: [
        {
          id: 'toggle-record-session',
          label: isRecording ? '停止屏幕录制' : '开始屏幕录制',
          title: isRecording ? '停止屏幕录制并保存' : '开始新屏幕录制',
          style: 'primary',
          onAction: () => {
            if (isRecording) {
              void handleStopRecording()
            } else {
              void handleStartRecording()
            }
          }
        },
        {
          id: 'rescan-record',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: '高清屏幕录制参数工作台',
      subtitle: `${activeSource.defaultResolution} · ${fps} FPS · ${wasapiLoopback ? 'WASAPI 内录' : '无音频'}`,
      fields: [
        {
          id: 'wb-rec-fps',
          label: '视频帧率',
          type: 'select',
          value: fps,
          onChange: val => setFps(val as any),
          options: [
            { label: '60 FPS 高刷录制 (丝滑演示)', value: '60' },
            { label: '30 FPS 标准演示 (均衡体积)', value: '30' },
            { label: '15 FPS 轻量教程 (代码/文档)', value: '15' }
          ]
        },
        {
          id: 'wb-rec-codec',
          label: '编码与容器',
          type: 'select',
          value: codecContainer,
          onChange: val => setCodecContainer(val as any),
          options: [
            { label: 'MP4 H.264 硬件编码 (全兼容)', value: 'mp4_h264' },
            { label: 'MP4 HEVC (H.265 高压缩)', value: 'mp4_hevc' },
            { label: '高清 GIF 动图直出', value: 'gif_hd' }
          ]
        },
        {
          id: 'wb-rec-wasapi',
          label: '系统声音内录 WASAPI Loopback',
          type: 'toggle',
          value: wasapiLoopback,
          onChange: val => setWasapiLoopback(Boolean(val))
        },
        {
          id: 'wb-rec-mic',
          label: '麦克风人声混音',
          type: 'toggle',
          value: micMix,
          onChange: val => setMicMix(Boolean(val))
        },
        {
          id: 'wb-rec-cursor',
          label: '显示鼠标点击高亮轨迹',
          type: 'toggle',
          value: cursorHighlight,
          onChange: val => setCursorHighlight(Boolean(val))
        }
      ],
      previewCard: {
        title: '录制规格与磁盘占用预估',
        badge: isRecording ? '录制进行中' : `${fps} FPS`,
        subtitle: `捕获源: ${activeSource.title}`,
        metrics: [
          { label: '目标显示器分辨率', value: activeSource.defaultResolution },
          { label: '预计每分钟体积', value: `~${estMbPerMin} MB/min` },
          { label: '录制保存目录', value: saveDir },
          { label: '已选录像队列', value: `${checkedIds.length} / ${recordings.length} 项` }
        ]
      }
    },
    subList: {
      title: '本机已录制视频文件管理队列 (按体积排序，按 ↵ 立即开始新屏幕录制或管理选中录像)',
      subtitle: `${filteredRecordings.length} 个录像文件 · 总计 ${formatBytes(totalBytes)} · 保存目录: ${saveDir}`,
      checkable: filteredRecordings.length > 0,
      checked:
        filteredRecordings.length > 0 && filteredRecordings.every(r => checkedIds.includes(r.id))
          ? true
          : filteredRecordings.some(r => checkedIds.includes(r.id))
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        setCheckedIds(checked ? filteredRecordings.map(r => r.id) : [])
      },
      emptyText: '当前保存目录暂无已录制视频文件',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `本机已录制视频文件队列 (${filteredRecordings.length})`,
        children: rightQueueItems
      })
    ]
  })
}

export default RecordCommand

