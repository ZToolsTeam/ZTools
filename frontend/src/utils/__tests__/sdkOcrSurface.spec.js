/**
 * 插件 SDK 的 OCR 接口面：只保留本地识别
 *
 * - window.ztools.ocr 只有 recognizeLocal / getLocalLanguages；服务器识别接口、云端识别（getOrcRes / batchOcr）
 *   与 plugin-sdk 的 services 都已移除；
 * - 打包后的 ztools-api.js 与 plugin-sdk.js 里不再出现内部后台地址、services.ocr / getQuota；
 * - 故障：本地识别失败时把错误交给调用方，不回退到任何云端接口。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OCRAPI from '../../../public/js/cef-ipc/src/api/ocr.js'

const sdkDir = path.resolve(__dirname, '../../../public/sdk')
const readSdk = (name) => readFileSync(path.join(sdkDir, name), 'utf8')

const REMOVED_METHODS = [
  'fromImage',
  'fromScreen',
  'fromFile',
  'fromImageTable',
  'fromScreenTable',
  'fromFileTable',
  'fromImageFormula',
  'fromScreenFormula',
  'fromFileFormula',
  'getOrcRes',
  'batchOcr',
  '_callOCRServer',
  '_callTableOCRServer',
  '_callFormulaOCRServer'
]

afterEach(() => {
  delete window.ztools
  vi.restoreAllMocks()
})

describe('window.ztools.ocr 接口面', () => {
  it('只保留本地识别，服务器识别与云端识别接口已移除', () => {
    const api = new OCRAPI({})
    for (const name of ['recognizeLocal', 'getLocalLanguages']) {
      expect(typeof api[name]).toBe('function')
    }
    for (const name of REMOVED_METHODS) {
      expect(api[name]).toBeUndefined()
    }
    expect(api.ocrServerUrl).toBeUndefined()
  })

  it('打包后的 SDK 不含内部后台地址与 services 接口', () => {
    const ztoolsApi = readSdk('ztools-api.js')
    // 不含任何指向本机后台端口的地址
    expect(ztoolsApi).not.toMatch(/localhost:\d+/)
    expect(ztoolsApi).not.toContain('/api/services/ocr')
    for (const name of REMOVED_METHODS) {
      expect(ztoolsApi).not.toMatch(new RegExp(`\\b${name}\\s*\\(`))
    }

    const pluginSdk = readSdk('plugin-sdk.js')
    expect(pluginSdk).not.toContain('ocr.recognize')
    expect(pluginSdk).not.toContain('ocr.quota')
    expect(pluginSdk).not.toMatch(/\bservices\b/)
  })

  it('[安全] 云端识别入口已移除：不读取登录凭据，不调用 ImageOcrPlugin', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../public/js/cef-ipc/src/api/ocr.js'), 'utf8')
    expect(source).not.toMatch(/getToken|_withAuthToken|ImageOcrPlugin|dllplugin|serial_no/)
    const bundle = readSdk('ztools-api.js')
    expect(bundle).not.toMatch(/\bgetOrcRes\s*\(|\bbatchOcr\s*\(|PerformOcr/)
  })

  it('[故障] 本地识别把宿主错误原样交给调用方，不回退到任何云端接口', async () => {
    const api = new OCRAPI({})
    const failure = new Error('本地识别不可用')
    api._localAPI = { recognize: vi.fn().mockRejectedValue(failure), languages: vi.fn().mockRejectedValue(failure) }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(api.recognizeLocal({ id: 'ref-1' })).rejects.toBe(failure)
    await expect(api.getLocalLanguages()).rejects.toBe(failure)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
