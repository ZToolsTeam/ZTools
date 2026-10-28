import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeBatteryCommandError,
  parseMacBatteryStatusOutput,
  parseWindowsBatteryStatusOutput,
  readSystemBatteryStatus,
  WINDOWS_BATTERY_STATUS_SCRIPT,
  type BatteryCommandRunner
} from '../../src/main/services/battery-status.js'
import { SystemService } from '../../src/main/services/system-service.js'

const win = (row: Record<string, unknown>) => JSON.stringify({ acLineStatus: 1, batteryFlag: 8, percent: 64, lifeTime: -1, batteryCount: 1, ...row })

test('电池：Windows 有电池时原样给出电量、供电来源与剩余时间', () => {
  assert.deepEqual(parseWindowsBatteryStatusOutput(win({ acLineStatus: 0, batteryFlag: 1, percent: 87, lifeTime: 5400 })), {
    percent: 87, isCharging: false, timeRemaining: 5400, batteryState: 'present', powerSource: 'battery'
  })
  // 0% 与 100% 是真实边界值
  assert.equal(parseWindowsBatteryStatusOutput(win({ percent: 0 })).percent, 0)
  assert.equal(parseWindowsBatteryStatusOutput(win({ percent: 100 })).percent, 100)
  // 带 BOM、前后空白的输出照常解析
  assert.equal(parseWindowsBatteryStatusOutput(`﻿  ${win({})}\r\n`).batteryState, 'present')
})

test('电池：Windows 电量 255（未知）不再被当成“无电池”，有 Win32_Battery 实例就是有电池', () => {
  const status = parseWindowsBatteryStatusOutput(win({ percent: 255, batteryFlag: 255, batteryCount: 1 }))
  assert.equal(status.batteryState, 'present')
  assert.equal(status.percent, 255)
  // CIM 查询失败（-1）但 BatteryFlag 已知且没有“无电池”位：有电池、电量未知
  const flagOnly = parseWindowsBatteryStatusOutput(win({ percent: 255, batteryFlag: 0, batteryCount: -1 }))
  assert.equal(flagOnly.batteryState, 'present')
  assert.equal(flagOnly.percent, 255)
})

test('电池：只有系统明确报告没有电池时才是 absent', () => {
  // 台式机：BatteryFlag 128 + 没有 Win32_Battery 实例
  const desktop = parseWindowsBatteryStatusOutput(win({ batteryFlag: 128, percent: 255, batteryCount: 0 }))
  assert.deepEqual(desktop, { percent: 255, isCharging: true, timeRemaining: -1, batteryState: 'absent', powerSource: 'ac' })
  // CIM 失败但 BatteryFlag 128 照样可信
  assert.equal(parseWindowsBatteryStatusOutput(win({ batteryFlag: 128, percent: 255, batteryCount: -1 })).batteryState, 'absent')
  // 没有 Win32_Battery 实例、BatteryFlag 未知：没有电池
  assert.equal(parseWindowsBatteryStatusOutput(win({ batteryFlag: 255, percent: 255, batteryCount: 0 })).batteryState, 'absent')
  // BatteryFlag 与 CIM 都未知：判断不了，不能写成“无电池”
  const unknown = parseWindowsBatteryStatusOutput(win({ batteryFlag: 255, percent: 255, batteryCount: -1, acLineStatus: 255 }))
  assert.equal(unknown.batteryState, 'unknown')
  assert.equal(unknown.powerSource, 'unknown')
  assert.equal(unknown.isCharging, false)
})

test('电池：Windows 畸形输出直接报错，不猜默认值', () => {
  for (const bad of ['', '{', 'null', '[]', '"text"', win({ percent: -1 }), win({ percent: 300 }), win({ acLineStatus: '1' }), win({ lifeTime: -5 }), win({ batteryCount: 1.5 }), JSON.stringify({ percent: 50 })]) {
    assert.throws(() => parseWindowsBatteryStatusOutput(bad), Error, bad)
  }
})

