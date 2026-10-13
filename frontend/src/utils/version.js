export const NUMERIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:\.\d+)?$/
export const APP_VERSION_PATTERN = /^[0-9]{1,15}\.[0-9]{1,15}\.[0-9]{1,15}(?:\.[0-9]{1,15})?(?![\s\S])/

export function parseNumericVersionParts(version) {
  const value = String(version ?? '').trim()
  if (!NUMERIC_VERSION_PATTERN.test(value)) return null

  return value.split('.').map((part) => Number(part))
}

export function compareNumericVersions(left, right) {
  const leftParts = parseNumericVersionParts(left)
  const rightParts = parseNumericVersionParts(right)
  if (!leftParts || !rightParts) return null

  const len = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < len; i++) {
    const leftValue = leftParts[i] || 0
    const rightValue = rightParts[i] || 0
    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }

  return 0
}

function parseAppVersionParts(version) {
  if (typeof version !== 'string' || !APP_VERSION_PATTERN.test(version)) return null

  const parts = version.split('.').map((part) => Number(part))
  if (parts.length === 3) parts.push(0)
  return parts
}

export function normalizeAppVersion(version) {
  const parts = parseAppVersionParts(version)
  return parts ? parts.join('.') : null
}

export function compareAppVersions(left, right) {
  const leftParts = parseAppVersionParts(left)
  const rightParts = parseAppVersionParts(right)
  if (!leftParts || !rightParts) return null

  for (let i = 0; i < 4; i++) {
    if (leftParts[i] > rightParts[i]) return 1
    if (leftParts[i] < rightParts[i]) return -1
  }

  return 0
}

export function isNumericVersionGte(current, required) {
  const requiredValue = String(required ?? '').trim()
  if (!requiredValue || requiredValue === '1.0.0' || requiredValue === '1.0.0.0') {
    return true
  }

  const compareResult = compareNumericVersions(current, requiredValue)
  return compareResult !== null && compareResult >= 0
}
