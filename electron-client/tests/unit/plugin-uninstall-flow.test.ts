import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { uninstallPluginWithCleanup, type PluginUninstallSteps } from '../../src/main/services/plugin-uninstall-flow.js'

function recordingSteps(overrides: Partial<PluginUninstallSteps> = {}) {
  const calls: string[] = []
  const warnings: string[] = []
  const steps: PluginUninstallSteps = {
    async stopRuntime(pluginId) { calls.push(`stop:${pluginId}`) },
    async planShortcutCleanup(pluginId) {
      calls.push(`plan:${pluginId}`)
      return async () => { calls.push(`shortcut:${pluginId}`) }
    },
    async uninstall(pluginId) {
      calls.push(`uninstall:${pluginId}`)
      return { success: true }
    },
    async removeTriggers(pluginId) { calls.push(`triggers:${pluginId}`) },
    warn(message) { warnings.push(message) },
    ...overrides
  }
  return { steps, calls, warnings }
}

test('卸载成功：先停运行、记下快捷方式、卸载，最后清理快捷键与快捷方式', async () => {
  const { steps, calls, warnings } = recordingSteps()
  const result = await uninstallPluginWithCleanup('demo', steps)
  assert.deepEqual(result, { success: true })
  assert.deepEqual(calls, ['stop:demo', 'plan:demo', 'uninstall:demo', 'triggers:demo', 'shortcut:demo'])
  assert.deepEqual(warnings, [])
})

test('卸载失败（内置插件不存在、被占用等）：快捷键与快捷方式保持原样，错误原样抛出', async () => {
  for (const failure of [
    new ZToolsError(errorCodes.pluginNotFound, '插件不存在'),
    new ZToolsError(errorCodes.pluginBusy, '插件正在执行其他操作')
  ]) {
    const { steps, calls } = recordingSteps({
      async uninstall(pluginId) {
        calls.push(`uninstall:${pluginId}`)
        throw failure
      }
    })
    await assert.rejects(uninstallPluginWithCleanup('calculator', steps), failure)
    assert.equal(calls.includes('triggers:calculator'), false, '卸载失败不能删快捷键')
    assert.equal(calls.includes('shortcut:calculator'), false, '卸载失败不能删快捷方式')
  }
})

test('插件已卸载后清理快捷键或快捷方式失败：仍报告卸载成功，并记录日志', async () => {
  const { steps, calls, warnings } = recordingSteps({
    async removeTriggers() { throw new Error('写入快捷键配置失败') },
    async planShortcutCleanup() {
      return async () => { throw new ZToolsError(errorCodes.permissionDenied, '插件桌面快捷方式不是普通文件') }
    }
  })
  const result = await uninstallPluginWithCleanup('demo', steps)
  assert.deepEqual(result, { success: true })
  assert.ok(calls.includes('uninstall:demo'))
  assert.equal(warnings.length, 2)
  assert.match(warnings[0] ?? '', /清理快捷键失败/)
  assert.match(warnings[1] ?? '', /删除桌面快捷方式失败/)
})

test('停止运行失败：不进入卸载，不清理任何东西', async () => {
  const { steps, calls } = recordingSteps({
    async stopRuntime() { throw new Error('关闭插件窗口失败') }
  })
  await assert.rejects(uninstallPluginWithCleanup('demo', steps), /关闭插件窗口失败/)
  assert.deepEqual(calls, [])
})
