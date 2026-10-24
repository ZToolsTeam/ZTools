import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { imageFixtureLaunch } from './reference-image-functions.mjs'
test('reference image launch selects an explicit Mac slice and preserves paths as arguments', () => {
  const args = ['/owned fixture/main.cjs', '/owned output', '/compiled', '/broker']
  assert.deepEqual(imageFixtureLaunch('darwin', 'arm64', '/Electron.app/Contents/MacOS/Electron', args), {
    executable: '/usr/bin/arch', args: ['-arm64', '/Electron.app/Contents/MacOS/Electron', ...args] })
  assert.equal(imageFixtureLaunch('darwin', 'x64', '/Electron', args).args[0], '-x86_64')
  assert.deepEqual(imageFixtureLaunch('win32', 'x64', 'E:/electron.exe', args), { executable: 'E:/electron.exe', args })
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'ia32'], ['darwin', 'any']]) assert.throws(() => imageFixtureLaunch(platform, arch, '/bad', []))
})
test('Mac image function entry publishes real help and exits NOT_RUN before any work on Windows', () => {
  const entry = new URL('./test-macos-reference-images.mjs', import.meta.url)
  const help = spawnSync(process.execPath, [fileURLToPath(entry), '--help'], { encoding: 'utf8', shell: false })
  assert.equal(help.status, 0); assert.match(help.stdout, /test:mac:reference:images/); assert.match(help.stdout, /--minimum-os/)
  if (process.platform === 'win32') {
    const refused = spawnSync(process.execPath, [fileURLToPath(entry)], { encoding: 'utf8', shell: false })
    assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stdout).code, 'DARWIN_REQUIRED')
  }
})

test('Windows image function help exposes the ASAR option and keeps its platform entry', () => {
  const entry = fileURLToPath(new URL('./test-windows-reference-images.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', shell: false })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--asar-workers/)
  assert.match(help.stdout, /test:win:reference:images/)
  assert.doesNotMatch(help.stdout, /--minimum-os/)
  if (process.platform === 'win32') {
    const refused = spawnSync(process.execPath, [fileURLToPath(new URL('./test-macos-reference-images.mjs', import.meta.url)), '--asar-workers'], { encoding: 'utf8', shell: false })
    assert.equal(refused.status, 1)
    assert.equal(JSON.parse(refused.stdout).code, 'DARWIN_REQUIRED')
  }
})
