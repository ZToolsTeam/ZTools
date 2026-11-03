import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SystemRegistryHostPluginHandler } from '../../src/main/services/host-plugins/system-registry-host.js'
import { PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

const pid = 54321
const lock = { pid, name: 'worker.exe', executablePath: 'C:\\tools\\worker.exe' }
type Reply = { success: boolean; errorCode?: string; processes?: Array<{ pid: number }> }
const context: HostPluginContext = { clipboard: null, processService: null, windowControl: null,
  authorizeExistingPath: async file => file, authorizeOutputPath: async file => file }

async function fixture(work: (file: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-lock-recheck-'))
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    const file = path.join(directory, 'document.txt')
    await fs.writeFile(file, 'unchanged')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await work(file)
    assert.equal(await fs.readFile(file, 'utf8'), 'unchanged')
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function system(replies: Array<unknown | Error>, names = ['worker.exe', '']) {
  const killed: number[] = [], scripts: string[] = [], commands: string[] = []
  const handler = new SystemRegistryHostPluginHandler(context, {
    runPowerShell: async script => {
      scripts.push(script)
      const value = replies.shift()
      if (value instanceof Error) throw value
      assert.notEqual(value, undefined, '不允许调用未预设的系统查询')
      return JSON.stringify(value)
    },
    runCommand: async (command, args) => {
      commands.push(command)
      assert.equal(command, 'tasklist')
      assert.ok(args.includes(`PID eq ${pid}`))
      const name = names.shift()
      assert.notEqual(name, undefined)
      return { stdout: name ? `"${name}","${pid}","Console","1","100 K"` : 'INFO: No tasks are running.', stderr: '', exitCode: 0 }
    },
    killProcess: value => { killed.push(value) }
  })
  return { handler, killed, scripts, commands }
}

test('Windows 文件解锁只采信 Restart Manager，先前列出的占用释放后不能再结束进程', async () => fixture(async file => {
  const h = system([{ processes: [lock] }, { processes: [] }])
  const scan = await h.handler.handleFileUnlock('inspectLocks', { targetPath: file }) as Reply
  assert.deepEqual(scan.processes?.map(item => item.pid), [pid])
  assert.match(h.scripts[0]!, /RmRegisterResources/)
  assert.doesNotMatch(h.scripts[0]!, /Get-CimInstance Win32_Process|\.CommandLine|\$targetPrefix/)
  const result = await h.handler.handleFileUnlock('unlockPath', { targetPath: file, pid, expectedName: lock.name }) as Reply
  assert.equal(result.errorCode, 'LOCK_CHANGED')
  assert.deepEqual(h.killed, [])
  assert.deepEqual(h.commands, [])
}))

test('Windows 文件解锁复核失败、PID 已无占用或占用者身份变化时不结束也不回收', async () => fixture(async file => {
  for (const [reply, code] of [
    [{ processes: [] }, 'LOCK_CHANGED'],
    [{ processes: [{ ...lock, pid: pid + 1 }] }, 'LOCK_CHANGED'],
    [{ processes: [{ ...lock, name: 'another.exe' }] }, 'LOCK_CHANGED'],
    [{ processes: 'invalid' }, 'LOCK_RECHECK_FAILED'],
    [new PowerShellError(124, 'timeout'), 'LOCK_RECHECK_FAILED']
  ] as const) {
    const h = system([reply])
    const result = await h.handler.handleFileUnlock('unlockPath', { targetPath: file, pid, expectedName: lock.name, trashAfterUnlock: true }) as Reply
    assert.equal(result.errorCode, code)
    assert.deepEqual(h.killed, [])
    assert.deepEqual(h.commands, [])
    assert.equal(h.scripts.length, 1)
  }
}))

test('Windows 文件解锁复核后再次核对进程名，正常占用才结束并确认退出', async () => fixture(async file => {
  const changed = system([{ processes: [lock] }], ['another.exe'])
  const denied = await changed.handler.handleFileUnlock('unlockPath', { targetPath: file, pid, expectedName: lock.name }) as Reply
  assert.equal(denied.errorCode, 'PROCESS_IDENTITY_MISMATCH')
  assert.deepEqual(changed.killed, [])
  const h = system([{ processes: [lock] }])
  const result = await h.handler.handleFileUnlock('unlockPath', { targetPath: file, pid, expectedName: 'WORKER.EXE' }) as Reply
  assert.equal(result.success, true)
  assert.deepEqual(h.killed, [pid])
  assert.deepEqual(h.commands, ['tasklist', 'tasklist'])
}))

test('Windows 文件解锁缺少目标或目标授权失败时不调用结束进程', async () => fixture(async file => {
  for (const targetPath of ['', path.join(path.dirname(file), 'missing.txt')]) {
    const h = system([])
    const result = await h.handler.handleFileUnlock('unlockPath', { targetPath, pid, expectedName: lock.name }) as Reply
    assert.equal(result.errorCode, 'LOCK_RECHECK_FAILED')
    assert.deepEqual(h.killed, [])
    assert.equal(h.scripts.length, 0)
  }
  const handler = new SystemRegistryHostPluginHandler({ ...context, authorizeExistingPath: async () => { throw new Error('访问授权已失效') } }, {
    killProcess: () => { assert.fail('未授权目标不能结束进程') }
  })
  const denied = await handler.handleFileUnlock('unlockPath', { targetPath: file, pid, expectedName: lock.name }) as Reply
  assert.equal(denied.errorCode, 'LOCK_RECHECK_FAILED')
}))
