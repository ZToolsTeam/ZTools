import assert from 'node:assert/strict'
import test from 'node:test'
import { StorageHostPluginHandler } from '../../src/main/services/host-plugins/storage-host.js'
import { PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

type Result = { ok?: boolean; success: boolean; errorCode?: string; error?: string; message?: string; [key: string]: unknown }

/** 旧处理器只在 Windows 走真实分支；在任意开发机上把 process.platform 临时视作 win32，命令一律由注入的替身提供 */
async function asWindows<T>(work: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}

function cleaner(runPowerShell: (script: string) => Promise<string>) {
  return new StorageHostPluginHandler({} as HostPluginContext, {
    runPowerShell: async (script) => runPowerShell(script),
    runCommand: async (command) => { throw new Error(`未预设命令: ${command}`) }
  })
}

test('清空回收站旧接口：以清空后重新数到的项目数判断结果，不再无论成败都报告“已清空”', async () => {
  await asWindows(async () => {
    const scripts: string[] = []
    const done = await cleaner(async (s) => { scripts.push(s); return '{"before":12,"after":0}' }).handleCleaner('CleanerPlugin', 'emptyRecycleBin', {}) as Result
    assert.equal(done.success, true); assert.equal(done.removedCount, 12); assert.match(done.message!, /已清空系统回收站（12 项）/)
    // 脚本以输出 JSON 结尾（不以允许静默失败的 Clear-RecycleBin 结尾），且只在回收站非空时才清空
    assert.match(scripts[0]!, /\$ErrorActionPreference = 'Stop'/)
    assert.match(scripts[0]!, /if \(\$before -gt 0\) \{[\s\S]*Clear-RecycleBin -Force -ErrorAction SilentlyContinue[\s\S]*\}/)
    assert.match(scripts[0]!, /ConvertTo-Json -Compress\s*$/)
    const empty = await cleaner(async () => '{"before":0,"after":0}').handleCleaner('CleanerPlugin', 'clearRecycleBin', {}) as Result
    assert.equal(empty.success, true); assert.equal(empty.message, '回收站已经是空的')
  })
})

test('清空回收站旧接口：部分未清空、PowerShell 失败、输出无法解析都如实报错', async () => {
  await asWindows(async () => {
    // 故障注入：清空后仍有项目（文件被占用、权限不足）
    const partial = await cleaner(async () => '{"before":5,"after":2}').handleCleaner('CleanerPlugin', 'emptyRecycleBin', {}) as Result
    assert.equal(partial.success, false); assert.equal(partial.ok, false); assert.equal(partial.errorCode, 'RECYCLE_BIN_NOT_EMPTY')
    assert.equal(partial.removedCount, 3); assert.equal(partial.remainingCount, 2); assert.match(partial.error!, /仍有 2 项未清空/)
    // 故障注入：PowerShell 非零退出、超时、取消
    for (const err of [new PowerShellError(1, '无法打开系统回收站'), new PowerShellError(124, ''), new PowerShellError(130, '')]) {
      const failed = await cleaner(async () => { throw err }).handleCleaner('CleanerPlugin', 'emptyRecycleBin', {}) as Result
      assert.equal(failed.success, false); assert.equal(failed.errorCode, 'RECYCLE_BIN_FAILED'); assert.ok(failed.error!.startsWith('清空回收站失败：'))
    }
    // 故障注入：输出为空、不是 JSON、数量缺失或不是非负整数
    for (const out of ['', 'OK', 'null', '{"before":3}', '{"before":"3","after":0}', '{"before":-1,"after":0}', '{"before":1.5,"after":0}']) {
      const bad = await cleaner(async () => out).handleCleaner('CleanerPlugin', 'emptyRecycleBin', {}) as Result
      assert.equal(bad.success, false, `输出 ${JSON.stringify(out)} 不能当成功`); assert.equal(bad.errorCode, 'RECYCLE_BIN_FAILED')
    }
  })
})
