import { callHostTransport } from '../shared/native-ipc.js'
import type { ConvertOptions, DocElement, DocMetadata, StylePreset } from './types.js'

function escapeXml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function stripInlineMarkdown(text: string): string {
  return String(text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

export function countMarkdownWords(markdownText: string): number {
  const clean = stripInlineMarkdown(markdownText)
    .replace(/[#>*|`~_-]/g, ' ')
    .trim()
  if (!clean) return 0
  const cjkMatches = clean.match(/[\u4e00-\u9fa5]/g) ?? []
  const latinWords = clean
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return cjkMatches.length + latinWords.length
}

/**
 * 容错式 Markdown AST 解析器（支持未闭合代码块、畸形/断头表格与大文本线性扫描）
 */
export function parseMarkdownAST(markdownText: string): {
  metadata: DocMetadata
  elements: DocElement[]
} {
  const raw = String(markdownText ?? '')
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      metadata: {
        title: '未命名文档',
        wordCount: 0,
        headingsCount: 0,
        tablesCount: 0,
        codeBlocksCount: 0,
        paragraphsCount: 0
      },
      elements: []
    }
  }

  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const elements: DocElement[] = []
  let headingsCount = 0
  let tablesCount = 0
  let codeBlocksCount = 0
  let paragraphsCount = 0
  let primaryTitle = ''

  let idx = 0
  let seq = 1

  while (idx < lines.length) {
    const line = lines[idx] ?? ''
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      idx++
      continue
    }

    // 1. 代码块 ```lang ... ```（容错处理未闭合代码块）
    if (trimmedLine.startsWith('```')) {
      const codeLanguage = trimmedLine.slice(3).trim() || 'text'
      const codeLines: string[] = []
      idx++
      while (idx < lines.length) {
        const cur = lines[idx] ?? ''
        if (cur.trim().startsWith('```')) {
          idx++
          break
        }
        codeLines.push(cur)
        idx++
      }
      const rawCode = codeLines.join('\n')
      const firstNonEmpty = codeLines.find((l) => l.trim().length > 0)?.trim() ?? '(空代码块)'
      codeBlocksCount++
      elements.push({
        id: `el-${seq++}`,
        type: 'code',
        typeLabel: `代码块 (${codeLanguage})`,
        title: firstNonEmpty.slice(0, 64),
        preview: `${codeLines.length} 行代码 · 语言 ${codeLanguage}`,
        rawContent: rawCode,
        extraInfo: `${codeLines.length} 行`,
        codeLanguage
      })
      continue
    }

    // 2. 标题 # ~ ######
    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length
      const titleText = stripInlineMarkdown(headingMatch[2]!)
      if (!primaryTitle && level === 1) {
        primaryTitle = titleText
      } else if (!primaryTitle) {
        primaryTitle = titleText
      }
      headingsCount++
      const levelNames = ['一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题']
      elements.push({
        id: `el-${seq++}`,
        type: 'heading',
        typeLabel: levelNames[level - 1] ?? `${level}级标题`,
        title: titleText,
        preview: `H${level} 章节标题`,
        rawContent: line,
        extraInfo: `H${level}`,
        headingLevel: level
      })
      idx++
      continue
    }

    // 3. Markdown 表格 | a | b |（容错断头表格）
    if (trimmedLine.startsWith('|') && trimmedLine.includes('|', 1)) {
      const tableLines: string[] = []
      while (idx < lines.length) {
        const tLine = (lines[idx] ?? '').trim()
        if (!tLine.startsWith('|')) break
        tableLines.push(tLine)
        idx++
      }
      const parsedRows: string[][] = []
      for (const tLine of tableLines) {
        const inner = tLine.replace(/^\|/, '').replace(/\|$/, '')
        const cells = inner.split('|').map((c) => stripInlineMarkdown(c.trim()))
        const isSeparator = cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')
        if (!isSeparator && cells.length > 0) {
          parsedRows.push(cells)
        }
      }
      if (parsedRows.length > 0) {
        const colCount = Math.max(...parsedRows.map((r) => r.length), 1)
        const normalizedRows = parsedRows.map((r) => {
          const copy = [...r]
          while (copy.length < colCount) copy.push('')
          return copy
        })
        tablesCount++
        const headerPreview = normalizedRows[0]?.join(' / ') || '数据表'
        elements.push({
          id: `el-${seq++}`,
          type: 'table',
          typeLabel: '数据表格',
          title: headerPreview.slice(0, 60),
          preview: `${normalizedRows.length} 行 × ${colCount} 列`,
          rawContent: tableLines.join('\n'),
          extraInfo: `${normalizedRows.length}×${colCount}`,
          tableRows: normalizedRows
        })
      }
      continue
    }

    // 4. 列表或普通段落
    const paraLines: string[] = [trimmedLine]
    idx++
    while (idx < lines.length) {
      const next = (lines[idx] ?? '').trim()
      if (
        !next ||
        next.startsWith('#') ||
        next.startsWith('```') ||
        (next.startsWith('|') && next.includes('|', 1))
      ) {
        break
      }
      paraLines.push(next)
      idx++
    }
    const mergedText = stripInlineMarkdown(paraLines.join(' '))
    paragraphsCount++
    elements.push({
      id: `el-${seq++}`,
      type: 'paragraph',
      typeLabel: '正文段落',
      title: mergedText.slice(0, 56) + (mergedText.length > 56 ? '...' : ''),
      preview: `共 ${mergedText.length} 字符`,
      rawContent: paraLines.join('\n'),
      extraInfo: `${mergedText.length} 字`
    })
  }

  return {
    metadata: {
      title: primaryTitle || elements[0]?.title || '未命名 Markdown 文档',
      wordCount: countMarkdownWords(raw),
      headingsCount,
      tablesCount,
      codeBlocksCount,
      paragraphsCount
    },
    elements
  }
}

