export type CodeTargetLang = 'fetch' | 'axios' | 'python' | 'go'

export interface ParsedCurlRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  cookies?: string
  rawCommand: string
}

export interface HttpResponseSnapshot {
  ok: boolean
  status: number
  statusText: string
  elapsedMs: number
  sizeBytes: number
  truncated: boolean
  responseHeaders: Record<string, string>
  bodyText: string
}
