<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import SearchBar from './SearchBar.vue'
import BrandMark from './BrandMark.vue'
import HeaderGeekModeTrigger from './HeaderGeekModeTrigger.vue'

import { isNative, sys } from '@/api/apiserver'
import { useUserStore, headerExtraComponents, feedbackEntry } from '@edition'
import { useUIStore } from '@/stores/ui'
import { useNavStore } from '@/stores/nav'
import { ROUTES, routeUtils } from '@/router/routes'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const uiStore = useUIStore()
const nav = useNavStore()

const isSidebarCollapsed = computed(() => uiStore.isSidebarCollapsed)
const toggleSidebar = () => uiStore.toggleSidebar()

const isMacPlatform = ref(
  typeof navigator !== 'undefined' &&
    (navigator.userAgent.includes('Mac') || navigator.platform?.includes('Mac'))
)

const currentCategoryTitle = computed(() => {
  if (route.name === 'my') return '我的插件'
  if (route.name === 'list') return nav.currentCategory || '全部插件'
  if (feedbackEntry.routeName && route.name === feedbackEntry.routeName) return feedbackEntry.title
  if (route.name === 'advanced-settings') return '偏好设置'
  if (route.name === 'about') return '关于'
  return ''
})

const keyword = ref('')
const searchBarRef = ref(null)
const searchPlaceholder = ref('搜索插件、命令与文件')
const searchFocusTimers = new Set()

const isDevelopment = import.meta.env.DEV
const isNativeDebug = ref(false)
const isWindowsPlatform = ref(
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
)

// 诊断/调试信息显示逻辑：
// 只在「浏览器 + Mock 接口」的开发模式下提示：此时看到的是模拟数据，需要提醒。
// 运行在客户端里时前端必然连着原生接口，常驻「Native」标记没有信息量，不再显示。
const showDebugInfo = computed(() => !isNative && isDevelopment)

const showDiagnostics = computed(() => {
  if (isNative) return isNativeDebug.value
  return isDevelopment
})

// 检查登录状态
// const isCheckingAuth = computed(() => userStore.isCheckingAuth)

// 搜索处理
const onSearch = (q) => {
  keyword.value = q
  router.push(routeUtils.toListWithSearch(q))
}

// 跳转到诊断页
const goDiagnostics = () => {
  router.push(ROUTES.DIAGNOSTICS)
}

// Logo点击返回首页
const goHome = () => {
  router.push(ROUTES.HOME)
}

const focusSearchInput = async () => {
  await nextTick()
  searchBarRef.value?.focusInput?.()
}

const clearSearchFocusTimers = () => {
  searchFocusTimers.forEach((timer) => window.clearTimeout(timer))
  searchFocusTimers.clear()
}

const scheduleSearchFocus = () => {
  clearSearchFocusTimers()

  // 原生窗口首次显示时可能晚于 Vue 挂载，短延迟重试确保焦点落到输入框。
  const focusDelays = [0, 120, 360]
  focusDelays.forEach((delay) => {
    const timer = window.setTimeout(() => {
      searchFocusTimers.delete(timer)
      focusSearchInput()
    }, delay)
    searchFocusTimers.add(timer)
  })
}

// 初始化
onMounted(async () => {
  window.__ztoolsFocusHomeSearch = scheduleSearchFocus
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
        // macOS：红绿灯 x=18、3×12px + 2×8px 间距，再留 16px 到侧栏按钮（与设计稿一致）
        paddingLeft: isMacPlatform ? '86px' : '14px',
        paddingRight: isWindowsPlatform ? '142px' : '14px'
      }"
    >
      <!-- Logo与侧栏折叠控制区域 -->
      <div class="flex items-center" style="gap: 10px; -webkit-app-region: no-drag">
        <!-- 侧栏折叠/展开切换按钮 (macOS 风格) -->
        <button
          type="button"
          class="sidebar-toggle-btn"
          :class="{ 'is-active': !isSidebarCollapsed }"
          :aria-label="isSidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
          :aria-pressed="!isSidebarCollapsed"
          :title="
            isSidebarCollapsed
              ? (isMacPlatform ? '展开侧边栏 (⌘B)' : '展开侧边栏 (Ctrl+B)')
              : (isMacPlatform ? '收起侧边栏 (⌘B)' : '收起侧边栏 (Ctrl+B)')
          "
          @click="toggleSidebar"
        >
          <!-- 侧栏状态图标：展开时左栏填充，收起时只保留细线 -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="3" />
            <rect class="sidebar-pane" x="5.6" y="7.1" width="3.6" height="9.8" rx="1.1" stroke="none" />
            <path d="M11.5 4.5v15" />
          </svg>
        </button>

        <!-- Logo -->
        <button
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

        <!-- 当侧边栏收起时展示当前分类面包屑胶囊，给小白用户提供确定性指示与快速展开入口 -->
        <div
          v-if="isSidebarCollapsed && currentCategoryTitle"
          class="category-breadcrumb-pill flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium cursor-pointer transition-colors"
          @click="toggleSidebar"
          title="点击展开侧边栏"
        >
          <span class="breadcrumb-marker"></span>
          <span>{{ currentCategoryTitle }}</span>
        </div>

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
          title="当前使用 Mock 接口（浏览器开发模式），数据为模拟数据"
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

      <!-- 右侧操作区 -->
      <div
        class="flex items-center"
        style="gap: 8px; -webkit-app-region: no-drag"
      >
        <!-- 版本附加组件（官方版的用户头像与登录入口，开源版没有） -->
        <component
          :is="extraComponent"
          v-for="(extraComponent, index) in headerExtraComponents"
          :key="index"
        />
      </div>
    </div>
  </header>
</template>

<style scoped>
.sidebar-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--rc-radius-md, 8px);
  color: var(--rc-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.sidebar-toggle-btn:hover {
  background-color: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.sidebar-toggle-btn:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.sidebar-toggle-btn .sidebar-pane {
  fill: currentColor;
  opacity: 0;
  transition: opacity 0.15s ease;
}

/* 侧栏展开：左栏以淡色填充，表示「当前显示中」 */
.sidebar-toggle-btn.is-active .sidebar-pane {
  opacity: 0.35;
}

.category-breadcrumb-pill {
  background-color: var(--rc-surface-subtle);
  color: var(--rc-text-secondary);
  border: 1px solid var(--rc-border-subtle);
}

.category-breadcrumb-pill:hover {
  background-color: var(--rc-surface-hover);
  color: var(--rc-text-primary);
  border-color: var(--rc-border);
}

/* 修复 Ant Design Spin 内部元素的垂直对齐（深度选择器） */
.header-spin :deep(.ant-spin-dot) {
  vertical-align: middle;
  display: inline-flex;
  align-items: center;
}
</style>
