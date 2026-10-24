/**
 * 「弹出独立窗口」时把插件 usePopoutState 登记的状态交给新窗口（设计第 5 项）。
 *
 * 流程：
 *   旧窗口：collectPopoutState → buildPopoutHandoff（只收纯 JSON，超限整份不带）→ window_open({ url, handoff })
 *           URL 里带一次性编号 handoff=<id>（非机密：主进程按新窗口 webContentsId 绑定，只交付编号对应的最新一份）
 *   新窗口：takePopoutHandoff（2 秒超时）→ 插件 ID / 功能码与本页一致才作为根页面的 handoffSeed
 *   同窗口兜底（宿主不支持多窗口或建窗失败）：状态放在本模块内存里，路由到 popout 页后由新挂载的页面取走
 *
 * state 文本格式（主进程只校验是 JSON 对象、≤ 256 KiB，不解读）：
 *   { "v": 1, "entries": { key: value }, "rejected": [key...], "oversized": boolean }
 */
import { callHostMethod } from './hostMethods.js'

export const POPOUT_STATE_MAX_BYTES = 256 * 1024
export const POPOUT_STATE_MAX_DEPTH = 32
export const POPOUT_STATE_MAX_NODES = 100_000
export const POPOUT_PATHS_MAX = 2000
export const POPOUT_PATH_MAX_LENGTH = 4096
export const POPOUT_PATHS_MAX_BYTES = 512 * 1024
export const POPOUT_TAKE_TIMEOUT_MS = 2000
/** 整个 window_open 请求（JSON 序列化后）留在主进程 1 MiB 普通上限内的预算 */
const POPOUT_REQUEST_BUDGET_BYTES = 1024 * 1024 - 16 * 1024
const MAX_REJECTED_KEYS = 64
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
function utf8Bytes(text) {
  if (encoder) return encoder.encode(text).length
  return unescape(encodeURIComponent(text)).length
}

/** 一次性交接编号：18 字节随机数的 base64url（24 个字符） */
export function createHandoffId() {
  const bytes = new Uint8Array(18)
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function isHandoffId(value) {
  return typeof value === 'string' && HANDOFF_ID_PATTERN.test(value)
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 值是否为「纯 JSON」：普通对象 / 数组 / 字符串 / 有限数字 / 布尔 / null。
 * 不偷偷转换：函数、Symbol、BigInt、Date、Map、类实例、循环引用、数组空位或 undefined、Symbol 键都判为不合格；
 * 对象属性值为 undefined 时按 JSON 语义省略（React 状态里很常见）。深度 ≤ 32、节点 ≤ 100k。
 */
export function checkPopoutValue(value) {
  let nodes = 0
  const ancestors = new Set()
  const visit = (item, depth) => {
    nodes += 1
    if (nodes > POPOUT_STATE_MAX_NODES) return 'too-many-nodes'
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return null
    if (typeof item === 'number') return Number.isFinite(item) ? null : 'non-finite-number'
    if (typeof item !== 'object') return `unsupported-${typeof item}`
    if (depth >= POPOUT_STATE_MAX_DEPTH) return 'too-deep'
    if (ancestors.has(item)) return 'circular'
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          if (!(i in item) || item[i] === undefined) return 'array-hole'
          const reason = visit(item[i], depth + 1)
          if (reason) return reason
        }
        return null
      }
      if (!isPlainObject(item)) return 'not-plain-object'
      if (Object.getOwnPropertySymbols(item).length > 0) return 'symbol-key'
      for (const key of Object.keys(item)) {
        const child = item[key]
        if (child === undefined) continue
        const reason = visit(child, depth + 1)
        if (reason) return reason
      }
      return null
    } finally {
      ancestors.delete(item)
    }
  }
  try {
    const reason = visit(value, 0)
    return reason ? { ok: false, reason } : { ok: true }
  } catch {
    // getter 抛错、Proxy 等
    return { ok: false, reason: 'unreadable' }
  }
}

