import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { FileSystemService } from '../services/file-system-service.js'
import { parseFileRange } from './file-byte-range.js'

export type FileCapabilityFetcher = (url: string, init: RequestInit) => Promise<Response>

export async function fileCapabilityResponse(
  request: Pick<Request, 'method' | 'url'> & Partial<Pick<Request, 'headers'>>,
  files: Pick<FileSystemService, 'resolveFileCapability'>,
  fetchFile: FileCapabilityFetcher
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const target = await files.resolveFileCapability(request.url)
    const metadata = await stat(target)
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)) throw new Error('Invalid file')
    const selected = parseFileRange(request.method === 'HEAD' ? null : request.headers?.get('range') ?? null, metadata.size)
    if (!selected) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + metadata.size } })
    const init: RequestInit = { method: request.method }
    if (selected.partial) init.headers = { Range: 'bytes=' + selected.start + '-' + selected.end }
    const response = await fetchFile(pathToFileURL(target).toString(), init)
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Cache-Control', 'no-store')
    headers.set('Referrer-Policy', 'no-referrer')
    if (response.ok) {
      headers.set('Accept-Ranges', 'bytes')
      headers.set('Content-Length', String(Math.max(0, selected.end - selected.start + 1)))
      if (selected.partial) headers.set('Content-Range', 'bytes ' + selected.start + '-' + selected.end + '/' + metadata.size)
    }
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.ok && selected.partial ? 206 : response.status,
      statusText: response.ok && selected.partial ? 'Partial Content' : response.statusText,
      headers
    })
  } catch {
    return new Response('Not Found', { status: 404 })
  }
}
