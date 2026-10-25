export type StylePreset = 'official' | 'business' | 'academic'
export type DocFontSize = 'size-3' | 'size-s4' | 'size-5'

export interface DocElement {
  id: string
  type: 'heading' | 'table' | 'code' | 'paragraph' | 'list'
  typeLabel: string
  title: string
  preview: string
  rawContent: string
  extraInfo: string
  headingLevel?: number
  tableRows?: string[][]
  codeLanguage?: string
}

export interface DocMetadata {
  title: string
  wordCount: number
  headingsCount: number
  tablesCount: number
  codeBlocksCount: number
  paragraphsCount: number
}

export interface ConvertOptions {
  preset: StylePreset
  fontSize: DocFontSize
  firstLineIndent: boolean
}
