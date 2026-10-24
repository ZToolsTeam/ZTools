const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

const htmlPath = path.resolve(__dirname, '../public/super-panel/index.html')
const html = fs.readFileSync(htmlPath, 'utf8')
const pinyinProPath = path.resolve(__dirname, '../node_modules/pinyin-pro/dist/index.js')
const pinyinProSource = fs.readFileSync(pinyinProPath, 'utf8')
const fuzzySearchPath = path.resolve(__dirname, '../public/shared/fuzzy-search.js')
const fuzzySearchSource = fs.readFileSync(fuzzySearchPath, 'utf8')
const runnableHtml = html
  .replace(
    '<script src="ztools://web/shared/pinyin-pro.js"></script>',
    `<script>${pinyinProSource}</script>`
  )
  .replace(
    '<script src="ztools://web/shared/fuzzy-search.js"></script>',
    `<script>${fuzzySearchSource}</script>`
  )

let defaultTab = 'history'
let getDataCalls = 0
let addLocalAppCalls = 0
let localAppAdded = false
const shownTooltips = []
let hiddenTooltipCalls = 0
let dragCalls = 0
const openItemCalls = []

const dom = new JSDOM(runnableHtml, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  url: 'ztools://web/super-panel/index.html?theme=dark',
  beforeParse(window) {
    window.ztools = {
      _sendMessage(method, rawPayload) {
        const payload = JSON.parse(rawPayload)
        if (method === 'window_show_tooltip') {
          shownTooltips.push(payload.text)
          window.setTimeout(() => {
            window.ztools._transport.handleMessage(method, {
              success: true,
              _messageId: payload._messageId
            })
          }, 0)
          return
        }
        if (method === 'window_hide_tooltip') {
          hiddenTooltipCalls += 1
          window.setTimeout(() => {
            window.ztools._transport.handleMessage(method, {
              success: true,
              _messageId: payload._messageId
            })
          }, 0)
          return
        }
        if (method === 'super_panel_add_local_app') {
          addLocalAppCalls += 1
          localAppAdded = true
          window.setTimeout(() => {
            window.ztools._transport.handleMessage(method, {
              success: true,
              _messageId: payload._messageId
            })
          }, 0)
          return
        }
        if (method === 'super_panel_drag') {
          dragCalls += 1
          window.setTimeout(() => {
            window.ztools._transport.handleMessage(method, {
              success: true,
              _messageId: payload._messageId
            })
          }, 0)
          return
        }
        if (method === 'super_panel_open_item') {
          openItemCalls.push(payload)
          window.setTimeout(() => {
            window.ztools._transport.handleMessage(method, {
              success: true,
              _messageId: payload._messageId
            })
          }, 0)
          return
        }

        if (method !== 'super_panel_get_data') return
        getDataCalls += 1
        window.setTimeout(() => {
          const items = [
            {
              id: 'recent-plugin',
              type: 'plugin',
              name: 'Recent Plugin',
              description: 'Recently used extension',
              keywords: ['history'],
              pinned: false,
              recent: true
            },
            {
              id: 'all-plugin',
              type: 'plugin',
              name: 'All Plugin',
              description: '',
              pinned: false,
              recent: false
            },
            {
              id: 'capture-plugin',
              type: 'plugin',
              name: '截图工具',
              description: '屏幕捕获',
              keywords: ['截图'],
              pinned: false,
              recent: false
            },
            {
              id: 'system-tool:this_pc',
              target: 'this_pc',
              type: 'system_tool',
              name: '此电脑',
              description: '打开此电脑',
              keywords: ['系统工具', '我的电脑 计算机'],
              pinned: false,
              recent: false
            },
            {
              id: 'system-tool:settings',
              target: 'settings',
              type: 'system_tool',
              name: 'Windows 设置',
              description: '打开 Windows 设置主页',
              keywords: ['系统工具', '电脑设置 Windows设置 设置中心'],
              pinned: false,
              recent: false
            }
          ]
          if (localAppAdded) {
            items.push({
              id: 'local-wechat',
              type: 'local',
              name: '微信',
              description: 'C:\\Program Files\\Tencent\\WeChat.exe',
              pinned: false,
              recent: false
            })
          }

          window.ztools._transport.handleMessage(method, {
            success: true,
            _messageId: payload._messageId,
            defaultTab,
            shortcuts: [],
            items
          })
        }, 0)
      }
    }
  }
})

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function activeTab() {
  return dom.window.document.querySelector('.tab.active')?.dataset.tab
}

