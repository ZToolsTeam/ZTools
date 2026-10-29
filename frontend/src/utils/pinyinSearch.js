/**
 * 悬浮条、工作台与插件市场共用的搜索匹配内核
 *
 * 一条结果只取最好的一档，不同字段的命中不累加（累加会让多处弱命中压过一处强命中）：
 *   别名完全一致 > 完全一致 > 开头一致 > 中间一致 > 只命中描述
 * 「一致」同时比较原文、全拼与首字母（英文按单词首字母）。读音来自 pinyin-pro：
 * 每个字按上下文取常用读音，其余读音（多音字的非常用读音）也能命中，但同档时排在后面。
 */
import { pinyin } from 'pinyin-pro'

/** 匹配档：数值越大越相关 */
export const MATCH_TIERS = Object.freeze({
  NONE: 0,
  DESCRIPTION: 1,
  INNER: 2,
  PREFIX: 3,
  EXACT: 4,
  ALIAS: 5
})

/** 命中字段：同档时名称优先于触发词，触发词优先于插件标识，描述最后 */
export const MATCH_FIELDS = Object.freeze({ NAME: 0, KEYWORD: 1, ID: 2, DESCRIPTION: 3 })

const PINYIN_OPTIONS = Object.freeze({ toneType: 'none', type: 'array', v: true })
const HAN_RE = /\p{Script=Han}/u
const ASCII_ALNUM_RE = /^[a-z0-9]$/i
const READING_RE = /^[a-z]+$/
const PINYIN_QUERY_RE = /^[a-z0-9]+$/
/** 超过这个长度的查询只做原文匹配（拼音展开对长句没有意义） */
const MAX_PINYIN_QUERY_LENGTH = 64
const TOKEN_CACHE_LIMIT = 5000

const NO_TEXT_MATCH = Object.freeze({ tier: MATCH_TIERS.NONE, secondary: false, range: null, literal: false })

const charReadingsCache = new Map()
const tokenCache = new Map()

function normalizeQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase().replace(/\s+/g, ' ') : ''
}

/** 统一的查询规范化（去首尾空白、小写、连续空白合成一个），记录「搜索词 → 选中项」时用同一规则 */
export function normalizeSearchQuery(query) {
  return normalizeQuery(query)
}

/** 单个汉字的全部读音（无声调，ü 写作 v），常用读音在前 */
function readingsOfChar(ch) {
  let readings = charReadingsCache.get(ch)
  if (readings) return readings
  readings = []
  try {
    for (const raw of pinyin(ch, { ...PINYIN_OPTIONS, multiple: true })) {
      const value = String(raw || '').toLowerCase()
      if (READING_RE.test(value) && !readings.includes(value)) readings.push(value)
    }
  } catch {
    readings = []
  }
  charReadingsCache.set(ch, readings)
  return readings
}

/**
 * 把文本切成匹配单元：每个汉字一个单元（带全部读音，按上下文的读音放第一位）；
 * 连续英文字母数字一个单元（驼峰处断开，如 WeChat → we / chat）；空格与标点只作分隔。
 * start / end 是原文中的 UTF-16 下标，用于高亮。
 */
function tokenize(text) {
  const cached = tokenCache.get(text)
  if (cached) return cached

  const tokens = []
  let hanRun = []
  let word = null

  const flushHan = () => {
    if (hanRun.length === 0) return
    let context = null
    try {
      context = pinyin(hanRun.map((c) => c.ch).join(''), PINYIN_OPTIONS)
    } catch {
      context = null
    }
    if (!Array.isArray(context) || context.length !== hanRun.length) context = null
    hanRun.forEach((c, index) => {
      const all = readingsOfChar(c.ch)
      const contextual = String(context?.[index] || '').toLowerCase()
      const primary = READING_RE.test(contextual) ? contextual : all[0]
      const readings = primary ? [primary, ...all.filter((r) => r !== primary)] : []
      tokens.push({ start: c.start, end: c.start + c.ch.length, readings, han: true })
    })
    hanRun = []
  }
  const flushWord = () => {
    if (!word) return
    tokens.push({ start: word.start, end: word.end, readings: [word.text.toLowerCase()], han: false })
    word = null
  }

  let offset = 0
  let previous = ''
  for (const ch of text) {
    if (HAN_RE.test(ch)) {
      flushWord()
      hanRun.push({ ch, start: offset })
    } else if (ASCII_ALNUM_RE.test(ch)) {
      flushHan()
      const camelBreak = word && /[a-z]/.test(previous) && /[A-Z]/.test(ch)
      if (camelBreak) flushWord()
      if (!word) word = { start: offset, end: offset, text: '' }
      word.text += ch
      word.end = offset + ch.length
    } else {
      flushHan()
      flushWord()
    }
    previous = ch
    offset += ch.length
  }
  flushHan()
  flushWord()

  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value)
  tokenCache.set(text, tokens)
  return tokens
}