function getFontSizeHalfPoints(fontSize: ConvertOptions['fontSize']): number {
  if (fontSize === 'size-3') return 32 // 16pt = 32 half-points
  if (fontSize === 'size-5') return 21 // 10.5pt = 21 half-points
  return 24 // 小四 12pt = 24 half-points
}

function getPresetFonts(preset: StylePreset): {
  heading1Font: string
  heading2Font: string
  bodyFont: string
  asciiFont: string
  lineTwips: number
} {
  if (preset === 'official') {
    return {
      heading1Font: '方正小标宋简体',
      heading2Font: '黑体',
      bodyFont: '仿宋_GB2312',
      asciiFont: 'Times New Roman',
      lineTwips: 560 // 固定 28 磅 = 560 twips
    }
  }
  if (preset === 'academic') {
    return {
      heading1Font: '黑体',
      heading2Font: '黑体',
      bodyFont: '宋体',
      asciiFont: 'Times New Roman',
      lineTwips: 400 // 20 磅
    }
  }
  return {
    heading1Font: 'Microsoft YaHei',
    heading2Font: 'Microsoft YaHei',
    bodyFont: 'Microsoft YaHei',
    asciiFont: 'Segoe UI',
    lineTwips: 360
  }
}

export function buildDocxXmlParts(
  markdownText: string,
  options: ConvertOptions
): {
  documentXml: string
  stylesXml: string
  metadata: DocMetadata
} {
  const trimmed = String(markdownText ?? '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_MARKDOWN_INPUT: 请输入或粘贴有效的 Markdown 文本后再导出')
  }

  const { metadata, elements } = parseMarkdownAST(trimmed)
  const fonts = getPresetFonts(options.preset)
  const bodySz = getFontSizeHalfPoints(options.fontSize)
  const indentXml =
    options.preset === 'official' || options.firstLineIndent
      ? '<w:ind w:firstLineChars="200" w:firstLine="640"/>'
      : ''

  const bodyNodes: string[] = []

  for (const el of elements) {
    if (el.type === 'heading') {
      const level = el.headingLevel ?? 1
      const hSz = level === 1 ? 44 : level === 2 ? 32 : 28
      const hFont = level === 1 ? fonts.heading1Font : fonts.heading2Font
      bodyNodes.push(
        `<w:p>` +
          `<w:pPr><w:pStyle w:val="Heading${level}"/><w:spacing w:before="240" w:after="120"/></w:pPr>` +
          `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(fonts.asciiFont)}" w:eastAsia="${escapeXml(hFont)}"/><w:b/><w:sz w:val="${hSz}"/></w:rPr><w:t>${escapeXml(el.title)}</w:t></w:r>` +
          `</w:p>`
      )
    } else if (el.type === 'table' && el.tableRows && el.tableRows.length > 0) {
      const rows = el.tableRows
      const hasLongCell = rows.some((r) => r.some((c) => c.length > 120))
      const tblBordersXml =
        options.preset === 'academic'
          ? `<w:tblBorders>` +
            `<w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>` +
            `<w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>` +
            `<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>` +
            `<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>` +
            `<w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>` +
            `<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>` +
            `</w:tblBorders>`
          : `<w:tblBorders>` +
            `<w:top w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/>` +
            `<w:bottom w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/>` +
            `<w:left w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/>` +
            `<w:right w:val="single" w:sz="6" w:space="0" w:color="CCCCCC"/>` +
            `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>` +
            `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="E0E0E0"/>` +
            `</w:tblBorders>`

      const autofitXml = `<w:tblLayout w:type="autofit"/><w:autofit/>`
      const rowXmlList = rows.map((row, rIndex) => {
        const isHeader = rIndex === 0
        const headerBottomBorder =
          isHeader && options.preset === 'academic'
            ? `<w:tcBorders><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/></w:tcBorders>`
            : ''
        const cellsXml = row
          .map(
            (cellText) =>
              `<w:tc>` +
              `<w:tcPr>${headerBottomBorder}${hasLongCell ? '<w:noWrap w:val="0"/>' : ''}</w:tcPr>` +
              `<w:p><w:r><w:rPr>${isHeader ? '<w:b/>' : ''}<w:sz w:val="${bodySz}"/></w:rPr><w:t>${escapeXml(cellText)}</w:t></w:r></w:p>` +
              `</w:tc>`
          )
          .join('')
        return `<w:tr>${cellsXml}</w:tr>`
      })

      bodyNodes.push(
        `<w:tbl><w:tblPr>${tblBordersXml}${autofitXml}</w:tblPr>${rowXmlList.join('')}</w:tbl>`
      )
    } else if (el.type === 'code') {
      bodyNodes.push(
        `<w:p>` +
          `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/></w:pPr>` +
          `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="${escapeXml(fonts.bodyFont)}"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(el.rawContent)}</w:t></w:r>` +
          `</w:p>`
      )
    } else {
      bodyNodes.push(
        `<w:p>` +
          `<w:pPr>${indentXml}<w:spacing w:line="${fonts.lineTwips}" w:lineRule="exact"/></w:pPr>` +
          `<w:r><w:rPr><w:rFonts w:ascii="${escapeXml(fonts.asciiFont)}" w:eastAsia="${escapeXml(fonts.bodyFont)}"/><w:sz w:val="${bodySz}"/></w:rPr><w:t>${escapeXml(stripInlineMarkdown(el.rawContent))}</w:t></w:r>` +
          `</w:p>`
      )
    }
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyNodes.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body>` +
    `</w:document>`

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
    `<w:name w:val="Normal"/>` +
    `<w:pPr>${indentXml}<w:spacing w:line="${fonts.lineTwips}" w:lineRule="exact"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${escapeXml(fonts.asciiFont)}" w:eastAsia="${escapeXml(fonts.bodyFont)}"/><w:sz w:val="${bodySz}"/></w:rPr>` +
    `</w:style>` +
    `</w:styles>`

  return { documentXml, stylesXml, metadata }
}

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff
  buf[offset + 1] = (val >>> 8) & 0xff
}

function writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff
  buf[offset + 1] = (val >>> 8) & 0xff
  buf[offset + 2] = (val >>> 16) & 0xff
  buf[offset + 3] = (val >>> 24) & 0xff
}

function buildZipStoreArchive(files: Array<{ name: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder()
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name)
    const dataBytes = encoder.encode(f.content)
    const crc = computeCrc32(dataBytes)
    return { nameBytes, dataBytes, crc, offset: 0 }
  })

  let totalLocalSize = 0
  for (const entry of entries) {
    entry.offset = totalLocalSize
    totalLocalSize += 30 + entry.nameBytes.length + entry.dataBytes.length
  }

  let centralSize = 0
  for (const entry of entries) {
    centralSize += 46 + entry.nameBytes.length
  }

  const out = new Uint8Array(totalLocalSize + centralSize + 22)
  let ptr = 0

  for (const entry of entries) {
    writeUint32LE(out, ptr, 0x04034b50)
    writeUint16LE(out, ptr + 4, 20)
    writeUint16LE(out, ptr + 6, 0)
    writeUint16LE(out, ptr + 8, 0) // Store (no compression)
    writeUint16LE(out, ptr + 10, 0)
    writeUint16LE(out, ptr + 12, 0)
    writeUint32LE(out, ptr + 14, entry.crc)
    writeUint32LE(out, ptr + 18, entry.dataBytes.length)
    writeUint32LE(out, ptr + 22, entry.dataBytes.length)
    writeUint16LE(out, ptr + 26, entry.nameBytes.length)
    writeUint16LE(out, ptr + 28, 0)
    out.set(entry.nameBytes, ptr + 30)
    out.set(entry.dataBytes, ptr + 30 + entry.nameBytes.length)
    ptr += 30 + entry.nameBytes.length + entry.dataBytes.length
  }

  const centralOffset = ptr
  for (const entry of entries) {
    writeUint32LE(out, ptr, 0x02014b50)
    writeUint16LE(out, ptr + 4, 20)
    writeUint16LE(out, ptr + 6, 20)
    writeUint16LE(out, ptr + 8, 0)
    writeUint16LE(out, ptr + 10, 0)
    writeUint16LE(out, ptr + 12, 0)
    writeUint16LE(out, ptr + 14, 0)
    writeUint32LE(out, ptr + 16, entry.crc)
    writeUint32LE(out, ptr + 20, entry.dataBytes.length)
    writeUint32LE(out, ptr + 24, entry.dataBytes.length)
    writeUint16LE(out, ptr + 28, entry.nameBytes.length)
    writeUint16LE(out, ptr + 30, 0)
    writeUint16LE(out, ptr + 32, 0)
    writeUint16LE(out, ptr + 34, 0)
    writeUint16LE(out, ptr + 36, 0)
    writeUint32LE(out, ptr + 38, 0)
    writeUint32LE(out, ptr + 42, entry.offset)
    out.set(entry.nameBytes, ptr + 46)
    ptr += 46 + entry.nameBytes.length
  }

  writeUint32LE(out, ptr, 0x06054b50)
  writeUint16LE(out, ptr + 4, 0)
  writeUint16LE(out, ptr + 6, 0)
  writeUint16LE(out, ptr + 8, entries.length)
  writeUint16LE(out, ptr + 10, entries.length)
  writeUint32LE(out, ptr + 12, centralSize)
  writeUint32LE(out, ptr + 16, centralOffset)
  writeUint16LE(out, ptr + 20, 0)

  return out
}

