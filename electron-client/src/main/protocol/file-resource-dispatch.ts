/** Select only from Main-owned token stores. A failed selected route never falls through. */
export interface FileResourceClaim { claimsUrl(url: string): boolean }

export function selectFileResourceRoute(url: string, legacy: FileResourceClaim, reference?: FileResourceClaim):
  'legacy' | 'reference' | 'deny' {
  try {
    const old = legacy.claimsUrl(url), current = reference?.claimsUrl(url) ?? false
    if (old === current) return 'deny'
    return old ? 'legacy' : 'reference'
  } catch { return 'deny' }
}

export async function dispatchFileResourceResponse(request: Request, legacy: FileResourceClaim & {
  respond(request: Request): Promise<Response>
}, reference?: FileResourceClaim & { respond(request: Request): Promise<Response> }): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
  const route = selectFileResourceRoute(request.url, legacy, reference)
  try {
    if (route === 'legacy') return await legacy.respond(request)
    if (route === 'reference' && reference) return await reference.respond(request)
  } catch { /* Do not retry another authorization domain. */ }
  return new Response(null, { status: 404 })
}
