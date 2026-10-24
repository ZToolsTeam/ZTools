import { parseNumericVersionParts } from './version'

export function toThreePartVersion(version) {
  const value = String(version ?? '').trim()
  if (!value) return ''

  const parts = parseNumericVersionParts(value)
  if (!parts || parts.length < 4) return value

  return parts.slice(0, 3).join('.')
}

export function formatVersionForDisplay(version, fallback = '--') {
  return String(version ?? '').trim() || fallback
}
