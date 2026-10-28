import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MacAudioController, macAudioHelperPath, type SystemAudioDevice, type AudioRequest, type AudioRunner } from '../../src/main/platform/macos/audio-controller.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'

const device: SystemAudioDevice = { id: 'output:uid', uid: 'uid', name: '测试设备', type: 'output', isDefault: true, canSetDefault: true, canSetVolume: true, canMute: true, volume: 40, muted: false }
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-controller-'))
const helper = path.join(directory, 'helper'); fs.writeFileSync(helper, 'unit-test fixture')
test.after(() => fs.rmSync(directory, { recursive: true, force: true }))
const result = (data: object) => ({ stdout: JSON.stringify({ version: 1, success: true, ...data }), exitCode: 0 })

test('控制协议校验方向、精确设备与音量范围，保留默认设备调用方式', () => {
  validateMethodParams('audio_set_default_device', { id: device.id, type: 'output' })
  validateMethodParams('audio_set_default_device', { name: device.name })
  validateMethodParams('audio_set_volume', { id: device.id, type: 'output', volume: 0 })
  validateMethodParams('audio_set_volume', { volume: 50.5 })
  validateMethodParams('audio_toggle_mute', { id: 'input:mic', type: 'input', muted: false })
  validateMethodParams('audio_toggle_mute', {})
  for (const volume of [NaN, Infinity, -1, 101, '40', false]) assert.throws(() => validateMethodParams('audio_set_volume', { volume }))
  assert.throws(() => validateMethodParams('audio_set_default_device', {}))
  assert.throws(() => validateMethodParams('audio_set_volume', { volume: 40, type: 'wrong' }))
  assert.throws(() => validateMethodParams('audio_toggle_mute', { muted: 'false' }))
  assert.throws(() => validateMethodParams('audio_toggle_mute', { id: '' }))
  assert.throws(() => validateMethodParams('audio_toggle_mute', { id: '\0' }))
  assert.throws(() => validateMethodParams('audio_set_volume', { volume: 30, uid: 'other' }))
})

test('真实控制器链路：列表和操作保留设备身份，响应读回后才成功', async () => {
  const requests: AudioRequest[] = []
  const runner: AudioRunner = async (_file, request) => {
    requests.push(request)
    return request.operation === 'list' ? result({ devices: [device] }) : result({ device: { ...device, volume: 25 } })
  }
  const controller = new MacAudioController(helper, 'darwin', runner)
  assert.deepEqual(await controller.list(), [device])
  assert.equal((await controller.change({ version: 1, operation: 'volume', type: 'output', id: device.id, volume: 25 })).volume, 25)
  assert.equal(requests[1]?.operation, 'volume')
  assert.equal(macAudioHelperPath(true, '/App/Contents/Resources'), '/App/Contents/Resources/native/ZToolsMacAudio')
})

test('设备不支持控制时明确失败，不回显未知原生错误', async () => {
  for (const [code, expected] of [['AUDIO_CONTROL_UNSUPPORTED', /不支持/], ['AUDIO_PARTIAL_CHANGE', /部分声道/], ['sensitive-unknown-log', /系统音频操作失败/]] as const) {
    const controller = new MacAudioController(helper, 'darwin', async () => ({ stdout: JSON.stringify({ version: 1, success: false, code }), exitCode: 1 }))
    await assert.rejects(controller.change({ version: 1, operation: 'mute', type: 'input', id: 'input:mic' }), expected)
  }
})

test('列表错误、无效数据、重复设备、假成功退出码都不能变成成功', async () => {
  for (const response of [result({ devices: [{}] }), result({ devices: [device, device] }), result({ devices: null }), { ...result({ devices: [device] }), exitCode: 1 }, { stdout: 'broken-json', exitCode: 0 }]) {
    await assert.rejects(new MacAudioController(helper, 'darwin', async () => response).list())
  }
  assert.deepEqual(await new MacAudioController(helper, 'darwin', async () => result({ devices: [] })).list(), [])
})

test('写操作读回设备不一致、默认未改变、音量和静音不一致均拒绝', async () => {
  const cases: Array<[AudioRequest, SystemAudioDevice]> = [
    [{ version: 1, operation: 'volume', id: 'output:other', type: 'output', volume: 40 }, device],
    [{ version: 1, operation: 'volume', id: device.id, type: 'input', volume: 40 }, device],
    [{ version: 1, operation: 'default', id: device.id, type: 'output' }, { ...device, isDefault: false }],
    [{ version: 1, operation: 'volume', id: device.id, type: 'output', volume: 70 }, device],
    [{ version: 1, operation: 'mute', id: device.id, type: 'output', muted: true }, device]
  ]
  for (const [request, reply] of cases) {
    if (request.operation === 'list') throw new Error('test setup')
    await assert.rejects(new MacAudioController(helper, 'darwin', async () => result({ device: reply })).change(request))
  }
})

test('并发修改不会交错，失败后可重试', async () => {
  let finish!: (value: { stdout: string; exitCode: number }) => void
  let calls = 0
  const controller = new MacAudioController(helper, 'darwin', async () => {
    calls++; if (calls === 1) return new Promise(resolve => { finish = resolve })
    return result({ device })
  })
  const request = { version: 1, operation: 'mute', id: device.id, type: 'output', muted: false } as const
  const pending = controller.change(request)
  await assert.rejects(controller.change(request), /正在执行/)
  assert.equal(calls, 1)
  finish({ stdout: '{}', exitCode: 1 }); await assert.rejects(pending)
  assert.equal((await controller.change(request)).muted, false)
})

test('组件缺失、平台不支持、符号链接与运行器失败均明确拒绝', async () => {
  await assert.rejects(new MacAudioController(path.join(directory, 'missing'), 'darwin').list(), /未构建/)
  await assert.rejects(new MacAudioController(helper, 'win32').list(), /尚未接入/)
  const link = path.join(directory, 'link'); fs.symlinkSync(helper, link)
  await assert.rejects(new MacAudioController(link, 'darwin').list(), /无效/)
  await assert.rejects(new MacAudioController(helper, 'darwin', async () => { throw new Error('timeout') }).list(), /timeout/)
})
