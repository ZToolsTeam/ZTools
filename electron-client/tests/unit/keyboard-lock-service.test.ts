import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { KeyboardLockService, macInputLockPath } from '../../src/main/services/keyboard-lock-service.js'
import { validateKeyboardLockRequest } from '../../src/contracts/keyboard-lock.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 7701, pluginId: 'clean-keyboard', pluginInstanceId: 'instance-1' }
const start = { action: 'start', operationId: 'lock_1', durationSeconds: 5, lockPointer: false }
const signal = () => new AbortController().signal
const nativeFixture = { skip: process.platform === 'win32' }
function fixture(body = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-input-lock-')), executable = path.join(root, 'helper')
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(path.join(root, 'pid'))},String(process.pid));
const emit=(event,extra={})=>process.stdout.write(JSON.stringify({version:1,event,remainingSeconds:event==='unlocked'?0:5,blockedEvents:0,reason:event==='unlocked'?'manual':'',...extra})+'\\n');
${body || "emit('locked'); process.stdin.on('data',bytes=>{if(bytes.includes('U')){emit('unlocked');process.exit(0)}else emit('status')}); process.stdin.on('end',()=>process.exit(0));"}
`, { mode: 0o755 })
  const service = new KeyboardLockService(executable, 'darwin')
  const request = (action: string, identity = caller) => service.handle({ action, operationId: 'lock_1' }, identity, signal())
  return { root, executable, service, request, async close() { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) } }
}
test('输入锁参数、能力与路径契约严格拒绝异常输入', () => {
  validateMethodParams('keyboard_lock', start); assert.equal(canCall('keyboard_lock', caller), true)
  for (const p of [null, [], {}, { ...start, action: ['start'] }, { ...start, durationSeconds: 4 }, { ...start, durationSeconds: 301 }, { ...start, durationSeconds: 5.5 }, { ...start, lockPointer: 1 }, { ...start, executable: '/tmp/file' }, { action: 'status', operationId: 'x', durationSeconds: 10 }]) assert.throws(() => validateKeyboardLockRequest(p))
  assert.ok(path.isAbsolute(macInputLockPath(false, ''))); assert.equal(macInputLockPath(true, '/resources'), path.join('/resources', 'native', 'ZToolsMacInputLock'))
})
test('缺失组件、符号链接与未实现平台明确失败', nativeFixture, async () => {
  const f = fixture()
  try {
    await assert.rejects(new KeyboardLockService(path.join(f.root, 'missing'), 'darwin').handle(start, caller, signal()), /尚未构建/)
    const link = path.join(f.root, 'link'); fs.symlinkSync(f.executable, link)
    await assert.rejects(new KeyboardLockService(link, 'darwin').handle(start, caller, signal()), /尚未构建/)
    await assert.rejects(new KeyboardLockService(f.executable, 'win32').handle(start, caller, signal()), /尚未接入/)
  } finally { await f.close() }
})
test('真实子进程确认、归属隔离、心跳、手动解除及重试', nativeFixture, async () => {
  const f = fixture()
  try {
    assert.equal((await f.request('status')).status, 'unlocked')
    const state = await f.service.handle(start, caller, signal()); assert.equal(state.status, 'locked')
    await assert.rejects(f.service.handle(start, caller, signal()), /正在运行/)
    for (const other of [{ ...caller, webContentsId: 7702 }, { ...caller, pluginInstanceId: 'other' }]) await assert.rejects(f.request('unlock', other), /另一个窗口/)
    for (let i = 0; i < 4; i++) { await delay(450); assert.equal((await f.request('status')).status, 'locked') }
    assert.equal((await f.request('unlock')).status, 'unlocked')
    assert.equal((await f.service.handle(start, caller, signal())).status, 'locked')
    await f.service.stop(); assert.equal((await f.service.handle(start, caller, signal()).catch(e => e)).message, '键盘锁服务已停止')
  } finally { await f.close() }
})
test('插件停止续租后退出子进程，不只改变页面状态', nativeFixture, async () => {
  const f = fixture()
  try {
    await f.service.handle(start, caller, signal()); const pid = Number(fs.readFileSync(path.join(f.root, 'pid'), 'utf8'))
    await delay(1700)
    assert.equal((await f.request('status')).status, 'unlocked')
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { await f.close() }
})
test('权限拒绝、畸形响应和异常退出均不能报告成功锁定', nativeFixture, async () => {
  for (const body of ["emit('error',{code:'ACCESSIBILITY_REQUIRED'});process.exit(1)", "emit(['locked']);setInterval(()=>{},1000)", "process.stdout.write('x'.repeat(9000));setInterval(()=>{},1000)", "emit('locked',{remainingSeconds:0});setInterval(()=>{},1000)", 'process.exit(1)']) {
    const f = fixture(body)
    try { await assert.rejects(f.service.handle(start, caller, signal())); assert.equal((await f.request('status')).status, 'unlocked') }
    finally { await f.close() }
  }
})
test('启动中取消、拒绝迟到成功及停止时强制回收不响应组件', nativeFixture, async () => {
  const f = fixture("setTimeout(()=>emit('locked'),200);process.stdin.resume();setInterval(()=>{},1000)")
  try {
    const controller = new AbortController(), task = f.service.handle(start, caller, controller.signal)
    const rejected = assert.rejects(task, /取消/); controller.abort(); await rejected
    assert.equal((await f.request('status')).status, 'unlocked')
    await f.service.handle(start, caller, signal()); const pid = Number(fs.readFileSync(path.join(f.root, 'pid'), 'utf8'))
    await f.service.stop(); assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { await f.close() }
})
test('系统未确认锁定时启动超时并完成进程清理', nativeFixture, async () => {
  const f = fixture('process.stdin.resume();setInterval(()=>{},1000)')
  try {
    await assert.rejects(f.service.handle(start, caller, signal()), /未确认/)
    assert.equal((await f.request('status')).status, 'unlocked')
  } finally { await f.close() }
})
