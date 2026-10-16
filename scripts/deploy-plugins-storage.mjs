#!/usr/bin/env node

/**
 * deploy-plugins-storage.mjs
 * ZTools GitOps 对象存储部署与 EdgeOne CDN 缓存预热脚本
 *
 * 功能：
 * 1. 同步全网静态索引 plugins.json 与插件包 (*.zip) 至腾讯云 COS (国内主力分发源)；
 * 2. 同步镜像至 Cloudflare R2 (海外与多云灾备源，零出网流量费)；
 * 3. 触发腾讯云 EdgeOne 边缘 CDN 全网节点缓存刷新与预热，确保终端秒级生效；
 * 4. 支持 --dry-run 仿真测试模式与无外部依赖的原生 AWS SigV4 认证协议。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

/**
 * 极简零依赖 .env 文件解析器（自动从 backend/.env 补充环境变量）
 */
export function loadEnvFile(envPath) {
  const target = envPath || path.join(rootDir, 'backend', '.env')
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
 * AWS Signature Version 4 签名生成工具（兼容腾讯云 COS S3 协议与 Cloudflare R2）
 */
function createAwsV4Headers({
  method,
  host,
  canonicalUri,
  payload,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  extraHeaders = {}
}) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.substring(0, 8)

  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex')

  const headers = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...extraHeaders
  }

  const sortedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort()
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k].trim()}\n`).join('')
  const signedHeaders = sortedHeaderKeys.join(';')

  const canonicalRequest = [
    method,
    canonicalUri,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n')

  function hmac(key, string) {
    return crypto.createHmac('sha256', key).update(string).digest()
  }

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    ...headers,
    Authorization: authorization
  }
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
 * 2. 全网静态索引 plugins.json: 短缓存 5 分钟 (300s)，确保下架或更新秒级生效
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
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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
 * 上传文件至腾讯云 COS
 */
async function uploadToCos({
  file,
  secretId,
  secretKey,
  bucket,
  region,
  dryRun = false
}) {
  const host = `${bucket}.cos.${region}.myqcloud.com`
  const canonicalUri = '/' + file.relPath
  const fileBuffer = fs.readFileSync(file.fullPath)
  const contentType = getMimeType(file.relPath)
  const cacheControl = getCacheControl(file.relPath)

  if (dryRun) {
    console.log(`   [COS 仿真] PUT https://${host}${canonicalUri} (${(file.size / 1024).toFixed(2)} KB, ${contentType}, Cache-Control: ${cacheControl})`)
    return { success: true, simulated: true }
  }

  const headers = createAwsV4Headers({
    method: 'PUT',
    host,
    canonicalUri,
    payload: fileBuffer,
    accessKeyId: secretId,
    secretAccessKey: secretKey,
    region,
    service: 's3',
    extraHeaders: {
      'content-type': contentType,
      'content-length': String(file.size),
      'cache-control': cacheControl
    }
  })

  const res = await makeHttpRequest({
    method: 'PUT',
    host,
    path: canonicalUri,
    headers
  }, fileBuffer)

  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { success: true, statusCode: res.statusCode }
  } else {
    throw new Error(`COS 上传失败 [HTTP ${res.statusCode}]: ${res.data}`)
  }
}

/**
 * 上传文件至 Cloudflare R2
 */
