import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import type { HostPluginContext, HostSystemCommands } from './shared-utils.js'

const METHODS = new Set(['batchconvertformat', 'batchloudnorm', 'batchadjustvolume', 'batchtrimaudio',
  'batchtrimduration', 'batchfadeinout', 'batchequalizer', 'batchcompressor', 'batchdenoise', 'batchmergeaudio', 'batchwritemetadata'])
const CODECS: Readonly<Record<string, readonly string[]>> = {
  mp3: ['-c:a', 'libmp3lame'], flac: ['-c:a', 'flac'], wav: ['-c:a', 'pcm_s24le'],
  aac: ['-c:a', 'aac'], m4a: ['-c:a', 'aac'], ogg: ['-c:a', 'libvorbis', '-q:a', '5']
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = params[key] === undefined ? fallback : Number(params[key])
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`无效音频参数 ${key}（${min}～${max}）`)
  return value
}

function audioFilters(method: string, params: Record<string, unknown>): string[] {
  const n = (key: string, fallback: number, min: number, max: number) => numberParam(params, key, fallback, min, max)
  const filters: string[] = []
  if (method === 'batchadjustvolume') filters.push(`volume=${n('gainDb', 3.5, -60, 30)}dB`)
  if (method === 'batchtrimduration') filters.push(`atrim=start=${n('skipStartSec', 2, 0, 86400)}`, 'asetpts=PTS-STARTPTS',
    'areverse', `atrim=start=${n('skipEndSec', 2, 0, 86400)}`, 'areverse', 'asetpts=PTS-STARTPTS')
  if (method === 'batchfadeinout') filters.push(`afade=t=in:d=${n('fadeInSec', 3, 0.001, 3600)}`, 'areverse',
    `afade=t=in:d=${n('fadeOutSec', 3, 0.001, 3600)}`, 'areverse')
  if (method === 'batchequalizer') filters.push(`highpass=f=${n('lowCutHz', 90, 10, 20000)}`,
    `equalizer=f=3000:width_type=q:w=1.2:g=${n('boost3kHzDb', 4, -24, 24)}`)
  if (method === 'batchcompressor') filters.push(`acompressor=threshold=${10 ** (n('thresholdDb', -18, -60, 0) / 20)}:ratio=${n('ratio', 4, 1, 20)}:attack=${n('attackMs', 20, 0.01, 2000)}:release=${n('releaseMs', 250, 0.01, 9000)}`)
  if (method === 'batchtrimaudio' || params.stripSilence === true) {
    const threshold = n('thresholdDb', -50, -100, 0)
    const trim = `silenceremove=start_periods=1:start_duration=0.02:start_threshold=${threshold}dB`
    filters.push(trim, 'areverse', trim, 'areverse')
  }
  if (method === 'batchdenoise' || params.afftdnDenoise === true) {
    filters.push(`afftdn=nr=${n('noiseReductionDb', 14, 0.01, 97)}:nf=${n('noiseFloorDb', -45, -80, -20)}`)
  }
  const loudness = params.loudnessTarget
  const loudnessValues: Readonly<Record<string, number>> = { lufs_16: -16, lufs_14: -14, lufs_23: -23 }
  if (loudness !== undefined && loudness !== 'keep_raw' && !(String(loudness) in loudnessValues)) throw new Error('无效响度选项')
  if (method === 'batchloudnorm' || (method === 'batchmergeaudio' && params.normalizeBeforeMerge === true) || loudnessValues[String(loudness)] !== undefined) {
    const target = loudnessValues[String(loudness)] ?? n('targetI', -16, -70, -5)
    filters.push(`loudnorm=I=${target}:TP=${n('targetTp', -1.5, -9, 0)}:LRA=${n('targetLra', 11, 1, 50)}`)
  }
  return filters
}

