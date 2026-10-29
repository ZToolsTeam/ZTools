import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FontManagerService } from '../../src/main/services/font-manager-service.js'
import { parseFontList, parseFontPreview, runFontProcess, SystemFontProvider } from '../../src/main/services/font-provider.js'
import { validateFontRequest } from '../../src/contracts/font-manager.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { FontProvider } from '../../src/main/services/font-provider.js'
const caller = { webContentsId: 770, pluginId: 'font-manager' } as CallerIdentity
const font = { id: 'Example-Regular', family: 'Example', style: 'Regular', filePath: '', hasLicense: false, system: false }
const signal = () => new AbortController().signal
test('拒绝任意路径、脚本参数、类型伪装和超长预览', () => {
  const input = { action: 'preview', operationId: 'font_1', id: font.id, text: '字体 preview' }
  validateFontRequest(input)
  for (const patch of [{ action: ['preview'] }, { id: [] }, { text: 'a'.repeat(161) }, { text: ' ' }, { text: '\0x' }, { path: '/tmp/a' }, { args: ['-Command'] }, { operationId: '../x' }]) assert.throws(() => validateFontRequest({ ...input, ...patch }))
  assert.throws(() => validateFontRequest({ ...input, action: 'list' }))
  assert.throws(() => validateFontRequest({ ...input, action: 'reveal' }))
})
test('读取失败不变成空字体列表；重复和不完整的条目拒绝', () => {
  assert.deepEqual(parseFontList({ version: 1, success: true, fonts: [] }), [])
  for (const reply of [{ success: false, fonts: [] }, { version: 1, success: true, fonts: [font, font] }, { version: 1, success: true, fonts: [{ ...font, family: '' }] }]) assert.throws(() => parseFontList(reply))
  assert.throws(() => parseFontPreview({ version: 1, success: true, id: 'wrong' }, font.id))
  assert.throws(() => parseFontPreview({ version: 1, success: true, id: font.id, png: 'not a PNG', fallbacks: [] }, font.id))
})
test('取消归属隔离，关闭宿主中断任务，迟到结果不报告成功', async () => {
  let finish!: (value: typeof font[]) => void
  const provider: FontProvider = { list: () => new Promise(resolve => { finish = resolve }), preview: async () => { throw new Error('unused') } }
  const service = new FontManagerService(provider, () => assert.fail('只读列表不定位文件'))
  const pending = service.execute({ action: 'list', operationId: 'scan' }, caller, signal())
  assert.equal(service.cancel('scan', { ...caller, webContentsId: 771 }).cancelRequested, false)
  assert.equal(service.cancel('scan', { ...caller, pluginId: 'other' }).cancelRequested, false)
  assert.equal(service.cancel('scan', caller).cancelRequested, true)
  finish([font]); await assert.rejects(pending)
  const second = service.execute({ action: 'list', operationId: 'scan2' }, caller, signal())
  service.stop(); finish([font]); await assert.rejects(second)
  await assert.rejects(service.execute({ action: 'list', operationId: 'scan3' }, caller, signal()))
})
test('定位只能使用系统实时列表内的字体文件，无法指定任意路径', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-font-test-')), file = path.join(root, 'font.ttf')
  await fs.writeFile(file, 'font path fixture')
  let files = [{ ...font, filePath: file }], revealed = ''
  const service = new FontManagerService({ list: async () => files, preview: async () => { throw new Error('unused') } }, file => { revealed = file })
  const run = (id: string) => service.execute({ action: 'reveal', operationId: 'reveal', id }, caller, signal())
  try {
    await assert.rejects(run('unknown')); assert.equal(revealed, '')
    assert.equal((await run(font.id)).revealRequested, true); assert.equal(revealed, file)
    files = []; revealed = ''; await assert.rejects(run(font.id)); assert.equal(revealed, '')
  } finally { await fs.rm(root, { force: true, recursive: true }) }
})
test('子进程失败和损坏输出不返回成功；取消终止实际子进程', async () => {
  const request = { version: 1, operation: 'fonts-list' } as const
  await assert.rejects(runFontProcess(process.execPath, ['-e', 'process.exit(1)'], request, signal()))
  await assert.rejects(runFontProcess(process.execPath, ['-e', 'console.log("not json")'], request, signal()))
  const abort = new AbortController(), start = Date.now()
  const pending = runFontProcess(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], request, abort.signal)
  setTimeout(() => abort.abort(), 80)
  await assert.rejects(pending); assert.ok(Date.now() - start < 3000)
})
test('预览缺字提示：coverageWarning 原样透传，超长或非字符串拒绝', () => {
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1000, 16); png.writeUInt32BE(200, 20)
  const base = { version: 1, success: true, id: font.id, png: png.toString('base64'), fallbacks: ['LastResort'], license: '', licenseUrl: '', copyright: '', manufacturer: '' }
  assert.equal(parseFontPreview(base, font.id).coverageWarning, '')
  assert.equal(parseFontPreview({ ...base, coverageWarning: '部分字符本机没有任何字体包含，显示为占位方框。' }, font.id).coverageWarning, '部分字符本机没有任何字体包含，显示为占位方框。')
  assert.throws(() => parseFontPreview({ ...base, coverageWarning: 'x'.repeat(1025) }, font.id))
  assert.throws(() => parseFontPreview({ ...base, coverageWarning: 1 }, font.id))
})
const visionHelper = path.resolve(__dirname, '../../../out/mac-vision-native/native/ZToolsMacVision')
const visionSkip = process.platform !== 'darwin' ? '仅 macOS' : existsSync(visionHelper) ? false : 'ZToolsMacVision 未构建'
test('真实 Mac 字体组件：苹方等 /System/ 下（含 AssetsV2、PrivateFrameworks）的字体标为系统字体；缺字时返回 coverageWarning', { skip: visionSkip }, async () => {
  const provider = new SystemFontProvider(visionHelper, 'darwin')
  const fonts = await provider.list(signal())
  const pingfang = fonts.filter(item => item.id.startsWith('PingFang'))
  assert.ok(pingfang.length > 0, '本机应有苹方字体')
  assert.ok(pingfang.every(item => item.system), '苹方必须标为系统字体')
  for (const item of fonts) assert.equal(item.system, item.filePath.startsWith('/System/'))
  const missing = await provider.preview('Helvetica', 'Hello 中文 \u{10FFFD}', signal())
  assert.ok(missing.fallbacks.includes('LastResort'))
  assert.match(missing.coverageWarning ?? '', /占位方框/)
  const complete = await provider.preview('Helvetica', 'Hello world', signal())
  assert.equal(complete.coverageWarning, '')
})
