function normalizeError(error) {
  const normalized = {
    name: error.name || 'Error',
    message: error.message || String(error)
  }

  if (error.stack) {
    normalized.stack = error.stack
  }

  for (const key of Object.keys(error)) {
    normalized[key] = error[key]
  }

  return normalized
}

export function formatLogArg(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value
  if (type === 'string') return value
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value)
  if (type === 'symbol') return value.toString()
  if (type === 'function') return `[Function ${value.name || 'anonymous'}]`

  const seen = new WeakSet()

  try {
    const json = JSON.stringify(value instanceof Error ? normalizeError(value) : value, (_key, item) => {
      if (item instanceof Error) {
        return normalizeError(item)
      }

      const itemType = typeof item
      if (itemType === 'bigint') return item.toString()
      if (itemType === 'symbol') return item.toString()
      if (itemType === 'function') return `[Function ${item.name || 'anonymous'}]`

      if (item && itemType === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }

      return item
    })

    if (json !== undefined) return json
  } catch (error) {
    return `[Unserializable ${Object.prototype.toString.call(value)}: ${error.message}]`
  }

  return String(value)
}
