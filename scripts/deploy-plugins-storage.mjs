#!/usr/bin/env node

/**
 * deploy-plugins-storage.mjs
 * 把插件发布产物上传到阿里云 OSS，并刷新阿里云 CDN 上的插件目录缓存。
 *
 * 线上实际使用：阿里云 OSS 存储桶 ztools-data，目录 plugins-v2/，经阿里云 CDN 域名 cdn.ztools.cn 分发。
 * 1. 先上传插件包与图标（带版本号，长缓存），最后上传插件目录 catalog.json / plugins.json（短缓存），
 *    保证目录里引用的安装包一定已经在线；
 * 2. 刷新 CDN 上插件目录的缓存，让更新与下架尽快生效；
 * 3. 支持 --dry-run 演练模式；非演练模式缺少凭证时直接报错，不会假装成功。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

/**
 * 极简零依赖 .env 文件解析器：本地手动发布时可把 OSS 凭据写在仓库根目录 .env（已被 .gitignore 忽略），
 * CI 里直接用环境变量，不需要这个文件
 */
export function loadEnvFile(envPath) {
  const target = envPath || path.join(rootDir, '.env')
  if (!fs.existsSync(target)) return {}
  const content = fs.readFileSync(target, 'utf8')
  const env = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[key] = val
    if (typeof process.env[key] === 'undefined') {
      process.env[key] = val
    }
  }
  return env
}

// 自动预加载本地环境变量
loadEnvFile()

// 线上实际配置：阿里云 OSS 存储桶 ztools-data 的 plugins-v2/ 目录，经 cdn.ztools.cn 分发
export const DEFAULT_CDN_BASE_URL = 'https://cdn.ztools.cn'
export const DEFAULT_OSS_BUCKET = 'ztools-data'
export const DEFAULT_OSS_REGION = 'oss-cn-shenzhen'
export const DEFAULT_OSS_PREFIX = 'plugins-v2'

function normalizePrefix(prefix) {
  return String(prefix || '').replace(/^\/+|\/+$/g, '')
}

function encodeOssPath(objectPath) {
  return objectPath.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

/**
 * 阿里云 OSS 签名生成工具 (HMAC-SHA1 REST API 标准，零外部依赖)
 */
export function createOssHeaders({
  method,
  bucket,
  objectKey,
  accessKeyId,
  accessKeySecret,
  contentType = 'application/octet-stream',
  contentLength = 0,
  cacheControl,
  extraHeaders = {}
}) {
  const date = new Date().toUTCString()
  const cleanKey = objectKey.replace(/^\/+/, '')
  const canonicalResource = `/${bucket}/${cleanKey}`

  const allHeaders = {
    Date: date,
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    ...extraHeaders
  }

  if (cacheControl) {
    allHeaders['Cache-Control'] = cacheControl
  }

  const ossHeaders = {}
  for (const [k, v] of Object.entries(allHeaders)) {
    if (k.toLowerCase().startsWith('x-oss-')) {
      ossHeaders[k.toLowerCase()] = String(v).trim()
    }
  }
  const sortedOssKeys = Object.keys(ossHeaders).sort()
  const canonicalOssHeaders = sortedOssKeys.map(k => `${k}:${ossHeaders[k]}\n`).join('')

  const stringToSign = [
    method.toUpperCase(),
    '', // Content-MD5 (可选)
    contentType,
    date,
    canonicalOssHeaders + canonicalResource
  ].join('\n')

  const signature = crypto.createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64')
  allHeaders['Authorization'] = `OSS ${accessKeyId}:${signature}`

  return allHeaders
}

/**
 * 收集待上传的发布文件列表
 */
function collectReleaseFiles(distDir) {
  const files = []

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const relPath = path.relative(distDir, fullPath).replace(/\\/g, '/')
        files.push({
          relPath,
          fullPath,
          size: fs.statSync(fullPath).size
        })
      }
    }
  }

  walk(distDir)
  return files
}

/**
 * 获取对应文件的 MIME 类型
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.json': return 'application/json; charset=utf-8'
    case '.zip': return 'application/zip'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    default: return 'application/octet-stream'
  }
}

/**
 * 根据文件类型固化静态分发缓存策略
 * 1. 带版本号的发布包 (*.zip): 强缓存 30 天 (2592000s) + immutable
 * 2. 插件目录 catalog.json / plugins.json: 短缓存 5 分钟 (300s)，确保更新与下架尽快生效
 * 3. 其它静态资源 (如 icon 图标): 默认 7 天
 */
export function getCacheControl(relPath) {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith('.zip')) {
    return 'public, max-age=2592000, immutable'
  }
  if (normalized.endsWith('plugins.json') || normalized.endsWith('.json')) {
    return 'public, max-age=300'
  }
  return 'public, max-age=604800'
}

