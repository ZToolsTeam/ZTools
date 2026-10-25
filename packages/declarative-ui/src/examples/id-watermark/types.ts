export interface WatermarkOptions {
  text: string
  opacityPercent: number
  fontSizePx?: number
  rotateDegree: number
  gapPx: number
  colorMode: 'auto' | 'dark' | 'light'
}

export interface ImageMetadata {
  fileName: string
  width: number
  height: number
  mimeType?: string
}

export interface PresetTemplate {
  id: string
  label: string
  scenarioTag: string
  rawText: string
  resolvedText: string
}

export interface WatermarkRenderResult {
  width: number
  height: number
  mimeType: 'image/jpeg' | 'image/png'
  tileCount: number
  effectiveFontSizePx: number
  effectiveGapPx: number
  wrappedLines: string[]
  svgOverlay: string
  blob: Blob
}
