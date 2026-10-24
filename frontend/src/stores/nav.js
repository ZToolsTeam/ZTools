import { defineStore } from 'pinia'

export const useNavStore = defineStore('nav', {
  state: () => ({
    currentCategory: '',
    currentPage: '',
    isInCategoryMode: false
  }),
  actions: {
    setCategory(c) {
      this.currentCategory = c || ''
      this.currentPage = ''
      this.isInCategoryMode = true
    },
    setPage(page) {
      this.currentPage = page
      this.currentCategory = ''
      this.isInCategoryMode = false
    }
  }
})
