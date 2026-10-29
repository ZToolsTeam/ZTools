import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { mediaFixtures } from '../helpers/media-fixtures.js'
import { MediaMetadataService } from '../../src/main/services/media-metadata-service.js'
import { readMediaTags, runExifTool, tagValue } from '../../src/main/services/media-metadata-engine.js'
import { validateMediaMetadataParams } from '../../src/contracts/media-metadata.js'
import { validateOfficeParams } from '../../src/contracts/office-document.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const caller = { webContentsId: 701, pluginId: 'media-metadata' } as CallerIdentity
const signal = () => new AbortController().signal
test('真实 ExifTool 隔离无效 locale，读取中文路径且不修改宿主环境', async () => {
  const names = ['LC_ALL', 'LC_CTYPE', 'LANG'] as const
  const saved = names.map(name => process.env[name])
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-locale-'))
  try {
    for (const name of names) process.env[name] = 'ztools_invalid_locale'
    const file = path.join(directory, '中文 照片 #&.jpg')
    await fs.writeFile(file, Buffer.from(mediaFixtures.jpg, 'base64'))
    const artist = '作者 #注释\\路径 "引号" $@'
    await runExifTool(['-overwrite_original', '-Artist=' + artist, file], signal())
    const tags = await readMediaTags(file, signal())
    assert.equal(tagValue(tags, 'FileType'), 'JPEG')
    assert.equal(tagValue(tags, 'Artist'), artist)
    await assert.rejects(runExifTool([file + '\0'], signal()), /空字符/)
    if (process.platform === 'win32') {
      for (const invalid of ['-Artist=x\n-overwrite_original', '-Artist=x\r-ver', '#-ver', ' -ver', '']) {
        await assert.rejects(runExifTool([invalid, file], signal()), /逐行参数格式/)
      }
    }
    for (const name of names) assert.equal(process.env[name], 'ztools_invalid_locale')
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index] })
    await fs.rm(directory, { recursive: true, force: true })
  }
})
function fixture(ext: keyof typeof mediaFixtures = 'jpg') {
  let bytes: Buffer = Buffer.from(mediaFixtures[ext], 'base64')
  let writes = 0, output: Buffer | undefined, writeError = '', writeUnknown = false
  const input = path.resolve(os.tmpdir(), 'original.' + ext), outputPath = path.resolve(os.tmpdir(), '副本.' + ext)
  const service = new MediaMetadataService({
    readFile: async () => ({ success: true, content: bytes.toString('base64'), size: bytes.length }),
    writeFile: async (p, _caller, aborted, options) => { aborted?.throwIfAborted(); assert.equal(p.overwrite, false); assert.deepEqual(options, { replaceConfirmed: true, protectedPath: input }); assert.notEqual(p.path, input); writes++; if (writeError) throw new Error(writeError); output = Buffer.from(p.content, 'base64'); return { success: true, size: writeUnknown ? 0 : output.length } }
  })
  const inspect = () => service.execute({ action: 'inspect', operationId: 'inspect', path: input }, caller, signal())
  const clean = (mode: 'location' | 'metadata' = 'location', extra = {}, sig = signal()) => service.execute({ action: 'clean', operationId: 'clean', path: input, outputPath, digest: createHash('sha256').update(bytes).digest('hex'), mode, ...extra }, caller, sig)
  return { service, inspect, clean, input, outputPath, writes: () => writes, output: () => output!, setBytes: (data: Buffer) => { bytes = data }, failWrite: () => { writeError = '测试磁盘不可写' }, unknownWrite: () => { writeUnknown = true } }
}
async function tagsFor(bytes: Buffer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-test-'))
  try { const file = path.join(root, 'photo.bin'); await fs.writeFile(file, bytes); return await readMediaTags(file, signal()) }
  finally { await fs.rm(root, { recursive: true, force: true }) }
}
for (const ext of ['jpg', 'png', 'heic'] as const) test(`真实 ${ext} 的定位/拍摄信息清理不改图像数据与方向`, async () => {
  const before = await tagsFor(Buffer.from(mediaFixtures[ext], 'base64'))
  for (const mode of ['location', 'metadata'] as const) {
    const f = fixture(ext), info = await f.inspect(); assert.equal(info.summary?.hasLocation, true)
    assert.equal((await f.clean(mode)).status, 'committed'); assert.equal(f.writes(), 1)
    const after = await tagsFor(f.output()); assert.equal(tagValue(after, 'GPSLatitude'), undefined); assert.equal(tagValue(after, 'GPSLongitude'), undefined)
    assert.equal(tagValue(after, 'ImageDataHash'), tagValue(before, 'ImageDataHash')); assert.equal(tagValue(after, 'Orientation'), tagValue(before, 'Orientation'))
    assert.equal(tagValue(after, 'Make'), mode === 'location' ? 'AuditCamera' : undefined)
  }
})
test('XMP 重复坐标、IPTC 地点和照片尾部残留被清理', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-test-'))
  try {
    const file = path.join(root, 'gps.jpg'); await fs.writeFile(file, Buffer.from(mediaFixtures.jpg, 'base64'))
    await runExifTool(['-overwrite_original', '-XMP:GPSLatitude=31.25', '-XMP:GPSLongitude=121.45', '-IPTC:City=FixtureCity', file], signal())
    await fs.appendFile(file, 'GPS_PRIVATE_TRAILER_SENTINEL')
    const f = fixture(); f.setBytes(await fs.readFile(file)); await f.clean()
    const after = await tagsFor(f.output()); assert.equal(Object.keys(after).some(key => /GPS|City/.test(key)), false)
    assert.equal(f.output().includes(Buffer.from('GPS_PRIVATE_TRAILER_SENTINEL')), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('原文件变化、同一路径、错误扩展名和已有目标均不会假成功', async () => {
  const f = fixture()
  for (const params of [{ digest: '0'.repeat(64) }, { outputPath: f.input }, { outputPath: f.outputPath + '.exe' }]) await assert.rejects(f.clean('location', params))
  assert.equal(f.writes(), 0)
  f.failWrite(); await assert.rejects(f.clean(), /不可写/)
})
test('写入回执未知时报告未确认，不返回 committed', async () => { const f = fixture(); f.unknownWrite(); await assert.rejects(f.clean(), /未确认/) })
test('损坏文件和超过大小限制的文件均拒绝，不写出占位副本', async () => {
  const f = fixture(); f.setBytes(Buffer.from('ZTOOLS_EXIF fake metadata'))
  await assert.rejects(f.clean()); assert.equal(f.writes(), 0)
  f.setBytes(Buffer.alloc(16 * 1024 * 1024 + 1)); await assert.rejects(f.inspect(), /16 MiB/)
})
test('真实 WAV 读取原参数，不伪造视频编码，也不允许清理', async () => {
  const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40)
  const f = fixture(); f.setBytes(wav); const info = await f.inspect(); assert.equal(info.summary?.canClean, false); assert.equal(info.summary?.type, 'WAV')
  assert.equal(JSON.stringify(info).includes('H264'), false); await assert.rejects(f.clean(), /扩展名|目前只支持/); assert.equal(f.writes(), 0)
})
test('错误枚举类型不能改变清理模式或触发写入', () => {
  const p = { action: 'clean', path: '/tmp/a.jpg', outputPath: '/tmp/b.jpg', operationId: 'a', digest: 'a'.repeat(64), mode: 'location' }
  for (const wrong of [['location'], {}, true, 1, null]) assert.throws(() => validateMediaMetadataParams({ ...p, mode: wrong }))
  assert.throws(() => validateMediaMetadataParams({ ...p, action: ['clean'] }))
  assert.throws(() => validateOfficeParams({ action: ['inspect'], path: '/tmp/a.docx', operationId: 'x' }))
})
test('取消只作用于拥有该操作的窗口与插件，取消后可以再次读取', async () => {
  const f = fixture(), pending = f.clean()
  assert.equal(f.service.cancel('clean', { ...caller, webContentsId: 702 }).cancelRequested, false)
  assert.equal(f.service.cancel('clean', { ...caller, pluginId: 'other' }).cancelRequested, false)
  assert.equal(f.service.cancel('clean', caller).cancelRequested, true)
  await assert.rejects(pending, /取消/); assert.equal(f.writes(), 0); assert.equal((await f.inspect()).success, true)
})
test('重复操作被拒绝，停机取消在途任务并拒绝新请求', async () => {
  const f = fixture(), pending = f.clean(); await assert.rejects(f.inspect(), /稍后重试/)
  f.service.stop(); await assert.rejects(pending, /取消/); await assert.rejects(f.inspect(), /稍后重试/); assert.equal(f.writes(), 0)
})
test('已取消的调用不会启动子进程', async () => { const c = new AbortController(); c.abort(); await assert.rejects(runExifTool(['-ver'], c.signal)) })

test('PNG 的 gAMA、sRGB、cHRM 色彩块在两种清理模式后保留', async () => {
  const original = Buffer.from(mediaFixtures.png, 'base64')
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), checksum = Buffer.alloc(4)
    header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, checksum])
  }
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(100000)
  const chroma = Buffer.alloc(32); [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((v, i) => chroma.writeUInt32BE(v, i * 4))
  const blocks = [chunk('gAMA', gamma), chunk('sRGB', Buffer.from([0])), chunk('cHRM', chroma)]
  const colored = Buffer.concat([original.subarray(0, 33), ...blocks, original.subarray(33)])
  for (const mode of ['location', 'metadata'] as const) {
    const f = fixture('png'); f.setBytes(colored); await f.clean(mode)
    for (const block of blocks) assert.equal(f.output().includes(block), true)
    const after = await tagsFor(f.output()); assert.equal(tagValue(after, 'Gamma'), 1); assert.equal(tagValue(after, 'SRGBRendering'), 0)
    assert.equal(tagValue(after, 'GPSLatitude'), undefined)
  }
})

test('JPEG 的 Adobe RGB 和互操作色彩声明不能被当作隐私删除', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-color-'))
  try {
    const file = path.join(root, 'adobe.jpg'); await fs.writeFile(file, Buffer.from(mediaFixtures.jpg, 'base64'))
    await runExifTool(['-overwrite_original', '-ExifIFD:ColorSpace#=2', '-InteropIFD:InteropIndex=R03', file], signal())
    const f = fixture(); f.setBytes(await fs.readFile(file)); await f.clean('metadata')
    const after = await tagsFor(f.output()); assert.equal(tagValue(after, 'ColorSpace'), 2); assert.equal(tagValue(after, 'InteropIndex'), 'R03')
    assert.equal(tagValue(after, 'Make'), undefined); assert.equal(tagValue(after, 'GPSLatitude'), undefined)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
