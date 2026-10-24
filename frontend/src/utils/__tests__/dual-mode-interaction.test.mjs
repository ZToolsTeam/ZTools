/**
 * ZTools 双模态交互 (Dual Mode Interaction) 集成与全异常覆盖测试套件
 * 按项目测试规范编写：
 * 1. 默认包含集成测试：打通“用户指令 -> 状态机流转 -> 下层服务/Native -> 结果回填”闭环；
 * 2. 严禁仅写 Happy Path：全面覆盖参数异常、IPC崩溃/超时注入、高频并发竞态锁等。
 */

import { describe, it } from 'vitest'
import assert from 'node:assert/strict'


// 模拟浏览器全局存储与 Window 对象
class MockLocalStorage {
  constructor() {
    this.store = new Map()
  }
  getItem(key) {
    return this.store.get(key) ?? null
  }
  setItem(key, value) {
    this.store.set(key, String(value))
  }
  removeItem(key) {
    this.store.delete(key)
  }
  clear() {
    this.store.clear()
  }
}

globalThis.localStorage = new MockLocalStorage()

// 引入被测试模块
import {
  initWindowMode,
  setWakePreference,
  switchWindowMode,
  windowModeState,
  WINDOW_MODES,
  WAKE_PREFERENCES,
  _resetWindowModeForTesting
} from '../windowMode.js'

import {
  getPinyinInitials,
  matchItemWithQuery,
  filterAndRankItems
} from '../pinyinSearch.js'

