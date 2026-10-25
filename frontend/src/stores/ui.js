import { defineStore } from 'pinia'

export const FOCUS_STATES = Object.freeze({
  SEARCH: 'SEARCH',
  GRID: 'GRID',
  DECLARATIVE: 'DECLARATIVE'
})

export const useUIStore = defineStore('ui', {
  state: () => ({
    showCloseConfirm: false,
    closeConfirmOrigin: 'closeButton',
    // 三态焦点状态机：SEARCH (搜索框) | GRID (卡片网格) | DECLARATIVE (声明式舞台)
    focusState: FOCUS_STATES.SEARCH,
    // 声明式舞台当前首要 Action（用于主界面底栏动态联动）
    declarativePrimaryAction: null,
    // 主界面动作面板可见性
    globalActionPanelVisible: false,
    // 侧边栏折叠状态：默认 false（展开，兼顾小白用户首屏发现），支持本地持久化
    sidebarCollapsed: (() => {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          return window.localStorage.getItem('ztools_sidebar_collapsed') === 'true'
        }
      } catch (e) {
        console.warn('[UIStore] 读取侧边栏折叠状态失败:', e)
      }
      return false
    })()
  }),
  getters: {
    isSearchFocused: (state) => state.focusState === FOCUS_STATES.SEARCH,
    isGridFocused: (state) => state.focusState === FOCUS_STATES.GRID,
    isDeclarativeFocused: (state) => state.focusState === FOCUS_STATES.DECLARATIVE,
    isSidebarCollapsed: (state) => Boolean(state.sidebarCollapsed)
  },
  actions: {
    setFocusState(newState) {
      if (!Object.values(FOCUS_STATES).includes(newState)) {
        console.warn(`[UIStore] 无效的焦点状态: ${newState}`)
        return
      }
      this.focusState = newState
    },
    focusSearch() {
      this.setFocusState(FOCUS_STATES.SEARCH)
    },
    focusGrid() {
      this.setFocusState(FOCUS_STATES.GRID)
    },
    focusDeclarative() {
      this.setFocusState(FOCUS_STATES.DECLARATIVE)
    },
    setDeclarativePrimaryAction(action) {
      this.declarativePrimaryAction = action || null
    },
    clearDeclarativePrimaryAction() {
      this.declarativePrimaryAction = null
    },
    setGlobalActionPanelVisible(visible) {
      this.globalActionPanelVisible = Boolean(visible)
    },
    toggleGlobalActionPanel() {
      this.globalActionPanelVisible = !this.globalActionPanelVisible
    },
    openCloseConfirm(origin) {
      this.closeConfirmOrigin = origin || 'closeButton'
      this.showCloseConfirm = true
    },
    closeCloseConfirm() {
      this.showCloseConfirm = false
    },
    setSidebarCollapsed(collapsed) {
      this.sidebarCollapsed = Boolean(collapsed)
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem('ztools_sidebar_collapsed', String(this.sidebarCollapsed))
        }
      } catch (e) {
        console.warn('[UIStore] 保存侧边栏折叠状态失败:', e)
      }
    },
    toggleSidebar() {
      this.setSidebarCollapsed(!this.sidebarCollapsed)
    }
  }
})
