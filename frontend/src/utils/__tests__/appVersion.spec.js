import { describe, expect, it } from 'vitest'
import comparisonCases from '../../../../packages/api/contracts/fixtures/app-version/comparison-cases.json'
import { compareAppVersions, normalizeAppVersion } from '../version'

describe('App version contract', () => {
  it.each(comparisonCases.valid)('accepts and canonicalizes $input', ({ input, canonical }) => {
    expect(normalizeAppVersion(input)).toBe(canonical)
    expect(compareAppVersions(input, canonical)).toBe(0)
  })

  it.each(comparisonCases.invalid)('rejects invalid App version %#', (input) => {
    expect(normalizeAppVersion(input)).toBeNull()
    expect(compareAppVersions(input, '1.2.3')).toBeNull()
    expect(compareAppVersions('1.2.3', input)).toBeNull()
  })

  it.each(comparisonCases.comparisons)(
    'compares $left with $right',
    ({ left, right, result }) => {
      expect(compareAppVersions(left, right)).toBe(result)
    }
  )

  it('accepts the maximum segment width without losing integer precision', () => {
    expect(normalizeAppVersion('999999999999999.0.0')).toBe('999999999999999.0.0.0')
    expect(compareAppVersions('999999999999999.0.0.1', '999999999999998.999.999.999')).toBe(1)
  })

  it('rejects a segment longer than 15 digits even when leading zeroes make its value small', () => {
    expect(normalizeAppVersion('0000000000000000.1.2')).toBeNull()
  })

  it('rejects leading and trailing whitespace including a final line break', () => {
    for (const input of [' 1.2.3', '1.2.3 ', '1.2.3\n']) {
      expect(normalizeAppVersion(input)).toBeNull()
    }
  })
})
