/**
 * 测试运行器
 * 提供测试套件注册、执行、断言和结果汇总
 */

const { CDPClient } = require('./cdp-client.cjs')

// 解析命令行参数
const CONFIG = {
  verbose: process.argv.includes('--verbose'),
  suite: (() => {
    const arg = process.argv.find((a) => a.startsWith('--suite='))
    return arg ? arg.split('=')[1] : null // api | e2e | null(全部)
  })(),
  filter: (() => {
    const arg = process.argv.find((a) => a.startsWith('--filter='))
    return arg ? arg.split('=')[1] : null
  })(),
  port: (() => {
    const arg = process.argv.find((a) => a.startsWith('--port='))
    return arg ? parseInt(arg.split('=')[1]) : 9222
  })()
}

// 日志工具
const log = {
  info: (msg) => console.log(`\n📋 ${msg}`),
  pass: (msg) => console.log(`  ✅ ${msg}`),
  fail: (msg) => console.error(`  ❌ ${msg}`),
  warn: (msg) => console.warn(`  ⚠️  ${msg}`),
  debug: (msg) => CONFIG.verbose && console.log(`  🔍 ${msg}`),
  section: (msg) => console.log(`\n${'═'.repeat(60)}\n  ${msg}\n${'═'.repeat(60)}`),
}

// 断言工具
const assert = {
  /** 值为真 */
  ok(value, msg = '期望值为真') {
    if (!value) throw new Error(`${msg}，实际: ${JSON.stringify(value)}`)
  },
  /** 严格相等 */
  equal(actual, expected, msg = '期望相等') {
    if (actual !== expected) {
      throw new Error(`${msg}，期望: ${JSON.stringify(expected)}，实际: ${JSON.stringify(actual)}`)
    }
  },
  /** 深度相等 */
  deepEqual(actual, expected, msg = '期望深度相等') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${msg}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`)
    }
  },
  /** 值的类型 */
  typeOf(value, type, msg) {
    const actual = typeof value
    if (actual !== type) {
      throw new Error(`${msg || '类型不匹配'}，期望: ${type}，实际: ${actual}`)
    }
  },
  /** 值包含子串或属性 */
  includes(haystack, needle, msg) {
    if (typeof haystack === 'string') {
      if (!haystack.includes(needle)) {
        throw new Error(`${msg || '期望包含子串'}，"${needle}" 不在 "${haystack.substring(0, 100)}" 中`)
      }
    } else if (Array.isArray(haystack)) {
      if (!haystack.includes(needle)) {
        throw new Error(`${msg || '期望数组包含元素'}，${JSON.stringify(needle)} 不在数组中`)
      }
    } else {
      throw new Error('includes 仅支持 string 和 array')
    }
  },
  /** 值匹配正则 */
  match(value, regex, msg) {
    if (!regex.test(value)) {
      throw new Error(`${msg || '期望匹配正则'}，"${value}" 不匹配 ${regex}`)
    }
  },
  /** 值大于 */
  gt(actual, expected, msg) {
    if (!(actual > expected)) {
      throw new Error(`${msg || '期望大于'}，${actual} 不大于 ${expected}`)
    }
  },
  /** 值大于等于 */
  gte(actual, expected, msg) {
    if (!(actual >= expected)) {
      throw new Error(`${msg || '期望大于等于'}，${actual} 不大于等于 ${expected}`)
    }
  },
  /** 不抛异常 */
  async doesNotThrow(fn, msg) {
    try {
      await fn()
    } catch (e) {
      throw new Error(`${msg || '期望不抛异常'}，但抛出: ${e.message}`)
    }
  },
  /** 期望抛异常 */
  async throws(fn, msg) {
    try {
      await fn()
      throw new Error(`${msg || '期望抛出异常'}，但未抛出`)
    } catch (e) {
      if (e.message.startsWith(msg || '期望抛出异常')) throw e
      return e
    }
  }
}

class TestRunner {
  constructor() {
    this.cdp = new CDPClient({ port: CONFIG.port })
    this.results = []
    this._connected = false
  }

  /** 确保 CDP 已连接 */
  async ensureConnected() {
    if (this._connected) return
    const target = await this.cdp.connect('ZTools')
    log.info(`已连接: ${target.title} (${target.url})`)
    this._connected = true
  }

  /** 运行一个测试套件 */
  async runSuite(name, tests) {
    // 过滤
    if (CONFIG.filter && !name.includes(CONFIG.filter)) return
    
    log.section(`${name}`)
    let passed = 0
    let failed = 0
    let skipped = 0

    for (const test of tests) {
      try {
        await test.fn(this.cdp, assert)
        log.pass(test.name)
        passed++
      } catch (err) {
        log.fail(`${test.name}: ${err.message}`)
        if (CONFIG.verbose && err.stack) {
          console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`)
        }
        failed++
      }
    }

    this.results.push({ suite: name, passed, failed, skipped, total: tests.length })
    log.info(`结果: ${passed}/${tests.length} 通过${failed ? `，${failed} 失败` : ''}`)
  }

  /** 打印汇总并返回是否全部通过 */
  printSummary() {
    log.section('测试汇总')
    let totalPassed = 0
    let totalFailed = 0

    for (const r of this.results) {
      const icon = r.failed === 0 ? '✅' : '❌'
      console.log(`  ${icon} ${r.suite}: ${r.passed}/${r.total}`)
      totalPassed += r.passed
      totalFailed += r.failed
    }

    const total = totalPassed + totalFailed
    console.log(`\n  总计: ${totalPassed} 通过, ${totalFailed} 失败 (共 ${total} 个测试)`)
    console.log(`${'═'.repeat(60)}`)

    return totalFailed === 0
  }

  /** 关闭连接 */
  close() {
    this.cdp.close()
    this._connected = false
  }
}

module.exports = { CONFIG, log, assert, TestRunner }
