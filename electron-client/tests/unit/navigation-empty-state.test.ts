import assert from 'node:assert/strict'
import test from 'node:test'
import { NavigationService } from '../../src/main/services/navigation-service.js'

test('macOS 空窗口与空菜单保持空，不生成示例', async () => {
  const service = new NavigationService({ platform: 'darwin', execFile: async () => ({ stdout: '[]' }) })
  assert.deepEqual(await service.listOpenWindows(), [])
  assert.deepEqual(await service.searchMenuItems(), [])
  await service.stop()
})

test('macOS 枚举权限失败明确拒绝，不返回演示进程或菜单', async () => {
  const service = new NavigationService({ platform: 'darwin', execFile: async () => { throw new Error('not authorized') } })
  await assert.rejects(service.listOpenWindows(), /辅助功能与自动化权限.*not authorized/)
  await assert.rejects(service.searchMenuItems(), /辅助功能与自动化权限/)
  await service.stop()
})
