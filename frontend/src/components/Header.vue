<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import SearchBar from './SearchBar.vue'
import BrandMark from './BrandMark.vue'
import HeaderGeekModeTrigger from './HeaderGeekModeTrigger.vue'

import { isNative, sys } from '@/api/apiserver'
import { useUserStore, headerExtraComponents } from '@edition'
import { ROUTES, routeUtils } from '@/router/routes'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()

const isMacPlatform = ref(
  typeof navigator !== 'undefined' &&
    (navigator.userAgent.includes('Mac') || navigator.platform?.includes('Mac'))
)

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

// 搜索处理：按 Enter 或选「在插件市场搜索」时跳到插件市场
const onSearch = (q) => {
  keyword.value = q
  router.push(routeUtils.toListWithSearch(q))
}

// 已经在插件市场页时，输入即时筛选列表：防抖后替换地址里的搜索词，不新增历史记录
const LIST_FILTER_DEBOUNCE_MS = 250
let listFilterTimer = null
const clearListFilterTimer = () => {
  if (listFilterTimer) clearTimeout(listFilterTimer)
  listFilterTimer = null
}
watch(keyword, () => {
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
  clearListFilterTimer()
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

<style scoped></style>
