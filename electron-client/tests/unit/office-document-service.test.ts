import test from 'node:test'
import assert from 'node:assert/strict'
import { buildZipFixture as rawZipFixture } from '../helpers/zip-fixture.js'
import { ReferenceZipService } from '../../src/main/services/reference-zip-service.js'
import { OfficeDocumentService } from '../../src/main/services/office-document-service.js'
import { inspectOffice, cleanOfficeMetadata, encodeVerifiedOfficeArchive } from '../../src/main/services/office-archive.js'
import type { ZipContentEntry } from '../../src/main/services/reference-zip-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const caller = { webContentsId: 77 } as CallerIdentity, input = '/tmp/source.docx', output = '/tmp/copy.docx', zipId = 'z'.repeat(43)
const buildZipFixture = (entries: ZipContentEntry[], corrupt = false, deflated = false) => rawZipFixture(entries.map(entry => ({ name: entry.name, data: Buffer.from(entry.data) })), corrupt, deflated)
const signal = () => new AbortController().signal
const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
function entries(type: 'docx' | 'xlsx' | 'pptx' = 'docx'): ZipContentEntry[] {
  const main = type === 'docx' ? 'word/document.xml' : type === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'
  const mainType = type === 'docx' ? 'wordprocessingml.document' : type === 'pptx' ? 'presentationml.presentation' : 'spreadsheetml.sheet'
  const prefix = main.split('/')[0]!, comment = prefix + (type === 'pptx' ? '/comments/comment1.xml' : '/comments.xml')
  const files: Record<string, string | Buffer> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${mainType}.main+xml"/><Override PartName="/${comment}" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relNS}"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,
    [main]: `<w:document xmlns:w="${w}"><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>正文保持不变</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p></w:body></w:document>`,
    [`${prefix}/_rels/${main.split('/')[1]}.rels`]: `<Relationships xmlns="${relNS}"><Relationship Id="comment" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="${comment.slice(prefix.length + 1)}"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`,
    [comment]: `<w:comments xmlns:w="${w}"><w:comment w:id="1" w:author="CommentAuthor"><w:p><w:r><w:t>机密批注</w:t></w:r></w:p></w:comment></w:comments>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>PrivateAuthor</dc:creator><cp:lastModifiedBy>PrivateEditor</cp:lastModifiedBy></cp:coreProperties>',
    [`${prefix}/media/image1.png`]: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64')
  }
  return Object.entries(files).map(([name, value]) => ({ name, isDirectory: false, data: Buffer.isBuffer(value) ? value : Buffer.from(value) }))
}
function fixture(type: 'docx' | 'xlsx' | 'pptx' = 'docx', deflated = false) {
  let bytes = buildZipFixture(entries(type), false, deflated), written: Buffer | undefined, writes = 0, failWrite = false
  const service = new OfficeDocumentService({
    readFile: async () => ({ success: true, content: bytes.toString('base64'), size: bytes.length }),
    writeFile: async params => {
      assert.equal(params.overwrite, false); writes++
      if (failWrite) throw new Error('目标文件已存在')
      written = Buffer.from(params.content, 'base64'); return { success: true, size: written.length }
    }
  })
  return { service, original: () => bytes, output: () => written, writes: () => writes, failWrite: () => { failWrite = true }, change: (data: Buffer) => { bytes = Buffer.from(data) } }
}
for (const type of ['docx', 'xlsx', 'pptx'] as const) for (const deflated of [false, true]) {
  test(`${type} ${deflated ? 'DEFLATE' : 'STORE'} 真 ZIP 往返；原图与正文保留，作者批注清除`, async () => {
    const f = fixture(type, deflated), original = Buffer.from(f.original())
    const inspected = await f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal())
    assert.ok('summary' in inspected); const summary = inspected.summary!
    assert.equal(summary.hasAuthor, true); assert.equal(summary.hasComments, true); assert.equal(summary.images.length, 1)
    const result = await f.service.execute({ action: 'slim', path: input, outputPath: output.replace('docx', type), operationId: 'slim', digest: summary.digest, cleanMetadata: true }, caller, signal())
    assert.ok('status' in result && result.status === 'committed'); assert.deepEqual(f.original(), original)
    const outputZip = new ReferenceZipService({ read: async () => f.output()! })
    const decoded = await outputZip.readEntries({ fileGrantId: zipId }, caller, signal())
    assert.equal(inspectOffice(decoded).hasComments, false); assert.equal(inspectOffice(decoded).hasAuthor, false)
    const texts = decoded.filter(e => e.name.endsWith('.xml')).map(e => e.data.toString()).join('')
    assert.match(texts, /正文保持不变/); assert.doesNotMatch(texts, /PrivateAuthor|PrivateEditor|机密批注|commentRange|commentReference/)
    assert.deepEqual(decoded.find(e => e.name.includes('/media/'))?.data, entries(type).find(e => e.name.includes('/media/'))?.data)
  })
}
test('只压缩时所有条目逐字节不变，原图导出 ZIP 解压后保持原字节', async () => {
  const source = entries(), bytes = await encodeVerifiedOfficeArchive(source, signal())
  const decoded = await new ReferenceZipService({ read: async () => bytes }).readEntries({ fileGrantId: zipId }, caller, signal())
  for (const item of source) assert.deepEqual(decoded.find(e => e.name === item.name)?.data, item.data)
})
test('损坏 CRC、假 PK+JSON、重复路径、XML 实体和悬空关系均拒绝，不保存', async () => {
  const invalidEntries = entries(); invalidEntries.find(e => e.name === 'word/document.xml')!.data = Buffer.from('<!DOCTYPE x [<!ENTITY test SYSTEM "file:///private">]><x>&test;</x>')
  const dangling = entries().filter(e => !e.name.includes('/media/'))
  for (const bytes of [Buffer.from('PK\x03\x04{"entries":{}}'), buildZipFixture(entries(), true), buildZipFixture([...entries(), entries()[0]!]), buildZipFixture(invalidEntries), buildZipFixture(dangling)]) {
    const f = fixture(); f.change(bytes)
    await assert.rejects(f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal()))
    assert.equal(f.writes(), 0)
  }
})
test('源文件变化、目标存在和写入失败不会报告成功', async () => {
  const f = fixture(), inspected = await f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal())
  assert.ok('summary' in inspected)
  const params = { action: 'slim', path: input, outputPath: output, operationId: 'slim', digest: inspected.summary!.digest }
  f.failWrite(); await assert.rejects(f.service.execute(params, caller, signal()), /已存在/)
  f.change(buildZipFixture(entries(), false, true)); await assert.rejects(f.service.execute(params, caller, signal()), /源文档已变化/)
  assert.equal(f.writes(), 1); assert.equal(f.output(), undefined)
})
test('取消与停机不读取、不保存；未知字段、原始路径和畸形 digest 拒绝', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort()
  await assert.rejects(f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, abort.signal))
  for (const params of [{ action: 'inspect', path: '/Users/source.docx' }, { action: 'inspect', path: input, operationId: 'inspect', unknown: true }, { action: 'slim', path: input, outputPath: output, operationId: 'slim', digest: '' }]) await assert.rejects(f.service.execute(params, caller, signal()))
  f.service.stop(); await assert.rejects(f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal()))
  assert.equal(f.writes(), 0)
})
test('UTF16 XML 清理后编码声明与实际 UTF8 一致，非批注 VML 控件保留', () => {
  const source = entries(), core = source.find(e => e.name === 'docProps/core.xml')!
  core.data = Buffer.concat([Buffer.from([255, 254]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + core.data.toString(), 'utf16le')])
  source.push({ name: 'xl/drawings/vmlDrawing1.vml', isDirectory: false, data: Buffer.from('<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="note"><x:ClientData ObjectType="Note"/></v:shape><v:shape id="button"><x:ClientData ObjectType="Button"/></v:shape></xml>') })
  const cleaned = cleanOfficeMetadata(source)
  assert.match(cleaned.find(e => e.name === core.name)!.data.toString(), /encoding="UTF-8"/)
  const vml = cleaned.find(e => e.name.endsWith('.vml'))!.data.toString()
  assert.doesNotMatch(vml, /ObjectType="Note"/); assert.match(vml, /ObjectType="Button"/)
})
test('[回归] 无批注的表格含解压后超过 8 MiB 的大工作表：检查与清理作者成功，工作表逐字节不变', () => {
  const source = entries('xlsx').filter(e => e.name !== 'xl/comments.xml')
  const types = source.find(e => e.name === '[Content_Types].xml')!, rels = source.find(e => e.name === 'xl/_rels/workbook.xml.rels')!
  types.data = Buffer.from(types.data.toString().replace('<Override PartName="/xl/comments.xml" ContentType="application/xml"/>', ''))
  rels.data = Buffer.from(rels.data.toString().replace(/<Relationship Id="comment"[^>]*\/>/, ''))
  const row = '<row><c t="inlineStr"><is><t>数据</t></is></c></row>'
  const sheet = Buffer.from(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row.repeat(Math.ceil(9 * 1024 * 1024 / row.length))}</sheetData></worksheet>`)
  assert.ok(sheet.length > 8 * 1024 * 1024)
  source.push({ name: 'xl/worksheets/sheet1.xml', isDirectory: false, data: sheet })
  const inspected = inspectOffice(source)
  assert.equal(inspected.hasComments, false); assert.equal(inspected.hasAuthor, true)
  const cleaned = cleanOfficeMetadata(source)
  assert.equal(inspectOffice(cleaned).hasAuthor, false)
  assert.deepEqual(cleaned.find(e => e.name === 'xl/worksheets/sheet1.xml')!.data, sheet)
})
test('[破坏性] 不建 DOM 的大部件仍拒绝 DTD 与实体定义', () => {
  const source = entries('xlsx')
  source.push({ name: 'xl/worksheets/sheet1.xml', isDirectory: false, data: Buffer.from('<!DOCTYPE x [<!ENTITY a "b">]><worksheet>&a;</worksheet>') })
  assert.throws(() => inspectOffice(source), /DTD 或实体/)
})
test('带数字签名文档拒绝改写', () => {
  const source = entries(); source.push({ name: '_xmlsignatures/sig1.xml', isDirectory: false, data: Buffer.from('<signature/>') })
  assert.throws(() => inspectOffice(source), /数字签名/)
})
test('宏文档与模板的 ContentType 不能冒充普通格式', () => {
  for (const contentType of ['application/vnd.ms-word.document.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml']) {
    const source = entries(), types = source.find(e => e.name === '[Content_Types].xml')!
    types.data = Buffer.from(types.data.toString().replace('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', contentType))
    assert.throws(() => inspectOffice(source), /宏文档或模板/)
  }
})
test('停机中断正在读取的操作，同一窗口并发禁止且结束后释放占用', async () => {
  let finish!: (value: Buffer) => void, reads = 0, writes = 0
  const service = new OfficeDocumentService({
    readFile: async () => { reads++; const data: Buffer = await new Promise(resolve => { finish = resolve }); return { success: true, content: data.toString('base64'), size: data.length } },
    writeFile: async () => { writes++; throw new Error('不应写入') }
  })
  const pending = service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal())
  await assert.rejects(service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal()), /正在处理中/)
  service.stop(); finish(buildZipFixture(entries())); await assert.rejects(pending)
  assert.equal(reads, 1); assert.equal(writes, 0)
})
test('压缩阶段取消排空工作后不返回产物', async () => {
  const controller = new AbortController()
  const pending = encodeVerifiedOfficeArchive(entries(), controller.signal)
  controller.abort(); await assert.rejects(pending)
})
test('元数据部件改名仍按 ContentType 清理，不依赖默认文件名', () => {
  const source = entries()
  for (const entry of source) {
    if (entry.name === 'word/comments.xml') entry.name = 'word/review-data.data'
    if (entry.name === 'docProps/core.xml') entry.name = 'properties/custom-core.data'
    if (entry.name === 'word/_rels/document.xml.rels') entry.data = Buffer.from(entry.data.toString().replace('Target="comments.xml"', 'Target="review-data.data"'))
    if (entry.name === '[Content_Types].xml') entry.data = Buffer.from(entry.data.toString().replace('PartName="/word/comments.xml" ContentType="application/xml"', 'PartName="/word/review-data.data" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"').replace('</Types>', '<Override PartName="/properties/custom-core.data" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'))
  }
  assert.equal(inspectOffice(source).hasAuthor, true); assert.equal(inspectOffice(source).hasComments, true)
  const result = cleanOfficeMetadata(source)
  assert.equal(inspectOffice(result).hasAuthor, false); assert.equal(inspectOffice(result).hasComments, false)
  assert.ok(!result.some(e => e.name === 'word/review-data.data'))
})
test('导出原图 ZIP 只含真实解压后的图片，源文件不变', async () => {
  const f = fixture('docx', true), before = Buffer.from(f.original())
  const inspected = await f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal())
  assert.ok('summary' in inspected)
  await f.service.execute({ action: 'extract', path: input, outputPath: '/tmp/images.zip', operationId: 'extract', digest: inspected.summary!.digest }, caller, signal())
  const decoded = await new ReferenceZipService({ read: async () => f.output()! }).readEntries({ fileGrantId: zipId }, caller, signal())
  assert.equal(decoded.length, 1); assert.deepEqual(decoded[0]!.data, entries().find(e => e.name.includes('/media/'))!.data)
  assert.deepEqual(f.original(), before)
})
test('输出原路径被拒绝，错误后允许重新另存', async () => {
  const f = fixture(), inspected = await f.service.execute({ action: 'inspect', path: input, operationId: 'inspect' }, caller, signal())
  assert.ok('summary' in inspected)
  await assert.rejects(f.service.execute({ action: 'slim', path: input, outputPath: input, operationId: 'slim', digest: inspected.summary!.digest }, caller, signal()), /不能覆盖原文件/)
  assert.equal(f.writes(), 0)
  await f.service.execute({ action: 'slim', path: input, outputPath: output, operationId: 'retry', digest: inspected.summary!.digest }, caller, signal())
  assert.equal(f.writes(), 1)
})
