import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfigRestartArgs, readConfigRestartEvidence, runConfigRestart } from './test-windows-normal-app-config-restart.mjs'

test('unsafe/unknown command options reject before App execution', () => {
  for (const args of [['--output', '../profile'], ['--output', ''], ['unexpected'], ['--arbitrary-app', 'other.exe']]) assert.throws(() => parseConfigRestartArgs(args))
  assert.deepEqual(parseConfigRestartArgs(['--help']), { help: true })
})

test('persisted bytes must contain the exact written value, including BOM JSON compatibility', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ZTools-config-restart-contract-'))
  const file = path.join(output, 'user_settings.json')
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ mergeCheckpointProbe: { value: 'expected-值' } }))
  const evidence = readConfigRestartEvidence(file, 'expected-值')
  assert.equal(evidence.valueMatches, true)
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/)
  assert.throws(() => readConfigRestartEvidence(file, 'wrong'), { message: 'PERSISTED_CONFIG_MISMATCH' })
  fs.writeFileSync(file, JSON.stringify({ mergeCheckpointProbe: 'expected-值' }))
  assert.throws(() => readConfigRestartEvidence(file, 'expected-值'), { message: 'PERSISTED_CONFIG_MISMATCH' })
})

test('existing output is never reused or overwritten and fails before an App is launched', { skip: process.platform !== 'win32' }, async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ZTools-config-restart-existing-'))
  const sentinel = path.join(output, 'sentinel.txt')
  fs.writeFileSync(sentinel, 'preserve-existing-evidence')
  await assert.rejects(runConfigRestart({ output }), { code: 'EEXIST' })
  assert.deepEqual(fs.readdirSync(output), ['sentinel.txt'])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve-existing-evidence')
})
