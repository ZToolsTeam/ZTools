<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { useUIStore } from '@/stores/ui'
import { ROUTES } from '@/router/routes'
import { feedbackEntry, useFeedbackIndicator } from '@edition'
import { BrandGlyph } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { CATEGORY_GLYPHS } from '@/utils/brandIcons'

defineProps({ activeCategory: String })

const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const categoriesStore = useCategoriesStore()
const pluginsStore = usePluginsStore()
// 反馈入口的未读提示（官方版登录后拉取未读回复，开源版始终没有）
const { hasUnread: hasUnreadFeedback } = useFeedbackIndicator()
const uiStore = useUIStore()

const isCollapsed = computed(() => uiStore.isSidebarCollapsed)
// 「全部」由上方的「插件市场」承担，分类区只列具体分类
// 去掉「全部」（上面已有「插件市场」）；当前系统上没有插件的分类不显示
const categoryItems = computed(() =>
  (categoriesStore.sidebarCategories || []).filter(
    (c) => c.name !== '全部' && pluginsStore.isCategoryVisible(c.name, isCategoryActive(c.name) ? c.name : '')
  )
)
const settingsKey = 'Ctrl+,'

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
const isFeedbackActive = computed(() => {
  const name = feedbackEntry.routeName
  if (!name || nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === name
  return route.name === name
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
  pluginsStore.refreshCategoryCounts()
})

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
// 反馈建议：官方版进入端内反馈页，开源版在浏览器打开 GitHub Issues
const openFeedback = () => {
  if (feedbackEntry.routeName) {
    nav.setPage(feedbackEntry.routeName)
    router.push({ name: feedbackEntry.routeName })
    return
  }
  const url = feedbackEntry.externalUrl
  if (!url) return
  const warn = (err) => console.warn('[Sidebar] 打开反馈页面失败:', err)
  if (window.ztools?.shell?.openExternal) {
    // 宿主接口可能同步抛错，也可能返回失败的 Promise，两种都只记日志
    try {
      Promise.resolve(window.ztools.shell.openExternal(url)).catch(warn)
    } catch (err) {
      warn(err)
    }
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
const goAbout = () => {
  nav.setPage('about')
  router.push(ROUTES.ABOUT)
}
</script>

<template>
  <aside
    class="sidebar-root h-full select-none flex-shrink-0"
    :class="{ 'is-collapsed': isCollapsed }"
    :aria-hidden="isCollapsed"
  >
    <nav
      class="sidebar-content h-full flex flex-col overflow-y-auto custom-scrollbar"
      style="width: 208px; padding: 14px 10px"
    >
      <!-- 主导航：主页 / 插件市场（与设计稿一致） -->
      <div class="mb-3 flex flex-col" style="gap: 2px">
        <div class="sidebar-item" :class="{ active: isMyActive }" @click="goMyPage">
          <BrandGlyph kind="home" :size="16" />
          <span>主页</span>
        </div>
        <div class="sidebar-item" :class="{ active: isCategoryActive('全部') }" @click="selectCategory('全部')">
          <BrandGlyph kind="store" :size="16" />
          <span>插件市场</span>
        </div>
      </div>

      <!-- 分类导航 (CATEGORIES) -->
      <div class="mb-3">
        <div
          class="sidebar-section-title"
        >
          分类
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
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
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
              v-for="c in categoryItems"
              :key="c.name"
              @click="selectCategory(c.name)"
            >
              <BrandGlyph :kind="CATEGORY_GLYPHS[c.name] || 'folder'" :size="16" />
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
          v-if="feedbackEntry.visible"
          class="sidebar-item is-quiet"
          :class="{ active: isFeedbackActive }"
          @click="openFeedback"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="flex items-center gap-1.5 flex-1 min-w-0">
            <span class="truncate">{{ feedbackEntry.title }}</span>
            <span
              v-if="hasUnreadFeedback"
              class="unread-dot ml-auto"
            ></span>
          </span>
        </div>
        <div
          class="sidebar-item"
          :class="{ active: isSettingsActive }"
          @click="goAdvancedSettings"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span class="flex-1">设置</span>
          <ShortcutKeys :combo="settingsKey" class="sidebar-kbd" />
        </div>
        <div
          class="sidebar-item is-quiet"
          :class="{ active: isAboutActive }"
          @click="goAbout"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
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

<style scoped>
.sidebar-root {
  width: 208px;
  background-color: var(--rc-side);
  border-right: 1px solid var(--rc-border);
  color: var(--rc-text-primary);
  overflow: hidden;
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.18s ease;
  will-change: width, opacity;
}

.sidebar-root.is-collapsed {
  width: 0px !important;
  opacity: 0;
  border-right-color: transparent;
  pointer-events: none;
}

.sidebar-content {
  width: 208px;
  min-width: 208px;
}

.unread-dot {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.sidebar-section-title {
  padding: 6px 10px 6px 22px;
  font-size: 12px;
  color: var(--rc-text-faint);
  user-select: none;
}


.sidebar-item.is-quiet:not(.active) {
  color: var(--rc-text-muted);
}
.sidebar-kbd {
  margin-left: auto;
  opacity: 0.85;
}
</style>
