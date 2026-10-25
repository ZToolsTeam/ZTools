import type { CodeTargetLang, HttpResponseSnapshot, ParsedCurlRequest } from './types.js'

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export function tokenizeShellCommand(raw: string): string[] {
  const normalized = String(raw || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim()

  const tokens: string[] = []
  let current = ''
  let quoteChar: "'" | '"' | null = null
  let escaped = false

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quoteChar !== "'") {
      escaped = true
      continue
    }
    if ((ch === "'" || ch === '"') && !quoteChar) {
      quoteChar = ch
      continue
    }
    if (ch === quoteChar) {
      quoteChar = null
      continue
    }
    if (/\s/.test(ch) && !quoteChar) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (quoteChar) {
    throw new Error(`UNCLOSED_QUOTE_IN_CURL: cURL 命令存在未闭合引号 (${quoteChar})`)
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

export function parseCurlCommand(rawInput: string): ParsedCurlRequest {
  const trimmed = String(rawInput || '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_CURL_INPUT: cURL 命令或 URL 不能为空')
  }

  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) {
    return {
      method: 'GET',
      url: trimmed,
      headers: {},
      rawCommand: `curl -X GET "${trimmed}"`,
    }
  }

  const tokens = tokenizeShellCommand(trimmed)
  if (tokens.length === 0) {
    throw new Error('EMPTY_CURL_TOKENS: 无法从输入提取命令参数')
  }

  const firstLower = tokens[0].toLowerCase()
  const startIdx = firstLower === 'curl' || firstLower === 'curl.exe' ? 1 : 0

  let method = ''
  let url = ''
  const headers: Record<string, string> = {}
  const bodyParts: string[] = []
  let cookies: string | undefined

  for (let i = startIdx; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      const next = tokens[++i]
      if (!next) throw new Error('MISSING_CURL_METHOD: -X 参数后缺少 HTTP 方法')
      method = next.toUpperCase()
    } else if (token === '-H' || token === '--header') {
      const next = tokens[++i]
      if (!next) throw new Error('MISSING_CURL_HEADER: -H 参数后缺少 Header 内容')
      const colonIdx = next.indexOf(':')
      if (colonIdx > 0) {
        const key = next.slice(0, colonIdx).trim()
        const val = next.slice(colonIdx + 1).trim()
        headers[key] = val
      }
    } else if (
      token === '-d' ||
      token === '--data' ||
      token === '--data-raw' ||
      token === '--data-binary' ||
      token === '--data-urlencode'
    ) {
      const next = tokens[++i]
      if (typeof next !== 'string') {
        throw new Error(`MISSING_CURL_BODY: ${token} 参数后缺少请求体数据`)
      }
      bodyParts.push(next)
    } else if (token === '-b' || token === '--cookie') {
      const next = tokens[++i]
      if (!next) throw new Error('MISSING_CURL_COOKIE: -b 参数后缺少 Cookie 内容')
      cookies = next
      headers['Cookie'] = next
    } else if (token === '-u' || token === '--user') {
      const next = tokens[++i]
      if (!next) throw new Error('MISSING_CURL_USER: -u 参数后缺少认证信息')
      const encoded =
        typeof Buffer !== 'undefined' ? Buffer.from(next, 'utf8').toString('base64') : btoa(next)
      headers['Authorization'] = `Basic ${encoded}`
    } else if (token === '--url') {
      const next = tokens[++i]
      if (!next) throw new Error('MISSING_CURL_URL: --url 参数后缺少目标地址')
      url = next
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      url = token
    }
  }

  if (!url) {
    throw new Error('MISSING_TARGET_URL: 未能在 cURL 命令中识别出合法的 http/https URL')
  }

  const body = bodyParts.length > 0 ? bodyParts.join('&') : undefined
  if (!method) {
    method = body !== undefined ? 'POST' : 'GET'
  }

  return {
    method,
    url,
    headers,
    body,
    cookies,
    rawCommand: trimmed,
  }
}

