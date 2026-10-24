/**
 * 内置翻译命令的翻译服务地址：构建时注入，源码不写死
 *
 * 打通「构建时注入的地址 -> 宿主配置入口 -> 内置翻译命令发请求」；
 * 故障：未配置、地址无效、服务不可用时都给出明确结果，不崩溃、不发到别的地址。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLiveTranslation } from '@ztools/declarative-ui'
import { getTranslationEndpoint } from '@ztools/declarative-ui/host'
import { applyTranslationServiceConfig } from '../translation'

const TEST_ENDPOINT = 'https://translate.example.test/api/translation'

afterEach(() => {
  applyTranslationServiceConfig('')
  vi.unstubAllGlobals()
})

describe('翻译服务地址注入', () => {
  it('测试构建没有注入地址：默认未配置，词典没有的内容提示未配置翻译服务且不发请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(applyTranslationServiceConfig()).toBe('')
    await expect(fetchLiveTranslation('Good morning developers', 'auto', 'ja')).rejects.toMatchObject({
      code: 'TRANSLATION_NOT_CONFIGURED',
      message: expect.stringContaining('未配置翻译服务')
    })
    // 词典收录的词照常离线返回
    expect((await fetchLiveTranslation('Hello', 'en', 'zh-CN')).translatedText).toBe('你好')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('注入地址后，内置翻译命令把请求发到该地址', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { trans_result: [{ dst: '早上好' }] } }) }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(applyTranslationServiceConfig(TEST_ENDPOINT)).toBe(TEST_ENDPOINT)
    const res = await fetchLiveTranslation('good morning', 'auto', 'zh-CN')
    expect(res.translatedText).toBe('早上好')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe(TEST_ENDPOINT)
  })

  it('[故障] 服务返回 5xx 时词典没有就如实报错，不编造译文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    applyTranslationServiceConfig(TEST_ENDPOINT)
    await expect(fetchLiveTranslation('Good morning developers', 'auto', 'ja')).rejects.toThrow('翻译服务暂时不可用')
  })

  it('[对抗] 非 http(s) 地址、带账号密码的地址或非字符串都按未配置处理', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/hosts', 'https://u:p@x.test/t', '  ', 42, null, {}]) {
      expect(applyTranslationServiceConfig(bad)).toBe('')
      expect(getTranslationEndpoint()).toBe('')
    }
  })

  it('[安全] 界面层源码里不写死任何翻译服务地址', () => {
    const srcDir = path.resolve(__dirname, '../..')
    const offenders = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full)
        } else if (/\.(js|vue|ts|mjs)$/.test(name) && /oauth\/translation/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full)
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})
