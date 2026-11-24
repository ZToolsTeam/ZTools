import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { t } from '../../i18n/index.js'

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

const AUDIO_ERROR_KEYS: Record<string, string> = {
  AUDIO_DEVICE_MISSING: 'macosAudio.error.AUDIO_DEVICE_MISSING',
  AUDIO_DEVICE_CHANGED: 'macosAudio.error.AUDIO_DEVICE_CHANGED',
  AUDIO_DEVICE_AMBIGUOUS: 'macosAudio.error.AUDIO_DEVICE_AMBIGUOUS',
  AUDIO_CONTROL_UNSUPPORTED: 'macosAudio.error.AUDIO_CONTROL_UNSUPPORTED',
  AUDIO_PARTIAL_CHANGE: 'macosAudio.error.AUDIO_PARTIAL_CHANGE',
  AUDIO_READBACK_MISMATCH: 'macosAudio.error.AUDIO_READBACK_MISMATCH',
  AUDIO_DEFAULT_MISSING: 'macosAudio.error.AUDIO_DEFAULT_MISSING'
}
const execute: AudioRunner = (executable, request) => new Promise((resolve, reject) => {
  const child = execFile(executable, [], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error && !stdout) {
      reject(new ZToolsError(errorCodes.notSupported, t('macosAudio.error.helperFailed'), {
        i18nKey: 'macosAudio.error.helperFailed'
      }))
    } else resolve({ stdout, exitCode: error ? 1 : 0 })
  })
  child.stdin?.on('error', () => { /* 进程提前结束时由 execFile 的回调统一报告。 */ })
  child.stdin?.end(JSON.stringify(request))
})
export function macAudioHelperPath(isPackaged: boolean, resourcesPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacAudio') : path.resolve(__dirname, '../../../mac-audio-native/native/ZToolsMacAudio')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('macosAudio.error.invalidData'))
  return value as Record<string, unknown>
}
export function parseAudioDevice(value: unknown): SystemAudioDevice {
  const item = record(value)
  if (!['input', 'output'].includes(String(item.type)) || ['id', 'uid', 'name'].some(key => typeof item[key] !== 'string' || !item[key]) || ['isDefault', 'canSetDefault', 'canSetVolume', 'canMute'].some(key => typeof item[key] !== 'boolean')) throw new Error(t('macosAudio.error.incompleteDevice'))
  if (item.id !== `${item.type}:${item.uid}`) throw new Error(t('macosAudio.error.invalidDeviceId'))
  if (item.volume !== undefined && (typeof item.volume !== 'number' || !Number.isFinite(item.volume) || item.volume < 0 || item.volume > 100)) throw new Error(t('macosAudio.error.invalidVolume'))
  if (item.muted !== undefined && typeof item.muted !== 'boolean') throw new Error(t('macosAudio.error.invalidMute'))
  if ((item.canSetVolume && item.volume === undefined) || (item.canMute && item.muted === undefined)) throw new Error(t('macosAudio.error.missingOperableState'))
  return item as unknown as SystemAudioDevice
}
export class MacAudioController implements AudioController {
  #changing = false
  // 路径在真正调用时再校验：SystemService 构造时就会创建本对象，构造期抛错会让与音频无关的系统能力全部不可用
  constructor(private readonly executable: string, private readonly platform: NodeJS.Platform = process.platform, private readonly runner: AudioRunner = execute) {}
  async #run(request: AudioRequest): Promise<Record<string, unknown>> {
    if (this.platform !== 'darwin') {
      throw new ZToolsError(errorCodes.notSupported, t('macosAudio.error.unsupportedPlatform'), {
        i18nKey: 'macosAudio.error.unsupportedPlatform'
      })
    }
    if (!path.isAbsolute(this.executable)) {
      throw new ZToolsError(errorCodes.notSupported, t('macosAudio.error.invalidHelperPath'), {
        i18nKey: 'macosAudio.error.invalidHelperPath'
      })
    }
    let stat: fs.Stats
    try { stat = fs.lstatSync(this.executable) }
    catch {
      throw new ZToolsError(errorCodes.notSupported, t('macosAudio.error.helperNotBuilt'), {
        i18nKey: 'macosAudio.error.helperNotBuilt'
      })
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ZToolsError(errorCodes.notSupported, t('macosAudio.error.helperInvalid'), {
        i18nKey: 'macosAudio.error.helperInvalid'
      })
    }
    const result = await this.runner(this.executable, request)
    const response = record(JSON.parse(result.stdout))
    if (response.version !== 1 || response.success !== true || result.exitCode !== 0) {
      const code = typeof response.code === 'string' ? response.code : ''
      const key = Object.hasOwn(AUDIO_ERROR_KEYS, code) ? AUDIO_ERROR_KEYS[code]! : 'macosAudio.error.operationFailed'
      throw new Error(t(key))
    }
    return response
  }
  async list(): Promise<SystemAudioDevice[]> {
    const response = await this.#run({ version: 1, operation: 'list' })
    if (!Array.isArray(response.devices)) throw new Error(t('macosAudio.error.invalidDeviceList'))
    const devices = response.devices.map(parseAudioDevice)
    if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error(t('macosAudio.error.duplicateDeviceId'))
    return devices
  }
  async change(request: Exclude<AudioRequest, { operation: 'list' }>): Promise<SystemAudioDevice> {
    if (this.#changing) throw new Error(t('macosAudio.error.operationInProgress'))
    this.#changing = true
    try {
      const response = await this.#run(request)
      const device = parseAudioDevice(response.device)
      if (device.type !== request.type || (request.id && ![device.id, device.uid, device.name].includes(request.id))) throw new Error(t('macosAudio.error.deviceMismatch'))
      if (request.operation === 'default' && !device.isDefault) throw new Error(t('macosAudio.error.defaultSwitchFailed'))
      if (request.operation === 'volume' && (device.volume === undefined || request.volume === undefined || Math.abs(device.volume - request.volume) > 1)) throw new Error(t('macosAudio.error.volumeReadbackMismatch'))
      if (request.operation === 'mute' && (device.muted === undefined || (request.muted !== undefined && device.muted !== request.muted))) throw new Error(t('macosAudio.error.muteReadbackMismatch'))
      return device
    } finally { this.#changing = false }
  }
}
