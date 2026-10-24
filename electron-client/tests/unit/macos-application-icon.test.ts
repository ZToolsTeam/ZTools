import assert from 'node:assert/strict'
import test from 'node:test'
import { readMacosApplicationIcon } from '../../src/main/platform/macos/application-icon.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

test('application path is a separate argument and icon output is a PNG data URL', async () => {
  const app = '/Applications/An app "quoted".app'
  const result = await readMacosApplicationIcon(app, async (executable, args) => {
    assert.equal(executable, '/usr/bin/osascript')
    assert.equal(args.at(-1), app)
    assert.ok(!args[3]?.includes(app))
    return png + '\n'
  })
  assert.equal(result, `data:image/png;base64,${png}`)
})

test('invalid paths, invalid icon output, oversized output and process errors are not successful icons', async () => {
  const runner = async () => png
  for (const value of ['relative.app', '/file.png', '/bad\0.app']) {
    await assert.rejects(readMacosApplicationIcon(value, runner))
  }
  for (const value of ['', 'generic placeholder', 'data:image/png;base64,' + png, 'iVBORw0KGgo' + 'A'.repeat(256 * 1024)]) {
    await assert.rejects(readMacosApplicationIcon('/Applications/Example.app', async () => value))
  }
  await assert.rejects(readMacosApplicationIcon('/Applications/Example.app', async () => { throw new Error('timeout') }), /timeout/)
})
