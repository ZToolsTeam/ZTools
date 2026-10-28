import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPackageWithOptions, statFile } from '@electron/asar'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createMacUniversalPackagerOptions } from './package-macos-universal.mjs'
import { createWindowsPackagerOptions } from './windows-package-contract.mjs'
const require = createRequire(import.meta.url)
test('Mac 和 Windows 打包均解包 ExifTool 的脚本、可执行文件和库', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-asar-'))
  try {
    const vendorName = process.platform === 'win32' ? 'exiftool-vendored.exe' : 'exiftool-vendored.pl'
    const vendorRoot = path.dirname(require.resolve(vendorName)), binaryRelative = path.relative(vendorRoot, require(vendorName)).split(path.sep).join('/')
    const source = path.join(root, 'app'), vendor = path.join(source, 'node_modules', vendorName)
    await fs.mkdir(path.dirname(vendor), { recursive: true })
    await fs.cp(vendorRoot, vendor, { recursive: true })
    const mac = createMacUniversalPackagerOptions({ sourceRoot: source, outputRoot: root, appBundleId: 'cn.ztools.audit', shortVersion: '1.1.8', buildVersion: '1.1.8004' })
    const win = createWindowsPackagerOptions({ clientRoot: source, outputRoot: root, applicationIcon: 'test.ico' })
    assert.deepEqual(mac.asar, win.asar)
    for (const options of [mac, win]) assert.equal(options.ignore.some(rule => rule.test('/node_modules/exiftool-vendored.pl/bin/lib/Image/ExifTool.pm')), false)
    const archive = path.join(root, 'app.asar'); await createPackageWithOptions(source, archive, mac.asar)
    for (const name of ['index.js', binaryRelative]) assert.equal(statFile(archive, 'node_modules/' + vendorName + '/' + name).unpacked, true)
    if (process.platform !== 'win32') assert.equal(statFile(archive, 'node_modules/exiftool-vendored.pl/bin/lib/Image/ExifTool.pm').unpacked, true)
    if (process.platform === 'darwin') {
      const bin = path.join(archive + '.unpacked', 'node_modules/exiftool-vendored.pl/bin/exiftool')
      assert.match(execFileSync('/usr/bin/perl', [bin, '-config', '', '-ver'], { encoding: 'utf8', timeout: 30000 }), /^13\.59/)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