/**
 * 从第 startIndex 个单元开始，用全拼、首字母或末尾的半个读音依次消费查询。
 * allowSecondary 为 false 时每个字只用按上下文的常用读音。
 */
function matchTokensFrom(tokens, q, startIndex, allowSecondary) {
  const failed = new Set()
  const walk = (index, pos) => {
    if (pos >= q.length) return { end: index, partial: false }
    if (index >= tokens.length) return null
    const memoKey = index * (MAX_PINYIN_QUERY_LENGTH + 1) + pos
    if (failed.has(memoKey)) return null
    const readings = tokens[index].readings
    const count = allowSecondary ? readings.length : Math.min(1, readings.length)
    for (let i = 0; i < count; i++) {
      const reading = readings[i]
      if (q.startsWith(reading, pos)) {
        const next = walk(index + 1, pos + reading.length)
        if (next) return next
      }
      if (reading.length > q.length - pos && reading.startsWith(q.slice(pos))) {
        // 只剩一个字母时等同于首字母，不算半个读音（wx → 微信 是完全一致）
        return { end: index + 1, partial: q.length - pos > 1 }
      }
      if (reading.length > 1 && reading[0] === q[pos]) {
        const next = walk(index + 1, pos + 1)
        if (next) return next
      }
    }
    failed.add(memoKey)
    return null
  }
  return walk(startIndex, 0)
}

/**
 * 拼音与英文单词首字母匹配：从第一个单元开始的是「开头一致 / 完全一致」，从中间开始的是「中间一致」
 */
function pinyinMatch(text, q, allowInner) {
  if (q.length > MAX_PINYIN_QUERY_LENGTH || !PINYIN_QUERY_RE.test(q)) return NO_TEXT_MATCH
  const tokens = tokenize(text)
  if (tokens.length === 0) return NO_TEXT_MATCH
  const toMatch = (startIndex, found, secondary) => {
    const exact = startIndex === 0 && !found.partial && found.end === tokens.length
    return {
      tier: exact ? MATCH_TIERS.EXACT : startIndex === 0 ? MATCH_TIERS.PREFIX : MATCH_TIERS.INNER,
      secondary,
      range: [tokens[startIndex].start, tokens[found.end - 1].end],
      literal: false
    }
  }
  for (const secondary of [false, true]) {
    const found = matchTokensFrom(tokens, q, 0, secondary)
    if (found) return toMatch(0, found, secondary)
  }
  if (!allowInner) return NO_TEXT_MATCH
  for (const secondary of [false, true]) {
    for (let start = 1; start < tokens.length; start++) {
      const found = matchTokensFrom(tokens, q, start, secondary)
      if (found) return toMatch(start, found, secondary)
    }
  }
  return NO_TEXT_MATCH
}

/**
 * 名称中间的原文命中。英文名里后面单词的开头（含驼峰处）算开头一致（Google Chrome 输入 chrome）；
 * 其余位置：中文任意位置，英文要求查询至少 3 个字符，算中间一致。
 */
function innerLiteralMatch(text, lower, q, allowInner) {
  if (!allowInner) return null
  const startsWithHan = HAN_RE.test(q[0] || '')
  let fallback = -1
  let index = lower.indexOf(q, 1)
  while (index > 0) {
    const before = text[index - 1] || ''
    const current = text[index] || ''
    const wordStart = ASCII_ALNUM_RE.test(current) &&
      (!ASCII_ALNUM_RE.test(before) || (/[a-z]/.test(before) && /[A-Z]/.test(current)))
    if (wordStart) return { index, wordStart: true }
    if (fallback < 0 && (startsWithHan || q.length >= 3)) fallback = index
    index = lower.indexOf(q, index + 1)
  }
  return fallback > 0 ? { index: fallback, wordStart: false } : null
}

