(function (global) {
  'use strict'

  // 集合常量集中维护；新增业务集合时在此追加，调用方不要散落硬编码字符串。
  const FUZZY_SEARCH_COLLECTIONS = Object.freeze({
    SUPER_PANEL: 'super_panel'
  })

  const DEFAULT_FIELDS = Object.freeze([
    Object.freeze({ key: 'name', weight: 100, polyphonic: true }),
    Object.freeze({ key: 'keywords', weight: 85 }),
    Object.freeze({ key: 'description', weight: 30, pinyin: false })
  ])

  const MAX_PINYIN_VARIANTS = 12
  const CHINESE_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/

  function normalizeText(value) {
    let text = String(value == null ? '' : value)
    if (typeof text.normalize === 'function') text = text.normalize('NFKC')
    return text.trim().toLocaleLowerCase()
  }

  function compactText(value) {
    return value.replace(/[\s\-_.\\/]+/g, '')
  }

  function toCharacters(value) {
    return Array.from(value)
  }

  function boundedLevenshtein(left, right, maxDistance) {
    const leftChars = toCharacters(left)
    const rightChars = toCharacters(right)
    const leftLength = leftChars.length
    const rightLength = rightChars.length

    if (Math.abs(leftLength - rightLength) > maxDistance) return maxDistance + 1
    if (leftLength === 0) return rightLength
    if (rightLength === 0) return leftLength

    let previous = Array.from({ length: rightLength + 1 }, (_, index) => index)
    let current = new Array(rightLength + 1)

    for (let leftIndex = 1; leftIndex <= leftLength; leftIndex += 1) {
      current[0] = leftIndex
      let rowMinimum = current[0]

      for (let rightIndex = 1; rightIndex <= rightLength; rightIndex += 1) {
        const substitutionCost = leftChars[leftIndex - 1] === rightChars[rightIndex - 1] ? 0 : 1
        current[rightIndex] = Math.min(
          previous[rightIndex] + 1,
          current[rightIndex - 1] + 1,
          previous[rightIndex - 1] + substitutionCost
        )
        rowMinimum = Math.min(rowMinimum, current[rightIndex])
      }

      if (rowMinimum > maxDistance) return maxDistance + 1
      ;[previous, current] = [current, previous]
    }

    return previous[rightLength]
  }

  function maxEditDistance(length) {
    if (length < 3) return 0
    if (length <= 4) return 1
    if (length <= 8) return 2
    return 3
  }

  function editDistanceScore(text, query) {
    const queryLength = toCharacters(query).length
    const allowedDistance = maxEditDistance(queryLength)
    if (allowedDistance === 0) return 0

    const candidates = text
      .split(/[\s\-_.\\/]+/)
      .filter(Boolean)
      .concat(compactText(text))
    let best = 0

    for (const candidate of candidates) {
      const candidateLength = toCharacters(candidate).length
      if (candidateLength < 2 || Math.abs(candidateLength - queryLength) > allowedDistance) continue

      const distance = boundedLevenshtein(query, candidate, allowedDistance)
      if (distance > allowedDistance) continue

      const similarity = 1 - distance / Math.max(queryLength, candidateLength)
      if (similarity >= 0.6) best = Math.max(best, Math.round(620 * similarity))
    }

    return best
  }

  function subsequenceScore(text, query) {
    const textChars = toCharacters(text)
    const queryChars = toCharacters(query)
    if (queryChars.length < 2 || queryChars.length > textChars.length) return 0

    let queryIndex = 0
    let firstMatch = -1
    let lastMatch = -1

    for (let textIndex = 0; textIndex < textChars.length && queryIndex < queryChars.length; textIndex += 1) {
      if (textChars[textIndex] !== queryChars[queryIndex]) continue
      if (firstMatch < 0) firstMatch = textIndex
      lastMatch = textIndex
      queryIndex += 1
    }

    if (queryIndex !== queryChars.length) return 0

    const span = lastMatch - firstMatch + 1
    const gapCount = span - queryChars.length
    const coverage = queryChars.length / textChars.length
    const shortQueryPenalty = queryChars.length === 2 && coverage < 0.25 ? 100 : 0
    return Math.max(180, Math.round(470 + coverage * 120 - gapCount * 14 - firstMatch * 5 - shortQueryPenalty))
  }

  function scoreText(text, query) {
    if (!text || !query) return 0
    if (text === query) return 1000

    let best = 0
    if (text.startsWith(query)) best = Math.max(best, 850 - Math.min(100, text.length - query.length))

    const position = text.indexOf(query)
    if (position >= 0) best = Math.max(best, 700 - Math.min(120, position * 8))

    const words = text.split(/[\s\-_.\\/]+/).filter(Boolean)
    if (words.some(word => word.startsWith(query))) best = Math.max(best, 780)

    const compact = compactText(text)
    const compactQuery = compactText(query)
    if (compact && compactQuery && (compact !== text || compactQuery !== query)) {
      if (compact === compactQuery) best = Math.max(best, 900)
      else if (compact.startsWith(compactQuery)) best = Math.max(best, 760)
      else {
        const compactPosition = compact.indexOf(compactQuery)
        if (compactPosition >= 0) best = Math.max(best, 640 - Math.min(100, compactPosition * 6))
      }
    }

    best = Math.max(best, editDistanceScore(text, query))
    best = Math.max(best, subsequenceScore(compact || text, compactQuery || query))
    return best
  }

  function readPath(target, path) {
    return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), target)
  }

  function addIndexValue(values, value, weight) {
    const normalized = normalizeText(value)
    if (!normalized) return
    const previousWeight = values.get(normalized) || 0
    if (weight > previousWeight) values.set(normalized, weight)
  }

  function addPinyinValues(values, text, includePolyphonic) {
    const api = global.pinyinPro
    if (!CHINESE_PATTERN.test(text) || !api || typeof api.pinyin !== 'function') return

    try {
      const options = { toneType: 'none', type: 'array', nonZh: 'consecutive', v: 'v' }
      const primary = api.pinyin(text, options)
      const primaryInitials = api.pinyin(text, { ...options, pattern: 'first' })
      addIndexValue(values, primary.join(' '), 85)
      addIndexValue(values, primaryInitials.join(''), 75)

      if (!includePolyphonic || typeof api.polyphonic !== 'function') return
      const groups = api.polyphonic(text, options)
      let variantCount = 0
      for (let index = 0; index < groups.length && index < primary.length; index += 1) {
        const alternatives = Array.isArray(groups[index]) ? groups[index] : []
        for (const alternative of alternatives) {
          if (!alternative || normalizeText(alternative) === normalizeText(primary[index])) continue

          const fullVariant = primary.slice()
          const initialsVariant = primaryInitials.slice()
          fullVariant[index] = alternative
          initialsVariant[index] = alternative[0]
          addIndexValue(values, fullVariant.join(' '), 78)
          addIndexValue(values, initialsVariant.join(''), 68)
          variantCount += 1
          if (variantCount >= MAX_PINYIN_VARIANTS) return
        }
      }
    } catch (_) {
      // 拼音是派生索引，转换异常时保留原文索引，不中断整个集合更新。
    }
  }

  function normalizeValues(value, includePinyin, includePolyphonic) {
    const values = Array.isArray(value) ? value : [value]
    const indexedValues = new Map()
    for (const item of values) {
      const text = String(item == null ? '' : item)
      addIndexValue(indexedValues, text, 100)
      if (includePinyin) addPinyinValues(indexedValues, text, includePolyphonic)
    }
    return Array.from(indexedValues, ([text, weight]) => ({ text, weight }))
  }

  function normalizeFields(fields) {
    const source = Array.isArray(fields) && fields.length > 0 ? fields : DEFAULT_FIELDS
    const normalized = source
      .map(field => {
        if (typeof field === 'string') {
          return { key: field, weight: 100, pinyin: true, polyphonic: false }
        }
        if (!field || typeof field !== 'object') return null

        const key = typeof field.key === 'string' ? field.key.trim() : ''
        const getter = typeof field.getValue === 'function' ? field.getValue : null
        const weight = Number(field.weight)
        if (!key && !getter) return null
        return {
          key,
          getter,
          weight: Number.isFinite(weight) && weight > 0 ? weight : 100,
          pinyin: field.pinyin !== false,
          polyphonic: field.polyphonic === true
        }
      })
      .filter(Boolean)

    if (normalized.length === 0) throw new TypeError('模糊搜索集合至少需要一个有效字段')
    return normalized
  }

  function requireCollectionId(collectionId) {
    if (typeof collectionId !== 'string' || collectionId.trim() === '') {
      throw new TypeError('模糊搜索集合标识不能为空')
    }
    return collectionId.trim()
  }

  class FuzzySearchEngine {
    constructor() {
      this._collections = new Map()
    }

    /**
     * fields 支持 key/getValue、weight、pinyin 和 polyphonic；后两项控制派生索引。
     */
    setCollection(collectionId, items, options = {}) {
      const id = requireCollectionId(collectionId)
      if (!Array.isArray(items)) throw new TypeError('模糊搜索集合数据必须是数组')

      const fields = normalizeFields(options.fields)
      const documents = items.map((item, index) => ({
        item,
        index,
        fields: fields.map(field => {
          const rawValue = field.getter ? field.getter(item) : readPath(item, field.key)
          return {
            weight: field.weight,
            values: normalizeValues(rawValue, field.pinyin, field.polyphonic)
          }
        })
      }))

      this._collections.set(id, documents)
      return documents.length
    }

    search(collectionId, query, options = {}) {
      const id = requireCollectionId(collectionId)
      const documents = this._collections.get(id)
      if (!documents) return []

      const normalizedQuery = normalizeText(query)
      const requestedLimit = Number(options.limit)
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : Number.POSITIVE_INFINITY

      if (!normalizedQuery) {
        return documents.slice(0, limit).map(document => ({
          item: document.item,
          score: 0,
          index: document.index
        }))
      }

      const minimumScore = Number.isFinite(Number(options.minimumScore))
        ? Math.max(0, Number(options.minimumScore))
        : 1
      const results = []

      for (const document of documents) {
        let score = 0
        for (const field of document.fields) {
          let fieldScore = 0
          for (const value of field.values) {
            fieldScore = Math.max(
              fieldScore,
              Math.round(scoreText(value.text, normalizedQuery) * value.weight / 100)
            )
          }
          score += Math.round(fieldScore * field.weight / 100)
        }

        if (score >= minimumScore) {
          results.push({ item: document.item, score, index: document.index })
        }
      }

      results.sort((left, right) => right.score - left.score || left.index - right.index)
      return results.slice(0, limit)
    }

    removeCollection(collectionId) {
      return this._collections.delete(requireCollectionId(collectionId))
    }

    clear() {
      this._collections.clear()
    }

    getCollectionSize(collectionId) {
      const documents = this._collections.get(requireCollectionId(collectionId))
      return documents ? documents.length : 0
    }

    isPinyinSupported() {
      return Boolean(global.pinyinPro && typeof global.pinyinPro.pinyin === 'function')
    }
  }

  global.ZToolsFuzzySearch = Object.freeze({
    FUZZY_SEARCH_COLLECTIONS,
    FuzzySearchEngine
  })
})(typeof globalThis !== 'undefined' ? globalThis : window)
