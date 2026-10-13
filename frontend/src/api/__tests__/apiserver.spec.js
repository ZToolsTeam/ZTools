import { describe, it, expect } from 'vitest'
import { slicePage } from '../apiserver'

describe('slicePage', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('第一页', () => {
    expect(slicePage(list, 1, 3)).toEqual([1, 2, 3])
  })

  it('中间页', () => {
    expect(slicePage(list, 2, 3)).toEqual([4, 5, 6])
  })

  it('最后一页（不满）', () => {
    expect(slicePage(list, 4, 3)).toEqual([10])
  })

  it('超出范围返回空数组', () => {
    expect(slicePage(list, 5, 3)).toEqual([])
  })

  it('page 为 0 或负数时从头开始', () => {
    expect(slicePage(list, 0, 3)).toEqual([1, 2, 3])
    expect(slicePage(list, -1, 3)).toEqual([1, 2, 3])
  })

  it('空列表返回空数组', () => {
    expect(slicePage([], 1, 10)).toEqual([])
  })
})