/** 英文单词内按顺序出现查询的每个字母（首字母必须相同），如 ps → Photoshop；只用于名称 */
function wordSubsequenceRange(text, q) {
  if (q.length < 2 || !/^[a-z]+$/.test(q)) return null
  for (const token of tokenize(text)) {
    const word = token.readings[0]
    if (token.han || !word || word.length <= q.length || word[0] !== q[0]) continue
    let pos = 1
    for (let i = 1; i < word.length && pos < q.length; i++) {
      if (word[i] === q[pos]) pos++
    }
    if (pos === q.length) return [token.start, token.end]
  }
  return null
}

/** 小写化但保持每个字符的 UTF-16 长度不变（如土耳其语 İ 小写后变长，原样保留），命中区间才能直接对应原文 */
function lowerKeepLength(text) {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let result = ''
  for (const ch of text) {
    const lowered = ch.toLowerCase()
    result += lowered.length === ch.length ? lowered : ch
  }
  return result
}

function matchSingleTerm(text, q, allowInner, allowSubsequence) {
  const lower = lowerKeepLength(text)
  if (lower === q) return { tier: MATCH_TIERS.EXACT, secondary: false, range: [0, text.length], literal: true }
  if (lower.startsWith(q)) return { tier: MATCH_TIERS.PREFIX, secondary: false, range: [0, q.length], literal: true }
  const fromPinyin = pinyinMatch(text, q, allowInner)
  if (fromPinyin.tier >= MATCH_TIERS.PREFIX && !fromPinyin.secondary) return fromPinyin
  const inner = innerLiteralMatch(text, lower, q, allowInner)
  if (inner && (inner.wordStart || fromPinyin.tier < MATCH_TIERS.PREFIX)) {
    return {
      tier: inner.wordStart ? MATCH_TIERS.PREFIX : MATCH_TIERS.INNER,
      secondary: false,
      range: [inner.index, inner.index + q.length],
      literal: true
    }
  }
  if (fromPinyin.tier > MATCH_TIERS.NONE) return fromPinyin
  if (allowSubsequence && allowInner) {
    const range = wordSubsequenceRange(text, q)
    if (range) return { tier: MATCH_TIERS.INNER, secondary: false, range, literal: false }
  }
  return NO_TEXT_MATCH
}

function betterTextMatch(a, b) {
  if (b.tier !== a.tier) return b.tier > a.tier ? b : a
  return a.secondary && !b.secondary ? b : a
}

/**
 * 文本与查询的匹配档和命中区间。查询里有空格时：先按整句匹配，再去掉空格按拼音匹配，
 * 最后要求每个词都命中（取其中最差的一档）。
 */
function matchText(text, q, allowInner, allowSubsequence = false) {
  if (!text || !q) return NO_TEXT_MATCH
  if (!q.includes(' ')) return matchSingleTerm(text, q, allowInner, allowSubsequence)

  let best = matchSingleTerm(text, q, allowInner, false)
  if (best.tier >= MATCH_TIERS.PREFIX) return best
  best = betterTextMatch(best, matchSingleTerm(text, q.replace(/ /g, ''), allowInner, false))
  if (best.tier > MATCH_TIERS.NONE) return best

  let combined = null
  for (const term of q.split(' ')) {
    const termMatch = matchSingleTerm(text, term, true, false)
    if (termMatch.tier === MATCH_TIERS.NONE) return NO_TEXT_MATCH
    if (!combined) combined = termMatch
    else if (termMatch.tier < combined.tier) combined = { ...termMatch, range: combined.range }
    else if (termMatch.secondary) combined = { ...combined, secondary: true }
  }
  return combined || NO_TEXT_MATCH
}

/**
 * 获取单个字符的全部读音：汉字返回全部拼音（常用读音在前），英文字母数字返回小写自身
 * @param {string} char
 * @returns {string[]}
 */
export function getCharPinyins(char) {
  if (!char || typeof char !== 'string') return []
  if (ASCII_ALNUM_RE.test(char)) return [char.toLowerCase()]
  return HAN_RE.test(char) ? readingsOfChar(char) : []
}

function contextualSyllables(text) {
  if (!text || typeof text !== 'string') return []
  return tokenize(text).map((token) => token.readings[0] || '').filter(Boolean)
}

/**
 * 文本的拼音首字母（英文单词逐字母保留）
 * @param {string} text
 * @returns {string}
 */
export function getPinyinInitials(text) {
  if (!text || typeof text !== 'string') return ''
  let initials = ''
  for (const token of tokenize(text)) {
    const reading = token.readings[0]
    if (reading) initials += token.han ? reading[0] : reading
  }
  return initials
}

/**
 * 文本的连续全拼（按上下文取常用读音）
 * @param {string} text
 * @returns {string}
 */
