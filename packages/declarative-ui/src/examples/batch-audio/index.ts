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
  FilterBar
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
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'

const INITIAL_SAMPLE_AUDIOS: RealAudioFileItem[] = [
  {
    id: 'aud-init-1',
    name: 'ZTools_Tech_Podcast_Ep42_Master_Raw.wav',
    path: 'D:\\Music\\Podcasts\\ZTools_Tech_Podcast_Ep42_Raw.wav',
    parentDir: 'D:\\Music\\Podcasts',
    extension: '.wav',
    sizeBytes: 186 * 1024 * 1024
  },
  {
    id: 'aud-init-2',
    name: 'Keynote_Voiceover_Recording_48kHz_24bit.flac',
    path: 'D:\\Music\\Voiceovers\\Keynote_Voiceover_Recording_48kHz_24bit.flac',
    parentDir: 'D:\\Music\\Voiceovers',
    extension: '.flac',
    sizeBytes: 94 * 1024 * 1024
  },
  {
    id: 'aud-init-3',
    name: 'Architecture_Review_Meeting_Audio_Track.m4a',
    path: 'C:\\Users\\Geek\\Music\\Meetings\\Architecture_Review_Meeting_Audio_Track.m4a',
    parentDir: 'C:\\Users\\Geek\\Music\\Meetings',
    extension: '.m4a',
    sizeBytes: 68 * 1024 * 1024
  },
  {
    id: 'aud-init-4',
    name: 'Ambient_Focus_Synthwave_Loop_Master.wav',
    path: 'D:\\Music\\Studio\\Ambient_Focus_Synthwave_Loop_Master.wav',
    parentDir: 'D:\\Music\\Studio',
    extension: '.wav',
    sizeBytes: 52 * 1024 * 1024
  },
  {
    id: 'aud-init-5',
    name: 'Customer_Interview_Session_08_Noisy.mp3',
    path: 'C:\\Users\\Geek\\Downloads\\Customer_Interview_Session_08_Noisy.mp3',
    parentDir: 'C:\\Users\\Geek\\Downloads',
    extension: '.mp3',
    sizeBytes: 34 * 1024 * 1024
  },
  {
    id: 'aud-init-6',
    name: 'UI_Sound_Effects_Pack_Uncompressed.flac',
    path: 'D:\\Music\\SFX\\UI_Sound_Effects_Pack_Uncompressed.flac',
    parentDir: 'D:\\Music\\SFX',
    extension: '.flac',
    sizeBytes: 26 * 1024 * 1024
  },
  {
    id: 'aud-init-7',
    name: 'Release_Trailer_Background_Score.aac',
    path: 'D:\\Music\\Scores\\Release_Trailer_Background_Score.aac',
    parentDir: 'D:\\Music\\Scores',
    extension: '.aac',
    sizeBytes: 18 * 1024 * 1024
  },
  {
    id: 'aud-init-8',
    name: 'Weekly_Standup_Voice_Memo_20261018.ogg',
    path: 'C:\\Users\\Geek\\Desktop\\Weekly_Standup_Voice_Memo_20261018.ogg',
    parentDir: 'C:\\Users\\Geek\\Desktop',
    extension: '.ogg',
    sizeBytes: 12 * 1024 * 1024
  }
]

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

