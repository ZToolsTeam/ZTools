import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { setI18nLocale, t } from '@/i18n'
import {
  HOTKEY_RULE_DESCRIPTION_KEY,
  HOTKEY_UNSUPPORTED_TEXT_KEY,
  HOTKEY_WAIT_TEXT_KEY,
  getDefaultHotkeyRuleDescription,
  getDefaultHotkeyUnsupportedText,
  getDefaultHotkeyWaitText
} from '@/utils/hotkeyRecorder'
import {
  ALL_CATEGORY_ID,
  FAVORITES_CATEGORY_ID,
  getCategoryIcon,
  isAllCategory,
  normalizeCategoryRouteParam
} from '@/utils/pluginCategories'
import { CATEGORY_GLYPHS, getCategoryGlyph } from '@/utils/brandIcons'
import { OFFICIAL_BADGE_CODE, getBundledPluginEntries } from '@/utils/bundledPlugins'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { useCategoriesStore, mergeLocalCategories } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { resolveErrorMessage, resolveResponseMessage } from '@/utils/errorMessage'
import ListRenderer from '@/declarative/components/ListRenderer.vue'

describe('阶段 2B 前端国际化深度重构回归测试', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    setI18nLocale('zh-CN')
    vi.restoreAllMocks()
  })

  describe('1. hotkeyRecorder 零顶层静态 t() 与热切换动态文案', () => {
    it('导出稳定 i18n key 常量，且动态 getter 随语言热切换实时变化', () => {
      expect(HOTKEY_RULE_DESCRIPTION_KEY).toBe('hotkey.recorder.ruleBase')
      expect(HOTKEY_WAIT_TEXT_KEY).toBe('hotkey.recorder.waitDefault')
      expect(HOTKEY_UNSUPPORTED_TEXT_KEY).toBe('hotkey.recorder.unsupportedWin')

      setI18nLocale('zh-CN')
      const zhRule = getDefaultHotkeyRuleDescription()
      const zhWait = getDefaultHotkeyWaitText()
      const zhUnsupported = getDefaultHotkeyUnsupportedText()
      expect(zhRule).toBe(t('hotkey.recorder.ruleBase'))
      expect(zhWait).toBe(t('hotkey.recorder.waitDefault'))
      expect(zhUnsupported).toBe(t('hotkey.recorder.unsupportedWin'))

      setI18nLocale('en-US')
      const enRule = getDefaultHotkeyRuleDescription()
      const enWait = getDefaultHotkeyWaitText()
      const enUnsupported = getDefaultHotkeyUnsupportedText()
      expect(enRule).toBe(t('hotkey.recorder.ruleBase'))
      expect(enWait).toBe(t('hotkey.recorder.waitDefault'))
      expect(enUnsupported).toBe(t('hotkey.recorder.unsupportedWin'))

      expect(enRule).not.toBe(zhRule)
      expect(enWait).not.toBe(zhWait)
      expect(enUnsupported).not.toBe(zhUnsupported)
      expect(/[\u4e00-\u9fa5]/.test(enRule)).toBe(false)
      expect(/[\u4e00-\u9fa5]/.test(enWait)).toBe(false)
      expect(/[\u4e00-\u9fa5]/.test(enUnsupported)).toBe(false)
    })
  })

  describe('2. 分类标准 categoryId 主键与旧中文分类兼容归一化', () => {
    it('isAllCategory / normalizeCategoryRouteParam / getCategoryIcon / getCategoryGlyph 同时支持标准 ID 与旧中文别名', () => {
      expect(isAllCategory('')).toBe(true)
      expect(isAllCategory(null)).toBe(true)
      expect(isAllCategory(undefined)).toBe(true)
      expect(isAllCategory(ALL_CATEGORY_ID)).toBe(true)
      expect(isAllCategory('ALL')).toBe(true)
      expect(isAllCategory('全部')).toBe(true)
      expect(isAllCategory('system')).toBe(false)

      expect(normalizeCategoryRouteParam('')).toBe('')
      expect(normalizeCategoryRouteParam('all')).toBe('')
      expect(normalizeCategoryRouteParam('全部')).toBe('')
      expect(normalizeCategoryRouteParam(FAVORITES_CATEGORY_ID)).toBe('favorites')
      expect(normalizeCategoryRouteParam('productivity')).toBe('productivity')
      expect(normalizeCategoryRouteParam('办公效率')).toBe('productivity')
      expect(normalizeCategoryRouteParam('效率工具')).toBe('productivity')
      expect(normalizeCategoryRouteParam('系统工具')).toBe('system')
      expect(normalizeCategoryRouteParam('媒体处理')).toBe('media')
      expect(normalizeCategoryRouteParam('安全工具')).toBe('security')
      expect(normalizeCategoryRouteParam('tools')).toBe('tools')

      expect(getCategoryIcon('developer')).toBe('fa-code')
      expect(getCategoryIcon('开发工具')).toBe('fa-code')
      expect(getCategoryIcon('')).toBe('fa-cube')

      expect(Object.keys(CATEGORY_GLYPHS)).toEqual(
        expect.arrayContaining(['all', 'system', 'productivity', 'files', 'media', 'developer', 'network', 'security', 'other'])
      )
      expect(getCategoryGlyph('all')).toBe('grid')
      expect(getCategoryGlyph('全部')).toBe('grid')
      expect(getCategoryGlyph('network')).toBe('wifi')
      expect(getCategoryGlyph('网络工具')).toBe('wifi')
    })

    it('mergeLocalCategories 与 StoreCatalogManager 以标准 categoryId 主键筛选，兼容旧中文分类名与语义官方标签', async () => {
      const merged = mergeLocalCategories([
        { id: 1, name: '系统工具', slug: 'system' },
        { id: 2, name: '效率工具', slug: 'office' }
      ])
      expect(merged.map((c) => c.id)).toEqual([
        'productivity',
        'system',
        'files',
        'media',
        'developer',
        'network',
        'security',
        'other'
      ])

      const manager = new StoreCatalogManager({
        fetchRemote: async () => [
          { pluginId: 'p-prod', name: 'Prod Tool', categoryId: 'productivity', author: 'ZTools Team' },
          { pluginId: 'p-legacy', name: 'Legacy Media', category: '媒体处理', author: 'community-dev', source_type: 'community' }
        ],
        getLocalSnapshot: async () => [],
        getOfficialList: () => []
      })

      const byId = await manager.query({ category: 'productivity' })
      expect(byId.list.map((p) => p.pluginId)).toEqual(['p-prod'])
      expect(byId.list[0].officialBadge).toBe(OFFICIAL_BADGE_CODE)

      const byLegacyZh = await manager.query({ category: '办公效率' })
      expect(byLegacyZh.list.map((p) => p.pluginId)).toEqual(['p-prod'])

      const mediaById = await manager.query({ category: 'media' })
      expect(mediaById.list.map((p) => p.pluginId)).toEqual(['p-legacy'])

      const bundled = getBundledPluginEntries()
      expect(bundled.length).toBeGreaterThan(0)
      for (const entry of bundled) {
        expect(entry.officialBadge).toBe(OFFICIAL_BADGE_CODE)
        expect(entry.official_badge).toBe(OFFICIAL_BADGE_CODE)
      }
    })
  })

  describe('3. Store 与运行时热切换响应式翻译（无冻结）', () => {
    it('categoriesStore 错误回退在语言热切换后实时响应，不冻结旧语种', () => {
      const store = useCategoriesStore()
      store.errorRaw = null
      store.errorKey = 'categoriesStore.loadFailed'

      setI18nLocale('zh-CN')
      const zhMsg = store.error
      expect(zhMsg).toBe(t('categoriesStore.loadFailed'))

      setI18nLocale('en-US')
      const enMsg = store.error
      expect(enMsg).toBe(t('categoriesStore.loadFailed'))
      expect(enMsg).not.toBe(zhMsg)
      expect(/[\u4e00-\u9fa5]/.test(enMsg)).toBe(false)
    })

    it('pluginsStore 平台不支持禁用原因与 StoreCatalogManager 下架原因随语言热切换实时更新', async () => {
      const pluginsStore = usePluginsStore()
      const oppositeTarget = globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ === 'darwin' ? 'windows' : 'macos'
      pluginsStore._applyPlatformSupport([
        { pluginId: 'platform-only-test', targets: [oppositeTarget] }
      ])

      setI18nLocale('zh-CN')
      const zhPlatformReason = pluginsStore.getRevokedReason('platform-only-test')
      expect(zhPlatformReason).toBeTruthy()

      setI18nLocale('en-US')
      const enPlatformReason = pluginsStore.getRevokedReason('platform-only-test')
      expect(enPlatformReason).not.toBe(zhPlatformReason)
      expect(/[\u4e00-\u9fa5]/.test(enPlatformReason)).toBe(false)

      const manager = new StoreCatalogManager({
        fetchRemote: async () => [
          {
            pluginId: 'revoked-bilingual',
            name: 'Revoked Plugin',
            revoked: true,
            revoked_reason: '安全下架',
            i18n: {
              'en-US': { revokedReason: 'Removed for security review' }
            }
          }
        ],
        getLocalSnapshot: async () => [],
        getOfficialList: () => []
      })
      await manager.ensureCatalog()

      setI18nLocale('zh-CN')
      expect(manager.isRevoked('revoked-bilingual').reason).toBe('安全下架')

      setI18nLocale('en-US')
      expect(manager.isRevoked('revoked-bilingual').reason).toBe('Removed for security review')
    })

    it('resolveErrorMessage 与 resolveResponseMessage 正确解析错误与回退译文，无空值崩溃', () => {
      setI18nLocale('en-US')
      expect(resolveErrorMessage(null, 'common.unknownError')).toBe(t('common.unknownError'))
      expect(resolveErrorMessage({}, 'common.unknownError')).toBe(t('common.unknownError'))
      expect(resolveErrorMessage({ error: 'Custom error' }, 'common.unknownError')).toBe('Custom error')
      expect(resolveErrorMessage(new Error('Boom'), 'common.unknownError')).toBe('Boom')
      expect(resolveResponseMessage({ message: 'Done' }, 'common.ok')).toBe('Done')
      expect(resolveResponseMessage({}, 'common.ok')).toBe(t('common.ok'))
    })
  })

  describe('4. ListRenderer 顶栏全局动作改用语义字段过滤，不依赖中文按钮文案', () => {
    it('存在 subList 时仅过滤带语义标记的重复批量动作，保留任意语言文本的普通动作', () => {
      const descriptor = {
        type: 'List',
        props: {
          filterBar: {
            summaryText: 'Summary',
            actions: [
              { id: 'batch-clean', label: 'Run', onAction: vi.fn() },
              { id: 'custom-role', role: 'batch-primary', label: 'Action A', onAction: vi.fn() },
              { id: 'custom-flag', hideWhenSubList: true, label: 'Action B', onAction: vi.fn() },
              { id: 'rescan', label: '批量清理日志导出', onAction: vi.fn() }
            ]
          },
          subList: {
            title: 'Details',
            items: [{ props: { id: 'sub-1', title: 'Item 1' } }]
          }
        },
        children: [
          { type: 'List.Item', props: { id: 'item-1', title: 'Row 1' } }
        ]
      }

      const wrapper = mount(ListRenderer, {
        props: { descriptor }
      })
      try {
        const texts = wrapper.findAll('button[type="button"]').map((b) => b.text().trim())
        expect(texts).toContain('批量清理日志导出')
        expect(texts).not.toContain('Run')
        expect(texts).not.toContain('Action A')
        expect(texts).not.toContain('Action B')
      } finally {
        wrapper.unmount()
      }
    })
  })
})
