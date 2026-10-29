import { describe, it, expect } from 'vitest'
import {
  MATCH_TIERS,
  compareMatches,
  filterAndRankItems,
  findPinyinMatchInText,
  getCharPinyins,
  getHighlightPartsWithPinyin,
  getPinyinFull,
  getPinyinInitials,
  matchItemWithQuery,
  splitHighlightParts
} from '../pinyinSearch.js'

const plugin = (pluginId, name, extra = {}) => ({ key: pluginId, pluginId, name, type: 'plugin', ...extra })
const app = (name, english) => ({ key: `file:/Applications/${english}.app`, name, altNames: english !== name ? [english] : [], isApplication: true, type: 'file' })

// 名称取自真实插件清单与常见程序，用来固定「输入什么，第一名应该是什么」
const FIXTURE = [
  plugin('screenshot', '截图历史'),
  plugin('clipboard-manager', '剪贴板历史'),
  plugin('system-tools', '系统工具', { keywords: ['系统工具', '锁屏', '睡眠', '关机', '音量'] }),
  plugin('system-backup', '系统备份'),
  plugin('batch-rename', '批量重命名', { description: '批量修改文件夹里的文件名：查找替换、加前缀 / 后缀' }),
  plugin('batch-image', '图片批量压缩', { keywords: ['压缩', '图片'] }),
  plugin('json-format', 'JSON 格式化', { keywords: ['json'] }),
  plugin('everything-file-search', '文件秒搜'),
  plugin('file-unlock', '文件解锁'),
  plugin('wechat-cleaner', '微信清理'),
  plugin('wechat-multi', '微信多开'),
  plugin('browser-bookmarks', '浏览器书签', { cmds: ['chrome书签'] }),
  plugin('docker-manager', 'Docker 管理', { keywords: ['docker', 'ps'] }),
  plugin('weak-desc', '通用效率工具', { description: '支持导出到微信、Visual Studio Code 或 Photoshop 的辅助说明' }),
  { key: 'system-settings', name: '系统设置', description: '查看或配置全局快捷键、窗口呼出形态偏好' },
  app('微信', 'WeChat'),
  app('系统设置', 'System Settings'),
  app('Visual Studio Code', 'Visual Studio Code'),
  app('Google Chrome', 'Google Chrome'),
  app('Adobe Photoshop 2024', 'Adobe Photoshop 2024'),
  app('网易云音乐', 'NeteaseMusic'),
  app('计算器', 'Calculator'),
  app('访达', 'Finder')
]

const top = (query, n = 1) => filterAndRankItems(FIXTURE, query).slice(0, n).map((item) => item.name)