export function BatchAudioCommand() {
  const [searchText, setSearchText] = useState('')
  const [activeModeId, setActiveModeId] = useState<string>(AUDIO_WORKSHOP_MODES[0].id)
  const [audioProfile, setAudioProfile] = useState<'studio_48k' | 'cd_44k' | 'podcast_mono' | 'lossless_flac'>('studio_48k')
  const [outputFormat, setOutputFormat] = useState<'mp3_320k' | 'flac_lossless' | 'wav_pcm' | 'aac_256k' | 'm4a_aac' | 'ogg_vorbis'>('mp3_320k')
  const [loudnessTarget, setLoudnessTarget] = useState<'lufs_16' | 'lufs_14' | 'lufs_23' | 'keep_raw'>('lufs_16')
  const [sampleRateMode, setSampleRateMode] = useState<'48000' | '44100' | 'source'>('48000')
  const [stripSilence, setStripSilence] = useState<boolean>(true)
  const [afftdnDenoise, setAfftdnDenoise] = useState<boolean>(false)
  const isRealHost = isRealElectronHost()
  const initialAudios = isRealHost ? [] : INITIAL_SAMPLE_AUDIOS
  const [files, setFiles] = useState<RealAudioFileItem[]>(initialAudios)
  const [checkedIds, setCheckedIds] = useState<string[]>(initialAudios.map(f => f.id))
  const [presets, setPresets] = useState<CapabilityActionItem[]>(AUDIO_WORKSHOP_MODES)
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealAudioWorkspace()
      const audioOnly = ws.files.filter(f => /\.(mp3|flac|wav|aac|m4a|ogg|wma|opus|aiff)$/i.test(f.name))
      const nextFiles = isRealElectronHost()
        ? audioOnly
        : audioOnly.length > 0
          ? audioOnly
          : INITIAL_SAMPLE_AUDIOS
      setFiles(nextFiles)
      setCheckedIds(nextFiles.map(f => f.id))
      setPresets(ws.presets)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '音频工坊已刷新',
          message: `队列就绪 ${nextFiles.length} 首本地音频文件 · 12 大声学引擎就绪`
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
  const ratio = FORMAT_RATIO_MAP[outputFormat] ?? 0.24
  const outExt = outputFormat.split('_')[0] || 'mp3'

  async function handleRunBatchChecked() {
    const selected = files.filter(f => checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的音频文件' })
      return
    }
    const ok = await confirmAlert({
      title: `确认对 ${selected.length} 首音频执行「${activePreset.title}」？`,
      message: `声学滤镜管线: ${activePreset.ffmpegFilter || activePreset.method}\n输出格式: .${outExt} · 响度: ${LOUDNESS_LABELS[loudnessTarget]} · 采样率: ${sampleRateMode === 'source' ? '原采样' : sampleRateMode + 'Hz'}`,
      primaryAction: { title: '开始批量处理', style: 'default' }
    })
    if (!ok) return

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
      if (res.ok) {
        count += 1
      } else {
        lastErr = res.error || '音频处理调用失败'
      }
    }
    if (count === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '批量音频处理未执行成功',
        message: lastErr
      })
      return
    }
    showToast({
      style: Toast.Style.Success,
      title: `已提交 ${count} 首音频批处理任务`,
      message: activePreset.title
    })
  }

  async function handleRunPreset(preset: CapabilityActionItem, targetFile?: RealAudioFileItem) {
    try {
      const payload = targetFile
        ? { ...preset.params, format: outExt, preset: outputFormat, inputPath: targetFile.path }
        : { ...preset.params, format: outExt, preset: outputFormat }
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
  const estimatedOutBytes = Math.round(totalBytes * ratio)

  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(
    p => !q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  )

  const maxAudioBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = checkedIds.includes(f.id)
    const estOut = Math.round(f.sizeBytes * ratio)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxAudioBytes) * 100)))

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · ${f.extension.toUpperCase()} → .${outExt.toUpperCase()} (~${formatBytes(estOut)})`,
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
        source: Icon.Music
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `→ .${outExt.toUpperCase()} ~${formatBytes(estOut)}`
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `开始批量处理 (${checkedIds.length}项)`,
            icon: Icon.Bolt,
            onAction: handleRunBatchChecked
          }),
          Action({
            title: '在资源管理器中定位文件',
            icon: Icon.Folder,
            onAction: () => {
              openAudioFileLocation(f.path)
            }
          }),
          Action({
            title: `仅对当前音轨执行「${activePreset.tag}」`,
            icon: Icon.Play,
            onAction: () => handleRunPreset(activePreset, f)
          }),
          Action({
            title: '复制等效 FFmpeg 声学命令',
            icon: Icon.Terminal,
            onAction: async () => {
              const cmd = `ffmpeg -i "${f.path}" ${activePreset.ffmpegFilter || ''} "${f.path.replace(/(\.[^.]+)$/, `_out.${outExt}`)}"`
              await Clipboard.copy(cmd)
              showToast({ style: Toast.Style.Success, title: '已复制 FFmpeg 音频命令' })
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索本机音频文件、12 大声学处理模式或输出格式 (MP3 / FLAC / -16 LUFS / 静音切除 / 降噪)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 12 大音频处理预设模式',
      value: activeModeId,
      onChange: val => setActiveModeId(val),
      children: AUDIO_WORKSHOP_MODES.map(m =>
        List.Dropdown.Item({
          title: `预设: ${m.tag}`,
          value: m.id
        })
      )
    }),
    filterBar: FilterBar({
      summaryText: `队列已选 ${checkedIds.length}/${files.length} 首音频 (${formatBytes(totalBytes)}) · 预计输出 ~${formatBytes(estimatedOutBytes)} · 响度 ${LOUDNESS_LABELS[loudnessTarget]}`,
      actions: [
        {
          id: 'rescan-audio',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: '音频声学与转码参数工作台',
      subtitle: stripSilence || afftdnDenoise ? 'EBU R128 + 降噪切静音管线' : 'FFmpeg 高精度声学管线',
      fields: [
        {
          id: 'wb-output-format',
          label: '输出格式',
          type: 'select',
          value: outputFormat,
          onChange: val => setOutputFormat(val as any),
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
          onChange: val => setAudioProfile(val as any),
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
          onChange: val => setLoudnessTarget(val as any),
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
          onChange: val => setSampleRateMode(val as any),
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
          { label: '已选音频数', value: `${checkedIds.length} / ${files.length} 首` }
        ]
      }
    },
    subList: {
      title: '待处理本机音频文件队列 (按体积降序，勾选或按 ↵ 立即开始声学批处理)',
      subtitle: `${filteredFiles.length} 首 · 原始 ${formatBytes(totalBytes)} → 预计 ~${formatBytes(estimatedOutBytes)}`,
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
      emptyText: '当前未找到匹配的音频文件',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `本机目录音频与媒体队列 (${filteredFiles.length})`,
        children: rightQueueItems
      }),
      List.Section({
        title: `12 大核心音频处理与声学工坊模式 (${filteredPresets.length})`,
        children: filteredPresets.map(p =>
          List.Item({
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            icon: {
              source: Icon.SpeakerHigh,
              tintColor: Color.SecondaryText
            },
            accessories: [
              { tag: { value: p.tag } },
              { text: p.method }
            ],
            actions: ActionPanel({
              title: p.title,
              children: [
                Action({
                  title: '设为当前激活声学模式',
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

export default BatchAudioCommand