/** 构建明确的音频处理参数；未知模式绝不落到普通转码。输入路径全部作为独立 argv。 */
export function buildAudioArguments(method: string, params: Record<string, unknown>, inputs: string[], output: string): string[] {
  if (!METHODS.has(method)) throw new Error(`不支持的音频操作：${method}`)
  if (inputs.length === 0 || (method === 'batchmergeaudio' && inputs.length < 2)) throw new Error('合并需要至少两首音频，其他处理需要至少一首音频')
  const format = String(params.format ?? params.outputFormat ?? 'mp3').toLowerCase()
  const codec = CODECS[format]
  if (!codec) throw new Error(`不支持的音频输出格式：${format}`)
  const filters = audioFilters(method, params)
  const args = ['-n', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap(input => ['-i', input])]
  const sampleRate = params.sampleRateMode === 'source' ? undefined : params.sampleRateMode ?? params.sampleRate
  const rate = sampleRate === undefined ? undefined : numberParam({ sampleRate }, 'sampleRate', 48000, 8000, 192000)
  if (rate !== undefined && !Number.isInteger(rate)) throw new Error('采样率必须是整数')
  if (method === 'batchmergeaudio') {
    const chains = inputs.map((_input, i) => `[${i}:a:0]${[...filters, `aresample=${rate ?? 48000}`, 'aformat=channel_layouts=stereo', 'asetpts=PTS-STARTPTS'].join(',')}[a${i}]`)
    chains.push(`${inputs.map((_input, i) => `[a${i}]`).join('')}concat=n=${inputs.length}:v=0:a=1[out]`)
    args.push('-filter_complex', chains.join(';'), '-map', '[out]')
  } else {
    args.push('-map', '0:a:0')
    if (filters.length) args.push('-af', filters.join(','))
  }
  args.push('-vn', '-map_metadata', '0', ...codec)
  if (rate !== undefined) args.push('-ar', String(rate))
  if (format === 'mp3' || format === 'aac' || format === 'm4a') {
    const bitrate = String(params.bitrate ?? (format === 'mp3' ? '320k' : '256k'))
    if (!/^(?:[1-9]\d{1,2})k$/.test(bitrate) || Number.parseInt(bitrate, 10) > 512) throw new Error('无效音频码率')
    args.push('-b:a', bitrate)
  }
  if (format === 'flac') args.push('-compression_level', String(numericCompression(params)))
  if (method === 'batchwritemetadata') {
    for (const [key, target] of [['artist', 'artist'], ['album', 'album'], ['year', 'date']] as const) {
      if (params[key] !== undefined) {
        if (typeof params[key] !== 'string' || params[key].length > 1024 || params[key].includes('\0')) throw new Error(`无效元数据：${key}`)
        args.push('-metadata', `${target}=${params[key]}`)
      }
    }
  }
  args.push(output)
  return args
}

function numericCompression(params: Record<string, unknown>): number {
  const level = numberParam(params, 'compressionLevel', 8, 0, 12)
  if (!Number.isInteger(level)) throw new Error('FLAC 压缩级别必须是整数')
  return level
}

