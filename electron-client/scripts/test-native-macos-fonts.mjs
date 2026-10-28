import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const executable = fileURLToPath(new URL('../out/mac-vision-native/native/ZToolsMacVision', import.meta.url))
const mac = { skip: process.platform !== 'darwin' }
function call(params) {
  const result = spawnSync(executable, [], { input: JSON.stringify({ version: 1, ...params }), encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw result.error
  return { status: result.status, ...JSON.parse(result.stdout) }
}
test('真实系统字体集合包含可用样式，集合字体可绘制不同字形', mac, () => {
  const list = call({ operation: 'fonts-list' })
  assert.equal(list.status, 0); assert.equal(list.success, true); assert.ok(list.fonts.length > 0)
  assert.equal(new Set(list.fonts.map(font => font.id)).size, list.fonts.length)
  const images = []
  for (const id of ['Helvetica', 'Menlo-Regular', 'PingFangSC-Regular']) {
    assert.ok(list.fonts.some(font => font.id === id), `${id} 未注册`)
    const preview = call({ operation: 'fonts-preview', id, text: 'ZTools 123 字体' })
    assert.equal(preview.status, 0); assert.equal(preview.id, id)
    const png = Buffer.from(preview.png, 'base64')
    assert.equal(png.readUInt32BE(16), 1000); assert.ok(png.length > 1000)
    images.push(createHash('sha256').update(png).digest('hex'))
    if (id === 'Menlo-Regular') assert.ok(preview.fallbacks.length > 0)
  }
  assert.equal(new Set(images).size, 3)
})
test('失效字体不静默替换，非法输入与超长文字不绘制', mac, () => {
  for (const request of [
    { operation: 'fonts-preview', id: 'Font-Not-Installed-ZToolsAudit', text: 'Test' },
    { operation: 'fonts-preview', id: 'Helvetica', text: ['Test'] },
    { operation: 'fonts-preview', id: 'Helvetica', text: 'a'.repeat(321) },
    { operation: 'fonts-list', path: '/tmp/unknown.ttf' },
    { operation: 'fonts-list', version: true }
  ]) { const result = call(request); assert.equal(result.success, false); assert.equal(result.status, 1); assert.equal(result.png, undefined) }
})
test('扩展字体能力后原 OCR 自检仍通过', mac, () => {
  const result = JSON.parse(execFileSync(executable, ['--self-test'], { encoding: 'utf8', timeout: 60000 }))
  assert.equal(result.success, true); assert.equal(result.cases, 9)
})
