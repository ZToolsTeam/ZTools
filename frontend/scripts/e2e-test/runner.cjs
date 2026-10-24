/**
 * E2E 测试公共基础设施
 * logger、DevToolsExecutor、TestRunner
 */

const { spawn } = require('child_process')
const path = require('path')

const CONFIG = {
  devtoolsPath: path.join(__dirname, '../../devtools'),
  verbose: process.argv.includes('--verbose'),
  testFilter: (() => {
    const arg = process.argv.find((a) => a.startsWith('--test='))
    return arg ? arg.split('=')[1] : null
  })(),
  timeout: 15000,
  retryCount: 2
}

const logger = {
  info: (msg) => console.log(`\n📋 ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.error(`❌ ${msg}`),
  warn: (msg) => console.warn(`⚠️  ${msg}`),
  debug: (msg) => CONFIG.verbose && console.log(`🔍 ${msg}`),
  section: (msg) => console.log(`\n${'='.repeat(60)}\n${msg}\n${'='.repeat(60)}`),
  step: (num, msg) => console.log(`\n  ${num}. ${msg}`)
}

class DevToolsExecutor {
  async exec(code, description = '') {
    logger.debug(`执行: ${description || code}`)
    return new Promise((resolve, reject) => {
      const child = spawn('node', ['exec.js', '-t', 'ZTools', code], {
        cwd: CONFIG.devtoolsPath
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      // 手动超时，Windows 上 spawn timeout 不可靠
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error(`执行超时 (${CONFIG.timeout}ms): ${description || code.substring(0, 50)}`))
        }
      }, CONFIG.timeout)
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
          resolve(lines[lines.length - 1] || '')
        } else {
          reject(new Error(stderr || `Exit code: ${code}`))
        }
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async retry(fn, description) {
    for (let i = 0; i <= CONFIG.retryCount; i++) {
      try {
        return await fn()
      } catch (error) {
        if (i === CONFIG.retryCount) throw error
        logger.warn(`${description} 失败，重试 ${i + 1}/${CONFIG.retryCount}...`)
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }
}

class TestRunner {
  constructor() {
    this.executor = new DevToolsExecutor()
    this.results = []
  }

  async runSuite(name, tests) {
    if (CONFIG.testFilter && !name.includes(CONFIG.testFilter)) return
    logger.section(`测试套件: ${name}`)
    let passed = 0, failed = 0
    for (const test of tests) {
      try {
        await test.fn(this.executor)
        logger.success(test.name)
        passed++
      } catch (error) {
        logger.error(`${test.name}: ${error.message}`)
        failed++
      }
    }
    this.results.push({ suite: name, passed, failed, total: tests.length })
    logger.info(`结果: ${passed}/${tests.length} 通过`)
  }

  printSummary() {
    logger.section('测试总结')
    let totalPassed = 0, totalFailed = 0
    this.results.forEach((r) => {
      logger.info(`${r.failed === 0 ? '✅' : '⚠️'} ${r.suite}: ${r.passed}/${r.total}`)
      totalPassed += r.passed
      totalFailed += r.failed
    })
    logger.section(`总计: ${totalPassed} 通过, ${totalFailed} 失败`)
    return totalFailed === 0
  }
}

module.exports = { CONFIG, logger, DevToolsExecutor, TestRunner }
