import type {
  DetectedSourceFormat,
  InferredColumnType,
  TableConversionTarget,
  TableGrid
} from './types.js'

/**
 * 符合 RFC 4180 规范的分隔符解析器（支持双引号包裹、内部含分隔符或真实换行 `\n`、双引号转义 `""`）
 */
export function parseDelimitedRows(rawText: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ''
  let inQuotes = false
  const text = String(rawText ?? '').replace(/\r\n/g, '\n')

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        currentCell += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      currentRow.push(currentCell)
      currentCell = ''
    } else if (ch === '\n') {
      currentRow.push(currentCell)
      rows.push(currentRow)
      currentRow = []
      currentCell = ''
    } else {
      currentCell += ch
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell)
    rows.push(currentRow)
  }

  return rows.filter((r) => !(r.length === 1 && r[0]?.trim() === ''))
}

function inferColumnTypes(headers: string[], rows: string[][]): InferredColumnType[] {
  return headers.map((_, colIdx) => {
    const values = rows.map((r) => (r[colIdx] ?? '').trim()).filter((v) => v !== '')
    if (values.length === 0) return 'null'
    if (values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'number'
    if (values.every((v) => /^(true|false)$/i.test(v))) return 'boolean'
    return 'string'
  })
}

function normalizeMatrixToGrid(rawRows: string[][], hasHeader: boolean): TableGrid {
  if (rawRows.length === 0) {
    return { headers: [], rows: [], inferredTypes: [] }
  }
  const colCount = Math.max(...rawRows.map((r) => r.length), 1)
  const paddedRows = rawRows.map((r) => {
    const copy = [...r]
    while (copy.length < colCount) {
      copy.push('')
    }
    return copy
  })

  const headers = hasHeader
    ? paddedRows[0]!.map((h, i) => h.trim() || `col_${i + 1}`)
    : Array.from({ length: colCount }, (_, i) => `col_${i + 1}`)
  const dataRows = hasHeader ? paddedRows.slice(1) : paddedRows

  return {
    headers,
    rows: dataRows,
    inferredTypes: inferColumnTypes(headers, dataRows)
  }
}

export function detectAndParse(
  rawText: string,
  hasHeader = true
): {
  format: DetectedSourceFormat
  grid: TableGrid
} {
  const trimmed = String(rawText ?? '').trim()
  if (!trimmed) {
    return {
      format: 'empty',
      grid: { headers: [], rows: [], inferredTypes: [] }
    }
  }

  // 1. JSON Array
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (Array.isArray(parsed[0])) {
          const matrix = (parsed as unknown[][]).map((r) => r.map((c) => String(c ?? '')))
          return { format: 'json', grid: normalizeMatrixToGrid(matrix, hasHeader) }
        }
        if (typeof parsed[0] === 'object' && parsed[0] !== null) {
          const keySet = new Set<string>()
          for (const item of parsed) {
            if (item && typeof item === 'object') {
              for (const k of Object.keys(item as Record<string, unknown>)) keySet.add(k)
            }
          }
          const headers = Array.from(keySet)
          const rows = parsed.map((item) => {
            const obj = (item || {}) as Record<string, unknown>
            return headers.map((h) => (obj[h] === undefined || obj[h] === null ? '' : String(obj[h])))
          })
          return {
            format: 'json',
            grid: {
              headers,
              rows,
              inferredTypes: inferColumnTypes(headers, rows)
            }
          }
        }
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // 2. Markdown Table
  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  if (lines.length >= 2 && lines[0]!.trim().startsWith('|') && lines[0]!.trim().endsWith('|')) {
    const mdRows: string[][] = []
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('|')) continue
      const inner = t.replace(/^\|/, '').replace(/\|$/, '')
      const cells = inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
      const isSep = cells.every((c) => /^:?-{2,}:?$/.test(c))
      if (!isSep) {
        mdRows.push(cells)
      }
    }
    if (mdRows.length > 0) {
      return { format: 'markdown', grid: normalizeMatrixToGrid(mdRows, hasHeader) }
    }
  }

  // 3. HTML <table>
  if (/<table[\s>]/i.test(trimmed) && /<tr[\s>]/i.test(trimmed)) {
    const trMatches = trimmed.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    const htmlRows: string[][] = []
    for (const tr of trMatches) {
      const cellMatches = tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) ?? []
      if (cellMatches.length > 0) {
        htmlRows.push(
          cellMatches.map((cell) =>
            cell
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .trim()
          )
        )
      }
    }
    if (htmlRows.length > 0) {
      return { format: 'html', grid: normalizeMatrixToGrid(htmlRows, hasHeader) }
    }
  }

  // 4. TSV vs CSV
  const firstLine = lines[0] ?? ''
  const tabCount = (firstLine.match(/\t/g) ?? []).length
  if (tabCount > 0) {
    const tsvRows = parseDelimitedRows(trimmed, '\t')
    return { format: 'tsv', grid: normalizeMatrixToGrid(tsvRows, hasHeader) }
  }

  const csvRows = parseDelimitedRows(trimmed, ',')
  return { format: 'csv', grid: normalizeMatrixToGrid(csvRows, hasHeader) }
}

