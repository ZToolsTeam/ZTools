import path from 'node:path'
import type { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom'
import { ZipFile } from 'yazl'
import { fromBufferPromise } from 'yauzl'
import type { ZipContentEntry } from './reference-zip-service.js'

const maxOutput = 16 * 1024 * 1024
const relNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const contentNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const wordNamespaces = ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']
const commentPart = /^(?:word\/(?:comments[^/]*|people)\.xml|xl\/(?:comments[^/]*\.xml|(?:comments|threadedComments|persons)\/[^/]+\.xml)|ppt\/(?:comments\/[^/]+\.xml|commentAuthors\.xml))$/i
const imagePart = /^(?:word|ppt|xl)\/media\/[^/]+\.(?:png|jpe?g|gif|webp|emf|wmf|svg|tiff?|bmp)$/i
const fail = (message: string): never => { throw new Error(message) }

function xmlText(bytes: Buffer): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('不支持含 DTD 或实体定义的文档')
  return text
}
function xml(bytes: Buffer): Document {
  if (bytes.length > 8 * 1024 * 1024) fail('文档 XML 超过处理上限')
  const text = xmlText(bytes)
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(`文档 XML 无效：${message}`) } }).parseFromString(text, 'application/xml')
  if (!document.documentElement) fail('文档 XML 为空')
  return document
}
function elements(document: Document): Element[] { return Array.from(document.getElementsByTagName('*')) }
function serialize(document: Document): Buffer {
  const source = new XMLSerializer().serializeToString(document).replace(/^\s*<\?xml[^?]*\?>/, '')
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + source)
}
function relationshipSource(name: string): string {
  if (name === '_rels/.rels') return ''
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name)
  if (!match) fail('文档关系文件路径无效')
  return (match![1] ?? '') + match![2]
}
function targetPart(source: string, target: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(target.split('#')[0] ?? '') } catch { return fail('文档关系路径编码无效') }
  if (!decoded) return source
  if (/[:\\\0]/.test(decoded)) fail('文档内部关系路径无效')
  const name = decoded.startsWith('/') ? path.posix.normalize(decoded.slice(1)) : path.posix.join(path.posix.dirname(source), decoded)
  if (name.startsWith('../') || name === '..') fail('文档关系越出压缩包')
  return name
}

