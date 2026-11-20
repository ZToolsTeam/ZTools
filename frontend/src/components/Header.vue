<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getActivePinia } from 'pinia'

import SearchBar from './SearchBar.vue'
import BrandMark from './BrandMark.vue'
import HeaderGeekModeTrigger from './HeaderGeekModeTrigger.vue'

import { isNative, sys } from '@/api/apiserver'
import { useUserStore } from '@edition'
import { useNavStore } from '@/stores/nav'
import { useUIStore } from '@/stores/ui'
import { ROUTES, routeUtils } from '@/router/routes'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const getNavStore = () => (getActivePinia() ? useNavStore() : null)
const getUIStore = () => (getActivePinia() ? useUIStore() : null)

const isMacPlatform = ref(
  typeof navigator !== 'undefined' &&
    (navigator.userAgent.includes('Mac') || navigator.platform?.includes('Mac'))
)

const keyword = ref(getNavStore()?.headerSearchKeyword || '')
const searchBarRef = ref(null)
const homeButtonRef = ref(null)
const searchPlaceholder = computed(() => t('search.placeholder'))
let searchFocusTimer = null
let searchFocusRequest = 0
let preserveHomeFocus = false

const isDevelopment = import.meta.env.DEV
const isNativeDebug = ref(false)
const isWindowsPlatform = ref(
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
)

// 浏览器开发模式显示连接类型；原生客户端默认隐藏该诊断标记。
const showDebugInfo = computed(() => !isNative && isDevelopment)

const showDiagnostics = computed(() => {
  if (isNative) return isNativeDebug.value
  return isDevelopment
})

// 检查登录状态
// const isCheckingAuth = computed(() => userStore.isCheckingAuth)

// 搜索处理：按 Enter 或选「在插件市场搜索」时跳到插件市场
const onSearch = (q) => {
  keyword.value = q
  getNavStore()?.setHeaderSearchKeyword(q)
  router.push(routeUtils.toListWithSearch(q))
}

// 已经在插件市场页时，输入即时筛选列表：防抖后替换地址里的搜索词，不新增历史记录
const LIST_FILTER_DEBOUNCE_MS = 250
let listFilterTimer = null
const clearListFilterTimer = () => {
  if (listFilterTimer) clearTimeout(listFilterTimer)
  listFilterTimer = null
}
watch(keyword, (val) => {
  getNavStore()?.setHeaderSearchKeyword(val)
  clearListFilterTimer()
  if (route.name !== ROUTES.LIST.name) return
  listFilterTimer = setTimeout(() => {
    listFilterTimer = null
    const next = String(keyword.value || '').trim()
    if (route.name !== ROUTES.LIST.name || next === String(route.query.q || '').trim()) return
    const query = { ...route.query }
    if (next) query.q = next
    else delete query.q
    router.replace({ name: ROUTES.LIST.name, params: route.params, query })
      .catch((err) => console.warn('[Header] 更新插件市场搜索词失败:', err))
  }, LIST_FILTER_DEBOUNCE_MS)
})

// 跳转到诊断页
const goDiagnostics = () => {
  router.push(ROUTES.DIAGNOSTICS)
}

// Logo点击返回首页
const goHome = () => {
  router.push(ROUTES.HOME)
}

