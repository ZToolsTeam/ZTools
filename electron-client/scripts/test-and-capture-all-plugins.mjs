import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')
const outputDir = path.resolve(projectRoot, 'docs/screenshots/plugins')
fs.mkdirSync(outputDir, { recursive: true })

async function getWsUrl() {
  const res = await fetch('http://127.0.0.1:9222/json/list')
  const pages = await res.json()
  const page = pages.find(p => p.type === 'page' && p.url.includes('ztools://')) || pages[0]
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('未找到 Electron 页面 WebSocket 调试地址')
  }
  return page.webSocketDebuggerUrl
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 1
    this.pending = new Map()
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (err) => reject(err)
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message))
          else res(msg.result)
        }
      }
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.seq++
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
    return res?.result?.value
  }

  async captureScreenshot(filepath) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png'
    })
    const buf = Buffer.from(res.data, 'base64')
    fs.writeFileSync(filepath, buf)
    return filepath
  }

  close() {
    if (this.ws) this.ws.close()
  }
}

// 32 款官方声明式标杆插件全量清单
const PLUGINS = [
  { id: 'clipboard-history', name: '剪贴板历史与流水粘贴', category: '办公效率' },
  { id: 'snippets', name: '快捷短语与宏展开', category: '办公效率' },
  { id: 'window-management', name: '窗口极速调度', category: '系统工具' },
  { id: 'everything-file-search', name: 'Everything 文件秒搜', category: '系统工具' },
  { id: 'calculator', name: '综合计算器与色彩速查', category: '办公效率' },
  { id: 'system', name: 'Windows 运维动作', category: '系统工具' },
  { id: 'quicklinks', name: '快捷直达链接', category: '办公效率' },
  { id: 'kill-process', name: '进程管理急救箱', category: '系统工具' },
  { id: 'json-format', name: 'JSON 格式化与类型推导', category: '办公效率' },
  { id: 'qr-code', name: '二维码生成与识别', category: '系统工具' },
  { id: 'color-picker', name: '色彩拾取与转换', category: '媒体处理' },
  { id: 'google-translate', name: '多语言即时翻译', category: '办公效率' },
  { id: 'raycast-settings', name: '系统偏好设置', category: '系统工具' },
  { id: 'raycast-core', name: '更新与版本公告', category: '系统工具' },
  { id: 'raycast-account', name: '极客账户与授权', category: '系统工具' },
  { id: 'organizations', name: '商业与团队协同', category: '办公效率' },
  { id: 'raycast-wrapped', name: '年度极客使用报告', category: '办公效率' },
  { id: 'trial-nudges', name: '核心特权与技术方案', category: '系统工具' },
  { id: 'windows-shortcuts', name: 'Windows 自动化快捷指令', category: '系统工具' },
  { id: 'emoji-picker', name: 'Emoji 与符号选择器', category: '办公效率' },
  { id: 'translator', name: '即时划词翻译', category: '办公效率' },
  { id: 'notes', name: '轻量便签记事', category: '办公效率' },
  { id: 'windows-run', name: 'Windows 运行中枢', category: '系统工具' },
  { id: 'windows-taskbar', name: 'Windows 任务栏控制', category: '系统工具' },
  { id: 'screenshots', name: '截图历史与回贴', category: '办公效率' },
  { id: 'applications', name: '已装应用管理与卸载', category: '系统工具' },
  { id: 'dictionary', name: '英汉双解科技词典', category: '办公效率' },
  { id: 'github', name: 'GitHub 仪表盘', category: '办公效率' },
  { id: 'obsidian', name: 'Obsidian 笔记随手记', category: '办公效率' },
  { id: 'speedtest', name: '网络诊断与网速测试', category: '系统工具' },
  { id: 'winget', name: 'Winget 软件包管理器', category: '系统工具' },
  { id: 'currency-exchange', name: '实时多币种汇率换算', category: '金融理财' }
]

async function run() {
  const wsUrl = await getWsUrl()
  const cdp = new CdpClient(wsUrl)
  await cdp.connect()
  console.log('✅ Connected to CDP:', wsUrl)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const results = []

  for (let i = 0; i < PLUGINS.length; i++) {
    const p = PLUGINS[i]
    const indexStr = String(i + 1).padStart(2, '0')
    const filename = `${indexStr}-${p.id}.png`
    const filepath = path.join(outputDir, filename)

    console.log(`\n[${i + 1}/${PLUGINS.length}] 测试并截图插件: ${p.name} (${p.id})...`)

    // 1. 设置 hash 并强制重载
    await cdp.evaluate(`window.location.hash = '#/declarative/${p.id}'`)
    await cdp.send('Page.reload', { ignoreCache: true })

    // 2. 等待声明式视图挂载与渲染完毕 (1600ms)
    await new Promise(r => setTimeout(r, 1600))

    // 3. 提取当前页面 UI 实际渲染特征
    const uiInfo = await cdp.evaluate(`
      (() => {
        const bodyText = document.body.innerText || '';
        const shell = document.querySelector('.declarative-mica-shell');
        const listItems = Array.from(document.querySelectorAll('[data-list-item], .list-item, li, tr')).map(el => el.innerText.trim()).filter(Boolean);
        const headers = Array.from(document.querySelectorAll('h1, h2, h3, h4')).map(el => el.innerText.trim()).filter(Boolean);
        const inputs = Array.from(document.querySelectorAll('input, textarea')).map(el => el.placeholder || el.value);
        const isError = bodyText.includes('未找到指定的声明式应用');

        return {
          hasShell: Boolean(shell),
          isError,
          titleText: document.querySelector('.truncate')?.innerText || '',
          sampleText: bodyText.slice(0, 400).replace(/\\s+/g, ' '),
          itemCount: listItems.length,
          headers: headers.slice(0, 5)
        };
      })()
    `)

    // 4. 高分辨率全视口截屏
    await cdp.captureScreenshot(filepath)
    const fileStats = fs.statSync(filepath)

    const passed = Boolean(uiInfo?.hasShell) && !uiInfo?.isError && (fileStats.size > 15000)

    console.log(`  📸 截图已保存: ${filename} (${(fileStats.size / 1024).toFixed(1)} KB)`)
    console.log(`  🔍 渲染特征: 标题="${uiInfo?.titleText}", 包含Shell=${uiInfo?.hasShell}, 错误状态=${uiInfo?.isError}`)
    console.log(`  📝 文本切片: ${uiInfo?.sampleText?.slice(0, 150)}...`)
    console.log(`  ${passed ? '✅ 验证通过' : '❌ 验证未通过'}`)

    results.push({
      index: i + 1,
      id: p.id,
      name: p.name,
      category: p.category,
      filename,
      filepath,
      sizeBytes: fileStats.size,
      uiInfo,
      passed
    })
  }

  cdp.close()

  const summaryFile = path.join(outputDir, 'plugins-test-summary.json')
  fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2), 'utf8')
  console.log(`\n🎉 全部 32 款插件执行测试与截图完成！汇总报告写入: ${summaryFile}`)
}

run().catch(err => {
  console.error('Test execution failed:', err)
  process.exit(1)
})
