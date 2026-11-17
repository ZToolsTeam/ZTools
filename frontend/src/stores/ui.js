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
    // 记录进入声明式舞台前的焦点状态，供退出插件时恢复原焦点位置
    previousFocusState: FOCUS_STATES.SEARCH,
    // 声明式舞台当前首要 Action（用于主界面底栏动态联动）
    declarativePrimaryAction: null,
    // 主界面动作面板可见性
    globalActionPanelVisible: false,
    // 底栏「动作 Ctrl+K」按钮触发递增信号，供当前激活页面打开聚焦项动作菜单
    actionPanelTriggerSeq: 0,
    // 顶栏搜索输入框是否正处于真实 DOM 聚焦态（用于消除搜索框与网格双焦点光环并存）
    searchInputActive: false,
    // 侧边栏收起状态：默认 false（展开显示图标和文字），收起时只显示图标
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
    isSearchInputActive: (state) => Boolean(state.searchInputActive),
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
    setSearchInputActive(active) {
      this.searchInputActive = Boolean(active)
    },
    focusSearch() {
      this.setFocusState(FOCUS_STATES.SEARCH)
    },
    focusGrid() {
      this.searchInputActive = false
      this.setFocusState(FOCUS_STATES.GRID)
    },
    focusDeclarative() {
      if (this.focusState !== FOCUS_STATES.DECLARATIVE) {
        this.previousFocusState = this.focusState
      }
      this.setFocusState(FOCUS_STATES.DECLARATIVE)
    },
    restoreFocusAfterDeclarative() {
      if (this.previousFocusState === FOCUS_STATES.GRID) {
        this.focusGrid()
      } else {
        this.focusSearch()
      }
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
      this.actionPanelTriggerSeq += 1
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
