import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { buildMacDisplay } from './build-macos-display.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
test('显示器原生帧与恢复策略：细微调节未生效必须失败，不能覆盖其他程序后续变化', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-display-test-'))
  try {
    const binary = path.join(directory, 'policy')
    execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', path.join(root, 'native/ZToolsMacDisplay/control_test.cpp'), '-o', binary], { timeout: 60000 })
    const output = execFileSync(binary, [], { timeout: 5000, encoding: 'utf8' }); assert.match(output, /全部通过/)
    assert.throws(() => buildMacDisplay({ platform: 'win32' }), /DARWIN_REQUIRED/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
