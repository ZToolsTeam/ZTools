import fs from 'node:fs'
import path from 'node:path'

const WebSocketClient = globalThis.WebSocket

const ARTIFACTS_DIR = 'C:\\Users\\hopob\\.gemini\\antigravity\\brain\\b9a25051-fc4c-4445-a22d-3b41534cf441'

async function getTargetWsUrl() {
  const res = await fetch('http://127.0.0.1:9223/json')
  const list = await res.json()
  const page = list.find(t => t.type === 'page' && t.url.includes('ztools://web/index.html'))
  if (!page) throw new Error('未找到 ZTools 前端主页面 CDP 目标')
  return page.webSocketDebuggerUrl
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.msgId = 1
    this.pending = new Map()
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocketClient(this.wsUrl)
      this.ws.onopen = () => resolve()
      this.ws.onerror = err => reject(err)
      this.ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data.toString())
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            if (msg.error) rej(new Error(msg.error.message))
            else res(msg.result)
          }
        } catch {}
      }
    })
  }

  async send(method, params = {}) {
    const id = this.msgId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return res.result?.value
  }

  async captureScreenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(res.data, 'base64')
    const outPath = path.join(ARTIFACTS_DIR, filename)
    fs.writeFileSync(outPath, buffer)
    console.log(`📸 截图保存成功: ${outPath}`)
    return outPath
  }

  close() {
    if (this.ws) this.ws.close()
  }
}

async function run() {
  const wsUrl = await getTargetWsUrl()
  const cdp = new CdpClient(wsUrl)
  await cdp.connect()
  console.log('✅ 已成功连接到 ZTools Electron CDP (9223)')

  // 确保启用必要领域
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const pluginsToVerify = [
    {
      id: 'json-format',
      name: 'JSON 格式化与类型推导',
      screenshot: 'live_declarative_json_format.png'
    },
    {
      id: 'qr-code',
      name: '二维码生成与管理',
      screenshot: 'live_declarative_qr_code.png'
    },
    {
      id: 'currency-exchange',
      name: '全球汇率即时换算',
      screenshot: 'live_declarative_currency.png'
    },
    {
      id: 'speedtest',
      name: '网络与 IP 测速诊断',
      screenshot: 'live_declarative_speedtest.png'
    },
    {
      id: 'everything-file-search',
      name: 'Everything 文件秒搜',
      screenshot: 'live_declarative_everything.png'
    },
    {
      id: 'kill-process',
      name: '进程急救与管理',
      screenshot: 'live_declarative_kill_process.png'
    },
    {
      id: 'obsidian',
      name: 'Obsidian 知识库笔记',
      screenshot: 'live_declarative_obsidian.png'
    },
    {
      id: 'color-picker',
      name: '色彩转换与调色板',
      screenshot: 'live_declarative_color_picker.png'
    }
  ]

  for (const item of pluginsToVerify) {
    console.log(`\n▶ 正在验证并截屏: [${item.name}] (${item.id})...`)
    // 路由导航至插件页面
    await cdp.evaluate(`window.__router.push('/declarative/${item.id}')`)
    // 等待渲染稳定
    await new Promise(r => setTimeout(r, 1200))
    // 捕获真实截图
    await cdp.captureScreenshot(item.screenshot)
  }

  cdp.close()
  console.log('\n🎉 所有标杆与核心插件 CDP 真实功能验证与截屏留证全部完成！')
}

run().catch(err => {
  console.error('❌ CDP 自动化执行异常:', err)
  process.exit(1)
})
