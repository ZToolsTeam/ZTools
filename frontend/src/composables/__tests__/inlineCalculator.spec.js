import { describe, it, expect, vi, afterEach } from 'vitest'
import { evaluateInlineCommandItem } from '@/composables/useCommandSearch'

/** 内存版宿主插件存储：记录写到了哪个插件的空间 */
function installFakeHost() {
  const dbs = new Map()
  const call = async (method, { params }) => {
    const db = dbs.get(params.plugin_id) || new Map()
    dbs.set(params.plugin_id, db)
    if (method === 'db_get') {
      if (!db.has(params.key)) return { success: false, error: { code: 'DATABASE_KEY_NOT_FOUND', message: 'nf' } }
      return { success: true, data: { data: db.get(params.key) } }
    }
    if (method === 'db_put') { db.set(params.key, params.data ?? params.value); return { success: true, data: true } }
    return { success: true, data: null }
  }
  window.__ztoolsElectron = { transport: { methods: new Proxy({}, { get: (_t, m) => (req) => call(m, req) }) } }
  window.ztools = { clipboard: { writeText: vi.fn().mockResolvedValue(true) } }
  return dbs
}

describe('主搜索框即时计算（与内置计算器插件共用引擎）', () => {
  afterEach(() => {
    delete window.__ztoolsElectron
    delete window.ztools
  })

  it('[回归] 一元负号算对：2*-3 = -6，2^-1 = 0.5', () => {
    expect(evaluateInlineCommandItem('2*-3')?.answer).toBe('-6')
    expect(evaluateInlineCommandItem('2^-1')?.answer).toBe('0.5')
    expect(evaluateInlineCommandItem('125 * 8 + 24')?.answer).toBe('1,024')
  })

  it('[破坏性] 除以零、括号不完整、普通文字、单个数字、空输入不出结果，不抢占搜索位', () => {
    for (const q of ['100 / 0', '1 + (2 * 3', 'chrome', '42', '', '   ', '<script>alert(1)</script>']) {
      expect(evaluateInlineCommandItem(q), q).toBeNull()
    }
  })

  it('[破坏性] 单个数字、日期字面量原样回显不出结果；不存在的日期不再按减法算出数值', () => {
    for (const q of ['-12.5', '1e-9', '18446744073709551615', '2026-11-05', '2026-11-05 14:30', '2026-02-30', '2026-11-05 25:00']) {
      expect(evaluateInlineCommandItem(q), q).toBeNull()
    }
  })

  it('[回归] 进制字面量显示十进制值，日期字面量加减可算', () => {
    expect(evaluateInlineCommandItem('0xFF')?.answer).toBe('255')
    expect(evaluateInlineCommandItem('0b1010')?.answer).toBe('10')
    expect(evaluateInlineCommandItem('2026-11-05 + 3 days')?.answer).toBe('2026-11-08')
    expect(evaluateInlineCommandItem('#3b82f6')?.answer).toBe('#3B82F6')
  })

  it('[集成] 回车复制结果并把这条计算写进计算器插件自己的历史', async () => {
    const dbs = installFakeHost()
    const item = evaluateInlineCommandItem('6 * 7')
    expect(item.answer).toBe('42')
    await item.action()
    expect(window.ztools.clipboard.writeText).toHaveBeenCalledWith('42')
    const calcDb = dbs.get('calculator')
    expect(calcDb, '应写入 calculator 插件的存储空间').toBeTruthy()
    const stored = [...calcDb.values()].map((v) => (typeof v === 'string' ? JSON.parse(v) : v)).flat()
    expect(stored.some((h) => h?.expression === '6 * 7' && h?.answer === '42')).toBe(true)
  })
})