export async function buildDocxBuffer(
  markdownText: string,
  options: ConvertOptions
): Promise<Uint8Array> {
  const { documentXml, stylesXml } = buildDocxXmlParts(markdownText, options)
  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  const docRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`

  return buildZipStoreArchive([
    { name: '[Content_Types].xml', content: contentTypesXml },
    { name: '_rels/.rels', content: rootRelsXml },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/styles.xml', content: stylesXml },
    { name: 'word/_rels/document.xml.rels', content: docRelsXml }
  ])
}

export function extractDocxXmlFromBuffer(docxBuffer: Uint8Array): {
  documentXml: string
  stylesXml: string
} {
  const decoder = new TextDecoder()
  const fullText = decoder.decode(docxBuffer)
  const docStart = fullText.indexOf('<w:document')
  const docEnd = fullText.indexOf('</w:document>')
  const stylesStart = fullText.indexOf('<w:styles')
  const stylesEnd = fullText.indexOf('</w:styles>')
  return {
    documentXml:
      docStart >= 0 && docEnd >= 0 ? fullText.slice(docStart, docEnd + '</w:document>'.length) : '',
    stylesXml:
      stylesStart >= 0 && stylesEnd >= 0
        ? fullText.slice(stylesStart, stylesEnd + '</w:styles>'.length)
        : ''
  }
}

export function buildWordClipboardHtml(markdownText: string, options: ConvertOptions): string {
  const trimmed = String(markdownText ?? '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_MARKDOWN_INPUT: 请输入有效的 Markdown 内容')
  }
  const { elements } = parseMarkdownAST(trimmed)
  const fonts = getPresetFonts(options.preset)
  const ptSize =
    options.fontSize === 'size-3' ? '16pt' : options.fontSize === 'size-5' ? '10.5pt' : '12pt'
  const indentStyle =
    options.preset === 'official' || options.firstLineIndent ? 'text-indent: 2em;' : ''

  const htmlBlocks = elements.map((el) => {
    if (el.type === 'heading') {
      const level = el.headingLevel ?? 1
      return `<h${level} style="font-family:'${fonts.heading1Font}','${fonts.asciiFont}',serif;font-weight:bold;">${escapeXml(el.title)}</h${level}>`
    }
    if (el.type === 'table' && el.tableRows) {
      const borderStyle =
        options.preset === 'academic'
          ? 'border-top:2px solid rgb(0,0,0);border-bottom:2px solid rgb(0,0,0);border-left:none;border-right:none;border-collapse:collapse;width:100%;'
          : 'border:1px solid rgb(204,204,204);border-collapse:collapse;width:100%;'
      const trs = el.tableRows
        .map((row, rIdx) => {
          const cellBorder =
            options.preset === 'academic'
              ? rIdx === 0
                ? 'border-bottom:1px solid rgb(0,0,0);padding:6px;'
                : 'border:none;padding:6px;'
              : 'border:1px solid rgb(204,204,204);padding:6px;'
          return `<tr>${row.map((c) => `<td style="${cellBorder}">${escapeXml(c)}</td>`).join('')}</tr>`
        })
        .join('')
      return `<table style="${borderStyle}">${trs}</table>`
    }
    if (el.type === 'code') {
      return `<pre style="font-family:Consolas,monospace;background:rgb(245,245,245);padding:8px;"><code>${escapeXml(el.rawContent)}</code></pre>`
    }
    return `<p style="font-family:'${fonts.bodyFont}','${fonts.asciiFont}',serif;font-size:${ptSize};${indentStyle}line-height:28pt;">${escapeXml(stripInlineMarkdown(el.rawContent))}</p>`
  })

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"/></head><body><!--StartFragment-->${htmlBlocks.join('\n')}<!--EndFragment--></body></html>`
}

