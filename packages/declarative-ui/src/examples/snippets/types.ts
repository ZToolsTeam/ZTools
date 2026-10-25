export type SnippetCategory =
  | 'invoice'
  | 'address'
  | 'customer_service'
  | 'code'
  | 'general'

export interface SnippetItem {
  id: string
  title: string
  category: SnippetCategory
  categoryLabel: string
  keyword?: string
  content: string
  previewText: string
  useCount: number
  updatedAt: number
}

export interface MacroResolveResult {
  text: string
  cursorOffsetFromEnd: number
}

export interface SnippetFormInput {
  id?: string
  title: string
  category: SnippetCategory
  keyword?: string
  content: string
}
