import { describe, it, expect } from 'vitest'
import {
  PLUGIN_CATEGORIES,
  CATEGORY_ICON_MAP,
  CATEGORY_ID_TO_NAME,
  CATEGORY_NAME_TO_ID,
  getCategoryId,
  normalizeCategoryIds,
  getPluginCategoryIds,
  normalizeCategoryNames,
  getPluginCategories,
  sortCategories
} from '../pluginCategories.js'

describe('pluginCategories utils', () => {
  describe('metadata and maps', () => {
    it('defines 8 stable category ids with backwards-compatible names and icons', () => {
      const expectedIds = [
        'productivity',
        'system',
        'files',
        'media',
        'developer',
        'network',
        'security',
        'other'
      ]
      expect(PLUGIN_CATEGORIES.map((c) => c.id)).toEqual(expectedIds)
      expect(Object.isFrozen(PLUGIN_CATEGORIES)).toBe(true)
      expect(Object.isFrozen(CATEGORY_ID_TO_NAME)).toBe(true)
      expect(Object.isFrozen(CATEGORY_NAME_TO_ID)).toBe(true)

      for (const cat of PLUGIN_CATEGORIES) {
        expect(CATEGORY_ID_TO_NAME[cat.id]).toBe(cat.name)
        expect(CATEGORY_NAME_TO_ID[cat.name]).toBe(cat.id)
        expect(CATEGORY_ICON_MAP[cat.name]).toBe(cat.icon)
      }
    })
  })

  describe('getCategoryId', () => {
    it('resolves Chinese names, stable ids, and English/Chinese aliases case-insensitively', () => {
      expect(getCategoryId('办公效率')).toBe('productivity')
      expect(getCategoryId('productivity')).toBe('productivity')
      expect(getCategoryId('  AI 工具  ')).toBe('productivity')
      expect(getCategoryId('OFFICE')).toBe('productivity')
      expect(getCategoryId('系统工具')).toBe('system')
      expect(getCategoryId('storage')).toBe('files')
      expect(getCategoryId('设计工具')).toBe('media')
      expect(getCategoryId('DEV')).toBe('developer')
      expect(getCategoryId('browser')).toBe('network')
      expect(getCategoryId('安全工具')).toBe('security')
      expect(getCategoryId('其他工具')).toBe('other')
      expect(getCategoryId('other')).toBe('other')
    })

    it('falls back to other for unknown or non-string inputs', () => {
      expect(getCategoryId('unknown-category')).toBe('other')
      expect(getCategoryId('')).toBe('other')
      expect(getCategoryId('   ')).toBe('other')
      expect(getCategoryId(null)).toBe('other')
      expect(getCategoryId(undefined)).toBe('other')
      expect(getCategoryId(0)).toBe('other')
      expect(getCategoryId({})).toBe('other')
      expect(getCategoryId([])).toBe('other')
    })
  })

  describe('normalizeCategoryIds and getPluginCategoryIds', () => {
    it('normalizes delimited strings and arrays and deduplicates ids', () => {
      expect(normalizeCategoryIds('开发工具 / 网络工具 · dev')).toEqual(['developer', 'network'])
      expect(normalizeCategoryIds(['AI工具', 'office', '安全隐私／files'])).toEqual([
        'productivity',
        'security',
        'files'
      ])
      expect(normalizeCategoryIds(['未知分类', 'other'])).toEqual(['other'])
    })

    it('ignores non-string or empty items and falls back to [other] in getPluginCategoryIds', () => {
      expect(normalizeCategoryIds(null)).toEqual([])
      expect(normalizeCategoryIds(undefined)).toEqual([])
      expect(normalizeCategoryIds(0)).toEqual([])
      expect(normalizeCategoryIds('')).toEqual([])
      expect(normalizeCategoryIds([null, undefined, 0, '', '   '])).toEqual([])
      expect(normalizeCategoryIds([0, null, 'developer', {}])).toEqual(['developer'])

      expect(getPluginCategoryIds(null)).toEqual(['other'])
      expect(getPluginCategoryIds(undefined)).toEqual(['other'])
      expect(getPluginCategoryIds(0)).toEqual(['other'])
      expect(getPluginCategoryIds([])).toEqual(['other'])
      expect(getPluginCategoryIds('dev / system')).toEqual(['developer', 'system'])
    })
  })

  describe('backwards-compatible name helpers and sortCategories', () => {
    it('preserves normalizeCategoryNames and getPluginCategories behavior', () => {
      expect(normalizeCategoryNames('dev / AI 工具')).toEqual(['开发工具', '办公效率'])
      expect(normalizeCategoryNames('other')).toEqual(['其他工具'])
      expect(normalizeCategoryNames(null)).toEqual([])
      expect(getPluginCategories(undefined)).toEqual(['其他工具'])
      expect(getPluginCategories(0)).toEqual(['其他工具'])
    })

    it('sorts categories by canonical order using either name or id', () => {
      const byName = sortCategories([
        { name: '其他工具' },
        { name: '开发工具' },
        { name: '办公效率' }
      ])
      expect(byName.map((c) => c.name)).toEqual(['办公效率', '开发工具', '其他工具'])

      const byId = sortCategories([
        { id: 'security', name: 'Security' },
        { id: 'files', name: 'Files' },
        { id: 'productivity', name: 'Productivity' }
      ])
      expect(byId.map((c) => c.id)).toEqual(['productivity', 'files', 'security'])
    })
  })
})