/**
 * 发送 HTTP/S 请求 (支持 Promise)
 */
function makeHttpRequest(options, body) {
  const { protocol = 'https:', ...requestOptions } = options
  const client = protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data
        })
      })
    })

    req.on('error', (err) => reject(err))
    if (body) {
      req.write(body)
    }
    req.end()
  })
}

/**
 * 上传文件至阿里云 OSS
 */
export async function uploadToOss({
  file,
  accessKeyId,
  accessKeySecret,
  bucket,
  region,
  prefix = DEFAULT_OSS_PREFIX,
  endpoint,
  dryRun = false
}) {
  // endpoint 仅供测试指向本地模拟服务，例如 http://127.0.0.1:8080
  const target = endpoint ? new URL(endpoint) : null
  const host = target ? target.host : `${bucket}.${region}.aliyuncs.com`
  const cleanPrefix = normalizePrefix(prefix)
  const objectKey = cleanPrefix ? `${cleanPrefix}/${file.relPath}` : file.relPath
  const canonicalUri = `/${objectKey}`
  const fileBuffer = fs.readFileSync(file.fullPath)
  const contentType = getMimeType(file.relPath)
  const cacheControl = getCacheControl(file.relPath)

  if (dryRun) {
    console.log(`   [OSS 仿真] PUT https://${host}${canonicalUri} (${(file.size / 1024).toFixed(2)} KB, ${contentType}, Cache-Control: ${cacheControl})`)
    return { success: true, simulated: true }
  }

  const headers = createOssHeaders({
    method: 'PUT',
    bucket,
    objectKey,
    accessKeyId,
    accessKeySecret,
    contentType,
    contentLength: file.size,
    cacheControl
  })

  const res = await makeHttpRequest({
    protocol: target ? target.protocol : 'https:',
    method: 'PUT',
    hostname: target ? target.hostname : host,
    port: target ? target.port : undefined,
    path: encodeOssPath(canonicalUri),
    headers
  }, fileBuffer)

  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { success: true, statusCode: res.statusCode }
  } else {
    throw new Error(`OSS 上传失败 [HTTP ${res.statusCode}]: ${res.data}`)
  }
}

/**
 * 从阿里云 OSS 读取对象（直接读源站，不经过 CDN 缓存）；对象不存在时返回 null
 */
export async function readOssObject({ objectKey, accessKeyId, accessKeySecret, bucket, region, endpoint }) {
  const target = endpoint ? new URL(endpoint) : null
  const host = target ? target.host : `${bucket}.${region}.aliyuncs.com`
  const headers = createOssHeaders({ method: 'GET', bucket, objectKey, accessKeyId, accessKeySecret })
  const res = await makeHttpRequest({
    protocol: target ? target.protocol : 'https:',
    method: 'GET',
    hostname: target ? target.hostname : host,
    port: target ? target.port : undefined,
    path: encodeOssPath(`/${objectKey}`),
    headers
  })
  if (res.statusCode === 404) return null
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`OSS 读取失败 [HTTP ${res.statusCode}]: ${res.data}`)
  }
  return res.data
}

function catalogEntries(catalog) {
  const list = catalog?.plugins || catalog?.list
  return Array.isArray(list) ? list : []
}

/**
 * 找出「同一个下载地址、内容却变了」的安装包。
 * 安装包按带版本号的文件名强缓存 30 天，改了代码没升版本号时 CDN 仍会返回旧包，
 * 客户端校验 SHA-256 不通过就装不上，所以这些地址必须刷新。
 * 读不到上一版目录（previousCatalog 为 null）时无法判断，保守地全部刷新。
 */
export function findChangedPackageUrls(nextCatalog, previousCatalog, cdnBaseUrl) {
  const urls = catalogEntries(nextCatalog)
    .map((p) => ({ url: String(p?.downloadUrl || ''), sha256: String(p?.sha256 || '') }))
    .filter((p) => p.url.startsWith(`${cdnBaseUrl}/`))
  if (!previousCatalog) return urls.map((p) => p.url)
  const before = new Map(catalogEntries(previousCatalog).map((p) => [String(p?.downloadUrl || ''), String(p?.sha256 || '')]))
  return urls.filter((p) => before.has(p.url) && before.get(p.url) !== p.sha256).map((p) => p.url)
}

/**
 * 阿里云 RPC 接口要求的百分号编码（RFC 3986，空格编为 %20，! ' ( ) * 也要编码）
 */
export function aliyunPercentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  )
}

/**
 * 生成阿里云 RPC 风格接口（如 CDN）的签名查询串（SignatureVersion 1.0，HMAC-SHA1）
 */