describe('搜索匹配：按匹配档取最好的一档，不累加', () => {
  it.each([
    ['wx', '微信'],
    ['weixin', '微信'],
    ['wechat', '微信'],
    ['jt', '截图历史'],
    ['jietu', '截图历史'],
    ['cmm', '批量重命名'],
    ['plcmm', '批量重命名'],
    ['vsc', 'Visual Studio Code'],
    ['chrome', 'Google Chrome'],
    ['json', 'JSON 格式化'],
    ['xtsz', '系统设置'],
    ['wyy', '网易云音乐'],
    ['finder', '访达'],
    ['fd', '访达'],
    ['截图', '截图历史'],
    ['文件', '文件秒搜'],
    ['wenjian', '文件秒搜']
  ])('%s → 第一名 %s', (query, expected) => {
    expect(top(query)).toEqual([expected])
  })

  it('多音字的非常用读音也能命中，但同档时排在常用读音之后（jt：截图在系统工具之前）', () => {
    const jt = matchItemWithQuery(FIXTURE.find((i) => i.name === '截图历史'), 'jt')
    const xt = matchItemWithQuery(FIXTURE.find((i) => i.name === '系统工具'), 'jt')
    expect(jt).toMatchObject({ matched: true, tier: MATCH_TIERS.PREFIX, secondary: false })
    expect(xt).toMatchObject({ matched: true, tier: MATCH_TIERS.PREFIX, secondary: true })
    expect(compareMatches(jt, xt)).toBeLessThan(0)
  })

  it('不同字段的命中不累加：名称、触发词都含查询词的条目不会压过名称完全一致的条目', () => {
    const exact = matchItemWithQuery(plugin('a', '压缩'), '压缩')
    const stacked = matchItemWithQuery(plugin('b', '压缩工具箱', { keywords: ['压缩', '压缩包'], description: '压缩与解压', category: '压缩' }), '压缩')
    expect(exact.tier).toBe(MATCH_TIERS.EXACT)
    expect(stacked.tier).toBe(MATCH_TIERS.EXACT)
    expect(stacked.field).toBeGreaterThan(exact.field)
    expect(compareMatches(exact, stacked)).toBeLessThan(0)
  })

  it('首字母或全拼全部对上算完全一致，只对上开头算开头一致，从中间开始算中间一致，只在描述里出现最低', () => {
    const wechat = FIXTURE.find((i) => i.name === '微信')
    expect(matchItemWithQuery(wechat, 'wx').tier).toBe(MATCH_TIERS.EXACT)
    expect(matchItemWithQuery(wechat, 'weix').tier).toBe(MATCH_TIERS.EXACT)
    expect(matchItemWithQuery(wechat, 'weixi').tier).toBe(MATCH_TIERS.PREFIX)
    expect(matchItemWithQuery(plugin('m', '微信多开'), 'wx').tier).toBe(MATCH_TIERS.PREFIX)
    expect(matchItemWithQuery(plugin('r', '批量重命名'), 'cmm').tier).toBe(MATCH_TIERS.INNER)
    expect(matchItemWithQuery(plugin('d', '通用工具', { description: '导出到微信' }), '微信').tier).toBe(MATCH_TIERS.DESCRIPTION)
  })

  it('英文名后面单词的开头算开头一致；单词内按顺序出现的字母（ps → Photoshop）只算中间一致', () => {
    const chrome = FIXTURE.find((i) => i.name === 'Google Chrome')
    expect(matchItemWithQuery(chrome, 'chrome').tier).toBe(MATCH_TIERS.PREFIX)
    expect(matchItemWithQuery(chrome, 'gc').tier).toBe(MATCH_TIERS.EXACT)
    const photoshop = FIXTURE.find((i) => i.name === 'Adobe Photoshop 2024')
    expect(matchItemWithQuery(photoshop, 'ps')).toMatchObject({ matched: true, tier: MATCH_TIERS.INNER })
    // 触发词明确写了 ps 的插件更相关
    expect(top('ps')).toEqual(['Docker 管理'])
  })

  it('别名完全一致高于一切，别名开头一致算开头一致', () => {
    const item = plugin('audio', '音频百宝箱', { alias: 'aud' })
    expect(matchItemWithQuery(item, 'aud').tier).toBe(MATCH_TIERS.ALIAS)
    expect(matchItemWithQuery(item, 'au').tier).toBe(MATCH_TIERS.PREFIX)
  })

  it('只输入一个英文字母时只认开头一致，名称中间与描述里碰巧出现的字母不算', () => {
    const names = filterAndRankItems(FIXTURE, 'p').map((i) => i.name)
    expect(names).toContain('批量重命名')
    expect(names).not.toContain('Adobe Photoshop 2024')
    expect(names).not.toContain('通用效率工具')
    // 单个汉字可以命中名称中间
    expect(filterAndRankItems(FIXTURE, '图').map((i) => i.name)).toContain('截图历史')
  })

  it('查询里有空格：整句、去掉空格的拼音、各词都要命中依次尝试', () => {
    expect(top('wei xin')).toEqual(['微信'])
    expect(top('google chrome')).toEqual(['Google Chrome'])
    expect(filterAndRankItems(FIXTURE, '批量 压缩').map((i) => i.name)).toEqual(['图片批量压缩'])
    expect(filterAndRankItems(FIXTURE, '批量 不存在')).toEqual([])
  })

  it('插件标识只认整体或单词开头，最多算中间一致', () => {
    const item = plugin('file-renamer', '批量重命名')
    expect(matchItemWithQuery(item, 'renamer')).toMatchObject({ matched: true, tier: MATCH_TIERS.INNER })
    expect(matchItemWithQuery(item, 'enamer').matched).toBe(false)
  })

  it('靠触发词命中时，不高亮名称里靠多音字非常用读音碰巧对上的字；名称原文命中照常高亮', () => {
    expect(matchItemWithQuery(plugin('s', '系统设置'), 'jt')).toMatchObject({ secondary: true, range: [0, 2] })
    const byKeyword = matchItemWithQuery(plugin('c', '前景色与背景色对比度', { keywords: ['ys'] }), 'ys')
    expect(byKeyword).toMatchObject({ tier: MATCH_TIERS.EXACT, field: 1, range: null })
    expect(matchItemWithQuery(plugin('j', 'JSON 格式化', { keywords: ['json'] }), 'json').range).toEqual([0, 4])
  })

  it('[边界] 小写后长度会变的字符（土耳其语 İ）不让命中位置错位', () => {
    const item = plugin('izmir', 'İzmir Map')
    expect(matchItemWithQuery(item, 'map')).toMatchObject({ tier: MATCH_TIERS.PREFIX, range: [6, 9] })
    expect(getHighlightPartsWithPinyin('İzmir Map', 'map')).toEqual([{ text: 'İzmir ', hit: false }, { text: 'Map', hit: true }])
  })

  it('[边界] 空查询、空白、畸形条目与超长查询', () => {
    expect(matchItemWithQuery(null, 'a').matched).toBe(false)
    expect(matchItemWithQuery({}, 'a').matched).toBe(false)
    expect(matchItemWithQuery(plugin('x', '任意'), '   ').matched).toBe(true)
    expect(filterAndRankItems(FIXTURE, '')).toHaveLength(FIXTURE.length)
    expect(filterAndRankItems('not-array', 'a')).toEqual([])
    expect(filterAndRankItems(FIXTURE, 'x'.repeat(300))).toEqual([])
    expect(filterAndRankItems(FIXTURE, '@@@###')).toEqual([])
    expect(matchItemWithQuery({ name: 123, keywords: [null, 1, ''], cmds: [{}, null] }, '123').matched).toBe(true)
  })
})

