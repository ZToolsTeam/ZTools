import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { setI18nLocale, getCurrentLocale } from '@/i18n'
import {
  getLocalizedPluginField,
  getLocalizedPluginName,
  getLocalizedPluginDescription,
  getLocalizedPluginAltNames,
  getLocalizedPluginScreenshots,
  getLocalizedFeatureExplain,
  getLocalizedFeatureCmds,
  getLocalizedFeatureAltNames,
  getLocalizedPluginKeywords,
  mergePluginI18n
} from '@/utils/pluginI18n'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'
import { normalizePluginFeatures, useCommandSearch } from '@/composables/useCommandSearch'
import { buildPluginFeatureHotkeyItems } from '@/utils/pluginFeatureHotkeys'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { normalizeCatalogEntry } from '@/api/pluginCatalog'
import { renderMarkdown } from '@/declarative/markdown'
import { describeHandoffLoss } from '@/declarative/popoutHandoff'
import { checkCompat } from '@/composables/useVersionCompat'
import { runPluginInstall } from '@/utils/pluginInstallOperation'
import { createScreenPermissionController } from '@/utils/screenPermissionController'

const SAMPLE_PLUGIN = {
  id: 'calculator',
  pluginId: 'calculator',
  name: '计算器',
  description: '输入算式即时计算与单位换算',
  category: ['办公效率'],
  categoryId: 'productivity',
  defaultLocale: 'zh-CN',
  keywords: ['calc', '计算', '汇率'],
  features: [
    {
      code: 'calc-unit',
      explain: '长度/重量/温度单位换算',
      mode: 'view',
      cmds: ['单位换算', '长度换算', { type: 'keyword', label: 'unit-alias' }]
    },
    {
      code: 'calc-rmb',
      label: '人民币大写',
      mode: 'view',
      cmds: ['大写金额']
    },
    {
      code: 'bare-feature',
      cmds: []
    }
  ],
  i18n: {
    'en-US': {
      name: 'Calculator',
      description: 'Instant expression calculator and unit conversions',
      keywords: ['Calc', 'calculator', 'math', 'currency'],
      features: {
        'calc-unit': {
          explain: 'Convert length, weight, and temperature units',
          cmds: ['unit convert', 'length convert', 'UNIT-ALIAS']
        }
      }
    }
  }
}