async function uploadToR2({
  file,
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  dryRun = false
}) {
  const host = `${accountId}.r2.cloudflarestorage.com`
  const canonicalUri = `/${bucket}/${file.relPath}`
  const fileBuffer = fs.readFileSync(file.fullPath)
  const contentType = getMimeType(file.relPath)
  const cacheControl = getCacheControl(file.relPath)

  if (dryRun) {
    console.log(`   [R2 仿真] PUT https://${host}${canonicalUri} (${(file.size / 1024).toFixed(2)} KB, ${contentType}, Cache-Control: ${cacheControl})`)
    return { success: true, simulated: true }
  }

  const headers = createAwsV4Headers({
    method: 'PUT',
    host,
    canonicalUri,
    payload: fileBuffer,
    accessKeyId,
    secretAccessKey,
    region: 'auto',
    service: 's3',
    extraHeaders: {
      'content-type': contentType,
      'content-length': String(file.size),
      'cache-control': cacheControl
    }
  })

  const res = await makeHttpRequest({
    method: 'PUT',
    host,
    path: canonicalUri,
    headers
  }, fileBuffer)

  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { success: true, statusCode: res.statusCode }
  } else {
    throw new Error(`R2 上传失败 [HTTP ${res.statusCode}]: ${res.data}`)
  }
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
  prefix = 'plugins/',
  dryRun = false
}) {
  const host = `${bucket}.${region}.aliyuncs.com`
  const cleanPrefix = prefix ? prefix.replace(/^\/+/, '').replace(/\/+$/, '') : ''
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
    method: 'PUT',
    host,
    path: canonicalUri,
    headers
  }, fileBuffer)

  if (res.statusCode >= 200 && res.statusCode < 300) {
    return { success: true, statusCode: res.statusCode }
  } else {
    throw new Error(`OSS 上传失败 [HTTP ${res.statusCode}]: ${res.data}`)
  }
}

/**
 * 刷新腾讯云 EdgeOne 边缘 CDN 缓存
 */