export function getPinyinFull(text) {
  return contextualSyllables(text).join('')
}

/**
 * 在文本中匹配查询词（原文、全拼、首字母与多音字），返回命中区间
 * @param {string} text
 * @param {string} query
 * @returns {{ matched: boolean, range: [number, number] | null, matchType: 'literal' | 'pinyin-prefix' | 'pinyin-sub' | 'none' }}
 */
export function findPinyinMatchInText(text, query) {
  if (!text || typeof text !== 'string') return { matched: false, range: null, matchType: 'none' }
  const q = normalizeQuery(query)
  if (!q) return { matched: false, range: null, matchType: 'none' }
  const match = matchText(text, q, true)
  if (match.tier === MATCH_TIERS.NONE) return { matched: false, range: null, matchType: 'none' }
  return {
    matched: true,
    range: match.range,
    matchType: match.literal ? 'literal' : match.range?.[0] === 0 ? 'pinyin-prefix' : 'pinyin-sub'
  }
}

/**
 * 按命中区间把文本拆成高亮片段
 * @param {string} text
 * @param {[number, number] | null | undefined} range
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function splitHighlightParts(text, range) {
  const source = typeof text === 'string' ? text : ''
  if (!source || !Array.isArray(range)) return [{ text: source, hit: false }]
  const start = Math.max(0, Math.min(source.length, Number(range[0]) || 0))
  const end = Math.max(start, Math.min(source.length, Number(range[1]) || 0))
  if (end <= start) return [{ text: source, hit: false }]
  return [
    { text: source.slice(0, start), hit: false },
    { text: source.slice(start, end), hit: true },
    { text: source.slice(end), hit: false }
  ].filter((part) => part.text)
}

/**
 * 将标题按查询词（含原文、中文全拼、首字母与多音字命中）拆分为高亮片段数组
 * @param {string} text
 * @param {string} query
 * @returns {Array<{ text: string, hit: boolean }>}
 */
export function getHighlightPartsWithPinyin(text, query) {
  const source = typeof text === 'string' ? text : ''
  const match = findPinyinMatchInText(source, query)
  return splitHighlightParts(source, match.matched ? match.range : null)
}

/**
 * 提取条目中的触发词列表
 */
export function extractItemKeywords(item) {
  if (!item || typeof item !== 'object') return []
  const result = []

  if (typeof item.keyword === 'string' && item.keyword.trim()) {
    for (const part of item.keyword.split(/[\s,，]+/)) {
      const clean = part.trim().toLowerCase()
      if (clean) result.push(clean)
    }
  }

  if (Array.isArray(item.keywords)) {
    for (const kw of item.keywords) {
      if (typeof kw === 'string' && kw.trim()) {
        result.push(kw.trim().toLowerCase())
      }
    }
  }

  if (Array.isArray(item.cmds)) {
    for (const cmd of item.cmds) {
      if (typeof cmd === 'string' && cmd.trim()) {
        result.push(cmd.trim().toLowerCase())
      } else if (cmd && typeof cmd === 'object') {
        const label = String(cmd.label || cmd.value || cmd.name || '').trim().toLowerCase()
        if (label) result.push(label)
      }
    }
  }

  return result
}

/** 插件标识只认整体或以 - _ . 分隔的单词开头，最多算「中间一致」，避免内部标识压过真实名称 */
function matchIdentifier(id, q) {
  if (!id || !q || q.includes(' ')) return false
  if (id === q || id.startsWith(q)) return true
  if (q.length < 2) return false
  let index = id.indexOf(q, 1)
  while (index > 0) {
    if (/[-_.:/]/.test(id[index - 1])) return true
    index = id.indexOf(q, index + 1)
  }
  return false
}

const NO_ITEM_MATCH = Object.freeze({
  matched: false,
  score: 0,
  tier: MATCH_TIERS.NONE,
  secondary: false,
  field: MATCH_FIELDS.DESCRIPTION,
  range: null
})

function itemNames(item) {
  const primary = String(item.name || item.title || '')
  const names = [primary]
  if (item.name && item.title && item.title !== item.name) names.push(String(item.title))
  if (Array.isArray(item.altNames)) {
    for (const alt of item.altNames) {
      if (typeof alt === 'string' && alt.trim() && !names.includes(alt)) names.push(alt)
    }
  }
  return names
}

/**
 * 条目与查询的匹配结果
 * @returns {{ matched: boolean, score: number, tier: number, secondary: boolean, field: number, range: [number, number] | null }}
 *   range 是名称（name || title）里的命中区间；名称没命中，或只靠非常用读音碰上而最好的命中在别的字段时为 null
 */