/** 临时文件通过音轨验证后再以排他方式发布，失败/取消不会覆盖旧文件。 */
export async function processAudioFiles(
  ctx: HostPluginContext, sys: HostSystemCommands, method: string, params: Record<string, unknown>,
  rawFiles: string[], caller?: CallerIdentity, signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []
  const errors: Array<{ file: string; error: string }> = []
  const format = String(params.format ?? params.outputFormat ?? 'mp3').toLowerCase()
  const groups = method === 'batchmergeaudio' ? [rawFiles] : rawFiles.map(file => [file])
  try {
    signal?.throwIfAborted()
    buildAudioArguments(method, params, rawFiles, `output.${format}`)
    if (params.outputPath && groups.length > 1) throw new Error('多个独立任务不能共用一个输出文件')
    for (const command of ['ffmpeg', 'ffprobe']) {
      signal?.throwIfAborted()
      const checked = await sys.runCommand(command, ['-version'], 4000, signal)
      if (checked.exitCode !== 0) throw new Error(`本机未检测到可用的 ${command}，无法处理并验证音频`)
    }
  } catch (err) {
    return { ok: false, success: false, processedCount: 0, results, errors, error: err instanceof Error ? err.message : String(err) }
  }
  for (const group of groups) {
    let tempPath = ''
    try {
      signal?.throwIfAborted()
      const inputs = await Promise.all(group.map(file => ctx.authorizeExistingPath(file, caller, 'read')))
      signal?.throwIfAborted()
      const first = path.parse(inputs[0]!)
      const outDir = typeof params.outputDir === 'string' && params.outputDir.trim()
        ? await ctx.authorizeOutputPath(params.outputDir.trim(), caller) : first.dir
      signal?.throwIfAborted()
      const outputPath = await ctx.authorizeOutputPath(typeof params.outputPath === 'string' && params.outputPath.trim()
        ? params.outputPath.trim() : path.join(outDir, `${first.name}_${method === 'batchmergeaudio' ? 'merged' : 'processed'}-${randomUUID().slice(0, 8)}.${format}`), caller)
      signal?.throwIfAborted()
      if (path.extname(outputPath).toLowerCase() !== `.${format}`) throw new Error('输出文件扩展名与所选格式不一致')
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      signal?.throwIfAborted()
      tempPath = path.join(path.dirname(outputPath), `.ztools-audio-${randomUUID()}.${format}`)
      const sourceProbe = await sys.runCommand('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'json', inputs[0]!], 15_000, signal)
      signal?.throwIfAborted()
      if (sourceProbe.exitCode !== 0) throw new Error(sourceProbe.stderr || '无法读取源音频采样率')
      const sourceInfo = JSON.parse(sourceProbe.stdout) as { streams?: Array<{ sample_rate?: string }> }
      const sourceRate = Number(sourceInfo.streams?.[0]?.sample_rate)
      if (!Number.isInteger(sourceRate) || sourceRate < 8000 || sourceRate > 192000) throw new Error('源文件没有有效音轨或采样率')
      const effectiveParams = params.sampleRateMode === 'source' || (params.sampleRateMode === undefined && params.sampleRate === undefined)
        ? { ...params, sampleRateMode: String(sourceRate) } : params
      const converted = await sys.runCommand('ffmpeg', buildAudioArguments(method, effectiveParams, inputs, tempPath), 300_000, signal)
      signal?.throwIfAborted()
      if (converted.exitCode !== 0) throw new Error(converted.stderr || 'FFmpeg 音频处理失败')
      const probed = await sys.runCommand('ffprobe', ['-v', 'error', '-f', format === 'm4a' ? 'mov' : format, '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', tempPath], 15_000, signal)
      if (probed.exitCode !== 0) throw new Error(probed.stderr || '无法验证处理后的音频')
      const info = JSON.parse(probed.stdout) as { streams?: Array<{ codec_name?: string }>; format?: { duration?: string } }
      const duration = Number(info.format?.duration)
      const stat = await fs.stat(tempPath)
      if (!info.streams?.[0]?.codec_name || !Number.isFinite(duration) || duration <= 0 || stat.size === 0) throw new Error('输出没有有效音轨或时长，未保存结果')
      signal?.throwIfAborted()
      await fs.copyFile(tempPath, outputPath, constants.COPYFILE_EXCL)
      results.push({ sourcePath: inputs[0], inputPaths: inputs, outputPath, engine: 'ffmpeg', sizeBytes: stat.size, outputBytes: stat.size, durationSeconds: duration })
    } catch (err) {
      errors.push({ file: group.join('\n'), error: err instanceof Error ? err.message : String(err) })
      if (signal?.aborted) break
    } finally {
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(err => console.warn('[AudioProcessing] 临时文件清理失败:', err))
    }
  }
  return { ok: errors.length === 0 && results.length > 0, success: errors.length === 0 && results.length > 0,
    processedCount: results.length, results, errors, ...(errors.length ? { error: errors[0]!.error } : {}) }
}