test('电池：Windows 脚本兼容 PowerShell 5.1，并查询 Win32_Battery', () => {
  assert.doesNotMatch(WINDOWS_BATTERY_STATUS_SCRIPT, /\?\?|\?\./)
  assert.match(WINDOWS_BATTERY_STATUS_SCRIPT, /Win32_Battery/)
  assert.match(WINDOWS_BATTERY_STATUS_SCRIPT, /exit 1/)
})

test('电池：macOS 笔记本、台式机与无法识别的 pmset 输出', () => {
  const laptop = parseMacBatteryStatusOutput("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t76%; discharging; 3:12 remaining present: true\n")
  assert.deepEqual(laptop, { percent: 76, isCharging: false, timeRemaining: 3 * 3600 + 12 * 60, batteryState: 'present', powerSource: 'battery' })
  const charging = parseMacBatteryStatusOutput("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n")
  assert.equal(charging.isCharging, true)
  assert.equal(charging.percent, 100)
  // Mac mini / Studio：只有供电来源行，没有内置电池
  assert.deepEqual(parseMacBatteryStatusOutput("Now drawing from 'AC Power'\n"), { percent: 255, isCharging: true, timeRemaining: -1, batteryState: 'absent', powerSource: 'ac' })
  // 只有 UPS 行时不是内置电池
  assert.equal(parseMacBatteryStatusOutput("Now drawing from 'AC Power'\n -CP1500 (id=5)\t100%; AC attached; not charging\n").batteryState, 'absent')
  // 电池行没有电量：有电池、电量未知
  assert.equal(parseMacBatteryStatusOutput("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t(no estimate)\n").percent, 255)
  assert.throws(() => parseMacBatteryStatusOutput('garbage'), /无法识别/)
})

test('电池：读取命令失败、超时、非零退出都写入 readError 而不是冒充“无电池”', async () => {
  const fail = (error: unknown): BatteryCommandRunner => async () => { throw error }
  const timeout = await readSystemBatteryStatus('win32', fail(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })))
  assert.equal(timeout.batteryState, 'unknown')
  assert.equal(timeout.percent, 255)
  assert.match(timeout.readError ?? '', /超时/)
  const exit = await readSystemBatteryStatus('win32', fail(Object.assign(new Error('Command failed'), { code: 1, stderr: 'GetSystemPowerStatus failed\r\nat line 1' })))
  assert.match(exit.readError ?? '', /退出码 1：GetSystemPowerStatus failed$/)
  const missing = await readSystemBatteryStatus('darwin', fail(Object.assign(new Error('spawn'), { code: 'ENOENT' })))
  assert.match(missing.readError ?? '', /ENOENT/)
  const malformed = await readSystemBatteryStatus('win32', async () => '{')
  assert.equal(malformed.batteryState, 'unknown')
  assert.match(malformed.readError ?? '', /JSON/)
  const unsupported = await readSystemBatteryStatus('linux', async () => { throw new Error('不应执行') })
  assert.match(unsupported.readError ?? '', /不支持/)
  assert.equal(describeBatteryCommandError('奇怪的错误'), '奇怪的错误')
})

test('电池：Windows 读取链路调用系统 PowerShell 并把解析结果交给 system_get_battery_status', async () => {
  const calls: Array<{ file: string; args: string[] }> = []
  const status = await readSystemBatteryStatus('win32', async (file, args) => {
    calls.push({ file, args })
    return win({ batteryFlag: 128, percent: 255, batteryCount: 0 })
  })
  assert.equal(calls.length, 1)
  assert.match(calls[0]!.file, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  assert.deepEqual(calls[0]!.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(status.batteryState, 'absent')
  // 服务层透传新字段，旧字段 percent 255 保持兼容
  const registry = { onRemoved: () => () => {} } as never
  const power = { execute: async () => {} }, browser = { read: async () => null } as never, audio = {} as never
  const service = new SystemService({} as never, registry, { getBatteryStatus: async () => status } as never, 'win32', power, browser, audio)
  assert.deepEqual(await service.getBatteryStatus(), { success: true, ...status })
})