export function matchItemWithQuery(item, query) {
  if (!item || typeof item !== 'object') return NO_ITEM_MATCH
  const q = normalizeQuery(query)
  if (!q) return { ...NO_ITEM_MATCH, matched: true }

  // 只输入一个英文字母或数字时只认开头一致，避免名称中间、描述里碰巧出现的字母刷屏
  const singleAscii = q.length === 1 && ASCII_ALNUM_RE.test(q)
  const allowInner = !singleAscii
  let best = { tier: MATCH_TIERS.NONE, secondary: false, field: MATCH_FIELDS.DESCRIPTION }
  const consider = (tier, secondary, field) => {
    if (tier === MATCH_TIERS.NONE) return
    const better = tier !== best.tier
      ? tier > best.tier
      : secondary !== best.secondary
        ? !secondary
        : field < best.field
    if (better) best = { tier, secondary, field }
  }

  const alias = String(item.alias || '').trim().toLowerCase()
  if (alias) {
    if (alias === q) consider(MATCH_TIERS.ALIAS, false, MATCH_FIELDS.NAME)
    else if (alias.startsWith(q)) consider(MATCH_TIERS.PREFIX, false, MATCH_FIELDS.NAME)
  }

  let nameMatch = null
  itemNames(item).forEach((name, index) => {
    const match = matchText(name, q, allowInner, true)
    if (index === 0 && match.tier !== MATCH_TIERS.NONE) nameMatch = match
    consider(match.tier, match.secondary, MATCH_FIELDS.NAME)
  })

  if (best.tier < MATCH_TIERS.EXACT) {
    for (const keyword of extractItemKeywords(item)) {
      const match = matchText(keyword, q, allowInner)
      consider(match.tier, match.secondary, MATCH_FIELDS.KEYWORD)
      if (best.tier >= MATCH_TIERS.EXACT) break
    }
  }

  if (allowInner && best.tier < MATCH_TIERS.INNER) {
    const ids = [item.pluginId || item.id, item.featureCode].map((v) => String(v || '').toLowerCase())
    if (ids.some((id) => matchIdentifier(id, q))) consider(MATCH_TIERS.INNER, false, MATCH_FIELDS.ID)
  }

  // 程序与文件的第二行是所在路径，不是描述，不参与匹配（否则 ys 会命中 /System/Applications 下的所有程序）
  if (q.length >= 2 && best.tier === MATCH_TIERS.NONE && item.type !== 'file') {
    const extra = [item.description || item.subtitle, item.category, item.author]
    if (extra.some((value) => typeof value === 'string' && value.toLowerCase().includes(q))) {
      consider(MATCH_TIERS.DESCRIPTION, false, MATCH_FIELDS.DESCRIPTION)
    }
  }

  if (best.tier === MATCH_TIERS.NONE) return NO_ITEM_MATCH
  // 靠触发词等其它字段命中时，不去高亮名称里靠多音字非常用读音碰巧对上的字
  const range = nameMatch && (!nameMatch.secondary || best.field === MATCH_FIELDS.NAME) ? nameMatch.range : null
  return {
    matched: true,
    score: best.tier * 100 + (best.secondary ? 0 : 50) + (3 - best.field) * 10,
    tier: best.tier,
    secondary: best.secondary,
    field: best.field,
    range
  }
}

/**
 * 两个匹配结果的先后：档高的在前；同档时常用读音命中在前，再名称命中在前
 */
export function compareMatches(a, b) {
  return (b?.tier ?? 0) - (a?.tier ?? 0) ||
    Number(Boolean(a?.secondary)) - Number(Boolean(b?.secondary)) ||
    (a?.field ?? 0) - (b?.field ?? 0)
}

/**
 * 过滤并按相关性排序；完全同分时名称短的在前，再保持原顺序
 * @param {Array} items
 * @param {string} query
 * @returns {Array}
 */
export function filterAndRankItems(items, query) {
  if (!Array.isArray(items)) return []
  if (!normalizeQuery(query)) return [...items]

  const scored = []
  items.forEach((item, index) => {
    const match = matchItemWithQuery(item, query)
    if (match.matched) scored.push({ item, match, index, length: String(item?.name || item?.title || '').length })
  })
  scored.sort((a, b) => compareMatches(a.match, b.match) || a.length - b.length || a.index - b.index)
  return scored.map((s) => s.item)
}
