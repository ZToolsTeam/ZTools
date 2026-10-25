export type QuicklinkCategory = 'search' | 'direct' | 'group'

export interface QuicklinkItem {
  id: string
  title: string
  alias?: string
  urlPattern: string
  isGroup: boolean
  urls?: string[]
  category: QuicklinkCategory
  description?: string
  createdAt: number
}

export interface Quicklink {
  id: string
  title: string
  link: string
  keyword?: string
  alias?: string
  urlPattern?: string
  isGroup?: boolean
  urls?: string[]
  category?: QuicklinkCategory
  description?: string
  icon?: string
  defaultArgument?: string
  openCount?: number
  createdAt: number
  updatedAt: number
}

export interface QuicklinkInput {
  title: string
  link: string
  keyword?: string
  description?: string
  defaultArgument?: string
  icon?: string
  isGroup?: boolean
  urls?: string[]
}

export interface QuicklinkResolved {
  url: string
  hasQuery: boolean
  queryParam?: string
  needsArgument?: boolean
}