export function signAliyunRpcQuery(params, accessKeySecret, method = 'GET') {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${aliyunPercentEncode(k)}=${aliyunPercentEncode(params[k])}`)
    .join('&')
  const stringToSign = `${method}&${aliyunPercentEncode('/')}&${aliyunPercentEncode(canonical)}`
  const signature = crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64')
  return `${canonical}&Signature=${aliyunPercentEncode(signature)}`
}

/**
 * 刷新阿里云 CDN 上指定文件的缓存（RefreshObjectCaches）
 */
export async function refreshAliyunCdnCache({
  accessKeyId,
  accessKeySecret,
  urls = [],
  endpoint,
  dryRun = false
}) {
  if (urls.length === 0) return { success: true, skipped: true }
  if (dryRun) {
    for (const url of urls) {
      console.log(`   [CDN 仿真刷新] ${url}`)
    }
    return { success: true, simulated: true }
  }

  const params = {
    Action: 'RefreshObjectCaches',
    Version: '2018-05-10',
    Format: 'JSON',
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ObjectPath: urls.join('\n'),
    ObjectType: 'File'
  }
  const target = new URL(endpoint || 'https://cdn.aliyuncs.com')
  const res = await makeHttpRequest({
    protocol: target.protocol,
    method: 'GET',
    hostname: target.hostname,
    port: target.port || undefined,
    path: `/?${signAliyunRpcQuery(params, accessKeySecret)}`
  })

  let body = null
  try {
    body = JSON.parse(res.data)
  } catch {
    // 非 JSON 响应按失败处理
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || !body || body.Code) {
    const reason = body?.Message || body?.Code || res.data || `HTTP ${res.statusCode}`
    throw new Error(`阿里云 CDN 缓存刷新失败 [HTTP ${res.statusCode}]: ${reason}`)
  }
  return { success: true, refreshTaskId: body.RefreshTaskId || null }
}

/**
 * 插件目录文件（catalog.json / plugins.json）必须最后上传，避免目录先引用到还没上传的安装包
 */
function isIndexFile(relPath) {
  return relPath.toLowerCase().endsWith('.json')
}

/**
 * 核心部署流程
 */
export async function deployPluginsStorage(options = {}) {
  const distDir = path.resolve(options.dir || path.join(rootDir, 'dist/plugins'))
  const dryRun = !!options.dryRun
  const cdnBaseUrl = (options.cdnBaseUrl || process.env.CDN_BASE_URL || DEFAULT_CDN_BASE_URL).replace(/\/$/, '')
  const prefix = normalizePrefix(options.ossPrefix ?? process.env.OSS_PREFIX ?? DEFAULT_OSS_PREFIX)

  console.log('☁️  开始上传插件发布产物到阿里云 OSS')
  console.log(`📂 本地产物目录: ${distDir}`)
  console.log(`🚀 运行模式: ${dryRun ? '演练模式 (--dry-run)' : '正式上传'}`)

  if (!fs.existsSync(distDir)) {
    throw new Error(`发布产物目录不存在: ${distDir}`)
  }

  const files = collectReleaseFiles(distDir)
  if (files.length === 0) {
    console.warn(`⚠️ 目录 ${distDir} 为空，没有可上传的文件！`)
    return { success: true, uploadedCount: 0 }
  }

  const ossConfig = {
    accessKeyId: options.ossAccessKeyId || process.env.OSS_ACCESS_KEY_ID || (dryRun ? 'simulated_oss_key' : null),
    accessKeySecret: options.ossAccessKeySecret || process.env.OSS_ACCESS_KEY_SECRET || (dryRun ? 'simulated_oss_secret' : null),
    bucket: options.ossBucket || process.env.OSS_BUCKET || DEFAULT_OSS_BUCKET,
    region: options.ossRegion || process.env.OSS_REGION || DEFAULT_OSS_REGION,
    endpoint: options.ossEndpoint
  }
  if (!ossConfig.accessKeyId || !ossConfig.accessKeySecret) {
    throw new Error('缺少阿里云 OSS 凭证 (OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET)，已停止上传。仅想演练请加 --dry-run')
  }

  const cdnConfig = {
    accessKeyId: options.cdnAccessKeyId || process.env.CDN_ACCESS_KEY_ID || ossConfig.accessKeyId,
    accessKeySecret: options.cdnAccessKeySecret || process.env.CDN_ACCESS_KEY_SECRET || ossConfig.accessKeySecret
  }
  const packages = files.filter((f) => !isIndexFile(f.relPath))
  const indexes = files.filter((f) => isIndexFile(f.relPath))

  // 上传前先从源站读出线上正在用的目录，用来判断哪些安装包内容变了
  let previousCatalog
  if (options.previousCatalog !== undefined) {
    previousCatalog = options.previousCatalog
  } else if (dryRun) {
    previousCatalog = null
  } else {
    try {
      const raw = await readOssObject({ ...ossConfig, objectKey: prefix ? `${prefix}/catalog.json` : 'catalog.json' })
      previousCatalog = raw ? JSON.parse(raw) : null
    } catch (err) {
      console.warn(`⚠️ 读取线上插件目录失败，将刷新全部安装包的 CDN 缓存: ${err.message}`)
      previousCatalog = null
    }
  }
  const nextCatalogFile = indexes.find((f) => f.relPath === 'catalog.json')
  const nextCatalog = nextCatalogFile ? JSON.parse(fs.readFileSync(nextCatalogFile.fullPath, 'utf8')) : null
  const changedPackageUrls = findChangedPackageUrls(nextCatalog, previousCatalog, cdnBaseUrl)

  // 顺序：安装包与图标 → 刷新内容变了的安装包 → 插件目录 → 刷新插件目录
  console.log(`\n📤 上传到 OSS 存储桶 ${ossConfig.bucket} (${ossConfig.region})，目录 ${prefix || '/'}，共 ${files.length} 个文件`)
  for (const file of packages) {
    await uploadToOss({ file, ...ossConfig, prefix, dryRun })
  }

  const refreshTaskIds = []
  if (changedPackageUrls.length > 0) {
    console.log(`\n🔄 刷新内容有变化的安装包缓存（${changedPackageUrls.length} 个${previousCatalog ? '' : '，读不到上一版目录，全部刷新'}）`)
    // 阿里云单次最多提交 100 个地址
    for (let i = 0; i < changedPackageUrls.length; i += 100) {
      const r = await refreshAliyunCdnCache({ ...cdnConfig, urls: changedPackageUrls.slice(i, i + 100), endpoint: options.cdnEndpoint, dryRun })
      if (r.refreshTaskId) refreshTaskIds.push(r.refreshTaskId)
    }
  }

  for (const file of indexes) {
    await uploadToOss({ file, ...ossConfig, prefix, dryRun })
  }
  console.log('✅ OSS 上传完成')

  const indexUrls = indexes.map((f) => `${cdnBaseUrl}/${prefix ? prefix + '/' : ''}${f.relPath}`)
  console.log(`\n🔄 刷新阿里云 CDN 上的插件目录缓存（${indexUrls.length} 个文件）`)
  const refresh = await refreshAliyunCdnCache({
    ...cdnConfig,
    urls: indexUrls,
    endpoint: options.cdnEndpoint,
    dryRun
  })
  if (refresh.refreshTaskId) refreshTaskIds.push(refresh.refreshTaskId)
  console.log(`✅ CDN 刷新已提交${refreshTaskIds.length ? `，任务 ID: ${refreshTaskIds.join(', ')}` : ''}`)
  const refreshUrls = [...changedPackageUrls, ...indexUrls]
  const ordered = [...packages, ...indexes]

  return {
    success: true,
    filesCount: files.length,
    uploadedKeys: ordered.map((f) => (prefix ? `${prefix}/${f.relPath}` : f.relPath)),
    refreshedUrls: refreshUrls,
    changedPackageUrls,
    dryRun
  }
}

async function runCli() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法:
  node scripts/deploy-plugins-storage.mjs [选项]

选项:
  --dir <path>          待上传的产物目录 (默认: dist/plugins)
  --cdn-base-url <url>  CDN 域名 (默认: ${DEFAULT_CDN_BASE_URL})
  --oss-prefix <dir>    OSS 目录 (默认: ${DEFAULT_OSS_PREFIX})
  --dry-run             演练模式，只打印计划，不发起任何网络请求
  --help, -h            显示帮助信息

环境变量:
  OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET  阿里云 OSS 凭证（必填）
  OSS_BUCKET (默认 ${DEFAULT_OSS_BUCKET}), OSS_REGION (默认 ${DEFAULT_OSS_REGION}), OSS_PREFIX
  CDN_ACCESS_KEY_ID, CDN_ACCESS_KEY_SECRET  阿里云 CDN 刷新凭证（不填则沿用 OSS 凭证）
    `.trim())
    process.exit(0)
  }

  function getArg(flag, fallback) {
    const idx = args.indexOf(flag)
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
    return fallback
  }

  await deployPluginsStorage({
    dir: getArg('--dir', path.join(rootDir, 'dist/plugins')),
    cdnBaseUrl: getArg('--cdn-base-url', process.env.CDN_BASE_URL || DEFAULT_CDN_BASE_URL),
    ossPrefix: getArg('--oss-prefix', process.env.OSS_PREFIX ?? DEFAULT_OSS_PREFIX),
    dryRun: args.includes('--dry-run')
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch(err => {
    console.error('部署执行异常:', err)
    process.exit(1)
  })
}