function metadataParts(entries: ZipContentEntry[]) {
  const comments = new Set(entries.filter(e => commentPart.test(e.name)).map(e => e.name))
  const authors = new Set(entries.filter(e => e.name === 'docProps/core.xml').map(e => e.name))
  const types = entries.find(e => e.name === '[Content_Types].xml')
  if (types) for (const node of Array.from(xml(types.data).getElementsByTagNameNS(contentNamespace, 'Override'))) {
    const type = node.getAttribute('ContentType') ?? '', name = (node.getAttribute('PartName') ?? '').replace(/^\//, '')
    if (/\.(?:comments(?:Extended|Extensible|Ids)?|commentAuthors|threadedcomments|person|people)\+xml$/i.test(type)) comments.add(name)
    if (/\.core-properties\+xml$/i.test(type)) authors.add(name)
  }
  return { comments, authors }
}

export function inspectOffice(entries: ZipContentEntry[]) {
  const files = new Map(entries.filter(e => !e.isDirectory).map(e => [e.name, e.data]))
  if ([...files.keys()].some(name => /^_xmlsignatures\//i.test(name))) fail('带数字签名的文档不能改写，请先另存无签名副本')
  const types = files.get('[Content_Types].xml'), root = files.get('_rels/.rels')
  if (!types || !root) fail('不是完整的 Office OOXML 文档；不支持旧版或加密格式')
  const typeXml = xml(types!)
  if (typeXml.documentElement?.namespaceURI !== contentNamespace) fail('Office 内容类型声明无效')
  const mainParts = ['word/document.xml', 'ppt/presentation.xml', 'xl/workbook.xml'].filter(name => files.has(name))
  if (mainParts.length !== 1) fail('Office 主文档缺失或类型不明确')
  const metadata = metadataParts(entries)
  let hasAuthor = false, hasComments = false
  for (const [name, data] of files) {
    if (metadata.comments.has(name)) hasComments = true
    const isXml = /\.(?:xml|rels|vml)$/i.test(name)
    // 正文、工作表等大部件只做文本安全检查（DTD / 实体），不建 DOM：解压后常超过单个 XML 的解析上限
    if (!name.endsWith('.rels') && !metadata.authors.has(name) && !metadata.comments.has(name)) {
      if (isXml) xmlText(data)
      continue
    }
    const document = xml(data)
    if (metadata.authors.has(name)) hasAuthor ||= elements(document).some(e => ['creator', 'lastModifiedBy'].includes(e.localName ?? '') && Boolean(e.textContent?.trim()))
    if (name.endsWith('.rels')) {
      for (const relation of Array.from(document.getElementsByTagNameNS(relNamespace, 'Relationship'))) {
        if (relation.getAttribute('TargetMode') === 'External') continue
        const target = targetPart(relationshipSource(name), relation.getAttribute('Target') ?? '')
        if (!files.has(target)) fail(`Office 内部关系缺少文件：${target}`)
      }
    }
  }
  const main = mainParts[0]!
  const expectedType = main.startsWith('word/') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : main.startsWith('ppt/') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  const declared = Array.from(typeXml.getElementsByTagNameNS(contentNamespace, 'Override')).filter(node => node.getAttribute('PartName') === '/' + main)
  if (declared.length !== 1 || declared[0]?.getAttribute('ContentType') !== expectedType) fail('仅支持普通 DOCX、PPTX、XLSX；不支持宏文档或模板')
  const rootRelations = xml(root!).getElementsByTagNameNS(relNamespace, 'Relationship')
  if (!Array.from(rootRelations).some(e => /\/officeDocument$/.test(e.getAttribute('Type') ?? '') && targetPart('', e.getAttribute('Target') ?? '') === main)) fail('Office 主文档关系无效')
  return { type: main.startsWith('word/') ? 'docx' : main.startsWith('ppt/') ? 'pptx' : 'xlsx', hasAuthor, hasComments,
    images: [...files].filter(([name]) => imagePart.test(name)).map(([name, data]) => ({ name, size: data.length })) }
}

/** 只清理作者属性与批注，不改写正文、修订内容、图片、宏或嵌入对象。 */
export function cleanOfficeMetadata(entries: ZipContentEntry[]): ZipContentEntry[] {
  const metadata = metadataParts(entries), removed = metadata.comments
  for (const name of [...removed]) {
    const rel = path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels')
    removed.add(rel)
  }
  const removedRelations = new Map<string, Set<string>>()
  const result = entries.filter(e => !removed.has(e.name)).map(entry => ({ ...entry }))
  for (const entry of result.filter(e => e.name.endsWith('.rels'))) {
    const document = xml(entry.data), source = relationshipSource(entry.name), ids = new Set<string>()
    for (const node of Array.from(document.getElementsByTagNameNS(relNamespace, 'Relationship'))) {
      if (node.getAttribute('TargetMode') !== 'External' && removed.has(targetPart(source, node.getAttribute('Target') ?? ''))) {
        ids.add(node.getAttribute('Id') ?? ''); node.parentNode?.removeChild(node)
      }
    }
    if (ids.size) { removedRelations.set(source, ids); entry.data = serialize(document) }
  }
  for (const entry of result) {
    if (!/\.(?:xml|vml)$/i.test(entry.name) && !metadata.authors.has(entry.name)) continue
    // 只解析确实可能改动的部件：作者属性；有批注被删除时，内容类型声明、Word 部件（批注范围标记）、VML 批注形状与引用了被删批注的部件
    const name = entry.name
    const needsRewrite = metadata.authors.has(name) || removedRelations.has(name) ||
      (removed.size > 0 && (name === '[Content_Types].xml' || /^word\/.+\.xml$/i.test(name) || /\.vml$/i.test(name)))
    if (!needsRewrite) continue
    const document = xml(entry.data), before = new XMLSerializer().serializeToString(document)
    for (const node of elements(document)) {
      const name = node.localName ?? '', ns = node.namespaceURI ?? ''
      if (metadata.authors.has(entry.name) && ['creator', 'lastModifiedBy', 'revision'].includes(name)) node.parentNode?.removeChild(node)
      else if (entry.name === '[Content_Types].xml' && name === 'Override' && removed.has((node.getAttribute('PartName') ?? '').replace(/^\//, ''))) node.parentNode?.removeChild(node)
      else if (wordNamespaces.includes(ns) && ['commentRangeStart', 'commentRangeEnd', 'commentReference'].includes(name)) node.parentNode?.removeChild(node)
      else if (entry.name.endsWith('.vml') && name === 'shape' && Array.from(node.getElementsByTagName('*')).some(child => child.localName === 'ClientData' && child.getAttribute('ObjectType') === 'Note')) node.parentNode?.removeChild(node)
      else {
        // PPT 的 cmLst 等通过 r:id 引用批注；只移除确实指向已删除批注的节点。
        const ids = removedRelations.get(entry.name)
        if (ids && Array.from(node.attributes).some(a => /\/relationships$/.test(a.namespaceURI ?? '') && ids.has(a.value))) node.parentNode?.removeChild(node)
      }
    }
    if (new XMLSerializer().serializeToString(document) !== before) entry.data = serialize(document)
  }
  const inspected = inspectOffice(result)
  if (inspected.hasAuthor || inspected.hasComments) fail('作者或批注清理校验失败')
  return result
}

export function officeImages(entries: ZipContentEntry[]): ZipContentEntry[] {
  const images = entries.filter(e => !e.isDirectory && imagePart.test(e.name))
  if (!images.length) fail('文档中没有可导出的原图')
  return images.map((entry, i) => ({ ...entry, name: `${i + 1}-${path.posix.basename(entry.name).replace(/[<>:"|?*\\\x00-\x1f]/g, '_')}` }))
}

/** 用第二个 ZIP 实现回读所有条目，核对实际解压字节及 CRC；通过后才能保存。 */
export async function encodeVerifiedOfficeArchive(entries: ZipContentEntry[], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const writer = new ZipFile(), stream = writer.outputStream as Readable
  writer.on('error', error => stream.destroy(error))
  for (const entry of entries) {
    if (entry.isDirectory) writer.addEmptyDirectory(entry.name)
    else writer.addBuffer(entry.data, entry.name, { compressionLevel: 9 })
  }
  writer.end()
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    // yazl 的 addBuffer 已派发给 zlib，库没有取消接口；排空这批有界工作再释放，取消后不继续校验或保存。
    if (size <= maxOutput && !signal.aborted) chunks.push(Buffer.from(chunk))
    else chunks.length = 0
  }
  signal.throwIfAborted()
  if (size > maxOutput) fail('处理后的压缩包超过 16 MiB 上限')
  const bytes = Buffer.concat(chunks, size), reader = await fromBufferPromise(bytes, { autoClose: false })
  try {
    const expected = new Map(entries.map(entry => [entry.name, entry.data]))
    for await (const entry of reader.eachEntry()) {
      signal.throwIfAborted()
      const original = expected.get(entry.fileName)
      if (!original) fail('输出压缩包存在未知或重复条目')
      const input = await reader.openReadStreamPromise(entry), parts: Buffer[] = []
      const abort = () => input.destroy(new Error('文档校验已取消'))
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        for await (const chunk of input) { signal.throwIfAborted(); parts.push(Buffer.from(chunk)) }
      } finally { signal.removeEventListener('abort', abort); input.destroy() }
      const data = Buffer.concat(parts)
      if (!data.equals(original!) || crc32(data) !== entry.crc32) fail('输出压缩包字节校验失败')
      expected.delete(entry.fileName)
    }
    if (expected.size) fail('输出压缩包缺少条目')
  } finally { reader.close() }
  return bytes
}
