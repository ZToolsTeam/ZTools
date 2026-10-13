#!/usr/bin/env node

/**
 * ZTools 交互式调试控制台 (REPL)
 *
 * 功能：
 * 1. 交互式执行 JS 代码
 * 2. 命令历史记录
 * 3. 自动补全
 * 4. 快捷命令
 */

const http = require('http')
const WebSocket = require('ws')
const readline = require('readline')
const fs = require('fs')
const path = require('path')

const HOST = '127.0.0.1'
const PORT = 9222
const HISTORY_FILE = path.join(__dirname, '.repl_history')

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
}

const c = (color, text) => `${colors[color]}${text}${colors.reset}`

// 快捷命令
const shortcuts = {
  '.help': '显示帮助',
  '.list': '列出调试目标',
  '.target <n>': '切换目标窗口',
  '.info': '显示系统信息',
  '.plugins': '列出所有插件',
  '.notify <msg>': '发送测试通知',
  '.toast <type> <msg>': '显示 Toast',
  '.db.get <key>': '获取数据库值',
  '.db.all [prefix]': '列出数据库文档',
  '.dll <plugin> <func> [params]': '调用 DLL',
  '.clear': '清屏',
  '.exit': '退出'
}

class ZToolsREPL {
  constructor() {
    this.ws = null
    this.target = null
    this.targets = []
    this.history = this.loadHistory()
    this.historyIndex = -1
    this.messageId = 0
    this.pendingRequests = new Map()
  }

