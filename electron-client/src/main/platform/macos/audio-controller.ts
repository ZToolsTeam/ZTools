import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'

export type AudioDirection = 'input' | 'output'
export interface SystemAudioDevice {
  id: string; uid: string; name: string; type: AudioDirection; isDefault: boolean
  canSetDefault: boolean; canSetVolume: boolean; canMute: boolean
  volume?: number; muted?: boolean; transport?: string; sampleRate?: number; channels?: number
}
export type AudioRequest = { version: 1; operation: 'list' } | {
  version: 1; operation: 'default' | 'volume' | 'mute'; type: AudioDirection
  id?: string; volume?: number; muted?: boolean
}
export type AudioRunner = (executable: string, request: AudioRequest) => Promise<{ stdout: string; exitCode: number }>
export interface AudioController {
  list(): Promise<SystemAudioDevice[]>
  change(request: Exclude<AudioRequest, { operation: 'list' }>): Promise<SystemAudioDevice>
}

const messages: Record<string, string> = {
  AUDIO_DEVICE_MISSING: '设备已断开，请重新扫描后重试',
  AUDIO_DEVICE_CHANGED: '设备在操作期间发生变化，请重新扫描',
  AUDIO_DEVICE_AMBIGUOUS: '存在同名设备，请通过设备列表选择',
  AUDIO_CONTROL_UNSUPPORTED: '此设备不支持该音频控制，请使用设备自身的调节方式',
  AUDIO_PARTIAL_CHANGE: '部分声道已改变且未能恢复，请重新检查设备设置',
  AUDIO_READBACK_MISMATCH: '系统读回的状态与设置不一致，请刷新后确认',
  AUDIO_DEFAULT_MISSING: '当前没有默认音频设备'
}
const execute: AudioRunner = (executable, request) => new Promise((resolve, reject) => {
  const child = execFile(executable, [], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error && !stdout) reject(new ZToolsError(errorCodes.notSupported, '本地音频组件未能完成操作，请检查组件是否已构建或设备是否可用'))
    else resolve({ stdout, exitCode: error ? 1 : 0 })
  })
  child.stdin?.on('error', () => { /* 进程提前结束时由 execFile 的回调统一报告。 */ })
  child.stdin?.end(JSON.stringify(request))
})
export function macAudioHelperPath(isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacAudio') : path.resolve(__dirname, '../../../mac-audio-native/native/ZToolsMacAudio')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('音频组件返回的数据无效')
  return value as Record<string, unknown>
}
export function parseAudioDevice(value: unknown): SystemAudioDevice {
  const item = record(value)
  if (!['input', 'output'].includes(String(item.type)) || ['id', 'uid', 'name'].some(key => typeof item[key] !== 'string' || !item[key]) || ['isDefault', 'canSetDefault', 'canSetVolume', 'canMute'].some(key => typeof item[key] !== 'boolean')) throw new Error('音频设备信息不完整')
  if (item.id !== `${item.type}:${item.uid}`) throw new Error('音频设备标识无效')
  if (item.volume !== undefined && (typeof item.volume !== 'number' || !Number.isFinite(item.volume) || item.volume < 0 || item.volume > 100)) throw new Error('音量状态无效')
  if (item.muted !== undefined && typeof item.muted !== 'boolean') throw new Error('静音状态无效')
  if ((item.canSetVolume && item.volume === undefined) || (item.canMute && item.muted === undefined)) throw new Error('音频设备缺少可操作状态')
  return item as unknown as SystemAudioDevice
}
export class MacAudioController implements AudioController {
  #changing = false
  constructor(private readonly executable: string, private readonly platform: NodeJS.Platform = process.platform, private readonly runner: AudioRunner = execute) {
    if (!path.isAbsolute(executable)) throw new Error('音频组件路径必须为绝对路径')
  }
  async #run(request: AudioRequest): Promise<Record<string, unknown>> {
    if (this.platform !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '当前平台尚未接入此音频控制接口')
    let stat: fs.Stats
    try { stat = fs.lstatSync(this.executable) }
    catch { throw new ZToolsError(errorCodes.notSupported, '本地音频组件未构建，请构建原生组件后重试') }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ZToolsError(errorCodes.notSupported, '本地音频组件无效')
    const result = await this.runner(this.executable, request)
    const response = record(JSON.parse(result.stdout))
    if (response.version !== 1 || response.success !== true || result.exitCode !== 0) {
      const code = typeof response.code === 'string' ? response.code : ''
      throw new Error(messages[code] || '系统音频操作失败，请重新扫描设备后重试')
    }
    return response
  }
  async list(): Promise<SystemAudioDevice[]> {
    const response = await this.#run({ version: 1, operation: 'list' })
    if (!Array.isArray(response.devices)) throw new Error('音频设备列表无效')
    const devices = response.devices.map(parseAudioDevice)
    if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error('音频设备列表含重复标识')
    return devices
  }
  async change(request: Exclude<AudioRequest, { operation: 'list' }>): Promise<SystemAudioDevice> {
    if (this.#changing) throw new Error('另一项音频操作正在执行，请稍后重试')
    this.#changing = true
    try {
      const response = await this.#run(request)
      const device = parseAudioDevice(response.device)
      if (device.type !== request.type || (request.id && ![device.id, device.uid, device.name].includes(request.id))) throw new Error('返回的音频设备与选择不一致')
      if (request.operation === 'default' && !device.isDefault) throw new Error('系统未切换到所选音频设备')
      if (request.operation === 'volume' && (device.volume === undefined || request.volume === undefined || Math.abs(device.volume - request.volume) > 1)) throw new Error('设备音量读回不一致')
      if (request.operation === 'mute' && (device.muted === undefined || (request.muted !== undefined && device.muted !== request.muted))) throw new Error('设备静音读回不一致')
      return device
    } finally { this.#changing = false }
  }
}
