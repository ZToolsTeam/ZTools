import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useNavStore } from '../nav'

describe('useNavStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态正确', () => {
    const store = useNavStore()
    expect(store.currentCategory).toBe('')
    expect(store.currentPage).toBe('')
    expect(store.isInCategoryMode).toBe(false)
  })

  it('setCategory 设置分类并清空 page', () => {
    const store = useNavStore()
    store.setPage('settings')
    store.setCategory('tools')
    expect(store.currentCategory).toBe('tools')
    expect(store.currentPage).toBe('')
    expect(store.isInCategoryMode).toBe(true)
  })

  it('setCategory 传空值时 currentCategory 为空字符串', () => {
    const store = useNavStore()
    store.setCategory(null)
    expect(store.currentCategory).toBe('')
    expect(store.isInCategoryMode).toBe(true)
  })

  it('setPage 设置页面并清空 category', () => {
    const store = useNavStore()
    store.setCategory('tools')
    store.setPage('settings')
    expect(store.currentPage).toBe('settings')
    expect(store.currentCategory).toBe('')
    expect(store.isInCategoryMode).toBe(false)
  })

  it('setCategory 和 setPage 互斥切换', () => {
    const store = useNavStore()
    store.setCategory('design')
    expect(store.isInCategoryMode).toBe(true)
    store.setPage('my')
    expect(store.isInCategoryMode).toBe(false)
    store.setCategory('dev')
    expect(store.isInCategoryMode).toBe(true)
  })
})
