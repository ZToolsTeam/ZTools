<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import SearchBar from './SearchBar.vue'
import HeaderUser from './HeaderUser.vue'
import HeaderGeekModeTrigger from './HeaderGeekModeTrigger.vue'

import { isNative, sys } from '@/api/apiserver'
import { useUserStore } from '@/stores/user'
import { isOnline } from '@/config/runtime-mode'
import { ROUTES, routeUtils } from '@/router/routes'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const keyword = ref('')
const searchBarRef = ref(null)
const searchPlaceholder = ref('搜索插件与命令...')
const searchFocusTimers = new Set()

const isDevelopment = import.meta.env.DEV
const isNativeDebug = ref(false)
const isWindowsPlatform = ref(typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows'))

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
  searchBarRef.value?.focusInput()
}

const clearSearchFocusTimers = () => {
  searchFocusTimers.forEach((timer) => window.clearTimeout(timer))
  searchFocusTimers.clear()
}

const scheduleSearchFocus = () => {
  clearSearchFocusTimers()

  // CEF 首次显示窗口时可能晚于 Vue 挂载，短延迟重试确保焦点落到输入框。
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
      height: 44px;
      background: var(--rc-surface-translucent, var(--rc-surface));
      border-color: var(--rc-border);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-app-region: drag;
    "
  >
    <div
      class="h-full w-full flex items-center justify-between"
      :style="{
        paddingLeft: '16px',
        paddingRight: isWindowsPlatform ? '142px' : '16px'
      }"
    >
      <!-- Logo区域 -->
      <div class="flex items-center" style="gap: 8px; -webkit-app-region: no-drag">
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