describe('pluginI18n 多语言 Schema 解析与容错', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setI18nLocale('zh-CN')
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
    vi.restoreAllMocks()
  })

  it('getLocalizedFeatureExplain 遵循 plugin.i18n -> feat.i18n -> feat.explain/label/code 优先级', () => {
    // 1. 优先读取 plugin.i18n[targetLocale].features[code].explain
    expect(getLocalizedFeatureExplain(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[0], 'en-US')).toBe(
      'Convert length, weight, and temperature units'
    )
    // 中文态无显式 zh-CN 覆盖时回退 feat.explain
    expect(getLocalizedFeatureExplain(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[0], 'zh-CN')).toBe(
      '长度/重量/温度单位换算'
    )

    // 2. 兼容 plugin.manifest.i18n
    const withManifestI18n = {
      id: 'demo',
      manifest: {
        i18n: {
          'en-US': {
            features: {
              run: { explain: 'Run from manifest i18n' }
            }
          }
        }
      }
    }
    expect(getLocalizedFeatureExplain(withManifestI18n, { code: 'run', explain: '运行' }, 'en-US')).toBe(
      'Run from manifest i18n'
    )

    // 3. 兼容 feat.i18n
    const featWithOwnI18n = {
      code: 'own',
      explain: '默认说明',
      i18n: {
        'en-US': { explain: 'Feature own i18n explain' }
      }
    }
    expect(getLocalizedFeatureExplain({ id: 'p' }, featWithOwnI18n, 'en-US')).toBe('Feature own i18n explain')

    // 4. 回退 feat.label 与 feat.code
    expect(getLocalizedFeatureExplain(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[1], 'en-US')).toBe('人民币大写')
    expect(getLocalizedFeatureExplain(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[2], 'en-US')).toBe('bare-feature')
  })

  it('getLocalizedFeatureCmds 合并当前语言与默认/对向语言触发词并去重过滤脏数据', () => {
    const enCmds = getLocalizedFeatureCmds(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[0], 'en-US')
    expect(enCmds[0]).toBe('unit convert')
    expect(enCmds).toContain('length convert')
    expect(enCmds).toContain('单位换算')
    expect(enCmds).toContain('长度换算')
    // UNIT-ALIAS 与对象型 { label: 'unit-alias' } 大小写不敏感去重，优先保留当前语言
    const aliasMatches = enCmds.filter((item) =>
      typeof item === 'string'
        ? item.toLowerCase() === 'unit-alias'
        : String(item?.label || '').toLowerCase() === 'unit-alias'
    )
    expect(aliasMatches).toHaveLength(1)
    expect(aliasMatches[0]).toBe('UNIT-ALIAS')

    // 中文态也包含对向英文 cmds，供中英互搜
    const zhCmds = getLocalizedFeatureCmds(SAMPLE_PLUGIN, SAMPLE_PLUGIN.features[0], 'zh-CN')
    expect(zhCmds[0]).toBe('单位换算')
    expect(zhCmds).toContain('unit convert')

    // 兼容 feat.i18n 并清洗非法项
    const dirtyFeat = {
      code: 'dirty',
      cmds: [null, 42, '', '   ', {}, { label: 'valid-obj' }, ' 默认词 '],
      i18n: {
        'en-US': { cmds: ['  English Cmd ', null, 0, 'english cmd'] }
      }
    }
    expect(getLocalizedFeatureCmds(null, dirtyFeat, 'en-US')).toEqual([
      'English Cmd',
      { label: 'valid-obj' },
      '默认词'
    ])
  })

  it('getLocalizedPluginKeywords 返回当前语言、默认字段与对向语言去重集合', () => {
    const enKeywords = getLocalizedPluginKeywords(SAMPLE_PLUGIN, 'en-US')
    expect(enKeywords[0]).toBe('Calc')
    expect(enKeywords).toEqual(['Calc', 'calculator', 'math', 'currency', '计算', '汇率'])

    const zhKeywords = getLocalizedPluginKeywords(SAMPLE_PLUGIN, 'zh-CN')
    expect(zhKeywords).toEqual(['calc', '计算', '汇率', 'calculator', 'math', 'currency'])

    // 兼容字符串格式 keywords
    const stringKeywordsPlugin = {
      id: 'str',
      keywords: 'json, 格式化，format',
      i18n: { 'en-US': { keywords: 'JSON, beautify' } }
    }
    expect(getLocalizedPluginKeywords(stringKeywordsPlugin, 'en-US')).toEqual([
      'JSON',
      'beautify',
      '格式化',
      'format'
    ])
  })

  it('getLocalizedFeatureAltNames 收集对向语言说明并排除当前主说明', () => {
    const alts = getLocalizedFeatureAltNames(
      SAMPLE_PLUGIN,
      SAMPLE_PLUGIN.features[0],
      'Convert length, weight, and temperature units'
    )
    expect(alts).toEqual(['长度/重量/温度单位换算'])
  })

  it('mergePluginI18n 合并多源 i18n、按 code 合并 features 并防御原型污染', () => {
    const remote = {
      'en-US': {
        name: 'Old Calc',
        description: 'Old desc',
        features: {
          'calc-unit': { explain: 'Old unit', cmds: ['old'] },
          'extra-feat': { explain: 'Remote only' }
        }
      }
    }
    const local = {
      'en-US': {
        name: 'Calculator',
        features: {
          'calc-unit': { explain: 'New unit' }
        }
      },
      '__proto__': { polluted: true }
    }
    const merged = mergePluginI18n(remote, local)
    expect(merged['en-US'].name).toBe('Calculator')
    expect(merged['en-US'].description).toBe('Old desc')
    expect(merged['en-US'].features['calc-unit']).toEqual({ explain: 'New unit', cmds: ['old'] })
    expect(merged['en-US'].features['extra-feat']).toEqual({ explain: 'Remote only' })
    expect(({}).polluted).toBeUndefined()
    expect(mergePluginI18n(null, undefined, [], {})).toBeUndefined()
  })

  it('[破坏性] 空值、原始值与畸形结构不抛错且安全回退', () => {
    for (const bad of [null, undefined, '', 123, true, [], { i18n: null }, { i18n: [] }]) {
      expect(getLocalizedPluginField(bad, 'name', 'en-US')).toBe('')
      expect(getLocalizedPluginName(bad, 'en-US')).toBe('')
      expect(getLocalizedPluginDescription(bad, 'en-US')).toBe('')
      expect(getLocalizedPluginAltNames(bad)).toEqual([])
      expect(getLocalizedFeatureExplain(bad, bad, 'en-US')).toBe('')
      expect(getLocalizedFeatureCmds(bad, bad, 'en-US')).toEqual([])
      expect(getLocalizedFeatureAltNames(bad, bad)).toEqual([])
      expect(getLocalizedPluginKeywords(bad, 'en-US')).toEqual([])
    }

    expect(
      getLocalizedFeatureExplain(
        { i18n: { 'en-US': { features: null } } },
        { code: 'f1', explain: '   ', i18n: 'invalid' },
        'en-US'
      )
    ).toBe('f1')
  })

  it('兼容 manifest.i18n 非精确变体键、AltNames 读取 manifest.i18n 且截图兼容 url/file/path', () => {
    const manifestPlugin = {
      id: 'variant-demo',
      name: '变体插件',
      icon: 'https://cdn.ztools.cn/plugins-v2/official/variant-demo/icon.svg',
      manifest: {
        i18n: {
          'ja-JP': { name: 'バリアント', description: '日本語のみ' },
          'en-GB': {
            name: 'Variant Plugin',
            description: 'Supports en-GB variant key',
            screenshots: [{ file: 'screenshots/en-US/01.png', title: 'Main' }]
          },
          'zh-Hans': {
            name: '变体插件简体',
            screenshots: [{ path: 'https://cdn.ztools.cn/plugins-v2/official/variant-demo/screenshots/01.png', title: '中文' }]
          }
        }
      }
    }

    expect(getLocalizedPluginName(manifestPlugin, 'en-US')).toBe('Variant Plugin')
    expect(getLocalizedPluginName(manifestPlugin, 'zh-CN')).toBe('变体插件简体')

    // 仅有第三语种 ja-JP 时绝不误判为 en-US
    const jaOnly = {
      id: 'ja-only',
      name: '默认名称',
      manifest: { i18n: { 'ja-JP': { name: '日本語ツール' } } }
    }
    expect(getLocalizedPluginName(jaOnly, 'en-US')).toBe('默认名称')

    // getLocalizedPluginAltNames 补全对 manifest.i18n 的读取
    const alts = getLocalizedPluginAltNames(manifestPlugin, 'Variant Plugin')
    expect(alts).toContain('变体插件')
    expect(alts).toContain('变体插件简体')

    // 截图兼容 file（配合可信基准 URL 解析）与 path（完整安全 URL）
    const enShots = getLocalizedPluginScreenshots(manifestPlugin, 'en-US')
    expect(enShots).toHaveLength(1)
    expect(enShots[0].url).toBe('https://cdn.ztools.cn/plugins-v2/official/variant-demo/screenshots/en-US/01.png')
    const zhShots = getLocalizedPluginScreenshots(manifestPlugin, 'zh-CN')
    expect(zhShots).toHaveLength(1)
    expect(zhShots[0].url).toBe('https://cdn.ztools.cn/plugins-v2/official/variant-demo/screenshots/01.png')
  })

  it('pluginFeatureHotkeys 兼容非精确 i18n 键并在无 cmds 时优先读取规范 explain 字段', () => {
    setI18nLocale('en-US')
    const items = buildPluginFeatureHotkeyItems([
      {
        pluginId: 'ocr-ext',
        name: '识图扩展',
        features: [{ code: 'table-scan', explain: '表格识别', cmds: [] }],
        i18n: {
          'ja-JP': { name: '日本語', features: { 'table-scan': { explain: 'テーブル' } } },
          en: {
            name: 'OCR Extended',
            features: {
              'table-scan': { explain: 'Recognize tables from screen' }
            }
          }
        }
      }
    ])
    const tableItem = items.find((item) => item.featureCode === 'table-scan')
    expect(tableItem).toMatchObject({
      pluginName: 'OCR Extended',
      featureName: 'Recognize tables from screen',
      description: 'Recognize tables from screen'
    })
  })

  it('declarativePluginLoader 返回的 name / title / featureExplain 随语言热切换实时更新', async () => {
    setI18nLocale('zh-CN')
    const manifest = {
      id: 'hot-switch-demo',
      name: '热切换插件',
      description: '中文简介',
      entry: 'dist/index.js',
      features: [{ code: 'quick', explain: '快速打开' }],
      i18n: {
        'en-US': {
          name: 'Hot Switch Plugin',
          description: 'English summary',
          features: { quick: { explain: 'Quick open' } }
        }
      }
    }
    const loaded = await loadInstalledDeclarativePlugin('hot-switch-demo', {
      featureCode: 'quick',
      readFile: async (_pid, relPath) => {
        if (relPath === 'plugin.json') return JSON.stringify(manifest)
        return 'module.exports = function Demo() { return null }'
      }
    })

    expect(loaded.name).toBe('热切换插件')
    expect(loaded.title).toBe('热切换插件')
    expect(loaded.featureExplain).toBe('快速打开')
    expect(loaded.description).toBe('中文简介')

    setI18nLocale('en-US')
    expect(loaded.name).toBe('Hot Switch Plugin')
    expect(loaded.title).toBe('Hot Switch Plugin')
    expect(loaded.featureExplain).toBe('Quick open')
    expect(loaded.description).toBe('English summary')
  })
})

