import type { MacroResolveResult, SnippetCategory, SnippetFormInput, SnippetItem } from './types.js'

const MAX_CLIPBOARD_EMBED_LEN = 32768

export function getSnippetCategoryLabel(category: SnippetCategory): string {
  switch (category) {
    case 'invoice':
      return '发票与开票信息'
    case 'address':
      return '常用地址与联系人'
    case 'customer_service':
      return '客服与商务话术'
    case 'code':
      return '开发与代码片段'
    default:
      return '通用短语'
  }
}

export function formatMacroDateParts(now = new Date()): {
  date: string
  time: string
  datetime: string
} {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const date = `${y}-${m}-${d}`
  const time = `${hh}:${mm}:${ss}`
  return {
    date,
    time,
    datetime: `${date} ${time}`
  }
}

export function resolveMacroTemplate(
  template: string,
  clipboardText = '',
  options?: { fixedDate?: string; fixedTime?: string; fixedDatetime?: string }
): MacroResolveResult {
  const raw = String(template || '')
  if (!raw) {
    return { text: '', cursorOffsetFromEnd: 0 }
  }

  const parts = formatMacroDateParts()
  const dateVal = options?.fixedDate ?? parts.date
  const timeVal = options?.fixedTime ?? parts.time
  const datetimeVal = options?.fixedDatetime ?? `${dateVal} ${timeVal}`
  const safeClip = String(clipboardText || '').slice(0, MAX_CLIPBOARD_EMBED_LEN)

  // Replace known macros except {cursor} first; leave unknown {xyz} or unclosed {date intact
  const expanded = raw
    .replace(/\{date\}/g, dateVal)
    .replace(/\{time\}/g, timeVal)
    .replace(/\{datetime\}/g, datetimeVal)
    .replace(/\{clipboard\}/g, safeClip)

  const cursorToken = '{cursor}'
  const cursorIdx = expanded.indexOf(cursorToken)
  if (cursorIdx === -1) {
    return {
      text: expanded,
      cursorOffsetFromEnd: 0
    }
  }

  const textWithoutCursor =
    expanded.slice(0, cursorIdx) +
    expanded.slice(cursorIdx + cursorToken.length).replace(/\{cursor\}/g, '')
  const cursorOffsetFromEnd = textWithoutCursor.length - cursorIdx

  return {
    text: textWithoutCursor,
    cursorOffsetFromEnd
  }
}

export function validateSnippetInput(input: SnippetFormInput): {
  valid: boolean
  error?: string
} {
  if (!input || !String(input.title || '').trim()) {
    return {
      valid: false,
      error: 'SNIPPET_INVALID_INPUT: 短语标题不能为空'
    }
  }
  if (!String(input.content || '').trim()) {
    return {
      valid: false,
      error: 'SNIPPET_INVALID_INPUT: 短语模板内容不能为空'
    }
  }
  return { valid: true }
}

export class SnippetStoreRepository {
  #items: SnippetItem[] = []

  constructor(initialItems: SnippetItem[] = []) {
    this.#items = [...initialItems]
  }

  list(): SnippetItem[] {
    return [...this.#items]
  }

  save(input: SnippetFormInput, nowMs = Date.now()): SnippetItem {
    const check = validateSnippetInput(input)
    if (!check.valid) {
      throw new Error(check.error)
    }

    const content = input.content.trim()
    const previewText = content.replace(/\s+/g, ' ').slice(0, 72)
    const category = input.category || 'general'
    const existingIdx = input.id ? this.#items.findIndex((s) => s.id === input.id) : -1

    if (existingIdx >= 0) {
      const prev = this.#items[existingIdx]!
      const updated: SnippetItem = {
        ...prev,
        title: input.title.trim(),
        category,
        categoryLabel: getSnippetCategoryLabel(category),
        keyword: input.keyword?.trim() || undefined,
        content,
        previewText,
        updatedAt: nowMs
      }
      this.#items[existingIdx] = updated
      return updated
    }

    const created: SnippetItem = {
      id: input.id || `snip-${nowMs}-${this.#items.length + 1}`,
      title: input.title.trim(),
      category,
      categoryLabel: getSnippetCategoryLabel(category),
      keyword: input.keyword?.trim() || undefined,
      content,
      previewText,
      useCount: 0,
      updatedAt: nowMs
    }
    this.#items.unshift(created)
    return created
  }

  delete(id: string): boolean {
    const before = this.#items.length
    this.#items = this.#items.filter((i) => i.id !== id)
    return this.#items.length < before
  }
}

export function expandSnippetTemplate(
  template: string,
  clipboardText = ''
): { expanded: string; cursorOffset: number } {
  const res = resolveMacroTemplate(template, clipboardText)
  return {
    expanded: res.text,
    cursorOffset: res.cursorOffsetFromEnd
  }
}

export interface SampleSnippet {
  id: string
  name: string
  title: string
  keyword: string
  snippet: string
  content: string
  category: string
  createdAt: number
  [key: string]: unknown
}

export const SAMPLE_SNIPPETS: SampleSnippet[] = [
  {
    id: 'snip-1',
    name: 'Shrug Emoji',
    title: 'Shrug Emoji',
    keyword: ':shrug',
    snippet: '¯\\_(ツ)_/¯',
    content: '¯\\_(ツ)_/¯',
    category: 'general',
    createdAt: Date.now()
  },
  {
    id: 'snip-2',
    name: 'Invoice Info',
    title: 'Invoice Info',
    keyword: ';inv',
    snippet: '发票抬头：科技有限公司',
    content: '发票抬头：科技有限公司',
    category: 'invoice',
    createdAt: Date.now()
  }
]

export function filterSnippets(
  items: Array<SampleSnippet | Record<string, unknown>> = SAMPLE_SNIPPETS,
  filter?: { query?: string } | string
): Array<SampleSnippet | Record<string, unknown>> {
  const q = (typeof filter === 'string' ? filter : filter?.query || '').trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (item) =>
      String(item.keyword || '').toLowerCase().includes(q) ||
      String(item.name || '').toLowerCase().includes(q) ||
      String(item.title || '').toLowerCase().includes(q) ||
      String(item.snippet || item.content || '').toLowerCase().includes(q)
  )
}
