import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { validatePluginManifest, buildPlatformTargets } from '../packages/ztools-plugins-spec/src/index.js'
import {
  HudService,
  NoViewCommandDispatcher,
  DEFAULT_HUD_DURATION_MS,
  MAX_HUD_MESSAGE_LENGTH
} from '../electron-client/out/main/services/hud-service.js'

test('集成规约测试：插件清单正确支持 mode: "no-view" 与 alias，并拒绝非法 mode', () => {
  // 1. 合法声明 no-view 模式与 alias 的插件清单
  const validManifest = {
    id: 'quick-uuid',
    name: 'UUID 快速生成器',
    version: '1.0.0',
    description: '轻量无视图后台命令，一键生成 UUID 并复制到剪贴板',
    author: 'Plugin Dev',
    entry: 'index.js',
    icon: 'icon.png',
    permissions: ['clipboard'],
    // 清单必须声明支持的平台（跨平台写 windows 与 macos 两个目标）
    targets: buildPlatformTargets(['windows', 'macos']),
    nativeComponents: [],
    mode: 'no-view',
    alias: 'uuid',
    features: [
      {
        code: 'generate-v4',
        explain: '生成标准 UUID v4',
        mode: 'no-view',
        alias: 'u4',
        shortcut: 'CommandOrControl+Shift+U'
      }
    ]
  }

  const validResult = validatePluginManifest(validManifest)
  assert.equal(validResult.valid, true, `合法清单校验失败: ${validResult.errors.join(', ')}`)

  // 2. 异常破坏测试：非法的 mode 模式必须被严格拦截
  const invalidManifest = {
    ...validManifest,
    mode: 'invalid-floating-window'
  }
  const invalidResult = validatePluginManifest(invalidManifest)
  assert.equal(invalidResult.valid, false, '非法的 mode 应该被拦截拒绝')
  assert.ok(invalidResult.errors.some((err) => err.includes('mode 必须为以下取值之一')))
})

test('端到端集成测试：声明 mode: "no-view" 的命令触发后，不映射主窗口，成功投递规范的 HUD 报文并在 1.5 秒后自动隐去', async () => {
  let mainWindowVisible = true
  const windowManager = {
    hideMainWindow: () => {
      mainWindowVisible = false
    },
    isMainWindowVisible: () => mainWindowVisible
  }

  const publishedEvents = []
  const hudEvents = {
    publishHost: (type, payload) => {
      publishedEvents.push({ type, payload })
      return { success: true, delivered: 1 }
    }
  }

  const hudService = new HudService({
    events: hudEvents,
    defaultDurationMs: 1500
  })

  const dispatcher = new NoViewCommandDispatcher(hudService, windowManager)

  // 模拟剪贴板状态
  let simulatedClipboard = 'old content'

  // 定义一个标准的 no-view 插件命令
  const clearClipboardCommand = {
    id: 'clear-clipboard',
    pluginId: 'clipboard-cleaner',
    title: '清空剪贴板',
    mode: 'no-view',
    action: async () => {
      simulatedClipboard = ''
      return '剪贴板已清空'
    }
  }

  // 执行命令
  const result = await dispatcher.executeCommand(clearClipboardCommand)

  // 1. 验证命令执行成功
  assert.equal(result.success, true)
  assert.equal(result.hudDispatched, true)
  assert.equal(simulatedClipboard, '', '后台业务逻辑必须切实生效')

  // 2. 验证主窗口被立即隐藏，不展示大窗口
  assert.equal(mainWindowVisible, false, 'no-view 模式执行时主窗口必须保持隐藏')

  // 3. 验证触发了规范的 hud_shown 广播报文
  const shownEvent = publishedEvents.find((e) => e.type === 'hud_shown')
  assert.ok(shownEvent !== undefined, '必须发布 hud_shown 事件')
  assert.equal(shownEvent.payload.message, '剪贴板已清空')
  assert.equal(shownEvent.payload.durationMs, 1500, 'HUD 默认展示时长必须为 1500 毫秒')
  assert.ok(shownEvent.payload.id !== undefined)
  assert.ok(hudService.isShowing(), 'HUD 当前应处于显示状态')

  // 4. 等待 1.5 秒后自动隐去
  await delay(1550)

  // 5. 验证自动触发了 hud_hidden 事件且状态已恢复
  assert.equal(hudService.isShowing(), false, '1.5 秒后 HUD 必须自动隐去')
  const hiddenEvent = publishedEvents.find((e) => e.type === 'hud_hidden')
  assert.ok(hiddenEvent !== undefined, '必须在超时后发布 hud_hidden 事件')
  assert.equal(hiddenEvent.payload.id, shownEvent.payload.id)
})