async function purgeEdgeOneCache({
  secretId,
  secretKey,
  zoneId,
  urls = [],
  dryRun = false
}) {
  console.log('\n🌐 正在触发腾讯云 EdgeOne 边缘节点缓存刷新...')
  console.log(`   刷新目标 URL 数量: ${urls.length}`)

  if (dryRun) {
    for (const url of urls) {
      console.log(`   [EdgeOne 仿真刷新] URL: ${url}`)
    }
    return { success: true, simulated: true }
  }

  // 腾讯云 API 3.0 调用准备 (EdgeOne PurgeUrlsCache)
  // 此处实现标准腾讯云 TC3-HMAC-SHA256 签名调用
  const endpoint = 'edgeone.tencentcloudapi.com'
  const service = 'edgeone'
  const action = 'PurgeUrlsCache'
  const version = '2022-09-01'
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

  const payload = JSON.stringify({
    ZoneId: zoneId,
    Type: 'purge_all',
    Urls: urls
  })

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${endpoint}\n`
  const signedHeaders = 'content-type;host'
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`

  const credentialScope = `${date}/${service}/tc3_request`
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`

  function tc3Hmac(key, str) {
    return crypto.createHmac('sha256', key).update(str).digest()
  }

  const secretDate = tc3Hmac('TC3' + secretKey, date)
  const secretService = tc3Hmac(secretDate, service)
  const secretSigning = tc3Hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await makeHttpRequest({
    method: 'POST',
    host: endpoint,
    path: '/',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: endpoint,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version
    }
  }, payload)

  const resultData = JSON.parse(res.data)
  if (resultData.Response?.Error) {
    throw new Error(`EdgeOne CDN 刷新失败: ${resultData.Response.Error.Message}`)
  }

  console.log(`✅ EdgeOne 边缘 CDN 缓存刷新请求已成功提交！JobID: ${resultData.Response?.JobId || 'OK'}`)
  return { success: true, response: resultData }
}

/**
 * 核心部署流程控制
 */
export async function deployPluginsStorage(options = {}) {
  const distDir = path.resolve(options.dir || path.join(rootDir, 'dist/plugins'))
  const dryRun = !!options.dryRun
  const cdnBaseUrl = (options.cdnBaseUrl || process.env.CDN_BASE_URL || 'https://plugins.ztools.cn').replace(/\/$/, '')

  console.log('☁️  开始执行 ZTools GitOps 对象存储与 CDN 部署流程...')
  console.log(`📂 本地资源目录: ${distDir}`)
  console.log(`🚀 运行模式: ${dryRun ? '仿真演练模式 (--dry-run)' : '生产同步模式'}`)

  if (!fs.existsSync(distDir)) {
    throw new Error(`发布产物目录不存在: ${distDir}`)
  }

  const files = collectReleaseFiles(distDir)
  if (files.length === 0) {
    console.warn(`⚠️ 目录 ${distDir} 为空，没有可上传的文件！`)
    return { success: true, uploadedCount: 0 }
  }

  console.log(`📦 扫描到待分发产物 ${files.length} 个文件:\n`)
  for (const f of files) {
    console.log(`   - ${f.relPath} (${(f.size / 1024).toFixed(2)} KB)`)
  }

  // 1. 同步至腾讯云 COS (国内 EdgeOne 源站)
  const cosConfig = {
    secretId: options.cosSecretId || process.env.TENCENT_COS_SECRET_ID || (dryRun ? 'simulated_secret_id' : null),
    secretKey: options.cosSecretKey || process.env.TENCENT_COS_SECRET_KEY || (dryRun ? 'simulated_secret_key' : null),
    bucket: options.cosBucket || process.env.TENCENT_COS_BUCKET || 'ztools-plugins-1250000000',
    region: options.cosRegion || process.env.TENCENT_COS_REGION || 'ap-guangzhou'
  }

  const hasCosConfig = cosConfig.secretId && cosConfig.secretKey
  if (hasCosConfig) {
    console.log(`\n📤 [1/4] 开始同步至腾讯云 COS 存储桶: ${cosConfig.bucket} (${cosConfig.region})...`)
    for (const file of files) {
      await uploadToCos({
        file,
        secretId: cosConfig.secretId,
        secretKey: cosConfig.secretKey,
        bucket: cosConfig.bucket,
        region: cosConfig.region,
        dryRun
      })
    }
    console.log('✅ 腾讯云 COS 对象存储全量同步完成！')
  } else {
    console.log('\n⏩ 未配置腾讯云 COS 凭证 (TENCENT_COS_SECRET_ID/KEY)，跳过 COS 上传')
  }

  // 2. 同步至 Cloudflare R2 (海外与多云容灾)
  const r2Config = {
    accountId: options.r2AccountId || process.env.R2_ACCOUNT_ID || (dryRun ? 'simulated_r2_account' : null),
    accessKeyId: options.r2AccessKeyId || process.env.R2_ACCESS_KEY_ID || (dryRun ? 'simulated_r2_key' : null),
    secretAccessKey: options.r2SecretAccessKey || process.env.R2_SECRET_ACCESS_KEY || (dryRun ? 'simulated_r2_secret' : null),
    bucket: options.r2Bucket || process.env.R2_BUCKET_NAME || 'ztools-plugins-r2'
  }

  const hasR2Config = r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey
  if (hasR2Config) {
    console.log(`\n📤 [2/4] 开始同步至 Cloudflare R2 存储桶: ${r2Config.bucket}...`)
    for (const file of files) {
      await uploadToR2({
        file,
        accountId: r2Config.accountId,
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
        bucket: r2Config.bucket,
        dryRun
      })
    }
    console.log('✅ Cloudflare R2 多云灾备同步完成！')
  } else {
    console.log('\n⏩ 未配置 Cloudflare R2 凭证 (R2_ACCOUNT_ID/ACCESS_KEY)，跳过 R2 上传')
  }

  // 3. 同步至阿里云 OSS (主力/灾备对象存储)
  const ossConfig = {
    accessKeyId: options.ossAccessKeyId || process.env.OSS_ACCESS_KEY_ID || (dryRun ? 'simulated_oss_key' : null),
    accessKeySecret: options.ossAccessKeySecret || process.env.OSS_ACCESS_KEY_SECRET || (dryRun ? 'simulated_oss_secret' : null),
    bucket: options.ossBucket || process.env.OSS_BUCKET || 'ztools-data',
    region: options.ossRegion || process.env.OSS_REGION || 'oss-cn-shenzhen',
    prefix: options.ossPrefix || process.env.OSS_PREFIX || 'plugins/'
  }

  const hasOssConfig = ossConfig.accessKeyId && ossConfig.accessKeySecret
  if (hasOssConfig) {
    console.log(`\n📤 [3/4] 开始同步至阿里云 OSS 存储桶: ${ossConfig.bucket} (${ossConfig.region}, 目录: ${ossConfig.prefix})...`)
    for (const file of files) {
      await uploadToOss({
        file,
        accessKeyId: ossConfig.accessKeyId,
        accessKeySecret: ossConfig.accessKeySecret,
        bucket: ossConfig.bucket,
        region: ossConfig.region,
        prefix: ossConfig.prefix,
        dryRun
      })
    }
    console.log('✅ 阿里云 OSS 对象存储全量同步完成！')
  } else {
    console.log('\n⏩ 未配置阿里云 OSS 凭证 (OSS_ACCESS_KEY_ID/SECRET)，跳过 OSS 上传')
  }

  // 4. 腾讯云 EdgeOne 边缘 CDN 缓存刷新
  const edgeOneConfig = {
    secretId: options.edgeOneSecretId || process.env.EDGEONE_SECRET_ID || cosConfig.secretId,
    secretKey: options.edgeOneSecretKey || process.env.EDGEONE_SECRET_KEY || cosConfig.secretKey,
    zoneId: options.edgeOneZoneId || process.env.EDGEONE_ZONE_ID || (dryRun ? 'zone-simulated' : null)
  }

  if (edgeOneConfig.secretId && edgeOneConfig.secretKey && edgeOneConfig.zoneId) {
    const purgeUrls = [
      `${cdnBaseUrl}/plugins.json`,
      ...files.filter(f => f.relPath.endsWith('.zip') || f.relPath.endsWith('.json')).map(f => `${cdnBaseUrl}/${f.relPath}`)
    ]
    console.log(`\n🔄 [4/4] 开始触发 EdgeOne 边缘 CDN 缓存清理...`)
    await purgeEdgeOneCache({
      secretId: edgeOneConfig.secretId,
      secretKey: edgeOneConfig.secretKey,
      zoneId: edgeOneConfig.zoneId,
      urls: purgeUrls,
      dryRun
    })
  } else {
    console.log('\n⏩ 未配置 EdgeOne 凭证或 ZoneId，跳过 CDN 缓存主动刷新')
  }

  console.log('\n🎉 ============================================================')
  console.log('✨ 全网分发同步流程执行成功！客户端可通过 EdgeOne CDN 稳定加速拉取最新插件。')
  console.log('============================================================\n')

  return {
    success: true,
    filesCount: files.length,
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
  --cdn-base-url <url>  CDN 域名 (默认: https://plugins.ztools.cn)
  --dry-run             演练模式，仅打印计划而不发起实际云端请求
  --help, -h            显示帮助信息

环境变量配置说明:
  - 阿里云 OSS: OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION, OSS_PREFIX (默认 plugins/)
  - 腾讯云 COS: TENCENT_COS_SECRET_ID, TENCENT_COS_SECRET_KEY, TENCENT_COS_BUCKET, TENCENT_COS_REGION
  - Cloudflare R2: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
  - 腾讯云 EdgeOne: EDGEONE_SECRET_ID, EDGEONE_SECRET_KEY, EDGEONE_ZONE_ID
    `.trim())
    process.exit(0)
  }

  function getArg(flag, fallback) {
    const idx = args.indexOf(flag)
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
    return fallback
  }

  const dir = getArg('--dir', path.join(rootDir, 'dist/plugins'))
  const cdnBaseUrl = getArg('--cdn-base-url', process.env.CDN_BASE_URL || 'https://plugins.ztools.cn')
  const ossPrefix = getArg('--oss-prefix', process.env.OSS_PREFIX || 'plugins/')
  const dryRun = args.includes('--dry-run')

  await deployPluginsStorage({
    dir,
    cdnBaseUrl,
    ossPrefix,
    dryRun
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch(err => {
    console.error('部署执行异常:', err)
    process.exit(1)
  })
}
