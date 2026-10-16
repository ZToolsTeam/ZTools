<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import SearchBar from './SearchBar.vue'
import HeaderUser from './HeaderUser.vue'
import HeaderGeekModeTrigger from './HeaderGeekModeTrigger.vue'

import { isNative, sys } from '@/api/apiserver'
import { useUserStore } from '@/stores/user'
import { useUIStore } from '@/stores/ui'
import { useNavStore } from '@/stores/nav'
import { isOnline } from '@/config/runtime-mode'
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
  if (route.name === 'wish-wall') return '反馈建议'
  if (route.name === 'advanced-settings') return '偏好设置'
  if (route.name === 'about') return '关于'
  return ''
})

const keyword = ref('')
const searchBarRef = ref(null)
const searchPlaceholder = ref('搜索插件与命令...')
const searchFocusTimers = new Set()

const isDevelopment = import.meta.env.DEV
const isNativeDebug = ref(false)
const isWindowsPlatform = ref(
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
)

// 诊断/调试信息显示逻辑：
// 1. 如果是原生壳子环境(isNative)，严格遵循后端返回的 debug 标识
// 2. 如果是纯网页开发环境(Mock)，遵循 Vite 的开发模式标识
const showDebugInfo = computed(() => {
  if (isNative) return isNativeDebug.value
  return isDevelopment
})

const showDiagnostics = computed(() => {
  if (isNative) return isNativeDebug.value
  return isDevelopment
})

const contactQrcodeUrl = 'https://www.ztools.cn/assets/ztools_qrcode.png'

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

// 打开联系二维码
const openContactQrcode = () => {
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(contactQrcodeUrl)
    return
  }

  window.open(contactQrcodeUrl, '_blank', 'noopener,noreferrer')
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
      height: 46px;
      background: var(--rc-surface-translucent, var(--rc-surface));
      border-color: var(--rc-border-subtle, var(--rc-border));
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      -webkit-app-region: drag;
    "
  >
    <div
      class="h-full w-full flex items-center justify-between"
      :style="{
        paddingLeft: isMacPlatform ? '78px' : '14px',
        paddingRight: isWindowsPlatform ? '142px' : '14px'
      }"
    >
      <!-- Logo与侧栏折叠控制区域 -->
      <div class="flex items-center" style="gap: 8px; -webkit-app-region: no-drag">
        <!-- 侧栏折叠/展开切换按钮 (macOS 风格) -->
        <button
          type="button"
          class="sidebar-toggle-btn"
          :class="{ 'is-active': !isSidebarCollapsed }"
          :title="
            isSidebarCollapsed
              ? (isMacPlatform ? '展开侧边栏 (⌘B)' : '展开侧边栏 (Ctrl+B)')
              : (isMacPlatform ? '收起侧边栏 (⌘B)' : '收起侧边栏 (Ctrl+B)')
          "
          @click="toggleSidebar"
        >
          <svg
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>

        <!-- Logo -->
        <button
          @click="goHome"
          class="flex items-center hover:opacity-85 transition-opacity"
          style="gap: 6px; cursor: pointer"
        >
          <div class="w-6 h-6 rounded-lg bg-[var(--rc-accent)] flex items-center justify-center text-white font-bold text-xs shadow-sm">
            Z
          </div>
          <span
            class="font-semibold text-sm tracking-tight"
            style="color: var(--rc-text-primary)"
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
          <span class="w-1.5 h-1.5 rounded-full bg-[var(--rc-accent)]"></span>
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
          :title="isNative ? '已连接 ZTools 原生接口' : '使用 Mock API（开发模式）'"
        >
          {{ isNative ? 'Native' : 'Mock' }}
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
        <!-- 用户信息组件 -->
        <HeaderUser v-if="isOnline" />
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
  border-radius: var(--rc-radius-md, 6px);
  color: var(--rc-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}

.sidebar-toggle-btn:hover {
  background-color: var(--rc-surface-hover);
  color: var(--rc-text-primary);
  border-color: var(--rc-border-subtle);
}

.sidebar-toggle-btn:active {
  transform: scale(0.95);
}

.sidebar-toggle-btn.is-active {
  color: var(--rc-text-primary);
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

.contact-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #cfe0ff;
  border-radius: 10px;
  background: #f4f8ff;
  color: #2f6fee;
  font-size: var(--font-size-body-s);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all var(--duration-fast) var(--easing-ease);
}

.contact-btn:hover {
  border-color: #8db4ff;
  background: #edf4ff;
}

.contact-btn:active {
  transform: scale(0.97);
}
</style>
