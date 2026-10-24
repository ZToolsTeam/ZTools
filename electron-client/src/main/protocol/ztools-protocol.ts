import { net, protocol, type Protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveSafeFile } from './safe-path.js'
import { fileCapabilityResponse } from './file-capability.js'
import { dispatchFileResourceResponse } from './file-resource-dispatch.js'
import type { FileSystemService } from '../services/file-system-service.js'
import type { ReferenceFileResources } from './reference-file-resources.js'

export { resolveSafeFile } from './safe-path.js'

export type ResourceRoot = string | (() => string)

export interface ZToolsProtocolRoots {
  plugins?: string
  web: ResourceRoot
  cache: string
  temp: string
}

export interface PluginZToolsProtocolRoots extends ZToolsProtocolRoots {
  plugin: string
}

type ProtocolTarget = Pick<Protocol, 'handle'>

function resolveResourceRoot(root: ResourceRoot): string {
  return typeof root === 'function' ? root() : root
}

export function registerZToolsScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ztools',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

function requireLocalUrl(requestUrl: string, host: string): URL {
  const url = new URL(requestUrl)
  if (
    url.protocol !== 'ztools:' ||
    url.hostname.toLowerCase() !== host ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    throw new Error('本地资源 URL 无效')
  }
  return url
}

function stripFirstPathSegment(encodedPath: string, expected: string): string {
  const segments = encodedPath.split('/')
  const encodedFirst = segments[0] === '' ? segments[1] : segments[0]
  const remainderIndex = segments[0] === '' ? 2 : 1
  if (!encodedFirst || decodeURIComponent(encodedFirst) !== expected) {
    throw new Error('资源不属于当前作用域')
  }
  return `/${segments.slice(remainderIndex).join('/')}`
}

export function pluginResourcePath(requestUrl: string, pluginId: string): string {
  return stripFirstPathSegment(
    requireLocalUrl(requestUrl, 'plugins').pathname,
    pluginId
  )
}

function sharedSdkPath(requestUrl: string): string {
  return stripFirstPathSegment(requireLocalUrl(requestUrl, 'web').pathname, 'sdk')
}

function withResourceHeaders(response: Response, corsOrigin: string): Headers {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', corsOrigin)
  headers.set('Cache-Control', 'no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  return headers
}

async function rootedFileResponse(
  request: Request,
  root: string,
  encodedPath: string,
  corsOrigin: string
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const target = await resolveSafeFile(root, encodedPath)
  const response = await net.fetch(pathToFileURL(target).toString(), { method: request.method })
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withResourceHeaders(response, corsOrigin)
  })
}

export function installZToolsProtocol(
  roots: ZToolsProtocolRoots,
  files: FileSystemService,
  referencesOrProtocol?: ReferenceFileResources | ProtocolTarget,
  explicitProtocol: ProtocolTarget = protocol
): void {
  const references = referencesOrProtocol && !('handle' in referencesOrProtocol) ? referencesOrProtocol : undefined
  const targetProtocol = referencesOrProtocol && 'handle' in referencesOrProtocol ? referencesOrProtocol : explicitProtocol
  targetProtocol.handle('ztools', async (request) => {
    try {
      const url = new URL(request.url)
      switch (url.host.toLowerCase()) {
        case 'web': {
          requireLocalUrl(request.url, 'web')
          const target = await resolveSafeFile(resolveResourceRoot(roots.web), url.pathname)
          return net.fetch(pathToFileURL(target).toString())
        }
        case 'plugins': {
          if (!roots.plugins) {
            return new Response('Not Found', { status: 404 })
          }
          requireLocalUrl(request.url, 'plugins')
          return await rootedFileResponse(
            request,
            resolveResourceRoot(roots.plugins),
            url.pathname,
            'ztools://web'
          )
        }
        case 'cache':
          requireLocalUrl(request.url, 'cache')
          return await rootedFileResponse(request, roots.cache, url.pathname, 'ztools://web')
        case 'temp':
          requireLocalUrl(request.url, 'temp')
          return await rootedFileResponse(request, roots.temp, url.pathname, 'ztools://web')
        case 'file':
          return await dispatchFileResourceResponse(request, {
            claimsUrl: url => files.claimsFileCapabilityUrl(url),
            respond: incoming => fileCapabilityResponse(incoming, files, (url, init) => net.fetch(url, init))
          }, references)
        default:
          return new Response('Not Found', { status: 404 })
      }
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}

export function installPluginZToolsProtocol(
  roots: PluginZToolsProtocolRoots,
  files: FileSystemService,
  pluginId: string,
  targetProtocol: ProtocolTarget,
  references?: ReferenceFileResources
): void {
  targetProtocol.handle('ztools', async (request) => {
    try {
      const url = new URL(request.url)
      switch (url.host.toLowerCase()) {
        case 'plugins':
          return await rootedFileResponse(
            request,
            roots.plugin,
            pluginResourcePath(request.url, pluginId),
            'ztools://plugins'
          )
        case 'web':
          return await rootedFileResponse(
            request,
            path.join(resolveResourceRoot(roots.web), 'sdk'),
            sharedSdkPath(request.url),
            'ztools://plugins'
          )
        case 'cache':
          requireLocalUrl(request.url, 'cache')
          return await rootedFileResponse(request, roots.cache, url.pathname, 'ztools://plugins')
        case 'temp':
          requireLocalUrl(request.url, 'temp')
          return await rootedFileResponse(request, roots.temp, url.pathname, 'ztools://plugins')
        case 'file':
          return await dispatchFileResourceResponse(request, {
            claimsUrl: url => files.claimsFileCapabilityUrl(url),
            respond: incoming => fileCapabilityResponse(incoming, files, (url, init) => net.fetch(url, init))
          }, references)
        default:
          return new Response('Not Found', { status: 404 })
      }
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
