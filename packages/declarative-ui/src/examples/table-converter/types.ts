export type InferredColumnType = 'number' | 'boolean' | 'string' | 'null'
export type DetectedSourceFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'html' | 'empty'

export interface TableGrid {
  headers: string[]
  rows: string[][]
  inferredTypes: InferredColumnType[]
}

export interface TableConversionTarget {
  id: 'markdown' | 'json' | 'sql' | 'html' | 'csv'
  title: string
  subtitle: string
  badge: string
  language: string
  fullText: string
  previewText: string
  typeSummary: string
}