describe('拼音工具与高亮区间', () => {
  it('首字母、全拼按上下文取常用读音，生僻字与标点不报错', () => {
    expect(getPinyinInitials('批量音频处理')).toBe('plypcl')
    expect(getPinyinInitials('系统设置')).toBe('xtsz')
    expect(getPinyinInitials('PDF 工具箱')).toBe('pdfgjx')
    expect(getPinyinFull('网易云音乐')).toBe('wangyiyunyinyue')
    expect(getPinyinFull('绿色')).toBe('lvse')
    expect(getCharPinyins('重')).toEqual(expect.arrayContaining(['zhong', 'chong']))
    expect(getCharPinyins('a')).toEqual(['a'])
    expect(getCharPinyins('（')).toEqual([])
    expect(getPinyinInitials('𠀾，测试')).toBe('cs')
  })

  it('高亮区间对应原文（含拼音命中与英文单词开头）', () => {
    const text = (parts) => parts.map((p) => (p.hit ? `[${p.text}]` : p.text)).join('')
    expect(text(getHighlightPartsWithPinyin('批量重命名', 'cmm'))).toBe('批量[重命名]')
    expect(text(getHighlightPartsWithPinyin('Google Chrome', 'chrome'))).toBe('Google [Chrome]')
    expect(text(getHighlightPartsWithPinyin('微信', 'wx'))).toBe('[微信]')
    expect(text(getHighlightPartsWithPinyin('访达', 'zzz'))).toBe('访达')
    expect(findPinyinMatchInText('截图历史', 'jietu')).toMatchObject({ matched: true, range: [0, 2], matchType: 'pinyin-prefix' })
    expect(splitHighlightParts('abc', [5, 9])).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlightParts('abc', null)).toEqual([{ text: 'abc', hit: false }])
    expect(splitHighlightParts('', [0, 1])).toEqual([{ text: '', hit: false }])
  })
})
