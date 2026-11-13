import { defineStore } from 'pinia'
import { ROUTES } from '@/router/routes'

const NON_WORKBENCH_ROUTE_NAMES = new Set(['declarative', 'popout', 'launcher'])

export function isWorkbenchRouteName(name) {
  return Boolean(name && !NON_WORKBENCH_ROUTE_NAMES.has(String(name)))
}

export const useNavStore = defineStore('nav', {
  state: () => ({
    currentCategory: '',
    currentPage: '',
    isInCategoryMode: false,
    // 记录进入未分离插件前所在的主窗口工作台路由快照，供 Esc 退出插件时精准恢复
    lastWorkbenchRoute: null,
    // 标记当前声明式插件页是否由工作台页面直接推入历史栈（为 true 时优先 router.back() 保持历史栈干净）
    canBackFromDeclarative: false,
    // 跨 Header 卸载/重挂载保留主窗口顶部搜索框输入词
    headerSearchKeyword: ''
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
    },
    recordWorkbenchRoute(routeSnapshot) {
      if (!routeSnapshot || typeof routeSnapshot !== 'object') return
      if (!isWorkbenchRouteName(routeSnapshot.name)) return
      this.lastWorkbenchRoute = {
        name: routeSnapshot.name || '',
        path: routeSnapshot.path || '',
        fullPath: routeSnapshot.fullPath || routeSnapshot.path || '/',
        params: routeSnapshot.params ? { ...routeSnapshot.params } : {},
        query: routeSnapshot.query ? { ...routeSnapshot.query } : {}
      }
    },
    markEnteredDeclarative(fromWorkbench = true) {
      this.canBackFromDeclarative = Boolean(fromWorkbench)
    },
    setHeaderSearchKeyword(keyword) {
      this.headerSearchKeyword = typeof keyword === 'string' ? keyword : ''
    },
    /**
     * 从未分离声明式插件页退出并返回打开插件前的工作台界面
     */
    exitDeclarativeToWorkbench(router) {
      if (!router) return
      if (this.canBackFromDeclarative && typeof router.back === 'function') {
        this.canBackFromDeclarative = false
        router.back()
        return
      }
      this.canBackFromDeclarative = false
      if (this.lastWorkbenchRoute) {
        const target = this.lastWorkbenchRoute.fullPath || this.lastWorkbenchRoute
        router.push(target)
        return
      }
      router.push(ROUTES.HOME)
    }
  }
})