const focusSearchInput = async (force, request) => {
  await nextTick()
  if (request !== searchFocusRequest) return
  if (!force) {
    // 激活窗口只恢复默认焦点；保留用户在表单、弹窗和键盘导航中的位置。
    if (route.name !== ROUTES.HOME.name) return
    if (getUIStore()?.isGridFocused) return
    const active = document.activeElement
    if (active === homeButtonRef.value && preserveHomeFocus) return
    if (active !== document.body && active !== document.documentElement && active !== homeButtonRef.value) return
    if ([...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .some((dialog) => dialog.getClientRects().length > 0)) return
  }
  searchBarRef.value?.focusInput?.()
}

const clearSearchFocusTimers = () => {
  searchFocusRequest += 1
  if (searchFocusTimer !== null) window.clearTimeout(searchFocusTimer)
  searchFocusTimer = null
}

const scheduleSearchFocus = (force = false) => {
  clearSearchFocusTimers()
  const request = searchFocusRequest
  // 等本次原生焦点恢复完成后再处理，不依赖窗口在挂载后的固定毫秒数内出现。
  searchFocusTimer = window.setTimeout(() => {
    searchFocusTimer = null
    void focusSearchInput(force, request)
  }, 0)
}
const handleWindowFocus = () => scheduleSearchFocus()
const focusHomeSearch = () => scheduleSearchFocus(true)
const handleFocusNavigation = (event) => {
  if (event.key === 'Tab') {
    preserveHomeFocus = true
    clearSearchFocusTimers()
  }
}

const handlePointerFocus = (event) => {
  preserveHomeFocus = event.target instanceof Node && Boolean(homeButtonRef.value?.contains(event.target))
  clearSearchFocusTimers()
}

// 初始化
onMounted(async () => {
  window.__ztoolsFocusHomeSearch = focusHomeSearch
  window.addEventListener('focus', handleWindowFocus)
  window.addEventListener('blur', clearSearchFocusTimers)
  window.addEventListener('keydown', handleFocusNavigation)
  window.addEventListener('pointerdown', handlePointerFocus)
  scheduleSearchFocus()

  userStore.checkLoginStatus()
  userStore.initEventListeners()

  // 如果是原生环境，获取系统信息判断是否为 Debug 版本
  if (isNative) {
    try {
      const info = await sys.getInfo()
      isNativeDebug.value = !!info.debug
    } catch (e) {
      console.warn('[Header] 获取系统信息失败:', e)
    }
  }
})

watch(
  () => route.name,
  (name) => {
    if (name === ROUTES.HOME.name) {
      scheduleSearchFocus()
    }
  }
)

// 清理
onUnmounted(() => {
  clearSearchFocusTimers()
  clearListFilterTimer()
  window.removeEventListener('focus', handleWindowFocus)
  window.removeEventListener('blur', clearSearchFocusTimers)
  window.removeEventListener('keydown', handleFocusNavigation)
  window.removeEventListener('pointerdown', handlePointerFocus)
  delete window.__ztoolsFocusHomeSearch
  userStore.cleanupEventListeners()
})
</script>

<template>
  <header
    class="border-b select-none flex items-center justify-between"
    style="
      height: 52px;
      background: var(--rc-head);
      border-color: var(--rc-border);
      -webkit-app-region: drag;
    "
  >
    <div
      class="h-full w-full flex items-center justify-between"
      :style="{
        // macOS：红绿灯 x=18、3×12px + 2×8px 间距，再留 16px 到 Logo
        paddingLeft: isMacPlatform ? '86px' : '14px',
        paddingRight: isWindowsPlatform ? '142px' : '14px'
      }"
    >
      <!-- Logo 区域 -->
      <div class="flex items-center" style="gap: 10px; -webkit-app-region: no-drag">
        <!-- Logo -->
        <button
          ref="homeButtonRef"
          :aria-label="t('header.backToHome')"
          @click="goHome"
          class="flex items-center hover:opacity-85 transition-opacity"
          style="gap: 10px; cursor: pointer"
        >
          <BrandMark :size="20" />
          <span
            class="font-semibold text-sm"
            style="color: var(--rc-text-primary); letter-spacing: -0.02em"
          >
            ZTools
          </span>
        </button>

        <!-- 调试信息 - 仅开发环境显示 -->
        <span
          v-if="showDebugInfo"
          class="inline-flex items-center rounded-full"
          style="
            padding: 1px 7px;
            font-size: 10px;
            font-weight: 600;
            font-family: var(--rc-font-mono);
          "
          :style="{
            backgroundColor: 'var(--rc-surface-subtle)',
            color: 'var(--rc-text-muted)',
            border: '1px solid var(--rc-border)'
          }"
          :title="t('header.mockTooltip')"
        >
          Mock
        </span>
      </div>

      <!-- 搜索框 (Command Bar) 与极客模式切换 -->
      <div
        class="home-search-shell flex-1 max-w-xl mx-4 flex items-center gap-2.5"
        style="-webkit-app-region: no-drag"
      >
        <div class="flex-1">
          <SearchBar
            ref="searchBarRef"
            v-model="keyword"
            :placeholder="searchPlaceholder"
            @search="onSearch"
          />
        </div>
        <HeaderGeekModeTrigger />
      </div>

      <!-- 右侧占位区（用户头像和昵称已移至左侧边栏反馈建议上方） -->
      <div
        class="flex items-center"
        style="gap: 8px; -webkit-app-region: no-drag"
      ></div>
    </div>
  </header>
</template>

<style scoped></style>
