import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  flushRuntimeLog,
  flushRuntimeLogSync,
  initializeRuntimeLogging,
  writeRuntimeLog
} from '../../src/main/services/runtime-logger.js'

const PER_LAUNCH_LOG_PATTERN = /^electron-main-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-pid\d+(?:-\d+)?\.log$/

test('runtime logger returns undefined without throwing when logDirectory is invalid', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-invalid-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  assert.equal(initializeRuntimeLogging(''), undefined)
  assert.equal(initializeRuntimeLogging('   '), undefined)

  const blockingFile = path.join(root, 'not-a-directory')
  await fs.writeFile(blockingFile, 'occupied', 'utf8')
  assert.equal(initializeRuntimeLogging(blockingFile), undefined)
  assert.equal(initializeRuntimeLogging(path.join(blockingFile, 'Logs')), undefined)
})

test('runtime logger writes console and scoped errors to a per-launch file', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const file = initializeRuntimeLogging(root)
  assert.ok(file)
  assert.match(path.basename(file), PER_LAUNCH_LOG_PATTERN)
  assert.match(path.basename(file), new RegExp(`-pid${process.pid}(?:-\\d+)?\\.log$`))
  console.warn('console diagnostic', { pluginId: 'todo' })
  writeRuntimeLog('ERROR', 'renderer:window:7', 'plugin launch failed')
  await flushRuntimeLog()

  const content = await fs.readFile(file, 'utf8')
  assert.match(content, /\[INFO\] \[logger\] Runtime file logging initialized/)
  assert.match(content, /\[WARN\] \[main\] console diagnostic \{ pluginId: 'todo' \}/)
  assert.match(content, /\[ERROR\] \[renderer:window:7\] plugin launch failed/)
})

test('runtime logger creates a separate log file for each initialization', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-multi-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const firstFile = initializeRuntimeLogging(root)
  assert.ok(firstFile)
  writeRuntimeLog('INFO', 'session-1', 'first launch marker')

  const secondFile = initializeRuntimeLogging(root)
  assert.ok(secondFile)
  assert.notEqual(secondFile, firstFile)
  assert.match(path.basename(firstFile), PER_LAUNCH_LOG_PATTERN)
  assert.match(path.basename(secondFile), PER_LAUNCH_LOG_PATTERN)
  writeRuntimeLog('INFO', 'session-2', 'second launch marker')
  await flushRuntimeLog()

  const firstContent = await fs.readFile(firstFile, 'utf8')
  const secondContent = await fs.readFile(secondFile, 'utf8')
  assert.match(firstContent, /first launch marker/)
  assert.doesNotMatch(firstContent, /second launch marker/)
  assert.match(secondContent, /second launch marker/)
  assert.doesNotMatch(secondContent, /first launch marker/)

  const files = await fs.readdir(root)
  assert.equal(files.length, 2)
})

test('runtime logger routes Node DeprecationWarning to WARN instead of ERROR', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-warn-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const file = initializeRuntimeLogging(root)
  assert.ok(file)

  process.emitWarning('fs.Stats constructor is deprecated.', {
    code: 'DEP0180',
    type: 'DeprecationWarning'
  })
  // Node warning 事件在同一轮事件循环微任务后触发 listener
  await new Promise((resolve) => setImmediate(resolve))
  await flushRuntimeLog()

  const content = await fs.readFile(file, 'utf8')
  assert.match(content, /\[WARN\] \[node-warning\] DeprecationWarning \[DEP0180\]: fs\.Stats constructor is deprecated\./)
  assert.doesNotMatch(content, /\[ERROR\].*DEP0180/)
})

test('runtime logger coalesces same-tick writes into a single async appendFile batch and supports sync flush', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-batch-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const file = initializeRuntimeLogging(root)
  assert.ok(file)
  await flushRuntimeLog()

  let appendCalls = 0
  const originalAppendFile = fs.appendFile
  fs.appendFile = (async (...args: Parameters<typeof fs.appendFile>) => {
    appendCalls += 1
    return originalAppendFile(...args)
  }) as typeof fs.appendFile
  try {
    writeRuntimeLog('INFO', 'batch', 'line-1')
    writeRuntimeLog('INFO', 'batch', 'line-2')
    writeRuntimeLog('WARN', 'batch', 'line-3')
    await flushRuntimeLog()
    assert.equal(appendCalls, 1, '同一事件循环 tick 内的多条日志应合并为单次异步写盘')
  } finally {
    fs.appendFile = originalAppendFile
  }

  writeRuntimeLog('ERROR', 'sync-flush', 'before-crash')
  flushRuntimeLogSync()
  const content = await fs.readFile(file, 'utf8')
  assert.match(content, /line-1/)
  assert.match(content, /line-2/)
  assert.match(content, /line-3/)
  assert.match(content, /before-crash/)
})
