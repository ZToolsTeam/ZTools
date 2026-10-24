import type { PathGrantService, PathResourceLease } from '../services/path-grant-service.js'

import { parseFileRange } from './file-byte-range.js'

const mediaTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm' }

/** Uses pinned native objects; the session owner guard must approve before entering this handler. */
export async function anchoredFileCapabilityResponse(request: Pick<Request, 'url' | 'method' | 'headers' | 'signal'>,
  grants: Pick<PathGrantService, 'openResource'>): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  let lease: PathResourceLease | undefined
  try {
    lease = await grants.openResource(request.url, request.signal)
    const selected = parseFileRange(request.method === 'HEAD' ? null : request.headers.get('range'), lease.metadata.size)
    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': mediaTypes[lease.displayName.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream' })
    if (!selected) { lease.close(); headers.set('Content-Range', `bytes */${lease.metadata.size}`); return new Response(null, { status: 416, headers }) }
    const length = Math.max(0, selected.end - selected.start + 1)
    headers.set('Content-Length', String(length))
    if (selected.partial) headers.set('Content-Range', `bytes ${selected.start}-${selected.end}/${lease.metadata.size}`)
    if (request.method === 'HEAD' || !length) { lease.close(); return new Response(null, { status: 200, headers }) }
    const resource = lease; let position = selected.start
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (resource.signal.aborted) throw new Error('RESOURCE_CLOSED')
          const count = Math.min(64 * 1024, selected.end - position + 1)
          const bytes = await resource.read(position, count)
          if (resource.signal.aborted || bytes.length !== count) throw new Error('RESOURCE_CHANGED')
          controller.enqueue(bytes); position += count
          if (position > selected.end) { resource.close(); controller.close() }
        } catch { resource.close(); controller.error(new Error('文件资源读取失败')) }
      },
      cancel() { resource.close() }
    }, { highWaterMark: 0 })
    return new Response(body, { status: selected.partial ? 206 : 200, headers })
  } catch { lease?.close(); return new Response(null, { status: 404 }) }
}
