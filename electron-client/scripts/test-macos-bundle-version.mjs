import test from 'node:test'
import assert from 'node:assert/strict'
import { validateMacBundleVersions } from './macos-bundle-version.mjs'
import { main } from './package-macos-universal.mjs'

test('native versions require explicit Apple formats and never truncate the logical app version', () => {
  for (const build of ['1', '1.2', '1.2.3']) assert.deepEqual(validateMacBundleVersions('1.1.7', build), { shortVersion: '1.1.7', buildVersion: build })
  for (const short of [undefined, '', '1.1.7.1', '1.2', '01.2.3', '1.2.3-beta', '9007199254740992.1.1']) assert.throws(() => validateMacBundleVersions(short, '1'))
  for (const build of [undefined, '', '1.2.3.4', '01', '-1', '1-beta']) assert.throws(() => validateMacBundleVersions('1.1.7', build))
})
test('packaging help works on Windows without native operations', async () => {
  const messages = []
  assert.equal(await main(['--help'], { platform: 'win32', stdout: message => messages.push(message) }), 0)
  assert.match(messages[0], /--short-version/)
})