function isAbsoluteLocalPath(value) {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

/**
 * 把 collectPopoutState 的结果整理成 window_open 的 handoff 内容。
 * @param {{ entries?: Array<{key: string, value: unknown, paths?: string[]}>, rejected?: string[] } | null} collected
 * @param {{ urlBytes?: number }} [options]
 * @returns {{ state: string, paths: string[], rejected: string[], oversized: boolean, keys: string[] }}
 */
export function buildPopoutHandoff(collected, options = {}) {
  const entries = {}
  const keys = []
  const rejected = []
  const candidatePaths = []
  for (const key of Array.isArray(collected?.rejected) ? collected.rejected : []) {
    if (typeof key === 'string') rejected.push(key)
  }
  for (const entry of Array.isArray(collected?.entries) ? collected.entries : []) {
    if (!entry || typeof entry.key !== 'string') continue
    // 顶层 undefined：没有可带的值，新窗口用 initialValue（不算失败）
    if (entry.value === undefined) continue
    if (!checkPopoutValue(entry.value).ok) {
      rejected.push(entry.key)
      continue
    }
    entries[entry.key] = entry.value
    keys.push(entry.key)
    if (Array.isArray(entry.paths)) candidatePaths.push(...entry.paths)
  }

  const rejectedKeys = rejected.slice(0, MAX_REJECTED_KEYS)
  let oversized = false
  let state = JSON.stringify({ v: 1, entries, rejected: rejectedKeys, oversized })
  if (utf8Bytes(state) > POPOUT_STATE_MAX_BYTES) {
    oversized = true
    keys.length = 0
    state = JSON.stringify({ v: 1, entries: {}, rejected: rejectedKeys, oversized })
  }

  // 路径：去重、只收绝对路径；条数、单条长度、合计字节都在主进程上限内，并保证整个请求不超过 1 MiB
  const paths = []
  if (!oversized) {
    const seen = new Set()
    const stateBytes = utf8Bytes(JSON.stringify(state))
    const budget = Math.min(
      POPOUT_PATHS_MAX_BYTES,
      POPOUT_REQUEST_BUDGET_BYTES - stateBytes - (Number(options.urlBytes) || 4096)
    )
    let used = 2
    let raw = 0
    for (const item of candidatePaths) {
      if (paths.length >= POPOUT_PATHS_MAX) break
      if (typeof item !== 'string' || !item || item.length > POPOUT_PATH_MAX_LENGTH || item.includes('\0')) continue
      if (!isAbsoluteLocalPath(item) || seen.has(item)) continue
      const itemRaw = utf8Bytes(item)
      const itemSerialized = utf8Bytes(JSON.stringify(item)) + 1
      if (raw + itemRaw > POPOUT_PATHS_MAX_BYTES || used + itemSerialized > budget) break
      seen.add(item)
      paths.push(item)
      raw += itemRaw
      used += itemSerialized
    }
  }
  return { state, paths, rejected: rejectedKeys, oversized, keys }
}

/** 解析交接的 state 文本：返回 { seed, rejected, oversized }，格式不对返回 null */
export function parsePopoutState(text) {
  if (typeof text !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entries = parsed.entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
  return {
    seed: entries,
    rejected: Array.isArray(parsed.rejected) ? parsed.rejected.filter((key) => typeof key === 'string') : [],
    oversized: parsed.oversized === true
  }
}

/** 弹出前的提示文案（新窗口里展示；旧窗口马上会离开插件页） */
export function describeHandoffLoss({ rejected = [], oversized = false } = {}) {
  if (oversized) return '内容过大，独立窗口将重新开始'
  if (rejected.length > 0) return '部分内容无法带到独立窗口'
  return ''
}

// ---------------------------------------------------------------------------
// 同窗口兜底：交接内容只在本渲染进程内存里，路由到 popout 页后由新页面取走
// ---------------------------------------------------------------------------
const pendingLocal = new Map()
const LOCAL_TTL_MS = 60_000

export function stashLocalHandoff(handoffId, payload) {
  if (!isHandoffId(handoffId)) return
  const now = Date.now()
  for (const [id, item] of pendingLocal) {
    if (item.expiresAt <= now) pendingLocal.delete(id)
  }
  pendingLocal.set(handoffId, { ...payload, expiresAt: now + LOCAL_TTL_MS })
}

function takeLocalHandoff(handoffId) {
  const item = pendingLocal.get(handoffId)
  if (!item) return null
  pendingLocal.delete(handoffId)
  return item.expiresAt > Date.now() ? item : null
}

/** 仅测试用 */
export function _resetLocalHandoffsForTesting() {
  pendingLocal.clear()
}

function withTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  return Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 新窗口取交接状态。
 * @returns {Promise<{ status: 'ok'|'none'|'mismatch'|'invalid'|'failed'|'timeout', seed?: object, notice?: string }>}
 *   只有 ok 带 seed；failed / timeout 时调用方提示「未能恢复弹出前的内容」，其余静默
 */
export async function takePopoutHandoff({ handoffId, pluginId, featureCode = '', timeoutMs = POPOUT_TAKE_TIMEOUT_MS, call = callHostMethod } = {}) {
  if (!isHandoffId(handoffId)) return { status: 'none' }
  const local = takeLocalHandoff(handoffId)
  const outcome = local
    ? { value: { status: 'ok', pluginId: local.pluginId, featureCode: local.featureCode, state: local.state } }
    : await withTimeout(Promise.resolve().then(() => call('window_popout_handoff_take', { handoffId })), timeoutMs)
  if (outcome.timedOut) return { status: 'timeout' }
  if (outcome.error) return { status: 'failed', error: outcome.error }
  const result = outcome.value
  if (!result || result.status !== 'ok') return { status: 'none' }
  if (result.pluginId !== pluginId || (result.featureCode || '') !== (featureCode || '')) {
    console.warn('[popout] 交接状态与本页插件不一致，已丢弃', { expected: pluginId, got: result.pluginId })
    return { status: 'mismatch' }
  }
  const parsed = parsePopoutState(result.state)
  if (!parsed) return { status: 'invalid' }
  return { status: 'ok', seed: parsed.seed, notice: describeHandoffLoss(parsed) }
}

/** 主进程拒绝后「保持原样不跳转」的错误码；其余失败（宿主不支持、建窗 / 加载失败）走同窗口兜底 */
const KEEP_IN_PLACE_CODES = new Set(['PLUGIN_BUSY', 'INVALID_REQUEST', 'PERMISSION_DENIED', 'CANCELLED'])

/** 与主进程 window_open 的 url 长度上限一致 */
export const POPOUT_URL_MAX_LENGTH = 2048
/** URL 超长时依次舍弃的查询参数：q（搜索框内容，可能很长）优先，其余是短的界面状态；feature / handoff 必须保留 */
const DROPPABLE_QUERY_KEYS = ['q', 'sel', 'drop', 'seg']

function buildPopoutUrl(pluginId, query) {
  return `ztools://web/index.html#/popout/${encodeURIComponent(pluginId)}?${new URLSearchParams(query).toString()}`
}

/**
 * 选出能放进 window_open 的 URL：
 * - 不超长：原样；
 * - 超长且插件接入了 usePopoutState（有可带的状态）：依次舍弃 q 等界面参数（内容靠交接状态恢复）；
 * - 超长且没有可带的状态：返回 null，由调用方走同窗口放大（与接入前的行为一致，搜索框内容完整保留）。
 */
function fitPopoutUrl(pluginId, fullQuery, hasState) {
  let url = buildPopoutUrl(pluginId, fullQuery)
  if (url.length <= POPOUT_URL_MAX_LENGTH) return { url, query: fullQuery }
  if (!hasState) return null
  const query = { ...fullQuery }
  for (const key of DROPPABLE_QUERY_KEYS) {
    if (!(key in query)) continue
    delete query[key]
    url = buildPopoutUrl(pluginId, query)
    if (url.length <= POPOUT_URL_MAX_LENGTH) return { url, query }
  }
  return null
}

/**
 * 发起弹出：建独立窗口并交接状态。
 * @param {{ pluginId: string, query: Record<string,string>, collected: object|null, call?: Function }} options
 * @returns {Promise<{ outcome: 'opened'|'fallback'|'kept', handoffId: string, query: Record<string,string>, error?: unknown }>}
 *   opened：独立窗口已加载，调用方离开插件页；fallback：调用方路由到同窗口 popout 页（状态已放进内存）；
 *   kept：主进程明确拒绝（窗口数上限等），调用方保持原样并提示
 */
export async function requestPopoutWindow({ pluginId, query = {}, collected = null, call = callHostMethod } = {}) {
  const handoffId = createHandoffId()
  const fullQuery = { ...query, handoff: handoffId }
  // 最终 URL 不会超过 POPOUT_URL_MAX_LENGTH（超长时要么舍弃参数，要么不发 window_open）
  const built = buildPopoutHandoff(collected, { urlBytes: POPOUT_URL_MAX_LENGTH })
  const featureCode = typeof query.feature === 'string' ? query.feature : ''
  const fitted = fitPopoutUrl(pluginId, fullQuery, built.keys.length > 0)
  if (!fitted) {
    // 搜索框内容太长放不进独立窗口地址，且插件没有可交接的状态：同窗口放大，内容完整保留
    stashLocalHandoff(handoffId, { pluginId, featureCode, state: built.state })
    return { outcome: 'fallback', handoffId, query: fullQuery, reason: 'url-too-long' }
  }
  const { url } = fitted
  const handoff = {
    id: handoffId,
    pluginId,
    ...(featureCode ? { featureCode } : {}),
    state: built.state,
    ...(built.paths.length > 0 ? { paths: built.paths } : {})
  }
  try {
    await call('window_open', { url, handoff })
    return { outcome: 'opened', handoffId, query: fitted.query }
  } catch (error) {
    if (KEEP_IN_PLACE_CODES.has(error?.code)) return { outcome: 'kept', handoffId, query: fullQuery, error }
    // 同一渲染进程内兜底，授权本来就在这个窗口
    stashLocalHandoff(handoffId, { pluginId, featureCode, state: built.state })
    return { outcome: 'fallback', handoffId, query: fullQuery, error }
  }
}
