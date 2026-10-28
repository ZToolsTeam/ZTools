import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createZipArchiveFromDirectory } from '../scripts/build-plugins-release.mjs'

/** 从 ZIP 中央目录读出全部文件名 */
function zipEntryNames(buf) {
  const names = []
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    let offset = buf.readUInt32LE(i + 16)
    const count = buf.readUInt16LE(i + 10)
    for (let n = 0; n < count; n++) {
      const nameLength = buf.readUInt16LE(offset + 28)
      const extraLength = buf.readUInt16LE(offset + 30)
      const commentLength = buf.readUInt16LE(offset + 32)
      names.push(buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
      offset += 46 + nameLength + extraLength + commentLength
    }
    break
  }
  return names.sort()
}

test('插件安装包不带真机截图目录（任意层级、任意大小写），运行需要的文件照常打包', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-plugin-zip-'))
  try {
    const files = {
      'plugin.json': '{"id":"demo","version":"1.0.0"}',
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'dist/index.js': 'export default 1',
      'screenshots/01-overview.png': 'png',
      'src/Screenshots/nested.png': 'png',
      'docs/SCREENSHOTS/x.png': 'png',
      'src/screenshots.ts': 'export const screenshotsFeature = 1'
    }
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel), content)
    }
    const names = zipEntryNames(createZipArchiveFromDirectory(dir))
    assert.deepEqual(names, ['dist/index.js', 'icon.svg', 'plugin.json', 'src/screenshots.ts'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