export async function exportMarkdownToDocxFile(
  markdownText: string,
  options: ConvertOptions,
  outputPath?: string,
  hostOverride?: unknown
): Promise<{ ok: boolean; outputPath?: string; byteLength?: number; error?: string }> {
  const docxBytes = await buildDocxBuffer(markdownText, options)
  if (!outputPath) {
    return { ok: true, byteLength: docxBytes.byteLength }
  }
  let binary = ''
  for (let i = 0; i < docxBytes.length; i++) {
    binary += String.fromCharCode(docxBytes[i]!)
  }
  const base64Data =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(docxBytes.buffer, docxBytes.byteOffset, docxBytes.byteLength).toString('base64')

  let res = await callHostTransport<{ outputPath: string; byteLength: number }>(
    'dllplugin_call',
    {
      plugin: 'MdToOfficePlugin',
      func: 'save_docx',
      params: {
        action: 'save_docx',
        outputPath,
        base64Data
      }
    },
    hostOverride
  )
  if (!res.ok || !res.data?.outputPath) {
    res = await callHostTransport<{ outputPath: string; byteLength: number }>(
      'md_to_office',
      {
        action: 'save_docx',
        outputPath,
        base64Data
      },
      hostOverride
    )
  }
  if (!res.ok || !res.data) {
    return { ok: false, error: res.error || '保存 Word 文档失败' }
  }
  return {
    ok: true,
    outputPath: res.data.outputPath,
    byteLength: res.data.byteLength
  }
}
