<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { useFeedbackUnreadStore } from '@/stores/feedbackUnread'
import { useUserStore } from '@/stores/user'
import { ROUTES } from '@/router/routes'
import { isOnline } from '@/config/runtime-mode'

defineProps({ activeCategory: String })

const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const categoriesStore = useCategoriesStore()
const feedbackUnreadStore = useFeedbackUnreadStore()
const userStore = useUserStore()

// 响应式路由与即时操作融合的高亮判断：点击瞬间即时高亮反馈，彻底消除假死与卡顿感
const isMyActive = computed(() => {
  if (nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === 'my'
  return route.name === 'my' || route.path === '/'
})
const isCategoryActive = (categoryName) => {
  if (nav.isInCategoryMode) {
    const curCat = nav.currentCategory || ''
    if (categoryName === '全部' || !categoryName) return !curCat
    return curCat === categoryName
  }
  if (route.name !== 'list') return false
  const curCat = route.params.category || ''
  if (categoryName === '全部' || !categoryName) return !curCat
  return curCat === categoryName
}
const isWishWallActive = computed(() => {
  if (nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === 'wish-wall'
  return route.name === 'wish-wall'
})
const isSettingsActive = computed(() => {
  if (nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === 'advanced-settings'
  return route.name === 'advanced-settings'
})
const isAboutActive = computed(() => {
  if (nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === 'about'
  return route.name === 'about'
})

// 监听路由变更，确保导航状态自动与 URL 对齐
watch(
  () => route.name,
  (name) => {
    if (name === 'list') {
      nav.setCategory(route.params.category || '')
    } else if (name) {
      nav.setPage(name)
    }
  }
)

// 组件挂载时获取分类（带缓存，不会重复请求）
onMounted(() => {
  categoriesStore.fetchCategories()
  if (userStore.isLoggedIn) {
    feedbackUnreadStore.refresh()
  }
})

watch(
  () => userStore.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) {
      feedbackUnreadStore.refresh()
    } else {
      feedbackUnreadStore.clear()
    }
  }
)

const retryCategories = () => {
  categoriesStore.fetchCategories(true)
}
const goMyPage = () => {
  nav.setPage('my')
  router.push(ROUTES.HOME)
}
const selectCategory = (categoryName) => {
  const category = categoryName === '全部' ? '' : categoryName
  nav.setCategory(category)
  router.push({ ...ROUTES.LIST, params: { category } })
}
const goAdvancedSettings = () => {
  nav.setPage('advanced-settings')
  router.push(ROUTES.ADVANCED_SETTINGS)
}
const goWishWall = () => {
  nav.setPage('wish-wall')
  router.push(ROUTES.WISH_WALL)
}
const goAbout = () => {
  nav.setPage('about')
  router.push(ROUTES.ABOUT)
}
</script>

<template>
  <aside
    class="h-full overflow-hidden border-r select-none"
    style="
      width: 168px;
      background-color: var(--rc-surface-subtle);
      border-color: var(--rc-border);
      color: var(--rc-text-primary);
    "
  >
    <nav
      class="h-full flex flex-col overflow-y-auto custom-scrollbar"
      style="padding: 10px 8px"
    >
      <!-- 工作空间分栏 (WORKSPACE) -->
      <div class="mb-3">
        <div
          class="font-semibold tracking-wider uppercase select-none"
          style="
            font-size: 10px;
            padding: 0 8px;
            margin-bottom: 4px;
            color: var(--rc-text-muted);
            letter-spacing: 0.06em;
          "
        >
          工作空间
        </div>
        <div class="flex flex-col" style="gap: 2px">
          <div
            class="sidebar-item"
            :class="{ active: isMyActive }"
            @click="goMyPage"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span>我的插件</span>
          </div>
        </div>
      </div>

      <!-- 分类导航 (CATEGORIES) -->
      <div class="mb-3">
        <div
          class="font-semibold tracking-wider uppercase select-none"
          style="
            font-size: 10px;
            padding: 0 8px;
            margin-bottom: 4px;
            color: var(--rc-text-muted);
            letter-spacing: 0.06em;
          "
        >
          探索分类
        </div>
        <div class="flex flex-col" style="gap: 2px">
          <!-- 加载中骨架 -->
          <template v-if="categoriesStore.loading || (!categoriesStore.loaded && !categoriesStore.error)">
            <div
              v-for="i in 4"
              :key="'skeleton-' + i"
              class="sidebar-item"
              style="opacity: 0.4"
            >
              <div class="w-4 h-4 rounded bg-[var(--rc-text-muted)] opacity-30"></div>
              <div class="h-3 rounded bg-[var(--rc-text-muted)] opacity-30" :style="{ width: (40 + i * 12) + 'px' }"></div>
            </div>
          </template>
          <template v-else-if="categoriesStore.error">
            <div class="sidebar-item" @click="retryCategories">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span>重试分类</span>
            </div>
          </template>
          <!-- 分类列表 -->
          <template v-else>
            <div
              class="sidebar-item"
              :class="{ active: isCategoryActive(c.name) }"
              v-for="c in categoriesStore.sidebarCategories"
              :key="c.name"
              @click="selectCategory(c.name)"
            >
              <svg v-if="c.name === '全部'" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <svg v-else-if="c.name === '系统工具'" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              <svg v-else-if="c.name === '办公效率'" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
              </svg>
              <svg v-else-if="c.name === '媒体处理'" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
              <svg v-else-if="c.name === '安全工具'" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <svg v-else class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span class="truncate">{{ c.name }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 底部系统与帮助区 (SYSTEM) -->
      <div
        class="mt-auto border-t flex flex-col"
        style="
          padding-top: 8px;
          border-color: var(--rc-border);
          gap: 2px;
        "
      >
        <div
          v-if="isOnline"
          class="sidebar-item"
          :class="{ active: isWishWallActive }"
          @click="goWishWall"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="flex items-center gap-1.5 flex-1 min-w-0">
            <span class="truncate">反馈建议</span>
            <span
              v-if="feedbackUnreadStore.hasUnreadReplies"
              class="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse ml-auto"
            ></span>
          </span>
        </div>
        <div
          class="sidebar-item"
          :class="{ active: isSettingsActive }"
          @click="goAdvancedSettings"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>设置</span>
        </div>
        <div
          class="sidebar-item"
          :class="{ active: isAboutActive }"
          @click="goAbout"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>关于</span>
        </div>
      </div>
    </nav>
  </aside>
</template>
