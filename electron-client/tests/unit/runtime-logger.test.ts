import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeRuntimeLogging, writeRuntimeLog } from '../../src/main/services/runtime-logger.js'

test('runtime logger writes console and scoped errors to a daily file', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-log-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const file = initializeRuntimeLogging(root)
  assert.ok(file)
  console.warn('console diagnostic', { pluginId: 'todo' })
  writeRuntimeLog('ERROR', 'renderer:window:7', 'plugin launch failed')

  const content = await fs.readFile(file, 'utf8')
  assert.match(content, /\[INFO\] \[logger\] Runtime file logging initialized/)
  assert.match(content, /\[WARN\] \[main\] console diagnostic \{ pluginId: 'todo' \}/)
  assert.match(content, /\[ERROR\] \[renderer:window:7\] plugin launch failed/)
})