  // 加载历史记录
  loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        return fs
          .readFileSync(HISTORY_FILE, 'utf-8')
          .split('\n')
          .filter(Boolean)
      }
    } catch (e) {}
    return []
  }

  // 保存历史记录
  saveHistory() {
    try {
      const recent = this.history.slice(-100) // 保留最近 100 条
      fs.writeFileSync(HISTORY_FILE, recent.join('\n'))
    } catch (e) {}
  }

  // 获取调试目标
  async getTargets() {
    return new Promise((resolve, reject) => {
      http
        .get(`http://${HOST}:${PORT}/json`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              const targets = JSON.parse(data)
              this.targets = targets.filter(
                (t) => t.type === 'page' && !t.url.startsWith('devtools://')
              )
              resolve(this.targets)
            } catch (e) {
              reject(e)
            }
          })
        })
        .on('error', reject)
    })
  }

  // 连接到目标
  async connect(target) {
    if (this.ws) {
      this.ws.close()
    }

    this.target = target

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(target.webSocketDebuggerUrl)

      this.ws.on('open', () => {
        console.log(c('green', `✓ 已连接到: ${target.title || 'Untitled'}`))
        resolve()
      })

      this.ws.on('message', (data) => {
        try {
          const response = JSON.parse(data)
          const pending = this.pendingRequests.get(response.id)
          if (pending) {
            this.pendingRequests.delete(response.id)
            pending.resolve(response)
          }
        } catch (e) {}
      })

      this.ws.on('error', reject)
      this.ws.on('close', () => {
        console.log(c('yellow', '连接已断开'))
        this.ws = null
      })
    })
  }

  // 执行 JS
  async execute(expression) {
    if (!this.ws) {
      throw new Error('未连接到 ZTools')
    }

    const id = ++this.messageId

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error('执行超时'))
      }, 30000)

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout)
          if (response.error) {
            reject(response.error)
          } else if (response.result?.exceptionDetails) {
            reject(response.result.exceptionDetails)
          } else {
            resolve(response.result?.result?.value)
          }
        }
      })

      this.ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true
          }
        })
      )
    })
  }

  // 处理快捷命令
  async handleShortcut(input) {
    const parts = input.trim().split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)

    switch (cmd) {
      case '.help':
        console.log(c('cyan', '\n快捷命令:'))
        for (const [k, v] of Object.entries(shortcuts)) {
          console.log(`  ${c('yellow', k.padEnd(25))} ${v}`)
        }
        console.log(c('gray', '\n直接输入 JS 代码执行，支持 await\n'))
        return true

      case '.list':
        await this.getTargets()
        console.log(c('cyan', '\n调试目标:'))
        this.targets.forEach((t, i) => {
          const current = t === this.target ? c('green', ' ← 当前') : ''
          console.log(
            `  [${c('yellow', i)}] ${t.title || 'Untitled'}${current}`
          )
          console.log(`      ${c('gray', t.url)}`)
        })
        console.log()
        return true

      case '.target':
        const idx = parseInt(args[0])
        if (isNaN(idx) || idx < 0 || idx >= this.targets.length) {
          console.log(c('red', '无效的目标索引'))
          return true
        }
        await this.connect(this.targets[idx])
        return true

      case '.info':
        const info = await this.execute('ztools.sys.getInfo()')
        console.log(c('cyan', '\n系统信息:'))
        console.log(JSON.stringify(info, null, 2))
        return true

      case '.plugins':
        const plugins = await this.execute('ztools.plugin.getList()')
        console.log(c('cyan', '\n插件列表:'))
        if (Array.isArray(plugins)) {
          plugins.forEach((p) => {
            console.log(
              `  ${c('yellow', p.id || p.name)} - ${p.description || ''}`
            )
          })
        } else {
          console.log(plugins)
        }
        return true

      case '.notify':
        const msg = args.join(' ') || '测试通知'
        await this.execute(`ztools.sys.notify('调试', '${msg}')`)
        console.log(c('green', '✓ 通知已发送'))
        return true

      case '.toast':
        const type = args[0] || 'info'
        const toastMsg = args.slice(1).join(' ') || '测试消息'
        await this.execute(`ztools.sys.toast('${type}', '${toastMsg}')`)
        console.log(c('green', '✓ Toast 已显示'))
        return true

      case '.db.get':
        const key = args[0]
        if (!key) {
          console.log(c('red', '请指定 key'))
          return true
        }
        const value = await this.execute(`ztools.db.get('${key}')`)
        console.log(value)
        return true

      case '.db.all':
        const prefix = args[0] || ''
        const docs = await this.execute(`ztools.db.allDocs('${prefix}')`)
        console.log(c('cyan', `\n文档列表 (prefix: ${prefix || '*'}):`))
        if (Array.isArray(docs)) {
          docs.forEach((d) => console.log(`  ${c('yellow', d._id)}`))
          console.log(c('gray', `共 ${docs.length} 条`))
        } else {
          console.log(docs)
        }
        return true

      case '.dll':
        const [plugin, func, ...paramParts] = args
        if (!plugin || !func) {
          console.log(c('red', '用法: .dll <插件名> <函数名> [参数JSON]'))
          return true
        }
        const params = paramParts.join(' ') || '{}'
        const dllResult = await this.execute(
          `ztools.dllplugin.call('${plugin}', '${func}', ${params})`
        )
        console.log(c('cyan', 'DLL 返回:'))
        console.log(JSON.stringify(dllResult, null, 2))
        return true

      case '.clear':
        console.clear()
        return true

      case '.exit':
      case '.quit':
        this.saveHistory()
        process.exit(0)

      default:
        return false
    }
  }

  // 格式化输出
  formatOutput(value) {
    if (value === undefined) {
      return c('gray', 'undefined')
    }
    if (value === null) {
      return c('gray', 'null')
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  }

  // 启动 REPL
  async start() {
    console.log(
      c(
        'cyan',
        `
╔═══════════════════════════════════════════════════╗
║         ZTools 交互式调试控制台 (REPL)            ║
║                                                   ║
║  输入 .help 查看帮助，.exit 退出                  ║
╚═══════════════════════════════════════════════════╝
`
      )
    )

    // 获取目标
    try {
      await this.getTargets()
      if (this.targets.length === 0) {
        console.log(c('red', '未找到 ZTools 实例'))
        console.log(
          c('gray', '请确保 ZTools 正在运行，且启用了远程调试端口 9222')
        )
        process.exit(1)
      }

      // 自动连接第一个目标
      await this.connect(this.targets[0])
    } catch (e) {
      console.log(c('red', `连接失败: ${e.message}`))
      console.log(
        c('gray', '请确保 ZTools 正在运行，且启用了远程调试端口 9222')
      )
      process.exit(1)
    }

    // 创建 readline 接口
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: c('cyan', 'ztools> '),
      historySize: 100
    })

    // 设置历史记录
    rl.history = this.history.slice().reverse()

    rl.prompt()

    rl.on('line', async (line) => {
      const input = line.trim()

      if (!input) {
        rl.prompt()
        return
      }

      // 保存历史
      if (this.history[this.history.length - 1] !== input) {
        this.history.push(input)
      }

      try {
        // 处理快捷命令
        if (input.startsWith('.')) {
          const handled = await this.handleShortcut(input)
          if (handled) {
            rl.prompt()
            return
          }
        }

        // 执行 JS
        const result = await this.execute(input)
        console.log(c('green', '→'), this.formatOutput(result))
      } catch (e) {
        if (e.text) {
          console.log(c('red', `错误: ${e.text}`))
          if (e.exception?.description) {
            console.log(c('gray', e.exception.description))
          }
        } else {
          console.log(c('red', `错误: ${e.message || e}`))
        }
      }

      rl.prompt()
    })

    rl.on('close', () => {
      this.saveHistory()
      console.log(c('gray', '\n再见!'))
      process.exit(0)
    })
  }
}

// 启动
const repl = new ZToolsREPL()
repl.start()
