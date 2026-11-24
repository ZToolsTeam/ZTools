import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCurrentLocale, setI18nLocale, t } from '@/i18n'
import { resolveErrorMessage, resolveResponseMessage } from '@/utils/errorMessage'
import { HostMethodError } from '@/declarative/hostMethods'

describe('errorMessage 多语言错误消息解析', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('中文模式下保留原始错误消息，空值或无效输入回退 fallbackKey', () => {
    setI18nLocale('zh-CN')
    expect(resolveErrorMessage(new Error('文件不存在'), 'common.unknownError')).toBe('文件不存在')
    expect(resolveErrorMessage({ error: '权限不足' }, 'common.unknownError')).toBe('权限不足')
    expect(resolveErrorMessage({ error: { message: '网络连接超时' } }, 'common.unknownError')).toBe('网络连接超时')
    expect(resolveErrorMessage({ message: '操作失败' }, 'common.unknownError')).toBe('操作失败')
    expect(resolveErrorMessage('  直接错误文本  ', 'common.unknownError')).toBe('直接错误文本')
    expect(resolveErrorMessage({ code: 'SOME_HOST_CODE', message: '宿主本地化消息' }, 'common.unknownError')).toBe('宿主本地化消息')
    expect(resolveErrorMessage(null, 'common.unknownError')).toBe(t('common.unknownError'))
    expect(resolveErrorMessage({}, 'common.unknownError')).toBe(t('common.unknownError'))
  })

  it('英文模式下禁止直出含中文（CJK）的原始错误消息，统一回退 fallbackKey', () => {
    setI18nLocale('en-US')
    const fallback = t('common.unknownError')
    expect(/[\u3400-\u4dbf\u4e00-\u9fff]/.test(fallback)).toBe(false)

    expect(resolveErrorMessage(new Error('发生未知中文错误'), 'common.unknownError')).toBe(fallback)
    expect(resolveErrorMessage({ error: '权限被拒绝' }, 'common.unknownError')).toBe(fallback)
    expect(resolveErrorMessage({ error: { code: 'E_PERM', message: 'IPC 拒绝访问' } }, 'common.unknownError')).toBe(fallback)
    expect(resolveErrorMessage({ code: 'INVALID_REQUEST', message: '参数无效' }, 'common.unknownError')).toBe(fallback)
    expect(resolveErrorMessage('部分 English 混杂中文', 'common.unknownError')).toBe(fallback)

    // 纯英文原始消息正常透出
    expect(resolveErrorMessage(new Error('Permission denied'), 'common.unknownError')).toBe('Permission denied')
    expect(resolveErrorMessage({ error: 'File not found' }, 'common.unknownError')).toBe('File not found')

    // 支持 fallbackParams 插值
    expect(
      resolveErrorMessage({ message: '拉取超时' }, 'pluginCatalog.remoteTimeout', { ms: 8000 })
    ).toBe(t('pluginCatalog.remoteTimeout', { ms: 8000 }))
  })

  it('resolveResponseMessage 在英文模式下同样拦截含中文响应文本并回退译文', () => {
    setI18nLocale('zh-CN')
    expect(resolveResponseMessage({ message: '已完成同步' }, 'common.ok')).toBe('已完成同步')
    expect(resolveResponseMessage('操作完成', 'common.ok')).toBe('操作完成')

    setI18nLocale('en-US')
    expect(resolveResponseMessage({ message: '已完成同步' }, 'common.ok')).toBe(t('common.ok'))
    expect(resolveResponseMessage('操作完成', 'common.ok')).toBe(t('common.ok'))
    expect(resolveResponseMessage({ message: 'Sync completed' }, 'common.ok')).toBe('Sync completed')
    expect(resolveResponseMessage('Done', 'common.ok')).toBe('Done')
  })

  it('中文模式下拦截纯英文底层技术报错并回退中文 fallbackKey', () => {
    setI18nLocale('zh-CN')
    const fallback = t('common.unknownError')
    for (const techErr of [
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      new Error('Failed to fetch'),
      new Error('Network Error'),
      { error: 'connect ECONNREFUSED 127.0.0.1:3000' },
      { message: 'Request failed with status code 502' },
      { code: 'ERR_NETWORK', error: 'timeout of 5000ms exceeded' }
    ]) {
      expect(resolveErrorMessage(techErr, 'common.unknownError')).toBe(fallback)
    }
  })

  it('HostMethodError 遵循双语拦截并保留结构化错误码与 details', () => {
    setI18nLocale('en-US')
    const errEn = new HostMethodError('db_get', {
      code: 'E_ACCESS',
      message: '数据库权限被拒绝',
      details: { table: 'kv' }
    })
    expect(errEn.code).toBe('E_ACCESS')
    expect(errEn.details).toEqual({ table: 'kv' })
    expect(errEn.message).toBe('Host method db_get failed')
    expect(/[\u3400-\u4dbf\u4e00-\u9fff]/.test(errEn.message)).toBe(false)

    setI18nLocale('zh-CN')
    const errZh = new HostMethodError('db_get', {
      code: 'E_NET',
      message: 'connect ECONNREFUSED 127.0.0.1:8080'
    })
    expect(errZh.code).toBe('E_NET')
    expect(errZh.message).toBe('宿主方法 db_get 调用失败')
  })

  it('[破坏性] 异常类型与原型污染键输入不抛错且安全回退', () => {
    setI18nLocale('en-US')
    for (const bad of [null, undefined, 0, NaN, false, true, [], { code: '__proto__' }, { errorCode: 'constructor', message: '中文' }]) {
      expect(resolveErrorMessage(bad, 'common.unknownError')).toBe(t('common.unknownError'))
      expect(resolveResponseMessage(bad, 'common.ok')).toBe(t('common.ok'))
    }
  })
})