test('集成测试：显式调用 context.showHUD 并携带自定义图标', async () => {
  let mainWindowHidden = false
  const windowManager = {
    hideMainWindow: () => { mainWindowHidden = true }
  }

  const publishedEvents = []
  const hudService = new HudService({
    events: {
      publishHost: (type, payload) => {
        publishedEvents.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    }
  })

  const dispatcher = new NoViewCommandDispatcher(hudService, windowManager)

  const customHudCommand = {
    id: 'toggle-dark',
    pluginId: 'theme-switcher',
    mode: 'no-view',
    action: async (ctx) => {
      await ctx.showHUD('已切换为暗黑模式', 'moon')
    }
  }

  const result = await dispatcher.executeCommand(customHudCommand)
  assert.equal(result.success, true)
  assert.equal(mainWindowHidden, true)

  const shown = publishedEvents.find((e) => e.type === 'hud_shown')
  assert.ok(shown !== undefined)
  assert.equal(shown.payload.message, '已切换为暗黑模式')
  assert.equal(shown.payload.icon, 'moon')

  hudService.stop()
})

test('破坏性异常用例 1：后台任务执行异常崩溃时，安全兜底并投递错误 HUD，宿主不崩溃', async () => {
  let mainWindowHidden = false
  const windowManager = {
    hideMainWindow: () => { mainWindowHidden = true }
  }

  const publishedEvents = []
  const hudService = new HudService({
    events: {
      publishHost: (type, payload) => {
        publishedEvents.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    }
  })

  const dispatcher = new NoViewCommandDispatcher(hudService, windowManager)

  const failingCommand = {
    id: 'failing-task',
    pluginId: 'bad-plugin',
    mode: 'no-view',
    action: async () => {
      throw new Error('磁盘空间不足或无写入权限')
    }
  }

  // 执行抛错命令
  const result = await dispatcher.executeCommand(failingCommand)

  // 宿主不被未捕获异常击垮，返回错误结果
  assert.equal(result.success, false)
  assert.ok(result.error.includes('磁盘空间不足'))
  assert.equal(result.hudDispatched, true)
  assert.equal(mainWindowHidden, true)

  // 必须向用户投递带有错误图标的 HUD 告警
  const shown = publishedEvents.find((e) => e.type === 'hud_shown')
  assert.ok(shown !== undefined)
  assert.ok(shown.payload.message.includes('执行失败: 磁盘空间不足'))
  assert.equal(shown.payload.icon, 'error')

  hudService.stop()
})

test('破坏性异常用例 2：高频并发连击触发 HUD 时，自动重置定时器防竞态早退', async () => {
  const publishedEvents = []
  const hudService = new HudService({
    events: {
      publishHost: (type, payload) => {
        publishedEvents.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    },
    defaultDurationMs: 300 // 测试使用 300ms 便于验证时序
  })

  // 第一次触发
  await hudService.showHUD('消息 1')
  const id1 = hudService.getActiveHUD().id

  // 150ms 后（在第一次超时前），快速连击触发第二次
  await delay(150)
  await hudService.showHUD('消息 2')
  const id2 = hudService.getActiveHUD().id
  assert.notEqual(id1, id2, '新 HUD 应分配新 ID')

  // 再过 180ms（此时距离消息 1 已过去 330ms，已超过 300ms；但距离消息 2 仅过去 180ms）
  await delay(180)
  // 如果旧定时器没有被清理，消息 2 会被提前关闭；而防御良好的实现必须保证当前 HUD 仍然存活！
  assert.equal(hudService.isShowing(), true, '旧定时器必须被正确重置，不能提前关闭最新 HUD')
  assert.equal(hudService.getActiveHUD().id, id2)

  // 再等待 150ms（消息 2 满 330ms）
  await delay(150)
  assert.equal(hudService.isShowing(), false, '最新 HUD 达到设定时长后正常隐去')
})

test('破坏性异常用例 3：超长字符串（10,000 字符）溢出测试与空值/畸形入参防御', async () => {
  const hudService = new HudService({ defaultDurationMs: 100 })

  // 1. 10,000 字符超长文本测试
  const massiveString = 'A'.repeat(10_000)
  const payload1 = await hudService.showHUD(massiveString)
  assert.ok(payload1.message.length <= MAX_HUD_MESSAGE_LENGTH + 3, '超长文本必须被安全截断防溢出')
  assert.ok(payload1.message.endsWith('...'))

  // 2. null、undefined、非字符串类型防御
  const payload2 = await hudService.showHUD(null)
  assert.equal(payload2.message, '')

  const payload3 = await hudService.showHUD({ invalid: 'object' })
  assert.equal(payload3.message, '[object Object]')

  hudService.stop()
})
