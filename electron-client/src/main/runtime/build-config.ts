import fs from 'node:fs'
import path from 'node:path'

/**
 * 构建期注入的运行配置。
 *
 * 官方后台地址不写死在源码里：`scripts/build.mjs` 在构建时解析地址并写入
 * `out/main/build-config.json`，运行时只读这一个文件。
 * 文件缺失、损坏或地址不合法时一律按空地址处理，即单机离线模式。
 * 开源版（src/main/edition-oss）不使用这个地址，任何情况下都不连接后台；
 * 只有运行时加载到的其他版本实现（见 src/main/edition.ts）才会用它。
 */
export interface BuildConfig {
  /** 官方后台根地址（不带末尾斜杠），空字符串表示单机离线 */
  apiBase: string
}

export const BUILD_CONFIG_FILE_NAME = 'build-config.json'
export const BUILD_CONFIG_SCHEMA_VERSION = 1
/** 构建时显式指定后台地址的环境变量；设为空字符串表示强制离线构建 */
export const BUILD_API_BASE_ENV = 'ZTOOLS_API_BASE'
/** 界面层生产环境变量文件里的后台地址键，主进程构建时复用同一个值 */
export const FRONTEND_API_BASE_KEY = 'VITE_API_BASE_URL'

const MAX_API_BASE_LENGTH = 2048
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 校验并规范化后台地址。
 * 只接受 https 地址；http 仅限本机回环（本地调试后台）。
 * 不允许带账号密码、查询参数或锚点。空字符串表示离线，原样返回空字符串。
 * 不合法时抛出错误，由调用方决定是中止构建还是降级为离线。
 */
export function normalizeApiBase(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('后台地址必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed.length > MAX_API_BASE_LENGTH) throw new Error('后台地址过长')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`后台地址不是有效的绝对地址: ${trimmed}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`后台地址只允许 https（本机调试可用 http://localhost）: ${trimmed}`)
  }
  if (url.username !== '' || url.password !== '') throw new Error('后台地址不能包含账号或密码')
  if (url.search !== '' || url.hash !== '') throw new Error('后台地址不能包含查询参数或锚点')
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** 解析 dotenv 文本中某个键的值（只支持 `KEY = value` 单行写法，去掉成对引号） */
export function readDotenvValue(source: string, key: string): string | undefined {
  let found: string | undefined
  for (const rawLine of source.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    if (line.slice(0, separator).trim() !== key) continue
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    found = value
  }
  return found
}

export interface ResolveBuildApiBaseInput {
  /** 构建进程环境变量 */
  env: Readonly<Record<string, string | undefined>>
  /** 界面层 `.env.production` 内容；文件不存在时传 undefined */
  frontendEnvProduction?: string | undefined
}

export interface ResolvedBuildApiBase {
  apiBase: string
  source: 'env' | 'frontend-env-production' | 'none'
}

/**
 * 构建期确定后台地址，优先级：
 * 1. 环境变量 ZTOOLS_API_BASE（显式设为空字符串即强制离线）；
 * 2. 界面层 `.env.production` 的 VITE_API_BASE_URL（仅当它是绝对地址；`/api` 这类相对前缀只给开发代理用，忽略）；
 * 3. 都没有：空地址，离线构建。
 * 显式给出的地址不合法时抛错，避免本应联网的构建悄悄变成离线版。
 */
export function resolveBuildApiBase(input: ResolveBuildApiBaseInput): ResolvedBuildApiBase {
  const fromEnv = input.env[BUILD_API_BASE_ENV]
  if (fromEnv !== undefined) {
    return { apiBase: normalizeApiBase(fromEnv), source: 'env' }
  }
  if (input.frontendEnvProduction !== undefined) {
    const value = readDotenvValue(input.frontendEnvProduction, FRONTEND_API_BASE_KEY)?.trim() ?? ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return { apiBase: normalizeApiBase(value), source: 'frontend-env-production' }
    }
  }
  return { apiBase: '', source: 'none' }
}

/** 生成构建配置文件内容 */
export function serializeBuildConfig(config: BuildConfig): string {
  return `${JSON.stringify({ schemaVersion: BUILD_CONFIG_SCHEMA_VERSION, apiBase: normalizeApiBase(config.apiBase) }, null, 2)}\n`
}

/**
 * 读取构建配置。任何异常（文件缺失、JSON 损坏、版本不符、地址不合法）都降级为离线配置，
 * 绝不因为配置问题阻止客户端启动。
 */
export function readBuildConfig(file = path.join(__dirname, '..', BUILD_CONFIG_FILE_NAME)): BuildConfig {
  let source: string
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    return { apiBase: '' }
  }
  try {
    const value: unknown = JSON.parse(source.replace(/^﻿/, ''))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('不是对象')
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== BUILD_CONFIG_SCHEMA_VERSION) throw new Error('版本不受支持')
    return { apiBase: normalizeApiBase(record.apiBase ?? '') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[build-config] 构建配置无效，按离线模式运行: ${message}`)
    return { apiBase: '' }
  }
}

let cachedConfig: BuildConfig | undefined

/** 当前构建注入的官方后台地址（进程内缓存），空字符串表示离线 */
export function officialApiBase(): string {
  cachedConfig ??= readBuildConfig()
  return cachedConfig.apiBase
}