describe('跨模块多语言集成验证（搜索 / 功能热键 / 市场目录 / 渲染器 / 弹窗）', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setActivePinia(createPinia())
    setI18nLocale('en-US')
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
    vi.restoreAllMocks()
    delete window.__ztoolsElectron
    delete window.__ztoolsPermissionPrompt
    delete window.__ztoolsRegionSelection
    delete window.ztoolsRuntimeCapabilityPrompt
  })

  it('英文态下 useCommandSearch 正确本地化子命令并支持英文与中英互搜', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [SAMPLE_PLUGIN]

    const normalized = normalizePluginFeatures(SAMPLE_PLUGIN, 'en-US')
    expect(normalized[0].explain).toBe('Convert length, weight, and temperature units')
    expect(normalized[0].cmds[0]).toBe('unit convert')
    expect(normalized[0].altNames).toContain('长度/重量/温度单位换算')

    const { filteredItems, search } = useCommandSearch({ enableFileSearch: false })

    // 搜英文关键词命中主插件
    search('math')
    expect(filteredItems.value.some((item) => item.key === 'calculator' && item.name === 'Calculator')).toBe(true)

    // 搜英文子命令词命中本地化后的英文子命令
    search('unit convert')
    const enFeat = filteredItems.value.find((item) => item.key === 'calculator:calc-unit')
    expect(enFeat).toBeTruthy()
    expect(enFeat.name).toBe('Convert length, weight, and temperature units')

    // 英文态下搜中文子命令触发词依然能中英互搜命中
    search('单位换算')
    expect(filteredItems.value.some((item) => item.key === 'calculator:calc-unit')).toBe(true)
  })

  it('英文态下 pluginFeatureHotkeys 读取 plugin.i18n[locale].features[code]', () => {
    const items = buildPluginFeatureHotkeyItems([SAMPLE_PLUGIN])
    const unitItem = items.find((item) => item.featureCode === 'calc-unit')
    expect(unitItem).toMatchObject({
      pluginName: 'Calculator',
      featureName: 'unit convert',
      description: 'Convert length, weight, and temperature units'
    })
  })

  it('插件市场合并元数据保留 i18n/defaultLocale/categoryId 且英文态可按英文名/英文关键词检索', async () => {
    const remote = [
      {
        id: 'calculator',
        name: '计算器',
        description: '旧描述',
        downloads: 100
      },
      {
        id: 'community-demo',
        name: '社区工具',
        description: '中文描述',
        defaultLocale: 'zh-CN',
        categoryId: 'developer',
        i18n: {
          'en-US': {
            name: 'Community Helper',
            description: 'Fast developer utility',
            keywords: ['devtool', 'snippet']
          }
        }
      }
    ]
    const manager = new StoreCatalogManager({
      fetchRemote: async () => ({ plugins: remote }),
      getOfficialList: () => [SAMPLE_PLUGIN]
    })

    const { catalog } = await manager.ensureCatalog(true)
    const calc = catalog.find((p) => p.pluginId === 'calculator')
    expect(calc.defaultLocale).toBe('zh-CN')
    expect(calc.categoryId).toBe('productivity')
    expect(calc.i18n?.['en-US']?.name).toBe('Calculator')

    // 英文态按英文名、英文关键词、英文描述搜索
    expect((await manager.query({ keyword: 'Calculator' })).list.map((p) => p.pluginId)).toEqual(['calculator'])
    expect((await manager.query({ keyword: 'devtool' })).list.map((p) => p.pluginId)).toEqual(['community-demo'])
    expect((await manager.query({ keyword: 'developer utility' })).list.map((p) => p.pluginId)).toEqual(['community-demo'])
    // 英文态仍支持搜中文名
    expect((await manager.query({ keyword: '计算器' })).list.map((p) => p.pluginId)).toEqual(['calculator'])

    // api/pluginCatalog.normalizeCatalogEntry 保留 i18n / defaultLocale / categoryId
    const entry = normalizeCatalogEntry(remote[1])
    expect(entry.defaultLocale).toBe('zh-CN')
    expect(entry.categoryId).toBe('developer')
    expect(entry.i18n?.['en-US']?.name).toBe('Community Helper')
  })

  it('英文态下 Markdown Alert/任务列表、弹窗交接、版本兼容、安装操作与权限控制器均输出英文文案', async () => {
    const mdHtml = renderMarkdown('> [!TIP]\n> Press Ctrl+K\n\n- [x] Done\n- [ ] Todo')
    expect(mdHtml).toContain('>Tip</strong>')
    expect(mdHtml).toContain('aria-label="Completed"')
    expect(mdHtml).toContain('aria-label="Incomplete"')

    expect(describeHandoffLoss({ oversized: true })).toContain('too large')
    expect(describeHandoffLoss({ rejected: ['fn'] })).toContain('pop-out window')

    const compatApp = checkCompat({ minAppVersion: '3.0.0' }, '2.0.0', '1.0.0')
    expect(compatApp.compatible).toBe(false)
    expect(compatApp.reason).toContain('This plugin requires App >= 3.0.0')

    const compatWeb = checkCompat({ minWebVersion: '2.0.0' }, '3.0.0', '1.0.0')
    expect(compatWeb.compatible).toBe(false)
    expect(compatWeb.reason).toContain('This plugin requires Web >= 2.0.0')

    await expect(runPluginInstall({ pluginId: 'demo', start: vi.fn(), events: null, getStatus: vi.fn() })).rejects.toThrow(
      'Client installation notifications are unavailable'
    )

    const onChange = vi.fn()
    const ctrl = createScreenPermissionController(
      {
        sys: { getCapability: vi.fn().mockRejectedValue(new Error('boom')) },
        events: { on: vi.fn(), off: vi.fn() }
      },
      onChange
    )
    await ctrl.start()
    expect(onChange.mock.lastCall[0].error).toContain('Unable to read current permission status')
  })

  it('独立平台弹窗页面在英文态自动切换文案，且静态 HTML 保留中文兜底', () => {
    const platformDir = path.resolve(__dirname, '../../../public/platform')

    // 1. region-selector
    const regionHtml = readFileSync(path.join(platformDir, 'region-selector.html'), 'utf-8')
    const regionJs = readFileSync(path.join(platformDir, 'region-selector.js'), 'utf-8')
    expect(regionHtml).toContain('选择截图区域')
    expect(regionHtml).toContain('取消')

    document.documentElement.innerHTML = regionHtml.replace(/^<!doctype html>/i, '')
    window.__ztoolsElectron = { initialLocale: 'en-US' }
    window.__ztoolsRegionSelection = { submit: vi.fn(), cancel: vi.fn() }
    new Function(regionJs)()
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Select Capture Area')
    expect(document.getElementById('confirm')?.textContent).toBe('Capture · Enter')
    expect(document.getElementById('cancel')?.textContent).toBe('Cancel')
    expect(document.getElementById('hint')?.textContent).toContain('Drag to select')

    // 2. runtime-permission-consent
    const consentHtml = readFileSync(path.join(platformDir, 'runtime-permission-consent.html'), 'utf-8')
    const consentJs = readFileSync(path.join(platformDir, 'runtime-permission-consent.js'), 'utf-8')
    expect(consentHtml).toContain('是否允许该插件获取屏幕画面')
    expect(consentHtml).toContain('允许访问')

    document.documentElement.innerHTML = consentHtml.replace(/^<!doctype html>/i, '')
    delete window.__ztoolsElectron
    window.__ztoolsPermissionPrompt = { locale: 'en-US' }
    window.ztoolsRuntimeCapabilityPrompt = {
      onRequest: vi.fn(() => () => {}),
      answer: vi.fn().mockResolvedValue({ success: true })
    }
    new Function(consentJs)()
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.title).toBe('Plugin Screen Access Request')
    expect(document.getElementById('prompt-title')?.textContent).toBe('Allow this plugin to capture your screen?')
    expect(document.getElementById('runtime-capability-deny')?.textContent).toBe('Deny')
    expect(document.getElementById('runtime-capability-allow')?.textContent).toBe('Allow Access')
  })
})