export function generateCodeFromCurl(parsed: ParsedCurlRequest, lang: CodeTargetLang): string {
  const hasHeaders = Object.keys(parsed.headers).length > 0

  if (lang === 'fetch') {
    const options: Record<string, unknown> = {
      method: parsed.method,
    }
    if (hasHeaders) {
      options.headers = parsed.headers
    }
    if (parsed.body !== undefined) {
      options.body = parsed.body
    }
    return `const response = await fetch(${JSON.stringify(parsed.url)}, ${JSON.stringify(
      options,
      null,
      2,
    )});\nconst data = await response.text();\nconsole.log(response.status, data);`
  }

  if (lang === 'axios') {
    const config: Record<string, unknown> = {
      method: parsed.method.toLowerCase(),
      url: parsed.url,
    }
    if (hasHeaders) {
      config.headers = parsed.headers
    }
    if (parsed.body !== undefined) {
      try {
        config.data = JSON.parse(parsed.body)
      } catch {
        config.data = parsed.body
      }
    }
    return `import axios from 'axios';\n\nconst response = await axios(${JSON.stringify(
      config,
      null,
      2,
    )});\nconsole.log(response.status, response.data);`
  }

  if (lang === 'python') {
    const lines: string[] = ['import requests', '']
    lines.push(`url = ${JSON.stringify(parsed.url)}`)
    if (hasHeaders) {
      lines.push(`headers = ${JSON.stringify(parsed.headers, null, 2)}`)
    }
    if (parsed.body !== undefined) {
      lines.push(`payload = ${JSON.stringify(parsed.body)}`)
    }
    const args: string[] = [`${ JSON.stringify(parsed.method) }`, 'url']
    if (hasHeaders) args.push('headers=headers')
    if (parsed.body !== undefined) args.push('data=payload')
    lines.push(`response = requests.request(${args.join(', ')})`)
    lines.push('print(response.status_code, response.text)')
    return lines.join('\n')
  }

  const goLines: string[] = [
    'package main',
    '',
    'import (',
    '  "fmt"',
    '  "io"',
    '  "net/http"',
    ...(parsed.body !== undefined ? ['  "strings"'] : []),
    ')',
    '',
    'func main() {',
  ]
  if (parsed.body !== undefined) {
    goLines.push(`  bodyReader := strings.NewReader(${JSON.stringify(parsed.body)})`)
    goLines.push(
      `  req, err := http.NewRequest(${JSON.stringify(parsed.method)}, ${JSON.stringify(
        parsed.url,
      )}, bodyReader)`,
    )
  } else {
    goLines.push(
      `  req, err := http.NewRequest(${JSON.stringify(parsed.method)}, ${JSON.stringify(
        parsed.url,
      )}, nil)`,
    )
  }
  goLines.push('  if err != nil { panic(err) }')
  for (const [k, v] of Object.entries(parsed.headers)) {
    goLines.push(`  req.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`)
  }
  goLines.push('  resp, err := http.DefaultClient.Do(req)')
  goLines.push('  if err != nil { panic(err) }')
  goLines.push('  defer resp.Body.Close()')
  goLines.push('  raw, _ := io.ReadAll(resp.Body)')
  goLines.push('  fmt.Println(resp.StatusCode, string(raw))')
  goLines.push('}')
  return goLines.join('\n')
}

export async function executeCurlRequest(
  parsed: ParsedCurlRequest,
  options?: {
    timeoutMs?: number
    fetchImpl?: typeof fetch
  },
): Promise<HttpResponseSnapshot> {
  const fetchFn = options?.fetchImpl || globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('FETCH_UNAVAILABLE: 当前运行环境不支持 fetch 网络请求')
  }

  const timeoutMs = options?.timeoutMs ?? 10000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const resp = await fetchFn(parsed.url, {
      method: parsed.method,
      headers: parsed.headers,
      body: parsed.method === 'GET' || parsed.method === 'HEAD' ? undefined : parsed.body,
      signal: controller.signal,
    })

    const rawText = await resp.text()
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    const sizeBytes =
      typeof Buffer !== 'undefined' ? Buffer.byteLength(rawText, 'utf8') : rawText.length

    let bodyText = rawText
    let truncated = false
    if (sizeBytes > MAX_RESPONSE_BYTES) {
      truncated = true
      bodyText = `${rawText.slice(0, 65536)}\n\n... [响应体超过 5MB 上限 (${sizeBytes} bytes)，已安全截断保护渲染性能]`
    } else {
      try {
        const parsedJson = JSON.parse(rawText)
        bodyText = JSON.stringify(parsedJson, null, 2)
      } catch {
        bodyText = rawText
      }
    }

    const responseHeaders: Record<string, string> = {}
    resp.headers.forEach((val, key) => {
      responseHeaders[key] = val
    })

    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText || (resp.ok ? 'OK' : 'Error'),
      elapsedMs,
      sizeBytes,
      truncated,
      responseHeaders,
      bodyText,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`HTTP_TIMEOUT: 请求在 ${timeoutMs}ms 内未响应已超时中断`)
    }
    throw new Error(`HTTP_REQUEST_FAILED: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
  }
}
