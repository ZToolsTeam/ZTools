/**
 * CDP (Chrome DevTools Protocol) 客户端
 * 直接通过 WebSocket 连接 ZTools CEF 实例，执行 JS 代码并获取结果
 * 比 devtools/exec.js 的子进程方式更高效，支持连接复用
 */

const http = require('http')
const WebSocket = require('ws')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9222
const DEFAULT_TIMEOUT = 15000

class CDPClient {
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST
    this.port = options.port || DEFAULT_PORT
    this.timeout = options.timeout || DEFAULT_TIMEOUT
    this._ws = null
    this._target = null
    this._msgId = 0
  }

  /** 获取所有调试目标 */
  async getTargets() {
    return new Promise((resolve, reject) => {
      http
        .get(`http://${this.host}:${this.port}/json`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => {
            try {
              const targets = JSON.parse(data)
              resolve(targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://')))
            } catch (e) {
              reject(new Error(`解析目标列表失败: ${e.message}`))
            }
          })
        })
        .on('error', (e) => reject(new Error(`无法连接 CDP (${this.host}:${this.port}): ${e.message}`)))
    })
  }

  /** 连接到指定目标（默认第一个页面） */
  async connect(targetSelector) {
    const targets = await this.getTargets()
    if (targets.length === 0) {
      throw new Error('未找到 ZTools 页面实例，请确认 ZTools 正在运行且开启了调试端口')
    }

    // 选择目标
    let target
    if (typeof targetSelector === 'number') {
      target = targets[targetSelector]
    } else if (typeof targetSelector === 'string') {
      target = targets.find((t) => t.title?.includes(targetSelector) || t.url?.includes(targetSelector))
    }
    this._target = target || targets[0]

    // 建立 WebSocket 连接
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._target.webSocketDebuggerUrl)
      const timer = setTimeout(() => {
        reject(new Error('WebSocket 连接超时'))
      }, this.timeout)

      this._ws.on('open', () => {
        clearTimeout(timer)
        resolve(this._target)
      })
      this._ws.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`WebSocket 连接失败: ${err.message}`))
      })
    })
  }

  /** 执行 JS 代码并返回结果 */
  async evaluate(expression, options = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('未连接到 CDP 目标，请先调用 connect()')
    }

    const id = ++this._msgId
    const timeout = options.timeout || this.timeout

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`执行超时 (${timeout}ms): ${expression.substring(0, 80)}...`))
      }, timeout)

      const handler = (data) => {
        try {
          const response = JSON.parse(data.toString())
          if (response.id !== id) return

          this._ws.off('message', handler)
          clearTimeout(timer)

          if (response.error) {
            reject(new Error(`CDP 错误: ${JSON.stringify(response.error)}`))
          } else if (response.result?.exceptionDetails) {
            const ex = response.result.exceptionDetails
            const msg = ex.exception?.description || ex.text || '未知 JS 异常'
            reject(new Error(msg))
          } else {
            resolve(response.result?.result?.value)
          }
        } catch (e) {
          // 非目标消息，忽略
        }
      }

      this._ws.on('message', handler)
      this._ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }
      }))
    })
  }

  /** 执行代码并解析 JSON 结果 */
  async evaluateJSON(expression, options = {}) {
    const raw = await this.evaluate(`JSON.stringify(${expression})`, options)
    if (raw === undefined || raw === null) return null
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  /** 关闭连接 */
  close() {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
    this._target = null
    this._msgId = 0
  }

  /** 当前连接的目标信息 */
  get target() {
    return this._target
  }

  /** 是否已连接 */
  get connected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN
  }
}

module.exports = { CDPClient, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_TIMEOUT }
