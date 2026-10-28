import { Marked, type Tokens, type Token } from 'marked'
import { Document, Packer } from 'docx'
import { htmlToContent } from 'docx/html'
import { DOMParser, type Node, type Element } from '@xmldom/xmldom'
import { validateMarkdownText, type MarkdownOptions } from '../../contracts/markdown-document.js'

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function safeLink(href: string): boolean {
  try { const u = new URL(href); return ['http:', 'https:', 'mailto:'].includes(u.protocol) && !u.username && !u.password } catch { return false }
}
function styles(o: MarkdownOptions) {
  const size = o.fontSize === 'size-3' ? 16 : o.fontSize === 'size-5' ? 10.5 : 12
  const eastAsia = o.preset === 'business' ? (process.platform === 'darwin' ? 'PingFang SC' : 'Microsoft YaHei') : (process.platform === 'darwin' ? 'Songti SC' : o.preset === 'official' ? 'FangSong' : 'SimSun')
  const font = `'${eastAsia}', 'Times New Roman', serif`
  return { size, eastAsia, css: `body, div, p, li, td, th { font-family: ${font}; font-size: ${size}pt; }
p { margin: 0 0 6pt; line-height: ${o.preset === 'official' ? 28 : size * 1.5}pt; text-indent: ${o.firstLineIndent ? size * 2 : 0}pt; }
h1, h2, h3, h4, h5, h6 { font-family: '${process.platform === 'darwin' ? 'Heiti SC' : 'SimHei'}', sans-serif; color: rgb(0,0,0); text-indent: 0; }
h1 { font-size: 22pt; } h2 { font-size: 16pt; } h3, h4, h5, h6 { font-size: 14pt; }
pre, code { font-family: Courier New, monospace; font-size: 10pt; white-space: pre-wrap; } pre { text-indent: 0; }
blockquote { margin-left: 24pt; } li p { text-indent: 0; }
table { width: 100%; border-collapse: collapse; } td, th { padding: 4pt; text-indent: 0; }
${o.preset === 'academic' ? 'table { border-top: 1.5pt solid black; border-bottom: 1.5pt solid black; } th { border-bottom: 0.75pt solid black; }' : 'td, th { border: 0.5pt solid black; }'}` }
}
function boundedTokens(tokens: Token[]) {
  let count = 0
  const visit = (items: Token[], depth: number) => {
    if (depth > 48) throw new Error('Markdown 嵌套超过 48 层，请简化后转换')
    for (const token of items) {
      if (++count > 12000) throw new Error('Markdown 结构超过处理上限，请拆分文档')
      if (token.type === 'list') for (const item of (token as Tokens.List).items) visit(item.tokens, depth + 1)
      else if (token.type === 'table') for (const row of [(token as Tokens.Table).header, ...(token as Tokens.Table).rows]) for (const cell of row) visit(cell.tokens, depth + 1)
      else if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens as Token[], depth + 1)
    }
  }
  visit(tokens, 0)
}
function plainText(html: string) {
  const document = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html')
  const walk = (node: Node, preserve = false, listDepth = 0): string => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      if (preserve) return text
      if (!text.trim() && /^(?:html|body|table|thead|tbody|tr|ol|ul)$/.test(node.parentNode?.nodeName.toLowerCase() ?? '')) return ''
      return text.replace(/\s+/g, ' ')
    }
    const tag = node.nodeName.toLowerCase(), children = Array.from(node.childNodes ?? [])
    if (tag === 'br') return '\n'
    if (tag === 'ol' || tag === 'ul') {
      const start = Number((node as Element).getAttribute('start') || 1)
      return children.filter(child => child.nodeName.toLowerCase() === 'li').map((child, i) => `${'  '.repeat(listDepth)}${tag === 'ol' ? start + i + '.' : '-'} ${walk(child, false, listDepth + 1)}\n`).join('') + '\n'
    }
    if (tag === 'tr') return children.filter(child => ['td', 'th'].includes(child.nodeName.toLowerCase())).map(child => walk(child)).join('\t') + '\n'
    const content = children.reduce((text, child) => {
      const separator = /^(?:ol|ul)$/.test(child.nodeName.toLowerCase()) && text && !text.endsWith('\n') ? '\n' : ''
      return text + separator + walk(child, preserve || tag === 'pre' || tag === 'code', listDepth)
    }, '')
    return content + (/^(?:p|h[1-6]|pre|blockquote|table)$/.test(tag) ? '\n\n' : '')
  }
  return walk(document.documentElement!)
}
/** 生成的是导出文档内容，不在插件页面执行 HTML；原始 HTML、图片与危险链接不会成为活动内容。 */
export function renderMarkdown(markdown: string, options: MarkdownOptions) {
  validateMarkdownText(markdown)
  const warnings = new Set<string>(), engine = new Marked({ gfm: true, async: false })
  engine.use({ renderer: {
    html({ text }) { warnings.add('原始 HTML 按文字保留，不执行其中内容'); return escape(text) },
    image({ href, text }) { warnings.add('图片保留说明和地址，不会自动读取本机文件或下载远程图片'); return escape(`[图片：${text || '未命名'}] ${href}`) },
    link({ href, tokens }) { const text = this.parser.parseInline(tokens); if (!safeLink(href)) { warnings.add('非 HTTP、HTTPS 或邮件链接保留为文字'); return `${text} (${escape(href)})` }; return `<a href="${escape(href)}">${text}</a>` },
    checkbox({ checked }) { return checked ? '[x] ' : '[ ] ' },
    br() { return '<br/>' }, hr() { return '<hr/>' }
  } })
  const tokens = engine.lexer(markdown), format = styles(options)
  boundedTokens(tokens)
  const fragment = engine.parser(tokens), text = plainText(fragment)
  if (!text.trim()) throw new Error('Markdown 中没有可导出的正文')
  const firstHeading = tokens.find((token): token is Tokens.Heading => token.type === 'heading')
  const title = (firstHeading ? plainText(engine.parser([firstHeading])) : text.split('\n')[0] || 'Markdown 文档').trim().slice(0, 100) || 'Markdown 文档'
  const summary = { title, characters: text.length, blocks: tokens.filter(t => !['space', 'def'].includes(t.type)).length, warnings: [...warnings] }
  const html = `<html><head><meta charset="utf-8"/><style>${format.css}</style></head><body><!--StartFragment-->${fragment}<!--EndFragment--></body></html>`
  return { html, text, summary, async docx() {
    const conversionWarnings: string[] = []
    const children = htmlToContent(fragment, { stylesheet: format.css, onWarning: warning => conversionWarnings.push(warning.message) })
    if (conversionWarnings.length) throw new Error(`文档转换存在未保留内容：${conversionWarnings.join('；')}`)
    const document = new Document({ title, creator: 'ZTools', description: '由本地 Markdown 转换', styles: { default: { document: { run: { font: { ascii: 'Times New Roman', eastAsia: format.eastAsia }, size: format.size * 2 } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }] })
    return Packer.toBuffer(document)
  } }
}
