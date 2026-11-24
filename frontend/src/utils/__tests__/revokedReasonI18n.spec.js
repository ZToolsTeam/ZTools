import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { getCurrentLocale, setI18nLocale } from '@/i18n'
import { getLocalizedPluginField } from '@/utils/pluginI18n'
import { buildCatalogDownloadInfo, buildCatalogUpdateInfo } from '@/api/pluginCatalog'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { usePluginsStore } from '@/stores/plugins'

describe('下架原因（revokedReason）全链路多语言消费与热切换', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setActivePinia(createPinia())
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('getLocalizedPluginField 优先读取 i18n[locale].revokedReason 并兼容 snake_case 与 manifest.i18n', () => {
    const item = {
      revoked_reason: '存在安全漏洞',
      i18n: {
        'en-US': { revokedReason: 'Removed due to security issue' },
        'zh-CN': { revokedReason: '因安全漏洞已下架' }
      }
    }

    expect(getLocalizedPluginField(item, 'revokedReason', 'en-US')).toBe('Removed due to security issue')
    expect(getLocalizedPluginField(item, 'revokedReason', 'zh-CN')).toBe('因安全漏洞已下架')

    const fallbackOnly = { revoked_reason: '违反隐私规范' }
    expect(getLocalizedPluginField(fallbackOnly, 'revokedReason', 'en-US')).toBe('违反隐私规范')

    const manifestNested = {
      revokedReason: '已合并',
      manifest: { i18n: { 'en-US': { revokedReason: 'Merged into built-in tool' } } }
    }
    expect(getLocalizedPluginField(manifestNested, 'revokedReason', 'en-US')).toBe('Merged into built-in tool')
  })

  it('pluginCatalog.js 的下载与更新检查按当前语言输出多语言下架原因', () => {
    const entry = {
      id: 'risky-plugin',
      pluginId: 'risky-plugin',
      version: '1.0.0',
      revoked: true,
      revokedReason: '存在隐私合规风险',
      i18n: {
        'en-US': { revokedReason: 'Violates privacy policy' }
      }
    }

    setI18nLocale('en-US')
    expect(() => buildCatalogDownloadInfo(entry)).toThrow('Violates privacy policy')
    const updateEn = buildCatalogUpdateInfo(entry, '0.9.0', 'windows')
    expect(updateEn.revoked).toBe(true)
    expect(updateEn.revokedReason).toBe('Violates privacy policy')

    setI18nLocale('zh-CN')
    expect(() => buildCatalogDownloadInfo(entry)).toThrow('存在隐私合规风险')
    const updateZh = buildCatalogUpdateInfo(entry, '0.9.0', 'windows')
    expect(updateZh.revokedReason).toBe('存在隐私合规风险')
  })

  it('StoreCatalogManager 提取下架原因时优先消费 i18n[locale].revokedReason', async () => {
    const remoteItem = {
      pluginId: 'revoked-demo',
      name: '已下架插件',
      version: '1.0.0',
      revoked: true,
      revokedReason: '官方安全下架测试',
      i18n: {
        'en-US': {
          name: 'Revoked Demo',
          revokedReason: 'Removed for security testing'
        }
      }
    }

    setI18nLocale('en-US')
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: async () => ({ plugins: [remoteItem] }),
      getOfficialList: () => []
    })
    await manager.ensureCatalog(true)
    expect(manager._revokedMap['revoked-demo']).toEqual({
      revoked: true,
      reason: 'Removed for security testing'
    })
  })

  it('usePluginsStore.getRevokedReason 响应式随语言热切换实时更新，不冻结静态中文', () => {
    const store = usePluginsStore()
    setI18nLocale('zh-CN')
    store._applyRevocations([
      {
        pluginId: 'gone-i18n',
        revoked: true,
        revokedReason: '已停止维护并下架',
        i18n: {
          'en-US': { revokedReason: 'Discontinued and removed' }
        }
      },
      {
        pluginId: 'gone-default',
        revoked: true
      }
    ])

    expect(store.getRevokedReason('gone-i18n')).toBe('已停止维护并下架')
    expect(store.getRevokedReason('gone-default')).toBe('该插件已被官方下架禁用')

    // 热切换至英文，无需重新拉取目录，getRevokedReason 立即返回英文译文与英文默认文案
    setI18nLocale('en-US')
    expect(store.getRevokedReason('gone-i18n')).toBe('Discontinued and removed')
    expect(store.getRevokedReason('gone-default')).toBe('This plugin has been removed and disabled')
  })
})
