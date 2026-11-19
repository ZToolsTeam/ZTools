import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
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
  AUDIO_WORKSHOP_MODES,
  BATCH_AUDIO_IMPORT_RULES,
  BATCH_AUDIO_SUPPORTED_TEXT,
  RealAudioFileItem,
  formatBytes,
  invokeNativeCapability,
  openAudioFileLocation,
  toRealAudioFileItem
} from './logic.js'

export * from './logic.js'

const FORMAT_RATIO_MAP: Record<string, number> = {
  mp3_320k: 0.24,
  flac_lossless: 0.58,
  wav_pcm: 1.0,
  aac_256k: 0.20,
  m4a_aac: 0.22,
  ogg_vorbis: 0.19
}

const LOUDNESS_LABELS: Record<string, string> = {
  lufs_16: '-16 LUFS (播客标准)',
  lufs_14: '-14 LUFS (流媒体标准)',
  lufs_23: '-23 LUFS (EBU 广播)',
  keep_raw: '保持原响度'
}

const MAX_MERGE_FILES = 100
const MAX_MERGE_BYTES = 2 * 1024 * 1024 * 1024

export function BatchAudioCommand() {
  const [searchText, setSearchText] = useState('')
  const [activeModeId, setActiveModeId] = useState<string>(AUDIO_WORKSHOP_MODES[0].id)
  const [audioProfile, setAudioProfile] = useState<'studio_48k' | 'cd_44k' | 'podcast_mono' | 'lossless_flac'>('studio_48k')
  const [outputFormat, setOutputFormat] = useState<'mp3_320k' | 'flac_lossless' | 'wav_pcm' | 'aac_256k' | 'm4a_aac' | 'ogg_vorbis'>('mp3_320k')
  const [loudnessTarget, setLoudnessTarget] = useState<'lufs_16' | 'lufs_14' | 'lufs_23' | 'keep_raw'>('lufs_16')
  const [sampleRateMode, setSampleRateMode] = useState<'48000' | '44100' | 'source'>('48000')
  const [stripSilence, setStripSilence] = useState<boolean>(true)
  const [afftdnDenoise, setAfftdnDenoise] = useState<boolean>(false)
  const [isRunning, setIsRunning] = useState(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<RealAudioFileItem>({
    rules: BATCH_AUDIO_IMPORT_RULES,
    toItem: (file, idx) => toRealAudioFileItem(file, idx),
    pathOf: f => f.path,
    idOf: f => f.id,
    fileTitle: '选择音频文件',
    folderTitle: '选择包含音频的文件夹',
    filterName: '音频文件',
    supportedText: BATCH_AUDIO_SUPPORTED_TEXT,
    defaultChecked: true,
    isBusy: () => runningRef.current,
    dropTitle: '拖入音频文件或文件夹',
    dropSubtitle: '文件夹内 5 层以内的音频会自动导入'
  })

  const presets = AUDIO_WORKSHOP_MODES
  const activePreset = presets.find(p => p.id === activeModeId) || AUDIO_WORKSHOP_MODES[0]
  const ratio = FORMAT_RATIO_MAP[outputFormat] ?? 0.24
  const outExt = outputFormat.split('_')[0] || 'mp3'

  async function handleRunBatchChecked() {
    const selected = queue.items.filter(f => queue.checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的音频文件' })
      return
    }
    const selectedSize = selected.reduce((sum, f) => sum + f.sizeBytes, 0)
    if (activePreset.method === 'BatchMergeAudio' && (selected.length > MAX_MERGE_FILES || selectedSize > MAX_MERGE_BYTES)) {
      showToast({ style: Toast.Style.Failure, title: '合并超出上限', message: '单次合并最多支持 100 个文件且总大小不超过 2 GiB' })
      return
    }
    const ok = await confirmAlert({
      title: `确认对 ${selected.length} 首音频执行「${activePreset.title}」？`,
      message: `声学滤镜管线: ${activePreset.ffmpegFilter || activePreset.method}\n输出格式: .${outExt} · 响度: ${LOUDNESS_LABELS[loudnessTarget]} · 采样率: ${sampleRateMode === 'source' ? '原采样' : sampleRateMode + 'Hz'}`,
      primaryAction: { title: '开始批量处理', style: 'default' }
    })
    if (!ok) return

    runningRef.current = true
    setIsRunning(true)
    try {
      let count = 0
      let lastErr = ''
      for (const f of selected) {
        const res = await invokeNativeCapability(activePreset.method, {
          ...activePreset.params,
          audioProfile,
          format: outExt,
          preset: outputFormat,
          outputFormat: outExt,
          loudnessTarget,
          sampleRateMode,
          stripSilence,
          afftdnDenoise,
          inputPath: f.path
        })
        if (res.ok) count += 1
        else lastErr = res.error || '音频处理调用失败'
      }
      if (count === 0) {
        showToast({ style: Toast.Style.Failure, title: '批量音频处理未执行成功', message: lastErr })
        return
      }
      showToast({ style: Toast.Style.Success, title: `已提交 ${count} 首音频批处理任务`, message: activePreset.title })
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  async function handleRunPreset(preset: typeof activePreset, targetFile?: RealAudioFileItem) {
    try {
      const payload = targetFile
        ? { ...preset.params, format: outExt, preset: outputFormat, inputPath: targetFile.path }
        : { ...preset.params, format: outExt, preset: outputFormat }
      const res = await invokeNativeCapability(preset.method, payload)
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: '音频处理失败', message: res.error || '原生模块返回错误' })
        return
      }
      showToast({ style: Toast.Style.Success, title: '音频批处理指令已下发', message: `${preset.title}${targetFile ? ` (${targetFile.name})` : ''}` })
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: '参数拦截', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const selectedFiles = queue.items.filter(f => queue.checkedIds.includes(f.id))
  const totalBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const estimatedOutBytes = Math.round(totalBytes * ratio)

  const q = searchText.trim().toLowerCase()
  const filteredFiles = queue.items.filter(f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
  const filteredPresets = presets.filter(
    p => !q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  )
  const allVisibleChecked = filteredFiles.length > 0 && filteredFiles.every(f => queue.checkedIds.includes(f.id))

  const maxAudioBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = queue.checkedIds.includes(f.id)
    const estOut = Math.round(f.sizeBytes * ratio)
    const volRatio = f.sizeBytes > 0 ? Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxAudioBytes) * 100))) : 0

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.extension.toUpperCase()} -> .${outExt.toUpperCase()} (~${formatBytes(estOut)})`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => queue.toggleCheck(f.id, c),
      icon: { source: Icon.Music },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: `-> .${outExt.toUpperCase()} ~${formatBytes(estOut)}` } },
        { text: f.sizeBytes > 0 ? formatBytes(f.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({ title: `开始批量处理 (${selectedFiles.length}项)`, icon: Icon.Bolt, onAction: handleRunBatchChecked }),
          Action({ title: '在资源管理器中定位文件', icon: Icon.Folder, onAction: () => { void openAudioFileLocation(f.path) } }),
          Action({ title: `仅对当前音轨执行「${activePreset.tag}」`, icon: Icon.Play, onAction: () => handleRunPreset(activePreset, f) }),
          Action({
            title: '复制等效 FFmpeg 声学命令',
            icon: Icon.Terminal,
            onAction: async () => {
              const cmd = `ffmpeg -i "${f.path}" ${activePreset.ffmpegFilter || ''} "${f.path.replace(/(\.[^.]+)$/, `_out.${outExt}`)}"`
              await Clipboard.copy(cmd)
              showToast({ style: Toast.Style.Success, title: '已复制 FFmpeg 音频命令' })
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
      ? '尚未添加文件 · 可选择音频文件、文件夹，或直接拖入'
      : `已选 ${selectedFiles.length}/${queue.items.length} 首音频 (${formatBytes(totalBytes)}) · 预计输出 ~${formatBytes(estimatedOutBytes)} · 清空列表 Ctrl+Shift+Backspace`

  return List({
    ...queue.fileInputProps,
    searchBarPlaceholder: '搜索音频文件、12 大声学处理模式或输出格式 (MP3 / FLAC / -16 LUFS / 静音切除 / 降噪)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading: isRunning || queue.isImporting,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 12 大音频处理预设模式',
      value: activeModeId,
      onChange: val => setActiveModeId(val),
      children: AUDIO_WORKSHOP_MODES.map(m => List.Dropdown.Item({ title: `预设: ${m.tag}`, value: m.id }))
    }),
    filterBar: FilterBar({ summaryText, actions: queue.topBarActions }),
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    workbenchPanel: {
      title: '音频声学与转码参数工作台',
      subtitle: stripSilence || afftdnDenoise ? 'EBU R128 + 降噪切静音管线' : 'FFmpeg 高精度声学管线',
      fields: [
        {
          id: 'wb-output-format',
          label: '输出格式',
          type: 'select',
          value: outputFormat,
          onChange: val => setOutputFormat(val as typeof outputFormat),
          options: [
            { label: 'MP3 320k (全平台高音质)', value: 'mp3_320k' },
            { label: 'FLAC 无损 (Level 8 归档)', value: 'flac_lossless' },
            { label: 'WAV PCM (未压缩母带)', value: 'wav_pcm' },
            { label: 'AAC 256k (流媒体高效)', value: 'aac_256k' },
            { label: 'M4A (Apple ALAC/AAC)', value: 'm4a_aac' },
            { label: 'OGG Vorbis (游戏音轨)', value: 'ogg_vorbis' }
          ]
        },
        {
          id: 'wb-audio-profile',
          label: '音质档位',
          type: 'select',
          value: audioProfile,
          onChange: val => setAudioProfile(val as typeof audioProfile),
          options: [
            { label: '录音室级 (48kHz / 320kbps)', value: 'studio_48k' },
            { label: '标准 CD 级 (44.1kHz / 256kbps)', value: 'cd_44k' },
            { label: '母带无损 (FLAC 24-bit)', value: 'lossless_flac' },
            { label: '播客语音优化 (单声道 -16 LUFS)', value: 'podcast_mono' }
          ]
        },
        {
          id: 'wb-loudness',
          label: '响度标准',
          type: 'select',
          value: loudnessTarget,
          onChange: val => setLoudnessTarget(val as typeof loudnessTarget),
          options: [
            { label: 'EBU R128 -16 LUFS 播客', value: 'lufs_16' },
            { label: '-14 LUFS 流媒体平台', value: 'lufs_14' },
            { label: '-23 LUFS 广电标准', value: 'lufs_23' },
            { label: '保持原响度 (不均衡)', value: 'keep_raw' }
          ]
        },
        {
          id: 'wb-samplerate',
          label: '采样率',
          type: 'select',
          value: sampleRateMode,
          onChange: val => setSampleRateMode(val as typeof sampleRateMode),
          options: [
            { label: '48kHz (影视录音室级)', value: '48000' },
            { label: '44.1kHz (CD 标准音乐)', value: '44100' },
            { label: '保持原采样率', value: 'source' }
          ]
        },
        {
          id: 'wb-strip-silence',
          label: '首尾静音自动切除',
          type: 'toggle',
          value: stripSilence,
          onChange: val => setStripSilence(Boolean(val))
        },
        {
          id: 'wb-afftdn',
          label: '频谱降噪 afftdn',
          type: 'toggle',
          value: afftdnDenoise,
          onChange: val => setAfftdnDenoise(Boolean(val))
        },
        {
          id: 'wb-outdir',
          label: '输出位置',
          type: 'info',
          value: `源同级目录 (*_ztools.${outExt})`
        }
      ],
      previewCard: {
        title: '声学处理与输出体积预估',
        badge: LOUDNESS_LABELS[loudnessTarget] || '-16 LUFS',
        subtitle: `当前引擎: ${activePreset.title}`,
        metrics: [
          { label: '原始总大小', value: formatBytes(totalBytes) },
          { label: '预计输出大小', value: `~${formatBytes(estimatedOutBytes)}` },
          { label: '目标响度', value: LOUDNESS_LABELS[loudnessTarget] || '-16 LUFS' },
          { label: '已选音频数', value: `${selectedFiles.length} / ${queue.items.length} 首` }
        ]
      }
    },
    subList: {
      title: '待处理音频文件队列 (勾选或按 Enter 立即开始声学批处理)',
      subtitle: `${filteredFiles.length} 首 · 原始 ${formatBytes(totalBytes)} -> 预计 ~${formatBytes(estimatedOutBytes)}`,
      checkable: filteredFiles.length > 0,
      checked: allVisibleChecked ? true : filteredFiles.some(f => queue.checkedIds.includes(f.id)) ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(filteredFiles),
      emptyText: '尚未添加音频文件，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      items: rightQueueItems
    },
    children: [
      ...(rightQueueItems.length > 0
        ? [List.Section({ title: `待处理音频与媒体队列 (${filteredFiles.length})`, children: rightQueueItems })]
        : []),
      List.Section({
        title: `12 大核心音频处理与声学工坊模式 (${filteredPresets.length})`,
        children: filteredPresets.map(p =>
          List.Item({
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            icon: { source: Icon.SpeakerHigh, tintColor: Color.SecondaryText },
            accessories: [{ tag: { value: p.tag } }, { text: p.method }],
            actions: ActionPanel({
              title: p.title,
              children: [
                Action({ title: '设为当前激活声学模式', icon: Icon.CheckCircle, onAction: () => setActiveModeId(p.id) }),
                buildListManagementSection({
                  onPickFiles: queue.handlePickFiles,
                  onPickFolder: queue.handlePickFolder,
                  onClear: queue.clearQueue
                })
              ]
            })
          })
        )
      })
    ]
  })
}

export default BatchAudioCommand