describe('ZTools 双模态交互集成测试', () => {
  it('1. [新手默认基线与容错] 首次启动默认应用工作台大界面，损坏存储安全自愈', async () => {
    localStorage.clear()
    _resetWindowModeForTesting()

  // 1.1 首次启动，偏好和当前模式必须是 DASHBOARD (大窗口)
  initWindowMode()
  assert.equal(windowModeState.currentMode, WINDOW_MODES.DASHBOARD, '默认必须是大窗口模式')
  assert.equal(windowModeState.wakePreference, WAKE_PREFERENCES.DASHBOARD, '默认偏好必须是大窗口')
  assert.equal(windowModeState.geekModeDiscovered, false, '新用户未发现极客条')

  // 1.2 注入畸形/非法 localStorage 数据
  localStorage.setItem('ztools_wake_preference', 'MALICIOUS_CORRUPTED_STRING_###')
  initWindowMode()
  assert.equal(windowModeState.wakePreference, WAKE_PREFERENCES.DASHBOARD, '数据异常必须自动降级回退为 DASHBOARD')

  // 1.3 非法参数传入 setWakePreference 必须明确拒绝
  assert.throws(
    () => setWakePreference('invalid_mode'),
    /无效的唤醒偏好设置/,
    '必须严格校验偏好参数类型'
  )
})

  it('2. [双模态切换与 Native 窗口集成链路] 成功流转与尺寸自适应', async () => {
  localStorage.clear()
  _resetWindowModeForTesting()

  let lastResizedBounds = null
  globalThis.window = {
    ztools: {
      window: {
        setSize: async (bounds) => {
          lastResizedBounds = bounds
          return { success: true }
        }
      }
    }
  }

  // 2.1 切换为极客悬浮条 (Launcher)
  const res1 = await switchWindowMode(WINDOW_MODES.LAUNCHER, { initialQuery: '音频' })
  assert.equal(res1, true, '切换应成功')
  assert.equal(windowModeState.currentMode, WINDOW_MODES.LAUNCHER)
  assert.equal(windowModeState.launcherInitialQuery, '音频', '初始查询词应正确传递')
  assert.equal(windowModeState.geekModeDiscovered, true, '发现标记应更新')
  assert.deepEqual(lastResizedBounds, { width: 680, height: 440, animate: true }, '应调整为极客条尺寸')

  // 2.2 展开回完整应用工作台 (Dashboard)
  const res2 = await switchWindowMode(WINDOW_MODES.DASHBOARD)
  assert.equal(res2, true, '切换回大窗口应成功')
  assert.equal(windowModeState.currentMode, WINDOW_MODES.DASHBOARD)
  assert.equal(windowModeState.launcherInitialQuery, '', '大窗口应清空查询词')
  assert.deepEqual(lastResizedBounds, { width: 900, height: 600, animate: true }, '应恢复为 900x600 大窗口尺寸')
})

  it('3. [混沌测试与异常注入] Native 接口报错或超时不导致前端崩溃与死锁', async () => {
  _resetWindowModeForTesting()

  // 模拟 Native setSize 失败 (例如 Windows 窗口句柄失效或 IPC 超时)
  globalThis.window = {
    ztools: {
      window: {
        setSize: async () => {
          throw new Error('IPC_CALL_TIMEOUT: 窗口未能响应尺寸调整')
        }
      }
    }
  }

  // 即使底层报错，前端状态机仍能正常流转，isTransitioning 必须释放
  const res = await switchWindowMode(WINDOW_MODES.LAUNCHER)
  assert.equal(res, true)
  assert.equal(windowModeState.currentMode, WINDOW_MODES.LAUNCHER)
  assert.equal(windowModeState.isTransitioning, false, '发生异常时互斥锁必须确保释放')
})

  it('4. [高频并发竞态锁] 极端频繁交替切换防重入保护', async () => {
  _resetWindowModeForTesting()

  let callCount = 0
  globalThis.window = {
    ztools: {
      window: {
        setSize: async () => {
          callCount++
          await new Promise((resolve) => setTimeout(resolve, 30))
          return { success: true }
        }
      }
    }
  }

  // 20ms 内连续交替触发 10 次并发切换
  const promises = []
  for (let i = 0; i < 10; i++) {
    const target = i % 2 === 0 ? WINDOW_MODES.LAUNCHER : WINDOW_MODES.DASHBOARD
    promises.push(switchWindowMode(target))
  }

  const results = await Promise.all(promises)
  // 首个任务执行中，后续重入的任务必须被原子互斥拦截并返回 false
  const rejectedCount = results.filter((r) => r === false).length
  assert.ok(rejectedCount > 0, `并发重入必须被互斥锁阻断，实际阻断数: ${rejectedCount}`)
  assert.equal(windowModeState.isTransitioning, false, '最终过渡状态必须解锁')
})

  it('5. [拼音模糊搜索与权重算法] 深入测试多种输入形态与边界极值', () => {
  const sampleItems = [
    { name: '批量音频处理', description: '专业的音频格式转换', pluginId: 'audio-processor', category: '媒体' },
    { name: '批量重命名', description: '强大的文件批量重命名工具', pluginId: 'file-renamer', category: '系统' },
    { name: '批量视频处理', description: '视频压缩与格式转换', pluginId: 'video-tool', category: '媒体' },
    { name: '系统设置', description: '全局配置与唤醒偏好', pluginId: 'settings', category: '系统' }
  ]

  // 5.1 首字母缩写测试
  assert.equal(getPinyinInitials('批量音频处理'), 'plypcl')
  assert.equal(getPinyinInitials('系统设置'), 'xtsz')
  assert.equal(getPinyinInitials(''), '')
  assert.equal(getPinyinInitials(null), '')

  // 5.2 拼音首字母匹配 (yp -> 音频, cm -> 重命名)
  const ypResults = filterAndRankItems(sampleItems, 'yp')
  assert.ok(ypResults.length > 0)
  assert.equal(ypResults[0].name, '批量音频处理', 'yp 应该精准匹配到批量音频处理')

  const cmResults = filterAndRankItems(sampleItems, 'cm')
  assert.ok(cmResults.length > 0)
  assert.equal(cmResults[0].name, '批量重命名', 'cm 应该匹配到批量重命名')

  // 5.3 英文 pluginId 匹配
  const renamerResults = filterAndRankItems(sampleItems, 'renamer')
  assert.equal(renamerResults[0].name, '批量重命名')

  // 5.4 边界极值测试：空值、非法字符、超长无意义字符串
  assert.deepEqual(filterAndRankItems(sampleItems, ''), sampleItems, '空搜索词应返回全部')
  assert.deepEqual(filterAndRankItems(sampleItems, '   '), sampleItems, '纯空格应返回全部')
  assert.deepEqual(filterAndRankItems(null, 'abc'), [], '空列表应返回空数组')

  const notFound = filterAndRankItems(sampleItems, '@@@不存在的插件标识XYZ999###')
  assert.equal(notFound.length, 0, '未匹配时返回空列表')
})

  it('6. [独立原生 Launcher 桥接测试] __ztoolsLauncher 双向流转与异常兜底', async () => {
  _resetWindowModeForTesting()

  let launcherShowCalled = false
  let launcherExpandCalled = false

  globalThis.window = {
    __ztoolsLauncher: {
      show: async () => {
        launcherShowCalled = true
        return { success: true }
      },
      expandToDashboard: async () => {
        launcherExpandCalled = true
        return { success: true }
      }
    }
  }

  // 6.1 呼出 Launcher
  await switchWindowMode(WINDOW_MODES.LAUNCHER, { initialQuery: 'test' })
  assert.equal(launcherShowCalled, true, '应当直接调用 __ztoolsLauncher.show()')
  assert.equal(windowModeState.currentMode, WINDOW_MODES.LAUNCHER)

  // 6.2 展开至 Dashboard
  await switchWindowMode(WINDOW_MODES.DASHBOARD)
  assert.equal(launcherExpandCalled, true, '应当直接调用 __ztoolsLauncher.expandToDashboard()')
  assert.equal(windowModeState.currentMode, WINDOW_MODES.DASHBOARD)

  // 6.3 异常注入：__ztoolsLauncher 报错
  globalThis.window.__ztoolsLauncher.show = async () => {
    throw new Error('IPC_BRIDGE_ERROR: 悬浮窗创建失败')
  }
  const failRes = await switchWindowMode(WINDOW_MODES.LAUNCHER)
  assert.equal(failRes, true, '报错时状态机自愈，不抛出未捕获异常')
  assert.equal(windowModeState.isTransitioning, false, '锁必须释放')
})

  it('7. [唤醒偏好状态与配置持久化] setWakePreference 联动 config 并在异常时兜底', () => {
    _resetWindowModeForTesting()
    let configWritten = null

    globalThis.window = {
      ztools: {
        config: {
          set: async (key, val, _sync, file) => {
            configWritten = { key, val, file }
            return true
          }
        }
      }
    }

    // 7.1 正常设置
    setWakePreference('launcher')
    assert.equal(windowModeState.wakePreference, 'launcher')
    assert.deepEqual(configWritten, {
      key: 'ui.wake_preference',
      val: 'launcher',
      file: 'user_settings.json'
    })

    // 7.2 非法值校验
    assert.throws(() => {
      setWakePreference('invalid_mode_xxx')
    }, /无效的唤醒偏好设置/)

    // 7.3 config.set 报错时优雅降级
    globalThis.window.ztools.config.set = async () => {
      throw new Error('CONFIG_WRITE_IO_ERROR')
    }
    assert.doesNotThrow(() => {
      setWakePreference('dashboard')
    })
    assert.equal(windowModeState.wakePreference, 'dashboard')
  })
})