(async () => {
  await delay(80)
  assert.equal(
    dom.window.document.documentElement.classList.contains('dark'),
    true,
    'dark query parameter should apply the theme before panel startup'
  )
  assert.equal(
    dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue('--bg').trim(),
    '#141414',
    'dark theme should expose the same background color as the native main window'
  )
  dom.window.__superPanelSetDarkMode(false)
  assert.equal(
    dom.window.document.documentElement.classList.contains('dark'),
    false,
    'native runtime updates should switch the panel back to light theme'
  )
  dom.window.__superPanelSetDarkMode(true)

  assert.equal(activeTab(), 'history', 'initial native default tab should be applied')

  assert.match(
    html,
    /\.window\s*{[\s\S]*border:\s*1px\s+solid\s+var\(--window-border\)/,
    'super panel window should have a visible border'
  )

  defaultTab = 'system_tools'
  dom.window.__superPanelReset()
  await delay(160)
  assert.equal(activeTab(), 'system_tools', 'system tools should be accepted as the native default tab')

  defaultTab = 'all'
  dom.window.__superPanelReset()
  await delay(160)

  assert.equal(activeTab(), 'all', 'reset should reload data and apply changed native default tab')
  assert.ok(getDataCalls >= 2, 'reset after first load should request fresh panel data')

  const toolbar = dom.window.document.querySelector('.toolbar')
  toolbar.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  assert.equal(dragCalls, 1, 'left-clicking empty toolbar space should start native window dragging')

  const footer = dom.window.document.querySelector('.footer')
  footer.querySelector('kbd').dispatchEvent(new dom.window.MouseEvent('mousedown', {
    bubbles: true,
    button: 0
  }))
  assert.equal(dragCalls, 2, 'left-clicking the footer should start native window dragging')

  const searchInput = dom.window.document.getElementById('searchInput')
  searchInput.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }))
  assert.equal(dragCalls, 2, 'interactive toolbar controls should not start window dragging')

  dom.window.document.querySelector('[data-tab="system_tools"]').click()
  assert.equal(activeTab(), 'system_tools', 'system tools tab should be selectable')
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.item')].map(item => item.dataset.type),
    ['system_tool', 'system_tool'],
    'system tools tab should only render system tool items'
  )

  searchInput.value = '我的电脑'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(
    dom.window.document.querySelector('.item .name')?.textContent.trim(),
    '此电脑',
    'system tool aliases should participate in global search'
  )
  dom.window.document.querySelector('.item').click()
  await delay(20)
  assert.equal(openItemCalls.at(-1)?.id, 'system-tool:this_pc')
  assert.equal(openItemCalls.at(-1)?.itemType, 'system_tool')

  searchInput.value = ''
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  dom.window.document.querySelector('[data-tab="all"]').click()

  const addButton = dom.window.document.getElementById('addBtn')
  assert.equal(addButton.hasAttribute('title'), false, 'native Chromium title should be disabled')
  assert.equal(addButton.dataset.systemTooltip, '添加本地软件')
  addButton.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  await delay(600)
  assert.deepEqual(shownTooltips, ['添加本地软件'], 'hover should show the system tooltip')
  addButton.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }))
  await delay(20)
  assert.equal(hiddenTooltipCalls, 1, 'mouse out should hide the system tooltip')

  const callsBeforeAddingLocalApp = getDataCalls
  addButton.click()
  await delay(80)
  assert.equal(addLocalAppCalls, 1, 'add local app button should invoke the native dialog')
  assert.ok(getDataCalls > callsBeforeAddingLocalApp, 'closing the native dialog should reload panel data')

  const { FuzzySearchEngine, FUZZY_SEARCH_COLLECTIONS } = dom.window.ZToolsFuzzySearch
  const engine = new FuzzySearchEngine()
  engine.setCollection(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, [
    { id: 'screen', name: 'Screenshot Tool', keywords: ['capture'] },
    { id: 'video', name: 'Batch Video', keywords: ['convert'] },
    { id: 'capture-cn', name: '截图工具', keywords: ['屏幕捕获'] },
    { id: 'rename-cn', name: '重命名工具', keywords: [] }
  ])
  engine.setCollection('test_other_collection', [
    { id: 'other', name: 'Unrelated Collection' }
  ])

  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'screnshot')[0].item.id, 'screen')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'batchvideo')[0].item.id, 'video')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, '截土工具')[0].item.id, 'capture-cn')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'jietugongju')[0].item.id, 'capture-cn')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'jtgj')[0].item.id, 'capture-cn')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'chongmingminggongju')[0].item.id, 'rename-cn')
  assert.equal(engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, 'unrelated').length, 0)
  assert.equal(engine.search('test_other_collection', 'unrelated')[0].item.id, 'other')
  assert.deepEqual(
    engine.search(FUZZY_SEARCH_COLLECTIONS.SUPER_PANEL, '', { limit: 2 }).map(row => row.item.id),
    ['screen', 'video']
  )
  assert.throws(() => engine.setCollection('', []), /集合标识不能为空/)
  assert.equal(engine.isPinyinSupported(), true)

  searchInput.value = 'recnt'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(dom.window.document.querySelector('.item .name')?.textContent.trim(), 'Recent Plugin')

  searchInput.value = 'history'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(
    dom.window.document.querySelector('.item .name')?.textContent.trim(),
    'Recent Plugin',
    'plugin keywords should participate in full-text search'
  )

  searchInput.value = 'Recent history'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(
    dom.window.document.querySelector('.item .name')?.textContent.trim(),
    'Recent Plugin',
    'plugin name and keywords should be searchable as one full-text document'
  )

  searchInput.value = 'jtgj'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(dom.window.document.querySelector('.item .name')?.textContent.trim(), '截图工具')

  searchInput.value = 'wx'
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.equal(dom.window.document.querySelector('.item')?.dataset.type, 'local')
  assert.equal(dom.window.document.querySelector('.item .name')?.textContent.trim(), '微信')

  dom.window.close()
  console.log('Super panel static checks passed.')
})().catch(error => {
  dom.window.close()
  console.error(error)
  process.exit(1)
})
