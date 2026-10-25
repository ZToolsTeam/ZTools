import type {
  DdlParsedColumn,
  DdlParsedResult,
  FormattedSqlOutput,
  MyBatisParsedResult
} from './types.js'

const SQL_UPPER_KEYWORDS = [
  'SELECT',
  'DISTINCT',
  'FROM',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'CROSS JOIN',
  'JOIN',
  'ON',
  'WHERE',
  'AND',
  'OR',
  'IN',
  'NOT IN',
  'IS NULL',
  'IS NOT NULL',
  'LIKE',
  'BETWEEN',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'UNION ALL',
  'UNION',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'CREATE TABLE',
  'PRIMARY KEY',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AS'
]

const NEWLINE_CLAUSES = [
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'LEFT JOIN',
  'RIGHT JOIN',
  'INNER JOIN',
  'JOIN',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'UNION ALL',
  'UNION',
  'SET',
  'VALUES'
]

const INDENT_CLAUSES = ['AND', 'OR']

/**
 * 保护字符串字面量与注释，将 SQL 关键字转为大写并按子句换行对齐，同时输出单行压缩版
 */
export function formatAndMinifySql(rawSql: string): FormattedSqlOutput {
  const input = String(rawSql ?? '').trim()
  if (!input) {
    return {
      beautified: '',
      minified: '',
      charCount: 0,
      lineCount: 0
    }
  }

  // 提取并保护引号字面量和注释
  const placeholders: string[] = []
  const masked = input.replace(
    /('(?:''|\\'|[^'])*'|"(?:\\"|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\/)/g,
    (match) => {
      const idx = placeholders.length
      placeholders.push(match)
      return `__ZSQL_LIT_${idx}__`
    }
  )

  // 规范化空白与操作符两侧空格
  let normalized = masked
    .replace(/\s+/g, ' ')
    .replace(/\s*([,=<>!]+)\s*/g, (full, op: string) => {
      if (op === ',') return ', '
      return ` ${op} `
    })
    .trim()

  // 关键字转大写（按从长到短匹配）
  const sortedKeywords = [...SQL_UPPER_KEYWORDS].sort((a, b) => b.length - a.length)
  for (const kw of sortedKeywords) {
    const pattern = new RegExp(`\\b${kw.replace(/\s+/g, '\\s+')}\\b`, 'gi')
    normalized = normalized.replace(pattern, kw)
  }

  const minifiedMasked = normalized.replace(/\s+/g, ' ').trim()

  // 美化换行
  let beautifiedMasked = minifiedMasked
  for (const clause of NEWLINE_CLAUSES) {
    const pattern = new RegExp(`\\s+\\b(${clause})\\b`, 'g')
    beautifiedMasked = beautifiedMasked.replace(pattern, `\n$1`)
  }
  for (const clause of INDENT_CLAUSES) {
    const pattern = new RegExp(`\\s+\\b(${clause})\\b`, 'g')
    beautifiedMasked = beautifiedMasked.replace(pattern, `\n  $1`)
  }

  const restoreLiterals = (text: string): string =>
    text.replace(/__ZSQL_LIT_(\d+)__/g, (_, idxStr: string) => placeholders[Number(idxStr)] ?? '')

  const beautified = restoreLiterals(beautifiedMasked)
  const minified = restoreLiterals(minifiedMasked)

  return {
    beautified,
    minified,
    charCount: beautified.length,
    lineCount: beautified ? beautified.split('\n').length : 0
  }
}

const NUMERIC_TYPES = new Set([
  'long',
  'integer',
  'int',
  'short',
  'byte',
  'double',
  'float',
  'bigdecimal',
  'biginteger',
  'number'
])

function parseMyBatisParametersLine(rawParamLine: string): MyBatisParsedResult['params'] {
  const trimmed = rawParamLine.trim()
  if (!trimmed) return []

  const results: MyBatisParsedResult['params'] = []
  // 匹配 `val(Type)` 或 `null`，兼容参数值内含逗号或空格
  const tokenRegex = /(?:^|,\s*)([\s\S]*?)(?:\(([A-Za-z0-9_$.]+)\)|(?=,|$))/g

  let cursor = 0
  const parts = trimmed.split(/,\s*(?=(?:[^()]*\([A-Za-z0-9_$.]+\)\s*(?:,|$))|null\s*(?:,|$))/)

  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) continue
    cursor++
    if (part.toLowerCase() === 'null') {
      results.push({
        value: 'null',
        type: 'Null',
        injectedSqlPart: 'NULL'
      })
      continue
    }

    const typeMatch = part.match(/^([\s\S]*)\(([A-Za-z0-9_$.]+)\)$/)
    if (typeMatch) {
      const val = typeMatch[1] ?? ''
      const rawType = typeMatch[2] ?? 'String'
      const shortType = rawType.split('.').pop() || rawType
      const lowerType = shortType.toLowerCase()

      if (NUMERIC_TYPES.has(lowerType) && /^-?\d+(?:\.\d+)?$/.test(val.trim())) {
        results.push({
          value: val.trim(),
          type: shortType,
          injectedSqlPart: val.trim()
        })
      } else if (lowerType === 'boolean' || lowerType === 'bool') {
        const boolSql = val.trim().toLowerCase() === 'true' ? 'TRUE' : 'FALSE'
        results.push({
          value: val.trim(),
          type: shortType,
          injectedSqlPart: boolSql
        })
      } else {
        const escaped = val.replace(/'/g, "\\'")
        results.push({
          value: val,
          type: shortType,
          injectedSqlPart: `'${escaped}'`
        })
      }
    } else {
      const escaped = part.replace(/'/g, "\\'")
      results.push({
        value: part,
        type: 'String',
        injectedSqlPart: `'${escaped}'`
      })
    }
    if (cursor > 500) break
  }

  void tokenRegex
  return results
}

/**
 * 游标级替换 SQL 中非引号内部的 `?` 占位符，保护字符串字面量内的问号（如 `'question?'`）
 */
function injectPlaceholdersSafely(
  preparingSql: string,
  params: MyBatisParsedResult['params']
): { mergedSql: string; placeholderCount: number } {
  let out = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let placeholderIdx = 0

  for (let i = 0; i < preparingSql.length; i++) {
    const ch = preparingSql[i]!
    const prev = i > 0 ? preparingSql[i - 1] : ''

    if (ch === "'" && !inDoubleQuote && prev !== '\\') {
      inSingleQuote = !inSingleQuote
      out += ch
      continue
    }
    if (ch === '"' && !inSingleQuote && prev !== '\\') {
      inDoubleQuote = !inDoubleQuote
      out += ch
      continue
    }

    if (ch === '?' && !inSingleQuote && !inDoubleQuote) {
      const param = params[placeholderIdx]
      placeholderIdx++
      if (param) {
        out += param.injectedSqlPart
      } else {
        out += '?'
      }
      continue
    }

    out += ch
  }

  return { mergedSql: out, placeholderCount: placeholderIdx }
}

/**
 * 解析 MyBatis 日志中的 `Preparing:` 与 `Parameters:` 并拼合为完整可执行 SQL
 */
export function mergeMyBatisLog(rawLogText: string): MyBatisParsedResult {
  const lines = String(rawLogText ?? '').replace(/\r\n/g, '\n').split('\n')
  let rawPreparing = ''
  let rawParameters = ''

  for (const line of lines) {
    const prepMatch = line.match(/Preparing:\s*(.+)$/i)
    if (prepMatch?.[1] && !rawPreparing) {
      rawPreparing = prepMatch[1].trim()
    }
    const paramMatch = line.match(/Parameters:\s*(.*)$/i)
    if (paramMatch && !rawParameters) {
      rawParameters = (paramMatch[1] || '').trim()
    }
  }

  if (!rawPreparing) {
    return {
      isSuccess: false,
      hasCountMismatch: false,
      errorMessage: '未在输入文本中识别到 "Preparing:" 行，请粘贴完整的 MyBatis 控制台日志',
      rawPreparing: '',
      mergedSql: '',
      beautifiedMergedSql: '',
      paramCountDisplay: '未识别到有效日志',
      placeholderCount: 0,
      params: []
    }
  }

  const params = parseMyBatisParametersLine(rawParameters)
  const { mergedSql, placeholderCount } = injectPlaceholdersSafely(rawPreparing, params)
  const formatted = formatAndMinifySql(mergedSql)
  const hasCountMismatch = placeholderCount !== params.length

  return {
    isSuccess: true,
    hasCountMismatch,
    errorMessage: hasCountMismatch
      ? `警告：Preparing 包含 ${placeholderCount} 个问号占位符，但 Parameters 提取到 ${params.length} 个参数`
      : undefined,
    rawPreparing,
    mergedSql,
    beautifiedMergedSql: formatted.beautified,
    paramCountDisplay: hasCountMismatch
      ? `参数数量不匹配 (${params.length}/${placeholderCount})`
      : `已精准注入 ${params.length} 个参数`,
    placeholderCount,
    params
  }
}

function toCamelCase(snake: string, pascal = false): string {
  const clean = snake.replace(/^`+|`+$/g, '').trim()
  const parts = clean.split(/[_-]+/).filter(Boolean)
  if (parts.length === 0) return clean
  return parts
    .map((p, i) => {
      const lower = p.toLowerCase()
      if (i === 0 && !pascal) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

function mapDbTypeToTs(dbType: string): string {
  const upper = dbType.toUpperCase()
  if (upper.includes('BIGINT')) {
    // 64 位整数在前端 JS Number 中超过 2^53-1 会丢失精度，强制映射为 string
    return 'string'
  }
  if (
    upper.includes('INT') ||
    upper.includes('DECIMAL') ||
    upper.includes('NUMERIC') ||
    upper.includes('FLOAT') ||
    upper.includes('DOUBLE')
  ) {
    if (upper.startsWith('TINYINT(1)')) return 'boolean'
    return 'number'
  }
  if (upper.includes('BOOL')) return 'boolean'
  if (upper.includes('JSON')) return 'Record<string, unknown>'
  return 'string'
}

function mapDbTypeToGo(dbType: string, nullable: boolean): string {
  const upper = dbType.toUpperCase()
  if (upper.startsWith('TINYINT(1)') || upper.includes('BOOL')) return 'bool'
  if (upper.includes('BIGINT')) return 'int64'
  if (upper.includes('INT')) return 'int'
  if (upper.includes('DECIMAL') || upper.includes('DOUBLE') || upper.includes('FLOAT')) {
    return 'float64'
  }
  if (upper.includes('DATE') || upper.includes('TIME')) {
    return nullable ? '*time.Time' : 'time.Time'
  }
  return 'string'
}

function mapDbTypeToJava(dbType: string): string {
  const upper = dbType.toUpperCase()
  if (upper.startsWith('TINYINT(1)') || upper.includes('BOOL')) return 'Boolean'
  if (upper.includes('BIGINT')) return 'Long'
  if (upper.includes('INT')) return 'Integer'
  if (upper.includes('DECIMAL') || upper.includes('NUMERIC')) return 'BigDecimal'
  if (upper.includes('DOUBLE') || upper.includes('FLOAT')) return 'Double'
  if (upper.includes('DATETIME') || upper.includes('TIMESTAMP')) return 'LocalDateTime'
  if (upper.includes('DATE')) return 'LocalDate'
  return 'String'
}

/**
 * 解析 `CREATE TABLE` DDL 建表语句并一键生成 TypeScript / Go / Java 实体模型代码
 */
export function parseDdlToEntities(rawDdl: string): DdlParsedResult {
  const text = String(rawDdl ?? '').trim()
  if (!text) {
    return {
      isValid: false,
      warningMessage: '请输入 CREATE TABLE 建表语句',
      tableName: '',
      columns: [],
      generatedCode: { typescript: '', golang: '', java: '' }
    }
  }

  const tableMatch = text.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[\]]?([a-zA-Z0-9_]+)[`"[\]]?/i)
  const tableName = tableMatch?.[1] || 'unknown_table'
  const pascalName = toCamelCase(tableName.replace(/^t_|^tb_/i, ''), true) || 'EntityModel'

  const openParenIdx = text.indexOf('(')
  let warningMessage: string | undefined

  if (openParenIdx < 0) {
    return {
      isValid: false,
      warningMessage: 'DDL 语法残缺：未找到字段定义括号 "("',
      tableName,
      columns: [],
      generatedCode: { typescript: '', golang: '', java: '' }
    }
  }

  let depth = 0
  let matchingCloseIdx = -1
  for (let i = openParenIdx; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) {
        matchingCloseIdx = i
        break
      }
    }
  }

  if (matchingCloseIdx < 0) {
    warningMessage = 'DDL 语法警告：缺少闭合括号 ")"，已尽力解析已识别字段'
  }

  const body =
    matchingCloseIdx > openParenIdx
      ? text.slice(openParenIdx + 1, matchingCloseIdx)
      : text.slice(openParenIdx + 1)

  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const columns: DdlParsedColumn[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/,$/, '').trim()
    if (!line || line.startsWith('--') || line.startsWith('/*')) continue
    if (/^(PRIMARY\s+KEY|UNIQUE\s+KEY|UNIQUE\s+INDEX|KEY\s+|INDEX\s+|CONSTRAINT\s+|FOREIGN\s+KEY)/i.test(line)) {
      continue
    }

    const colMatch = line.match(/^[`"[\]]?([a-zA-Z0-9_]+)[`"[\]]?\s+([a-zA-Z0-9_]+(?:\s*\([^)]+\))?)(.*)$/)
    if (!colMatch?.[1] || !colMatch[2]) continue

    const colName = colMatch[1]
    const dbType = colMatch[2].trim().toUpperCase()
    const rest = colMatch[3] || ''
    const nullable = !/NOT\s+NULL/i.test(rest) && !/PRIMARY\s+KEY/i.test(rest)
    const commentMatch = rest.match(/COMMENT\s+['"]([^'"]*)['"]/i)
    const comment = commentMatch?.[1]

    columns.push({
      name: colName,
      dbType,
      nullable,
      comment
    })
  }

  if (columns.length === 0) {
    return {
      isValid: false,
      warningMessage: warningMessage || '未能从建表语句中提取出有效列定义',
      tableName,
      columns: [],
      generatedCode: { typescript: '', golang: '', java: '' }
    }
  }

  // 1. TypeScript Interface
  const tsLines = [`export interface ${pascalName} {`]
  for (const col of columns) {
    if (col.comment) {
      tsLines.push(`  /** ${col.comment} (${col.dbType}) */`)
    }
    const propName = toCamelCase(col.name, false)
    const opt = col.nullable ? '?' : ''
    tsLines.push(`  ${propName}${opt}: ${mapDbTypeToTs(col.dbType)};`)
  }
  tsLines.push('}')

  // 2. Go Struct (with json & gorm tags)
  const goLines = [`type ${pascalName} struct {`]
  for (const col of columns) {
    const fieldName = toCamelCase(col.name, true)
    const jsonName = toCamelCase(col.name, false)
    const goType = mapDbTypeToGo(col.dbType, col.nullable)
    const commentTag = col.comment ? `;comment:${col.comment}` : ''
    goLines.push(
      `  ${fieldName} ${goType} \`json:"${jsonName}" gorm:"column:${col.name}${commentTag}"\``
    )
  }
  goLines.push('}')

  // 3. Java POJO (with Lombok & Javadoc)
  const javaLines = [
    'import lombok.Data;',
    'import lombok.NoArgsConstructor;',
    'import java.io.Serializable;',
    'import java.math.BigDecimal;',
    'import java.time.LocalDateTime;',
    '',
    '@Data',
    '@NoArgsConstructor',
    `public class ${pascalName} implements Serializable {`
  ]
  for (const col of columns) {
    if (col.comment) {
      javaLines.push('  /**')
      javaLines.push(`   * ${col.comment}`)
      javaLines.push('   */')
    }
    const fieldName = toCamelCase(col.name, false)
    const javaType = mapDbTypeToJava(col.dbType)
    javaLines.push(`  private ${javaType} ${fieldName};`)
  }
  javaLines.push('}')

  return {
    isValid: !warningMessage,
    warningMessage,
    tableName,
    columns,
    generatedCode: {
      typescript: tsLines.join('\n'),
      golang: goLines.join('\n'),
      java: javaLines.join('\n')
    }
  }
}
