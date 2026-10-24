import { describe, expect, it } from 'vitest'
import { formatVersionForDisplay, toThreePartVersion } from '../versionDisplay'

describe('versionDisplay', () => {
  it('产品版本显示完整四段，三段转换工具保持兼容', () => {
    expect(toThreePartVersion('1.2.3.4')).toBe('1.2.3')
    expect(formatVersionForDisplay('10.20.30.40')).toBe('10.20.30.40')
    expect(formatVersionForDisplay('1.2.0.0')).toBe('1.2.0.0')
  })

  it('三段版本和非标准版本保持原样', () => {
    expect(toThreePartVersion('1.2.3')).toBe('1.2.3')
    expect(toThreePartVersion('1.2.3-beta')).toBe('1.2.3-beta')
    expect(toThreePartVersion('1.2.3.4-beta')).toBe('1.2.3.4-beta')
    expect(toThreePartVersion('1.2.3.4.5')).toBe('1.2.3.4.5')
  })

  it('空值使用显示兜底', () => {
    expect(formatVersionForDisplay('')).toBe('--')
    expect(formatVersionForDisplay(null, '0')).toBe('0')
  })
})
