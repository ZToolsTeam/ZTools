export type StackPopMode = 'fifo' | 'lifo'

export interface StackItem {
  id: string
  text: string
  textPreview: string
  charCount: number
  timestamp: number
  timeAgo: string
  sourceApp?: string
}

export interface PopAndPasteResult {
  ok: boolean
  popped?: StackItem
  remainingCount: number
  errorCode?: string
  error?: string
}
