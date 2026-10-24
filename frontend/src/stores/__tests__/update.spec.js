import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUpdateStore } from '../update'

describe('useUpdateStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态正确', () => {
    const store = useUpdateStore()
    expect(store.hasUpdate).toBe(false)
    expect(store.isMandatory).toBe(false)
    expect(store.error).toBe(null)
    expect(store.versionInfo.version).toBe('')
  })

  it('setUpdateInfo 正确设置更新信息', () => {
    const store = useUpdateStore()
    store.setUpdateInfo({
      hasUpdate: true,
      isMandatory: true,
      versionInfo: { version: '2.0.0', changelog: '新功能', fileSize: 1024, downloadUrl: 'http://x', checksum: 'abc' }
    })
    expect(store.hasUpdate).toBe(true)
    expect(store.isMandatory).toBe(true)
    expect(store.versionInfo.version).toBe('2.0.0')
  })

  it('isUpdateAvailable 和 shouldShowMandatoryDialog computed 正确', () => {
    const store = useUpdateStore()
    expect(store.isUpdateAvailable).toBe(false)
    expect(store.shouldShowMandatoryDialog).toBe(false)

    store.setUpdateInfo({ hasUpdate: true, isMandatory: false })
    expect(store.isUpdateAvailable).toBe(true)
    expect(store.shouldShowMandatoryDialog).toBe(false)

    store.setUpdateInfo({ hasUpdate: true, isMandatory: true })
    expect(store.shouldShowMandatoryDialog).toBe(true)
  })

  it('setError 设置错误信息', () => {
    const store = useUpdateStore()
    store.setError('网络错误')
    expect(store.error).toBe('网络错误')
  })

  it('reset 重置所有状态', () => {
    const store = useUpdateStore()
    store.setUpdateInfo({ hasUpdate: true, isMandatory: true, versionInfo: { version: '2.0.0' } })
    store.setError('some error')
    store.reset()
    expect(store.hasUpdate).toBe(false)
    expect(store.isMandatory).toBe(false)
    expect(store.error).toBe(null)
    expect(store.versionInfo.version).toBe('')
  })

  it('setUpdateInfo 缺省字段时使用默认值', () => {
    const store = useUpdateStore()
    store.setUpdateInfo({})
    expect(store.hasUpdate).toBe(false)
    expect(store.isMandatory).toBe(false)
    expect(store.versionInfo.version).toBe('')
  })
})
