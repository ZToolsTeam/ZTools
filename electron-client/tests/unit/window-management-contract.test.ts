import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WindowManagementService } from '../../src/main/services/window-management-service.js'
import type { SidecarManager } from '../../src/main/services/sidecar-manager.js'

async function windows(work: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try { await work() } finally { Object.defineProperty(process, 'platform', previous) }
}
const actual = { x: -1919, y: 11, width: 960, height: 1041 }

test('Windows 窗口清单与原生可执行动作一致，四角别名规范化，拒绝虚假还原', async () => windows(async () => {
  const calls: unknown[][] = []
  const service = new WindowManagementService({ sidecarManager: { manageWindow: async (...args: unknown[]) => {
    calls.push(args)
    return { success: true, action: args[0], rect: actual }
  } } as unknown as SidecarManager })
  const native = await fs.readFile(path.resolve('native/ztools-uiaccess/uiaccess_worker.hpp'), 'utf8')
  const block = native.match(/validActions = \{([\s\S]*?)\};/)?.[1]
  assert.ok(block)
  const nativeActions = Array.from(block.matchAll(/"([a-z-]+)"/g), match => match[1]!).sort()
  assert.deepEqual(service.listActions().map(action => action.name).sort(), nativeActions)
  assert.equal(nativeActions.length, 20)
  assert.ok(!nativeActions.includes('restore'))
  for (const action of service.listActions()) {
    const result = await service.applyAction(action.name, { windowId: '98765', targetProcessId: process.pid + 1, currentBounds: { x: 0, y: 0, width: 1, height: 1 } })
    assert.equal(result.success, true)
    assert.deepEqual(result.rect, actual)
    assert.deepEqual(calls.at(-1), [action.name, undefined, { hwnd: 98765, pid: process.pid + 1 }], '只传递宿主确认的窗口身份，禁止注入虚构坐标')
  }
  assert.equal((await service.applyAction('top_left_quarter', { windowId: '98765', targetProcessId: process.pid + 1 })).action, 'top-left')
  const before = calls.length
  assert.equal((await service.applyAction('restore')).success, false)
  assert.equal((await service.applyAction('center-half')).success, false)
  assert.equal(calls.length, before)
}))

test('Windows 窗口原生缺失、拒绝、空回执、非法坐标或抛错均不报告成功', async () => windows(async () => {
  assert.equal((await new WindowManagementService().applyAction('left-half')).success, false)
  for (const reply of [undefined, {}, { success: false, error: '拒绝移动' }, { success: true }, { success: true, rect: { ...actual, width: 0 } }, { success: true, rect: { ...actual, x: NaN } }, new Error('原生连接断开')]) {
    const service = new WindowManagementService({ sidecarManager: { manageWindow: async () => {
      if (reply instanceof Error) throw reply
      return reply
    } } as unknown as SidecarManager })
    const result = await service.applyAction('next-display', { windowId: '98765', targetProcessId: process.pid + 1 })
    assert.equal(result.success, false)
    assert.equal(result.rect, undefined)
    assert.ok(result.error)
  }
}))

test('Windows 窗口动作先隐藏宿主，再确认外部 HWND/PID；成功才保持隐藏', async () => windows(async () => {
  const steps: string[] = []
  const target = { active: true, hwnd: 98765, pid: process.pid + 1 }
  const service = new WindowManagementService({ sidecarManager: {
    getActiveWindow: async () => { steps.push('query'); return target },
    manageWindow: async (...args: unknown[]) => {
      steps.push('move')
      assert.deepEqual(args, ['left-half', undefined, { hwnd: target.hwnd, pid: target.pid }])
      return { success: true, action: 'left-half', rect: actual }
    }
  } as unknown as SidecarManager })
  const window = { hide() { steps.push('hide') }, show() { steps.push('show') }, focus() { steps.push('focus') }, isDestroyed: () => false }
  assert.equal((await service.applyToExternalWindow('left-half', window)).success, true)
  assert.deepEqual(steps, ['hide', 'query', 'move'])
}))

test('Windows 无目标、仍为ZTools、取消或目标变化失败时不误移动，并恢复调用窗口', async () => windows(async () => {
  for (const scenario of ['no-window', 'self', 'invalid-hwnd', 'cancel', 'changed', 'query-failure']) {
    const steps: string[] = []
    const controller = new AbortController()
    const service = new WindowManagementService({ sidecarManager: {
      getActiveWindow: async () => {
        steps.push('query')
        if (scenario === 'query-failure') throw new Error('查询连接断开')
        if (scenario === 'cancel') controller.abort()
        return { active: scenario !== 'no-window', hwnd: scenario === 'invalid-hwnd' ? 0 : 98765, pid: scenario === 'self' ? process.pid : process.pid + 1 }
      },
      manageWindow: async () => { steps.push('move'); return { success: false, error: 'Target window changed or belongs to ZTools' } }
    } as unknown as SidecarManager })
    const window = { hide() { steps.push('hide') }, show() { steps.push('show') }, focus() { steps.push('focus') }, isDestroyed: () => false }
    const result = await service.applyToExternalWindow('left-half', window, controller.signal)
    assert.equal(result.success, false)
    assert.deepEqual(steps, scenario === 'changed' ? ['hide', 'query', 'move', 'show', 'focus'] : ['hide', 'query', 'show', 'focus'])
  }
}))
