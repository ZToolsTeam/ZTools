import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import { renderMarkdown } from '../../src/main/services/markdown-renderer.js'
import { MarkdownDocumentService } from '../../src/main/services/markdown-document-service.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ClipboardService, type ClipboardImageFactory } from '../../src/main/services/clipboard-service.js'
import type { EventService } from '../../src/main/services/event-service.js'
import { readZipArchive } from '../../src/main/services/reference-zip-service.js'
import { inspectOffice } from '../../src/main/services/office-archive.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { validateMarkdownText, type MarkdownOptions } from '../../src/contracts/markdown-document.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const options: MarkdownOptions = { preset: 'academic', fontSize: 'size-s4', firstLineIndent: false }
const caller: CallerIdentity = { type: 'plugin', webContentsId: 77, pluginId: 'md-to-office' }
const signal = () => new AbortController().signal
const source = '# 验收文档\n\n中文 **加粗** *斜体* ~~删除~~ `代码` &amp; &#x4e2d; [链接](https://example.com/a)\n\n3. 第一项\n4. 第二项\n\n| 名称 | 结果 |\n| --- | --- |\n| 中文 | **正常** |\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n'
const request = (action = 'inspect') => ({ action, operationId: 'test', markdown: source, options })
function clipboard(files = {} as FileSystemService) {
  let text = '', html = ''
  const adapter = {
    write(data: { text: string; html: string }) { text = data.text; html = data.html },
    writeText(value: string) { text = value; html = '' },
    readText: () => text, readHTML: () => html, availableFormats: () => html ? ['text/plain', 'text/html'] : ['text/plain'],
    readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0), toBitmap: () => Buffer.alloc(0) }),
    has: () => false, clear() { text = ''; html = '' }, writeImage() { throw new Error('测试不写入图片') }
  }
  const service = new ClipboardService(files, { onSubscriptionChanged: () => () => {} } as unknown as EventService,
    adapter, {} as ClipboardImageFactory, { readFiles: async () => [], writeFiles: async () => {} })
  return Object.assign(adapter, { service, copyRichText: service.copyRichText.bind(service) })
}
async function xmlParts(bytes: Buffer) { return new Map((await readZipArchive(bytes, signal())).entries.map(e => [e.name, e.data.toString()])) }
test('实际方法契约拒绝畸形枚举、未知字段、无目标、空输入与超限 Unicode', () => {
  validateMethodParams('markdown_document', request())
  for (const patch of [{ action: ['copy'] }, { options: { ...options, preset: ['official'] } }, { options: { ...options, fontSize: {} } }, { markdown: '' }, { markdown: '\0a' }, { markdown: '\ud800' }, { markdown: '中'.repeat(90000) }, { outputPath: '/tmp/unexpected.docx' }, { options: { ...options, extra: true } }]) assert.throws(() => validateMethodParams('markdown_document', { ...request(), ...patch }))
  for (const outputPath of [undefined, '', '/tmp/a.txt']) assert.throws(() => validateMethodParams('markdown_document', { ...request('export'), outputPath }))
  validateMarkdownText('中'.repeat(80000)); assert.throws(() => validateMarkdownText(' '))
})
test('真实 Markdown→DOCX→ZIP/XML：保留标题、加粗、斜体、删除线、编号起点、三线表和代码换行', async () => {
  const rendered = renderMarkdown(source, options), bytes = await rendered.docx(), parts = await xmlParts(bytes)
  const xml = parts.get('word/document.xml')!, numbering = parts.get('word/numbering.xml')!
  assert.equal(inspectOffice((await readZipArchive(bytes, signal())).entries).type, 'docx')
  for (const pattern of [/Heading1/, /<w:b\b/, /<w:i\b/, /<w:strike\b/, /<w:tbl>/, /const a = 1;/, /console.log\(a\);/, /<w:br\b/, /<w:numPr>/]) assert.match(xml, pattern)
  assert.match(numbering, /w:startOverride w:val="3"/)
  assert.match(parts.get('word/_rels/document.xml.rels')!, /https:\/\/example.com\/a/)
  assert.match(rendered.text, /3\. 第一项\n4\. 第二项/); assert.match(rendered.text, /名称\t结果/); assert.match(rendered.text, /& 中/)
  assert.equal(rendered.summary.title, '验收文档'); assert.deepEqual(rendered.summary.warnings, [])
})
test('三个预设、三种字号和首行缩进都进入真实文档，关闭缩进在公文风格下同样生效', async () => {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  for (const preset of ['official', 'business', 'academic'] as const) for (const [fontSize, size] of [['size-3', '32'], ['size-s4', '24'], ['size-5', '21']] as const) {
    const parts = await xmlParts(await renderMarkdown('第一段。\n\n第二段。', { preset, fontSize, firstLineIndent: true }).docx())
    const doc = new DOMParser().parseFromString(parts.get('word/document.xml')!, 'application/xml')
    assert.ok(Array.from(doc.getElementsByTagNameNS(w, 'sz')).some(n => n.getAttribute('w:val') === size))
    assert.ok(Array.from(doc.getElementsByTagNameNS(w, 'ind')).some(n => Number(n.getAttribute('w:firstLine')) > 0))
    const plain = await xmlParts(await renderMarkdown('不缩进。', { preset, fontSize, firstLineIndent: false }).docx())
    assert.doesNotMatch(plain.get('word/document.xml')!, /w:firstLine="[1-9]/)
  }
})
test('纯文本剪贴板保留相邻行内格式之间的空格及代码内连续空白', () => {
  const rendered = renderMarkdown('**foo** **bar**\n\n`a  b`\n\n```\n  first\n\tsecond\n```', options)
  assert.match(rendered.text, /foo bar/); assert.match(rendered.text, /a  b/); assert.match(rendered.text, /  first\n\tsecond/)
  const firstCode = renderMarkdown('```python\n    first = 1  \n    second = 2\n```', options)
  assert.ok(firstCode.text.startsWith('    first = 1  \n    second = 2'))
  const nested = renderMarkdown('1. first\n   1. child\n   2. child2\n2. next\n\n- parent\n  - child\n    - grandchild', options)
  assert.match(nested.text, /1\. first\n  1\. child\n  2\. child2/)
  assert.match(nested.text, /\n2\. next/); assert.match(nested.text, /- parent\n  - child\n    - grandchild/)
})
test('原始 HTML 与危险链接仅作为文字，不生成活动内容；图片明确保留引用而非悄悄丢失', async () => {
  const rendered = renderMarkdown('# 安全\n\n<script>alert(1)</script>\n\n[危险](javascript:alert) ![图片](file:///private/test.png)\n\n<div onclick="x">正文</div>', options)
  assert.doesNotMatch(rendered.html, /<script>|<div onclick|<img|href="javascript/)
  assert.match(rendered.html, /&lt;script&gt;/); assert.match(rendered.text, /file:\/\/\/private\/test.png/); assert.equal(rendered.summary.warnings.length, 3)
  const parts = await xmlParts(await rendered.docx()); assert.doesNotMatch(parts.get('word/_rels/document.xml.rels')!, /javascript:|file:/)
  assert.match(parts.get('word/document.xml')!, /alert\(1\)/)
})
test('真实文件授权→读取→转换→另存：无授权拒绝、原文不变、已有目标不覆盖、失效UTF8拒绝', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-docx-')))
  const registry = { onRemoved: () => () => {}, get: (id: number) => id === caller.webContentsId ? caller : undefined } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache')), service = new MarkdownDocumentService(files, clipboard())
  const input = path.join(root, '原文.md'), output = path.join(root, '新副本.docx')
  try {
    await fs.writeFile(input, source)
    await assert.rejects(service.execute({ action: 'read', path: input, operationId: 'read' }, caller, signal()))
    await files.grantOpenPath(input, caller)
    const loaded = await service.execute({ action: 'read', path: input, operationId: 'read' }, caller, signal()); assert.ok('markdown' in loaded && loaded.markdown === source)
    await assert.rejects(service.execute({ ...request('export'), outputPath: output }, caller, signal()))
    await files.grantSavePath(output, caller)
    const saved = await service.execute({ ...request('export'), outputPath: output }, caller, signal()); assert.ok('status' in saved && saved.status === 'committed')
    const bytes = await fs.readFile(output); assert.ok((await xmlParts(bytes)).has('word/document.xml')); assert.equal(await fs.readFile(input, 'utf8'), source)
    await assert.rejects(service.execute({ ...request('export'), markdown: '试图覆盖', outputPath: output }, caller, signal()))
    assert.deepEqual(await fs.readFile(output), bytes)
    await fs.writeFile(input, Buffer.from([0xff, 0xfe, 0x00])); await assert.rejects(service.execute({ action: 'read', path: input, operationId: 'bad' }, caller, signal()))
    await fs.writeFile(input, 'a'.repeat(256 * 1024 + 1)); await assert.rejects(service.execute({ action: 'read', path: input, operationId: 'large' }, caller, signal()), /256 KiB/)
  } finally { await service.stop(); await files.stop(); await fs.rm(root, { recursive: true, force: true }) }
})
test('授权文件被换成 FIFO 时读取及时失败，取消和停止完成；子进程隔离避免回归挂住测试', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-pipe-'))), input = path.join(root, 'input.md')
  try {
    await fs.writeFile(input, '原文')
    const script = `
      import fs from 'node:fs/promises'; import { execFileSync } from 'node:child_process';
      import { MarkdownDocumentService } from ${JSON.stringify(pathToFileURL(require.resolve('../../src/main/services/markdown-document-service.js')).href)};
      import { FileSystemService } from ${JSON.stringify(pathToFileURL(require.resolve('../../src/main/services/file-system-service.js')).href)};
      const caller = ${JSON.stringify(caller)}, input = ${JSON.stringify(input)};
      const files = new FileSystemService({ onRemoved: () => () => {}, get: () => caller }, ${JSON.stringify(path.join(root, 'cache'))});
      await files.grantOpenPath(input, caller); await fs.unlink(input); execFileSync('mkfifo', [input]);
      const service = new MarkdownDocumentService(files, {}), signal = new AbortController().signal;
      let rejected = false;
      try { await service.execute({ action:'read', path:input, operationId:'pipe' }, caller, signal) } catch (e) { rejected = /普通/.test(e.message) }
      const cancel = await service.execute({ action:'cancel', operationId:'pipe' }, caller, signal);
      await service.stop(); await files.stop();
      if (!rejected || cancel.cancelRequested !== false) process.exitCode = 1;
      console.log(JSON.stringify({ rejected, stopCompleted:true, cancelCompleted:true }));
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.deepEqual(JSON.parse(child.stdout), { rejected: true, stopCompleted: true, cancelCompleted: true })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('富文本写入与读回一致才成功；相同纯文本但格式未更新仍判失败，磁盘失败不报成功', async () => {
  const clip = clipboard(), files = { resolveAuthorizedPath: async () => { throw new Error('读取失败') }, writeFile: async () => { throw new Error('磁盘已满') } }
  const service = new MarkdownDocumentService(files, clip)
  const result = await service.execute(request('copy'), caller, signal()); assert.ok('copied' in result && result.copied)
  assert.match(clip.readHTML(), /<strong>加粗<\/strong>/)
  const oldHtml = clip.readHTML(); clip.readHTML = () => oldHtml
  await assert.rejects(service.execute({ ...request('copy'), options: { ...options, fontSize: 'size-3' } }, caller, signal()), /富文本/)
  await assert.rejects(service.execute({ ...request('export'), outputPath: '/tmp/test.docx' }, caller, signal()), /磁盘已满/)
  await assert.rejects(service.execute({ action: 'read', operationId: 'x', path: '/tmp/test.md' }, caller, signal()), /读取失败/)
  service.stop(); await assert.rejects(service.execute(request(), caller, signal()), /停止/)
})
test('并发、取消、关闭和迟到读取：取消等待当前处理退出且不声称已撤回成功写入', async () => {
  let finish!: (value: string) => void, writes = 0
  const service = new MarkdownDocumentService({ resolveAuthorizedPath: () => new Promise(resolve => { finish = resolve }), writeFile: async () => { writes++; throw new Error('不该写入') } }, clipboard())
  const pending = service.execute({ action: 'read', operationId: 'read', path: '/tmp/test.md' }, caller, signal()), rejected = assert.rejects(pending, /取消/)
  await assert.rejects(service.execute(request(), caller, signal()), /正在处理/)
  const other = await service.execute({ action: 'cancel', operationId: 'read' }, { ...caller, webContentsId: 78 }, signal()); assert.equal('cancelRequested' in other && other.cancelRequested, false)
  const cancel = service.execute({ action: 'cancel', operationId: 'read' }, caller, signal()); finish('/tmp/test.md'); await rejected
  const response = await cancel; assert.equal('cancelRequested' in response && response.cancelRequested, true); assert.ok(!('cancelled' in response)); assert.equal(writes, 0)
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(service.execute(request(), caller, aborted.signal))
})

test('Markdown富文本与普通复制共用真实宿主互斥，延迟读取期间不允许第二次写入', async () => {
  let finish!: (value: { success: true; content: string; size: number }) => void
  const files = { readFile: () => new Promise(resolve => { finish = resolve }) } as unknown as FileSystemService
  const clip = clipboard(files), service = new MarkdownDocumentService({} as FileSystemService, clip.service)
  try {
    const earlier = clip.service.copyText({ tempFile: '/isolated-fixture/input.txt' }, caller)
    await assert.rejects(clip.service.copyText({ text: 'other' }, caller), (error: unknown) => error instanceof Error && /正在进行/.test(error.message))
    await assert.rejects(service.execute(request('copy'), caller, signal()), (error: unknown) => error instanceof Error && /正在进行/.test(error.message))
    assert.equal(clip.readText(), '')
    finish({ success: true, content: 'earlier', size: 7 }); await earlier
    const copied = await service.execute(request('copy'), caller, signal())
    assert.ok('copied' in copied && copied.copied)
    assert.match(clip.readText(), /验收文档/); assert.match(clip.readHTML(), /<strong>加粗<\/strong>/)
    await clip.service.stop()
    await assert.rejects(service.execute(request('copy'), caller, signal()), /取消/)
  } finally { await service.stop(); await clip.service.stop() }
})

test('富文本写入失败保留敏感清除任务，成功替换后不误清除新内容', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clip = clipboard(), service = new MarkdownDocumentService({} as FileSystemService, clip.service)
  const write = clip.write
  try {
    await clip.service.copyText({ text: 'isolated-secret', sensitive: true }, caller)
    clip.write = () => {}
    await assert.rejects(service.execute(request('copy'), caller, signal()), /富文本/)
    assert.equal(clip.readText(), 'isolated-secret')
    t.mock.timers.tick(30000); assert.equal(clip.readText(), '')
    await clip.service.copyText({ text: 'second-secret', sensitive: true }, caller)
    clip.write = write
    await service.execute(request('copy'), caller, signal())
    const copied = clip.readText(), html = clip.readHTML()
    t.mock.timers.tick(30000)
    assert.equal(clip.readText(), copied); assert.equal(clip.readHTML(), html)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(clip.service.copyRichText({ text: 'late', html: '<p>late</p>' }, aborted.signal), /取消/)
    assert.equal(clip.readText(), copied)
  } finally { await service.stop(); await clip.service.stop() }
})
