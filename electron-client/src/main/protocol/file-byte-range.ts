export function parseFileRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | undefined {
  if (header === null) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return undefined
  const left = match[1] ? Number(match[1]) : undefined, right = match[2] ? Number(match[2]) : undefined
  if ([left, right].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return undefined
  if (left === undefined) {
    if (!right) return undefined
    return { start: Math.max(0, size - right), end: size - 1, partial: true }
  }
  if (left >= size || (right !== undefined && right < left)) return undefined
  return { start: left, end: Math.min(right ?? size - 1, size - 1), partial: true }
}