function sanitizeMarkdownCell(val: string): string {
  return String(val ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim()
}

export function gridToMarkdown(grid: TableGrid): string {
  if (grid.headers.length === 0) return ''
  const escapedHeaders = grid.headers.map(sanitizeMarkdownCell)
  const escapedRows = grid.rows.map((row) =>
    grid.headers.map((_, cIdx) => sanitizeMarkdownCell(row[cIdx] ?? ''))
  )

  const colWidths = escapedHeaders.map((h, cIdx) => {
    const maxCell = Math.max(h.length, ...escapedRows.map((r) => (r[cIdx] ?? '').length), 3)
    return maxCell
  })

  const formatRow = (cells: string[]) =>
    '| ' +
    cells.map((c, idx) => c.padEnd(colWidths[idx]!, ' ')).join(' | ') +
    ' |'

  const sepRow =
    '| ' +
    colWidths
      .map((w, idx) =>
        grid.inferredTypes[idx] === 'number' ? '-'.repeat(w - 1) + ':' : '-'.repeat(w)
      )
      .join(' | ') +
    ' |'

  return [formatRow(escapedHeaders), sepRow, ...escapedRows.map(formatRow)].join('\n')
}

export function gridToJson(grid: TableGrid): string {
  if (grid.headers.length === 0) return '[]'
  const objects = grid.rows.map((row) => {
    const item: Record<string, unknown> = {}
    grid.headers.forEach((h, idx) => {
      const raw = (row[idx] ?? '').trim()
      const colType = grid.inferredTypes[idx]
      if (raw === '') {
        item[h] = null
      } else if (colType === 'number' && /^-?\d+(\.\d+)?$/.test(raw)) {
        item[h] = Number(raw)
      } else if (colType === 'boolean' && /^(true|false)$/i.test(raw)) {
        item[h] = raw.toLowerCase() === 'true'
      } else {
        item[h] = row[idx] ?? ''
      }
    })
    return item
  })
  return JSON.stringify(objects, null, 2)
}

export function gridToSql(grid: TableGrid, tableName = 'my_table'): string {
  if (grid.headers.length === 0 || grid.rows.length === 0) return ''
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '_') || 'my_table'
  const colList = grid.headers
    .map((h) => `\`${h.replace(/`/g, '')}\``)
    .join(', ')

  const valueTuples = grid.rows.map((row) => {
    const vals = grid.headers.map((_, idx) => {
      const raw = row[idx] ?? ''
      const trimmed = raw.trim()
      const colType = grid.inferredTypes[idx]
      if (trimmed === '') return 'NULL'
      if (colType === 'number' && /^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
      if (colType === 'boolean' && /^(true|false)$/i.test(trimmed)) {
        return trimmed.toLowerCase() === 'true' ? 'TRUE' : 'FALSE'
      }
      const escaped = raw.replace(/'/g, "''").replace(/\r\n/g, '\n')
      return `'${escaped}'`
    })
    return `  (${vals.join(', ')})`
  })

  return `INSERT INTO ${safeTable} (${colList})\nVALUES\n${valueTuples.join(',\n')};`
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function gridToHtml(grid: TableGrid): string {
  if (grid.headers.length === 0) return ''
  const thead = `  <thead>\n    <tr>${grid.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>\n  </thead>`
  const tbodyRows = grid.rows
    .map(
      (r) =>
        `    <tr>${grid.headers.map((_, idx) => `<td>${escapeHtml(r[idx] ?? '')}</td>`).join('')}</tr>`
    )
    .join('\n')
  return `<table>\n${thead}\n  <tbody>\n${tbodyRows}\n  </tbody>\n</table>`
}

export function gridToCsv(grid: TableGrid): string {
  if (grid.headers.length === 0) return ''
  const encodeCsvCell = (val: string) => {
    const s = String(val ?? '')
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines = [
    grid.headers.map(encodeCsvCell).join(','),
    ...grid.rows.map((r) => grid.headers.map((_, i) => encodeCsvCell(r[i] ?? '')).join(','))
  ]
  return lines.join('\n')
}

export function buildAllConversionTargets(
  grid: TableGrid,
  sqlTableName = 'my_table'
): TableConversionTarget[] {
  const typeSummary = grid.headers
    .map((h, i) => `${h}: ${grid.inferredTypes[i]}`)
    .join(' · ')

  const mdFull = gridToMarkdown(grid)
  const jsonFull = gridToJson(grid)
  const sqlFull = gridToSql(grid, sqlTableName)
  const htmlFull = gridToHtml(grid)
  const csvFull = gridToCsv(grid)

  const slicePreview = (text: string) => {
    const lines = text.split('\n')
    if (lines.length <= 100) return text
    return lines.slice(0, 100).join('\n') + `\n... (已截断预览，共 ${lines.length} 行)`
  }

  return [
    {
      id: 'markdown',
      title: 'Markdown 对齐表格',
      subtitle: '自动计算等宽空格对齐 · 数值列右对齐 · 管道符与换行安全转义',
      badge: '推荐文档格式',
      language: 'markdown',
      fullText: mdFull,
      previewText: slicePreview(mdFull),
      typeSummary
    },
    {
      id: 'json',
      title: 'JSON 结构化对象数组',
      subtitle: '首行自动映射为 Key · 智能推导 number / boolean / null 类型',
      badge: 'API / 研发',
      language: 'json',
      fullText: jsonFull,
      previewText: slicePreview(jsonFull),
      typeSummary
    },
    {
      id: 'sql',
      title: `SQL 批量 INSERT 语句 (${sqlTableName})`,
      subtitle: '单引号自动防注入双写转义 · 空值映射 NULL',
      badge: '数据库导入',
      language: 'sql',
      fullText: sqlFull,
      previewText: slicePreview(sqlFull),
      typeSummary
    },
    {
      id: 'html',
      title: 'HTML <table> 语义化结构',
      subtitle: '标准 thead / tbody 标签封装',
      badge: '网页内嵌',
      language: 'html',
      fullText: htmlFull,
      previewText: slicePreview(htmlFull),
      typeSummary
    },
    {
      id: 'csv',
      title: 'RFC 4180 标准 CSV',
      subtitle: '自动包裹含逗号或换行的复杂单元格',
      badge: '通用交换',
      language: 'csv',
      fullText: csvFull,
      previewText: slicePreview(csvFull),
      typeSummary
    }
  ]
}
