<script setup>
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  MessageSquareIcon,
  RotateCwIcon,
  SettingsIcon
} from '@lucide/vue'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { useUIStore } from '@/stores/ui'
import { ROUTES } from '@/router/routes'
import { feedbackEntry, headerExtraComponents, useFeedbackIndicator } from '@edition'
import { BrandGlyph } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { CATEGORY_GLYPHS } from '@/utils/brandIcons'
import { shortcutLabel } from '@/utils/platform'
import { OPEN_SETTINGS_SHORTCUT, SHELL_SHORTCUTS } from '@/utils/shellShortcuts'

const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const categoriesStore = useCategoriesStore()
const pluginsStore = usePluginsStore()
const uiStore = useUIStore()
// 反馈入口的未读提示（官方版登录后拉取未读回复，开源版始终没有）
const { hasUnread: hasUnreadFeedback } = useFeedbackIndicator()

const isCollapsed = computed(() => uiStore.isSidebarCollapsed)
const toggleSidebar = () => uiStore.toggleSidebar()
const settingsKey = OPEN_SETTINGS_SHORTCUT
const toggleSidebarHint = shortcutLabel(SHELL_SHORTCUTS.TOGGLE_SIDEBAR)

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

const isMarketActive = computed(() => isCategoryActive('全部'))

// 插件市场下的具体分类：去掉「全部」（上方已有「插件市场」）；当前系统上没有插件的分类不显示
const categoryItems = computed(() =>
  (categoriesStore.sidebarCategories || []).filter(
    (c) => c.name !== '全部' && pluginsStore.isCategoryVisible(c.name, isCategoryActive(c.name) ? c.name : '')
  )
)

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
  () => [route.name, route.params?.category],
  ([name, cat]) => {
    if (name === 'list') {
      nav.setCategory(cat || '')
    } else if (name) {
      nav.setPage(name)
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

const goMarket = () => {
  selectCategory('全部')
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

// 侧边栏键盘导航：上下方向键与 Home/End 在可见导航项间循环聚焦，右方向键切入主内容网格
const handleSidebarKeydown = (event) => {
  const navEl = event.currentTarget
  if (!navEl || event.ctrlKey || event.metaKey || event.altKey) return

  const targetEl = event.target instanceof Element ? event.target : null
  const activeEl =
    typeof document !== 'undefined' &&
    document.activeElement instanceof Element &&
    navEl.contains(document.activeElement)
      ? document.activeElement
      : null
  const currentItem =
    targetEl?.closest?.('.sidebar-item[tabindex="0"]') ||
    activeEl?.closest?.('.sidebar-item[tabindex="0"]')
  if (!currentItem || !navEl.contains(currentItem)) return

  if (event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    if (typeof document !== 'undefined' && typeof document.activeElement?.blur === 'function') {
      document.activeElement.blur()
    }
    uiStore.focusGrid()
    return
  }

  const items = Array.from(navEl.querySelectorAll('.sidebar-item[tabindex="0"]')).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
    }
    return true
  })
  if (!items.length) return

  const currentIndex = items.indexOf(currentItem)
  if (currentIndex === -1) return

  let nextIndex = -1
  if (event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % items.length
  } else if (event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + items.length) % items.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = items.length - 1
  }

  if (nextIndex !== -1) {
    event.preventDefault()
    event.stopPropagation()
    items[nextIndex]?.focus?.()
  }
}
</script>

<template>
  <aside
    class="sidebar-root h-full select-none flex-shrink-0"
    :class="{ 'is-collapsed': isCollapsed }"
  >
    <nav class="sidebar-content h-full flex flex-col" @keydown="handleSidebarKeydown">
      <!-- 上半区：主页、插件市场及其下属分类 -->
      <div
        class="sidebar-nav-scroll flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col"
        style="gap: 2px"
      >
        <div
          class="sidebar-item"
          role="button"
          tabindex="0"
          :aria-current="isMyActive ? 'page' : undefined"
          :class="{ active: isMyActive }"
          :title="isCollapsed ? '主页' : undefined"
          @click="goMyPage"
          @keydown.enter.prevent="goMyPage"
          @keydown.space.prevent="goMyPage"
        >
          <BrandGlyph kind="home" :size="16" />
          <span v-if="!isCollapsed" class="sidebar-label truncate">主页</span>
        </div>

        <div
          class="sidebar-item"
          role="button"
          tabindex="0"
          :aria-current="isMarketActive ? 'page' : undefined"
          :class="{ active: isMarketActive }"
          :title="isCollapsed ? '插件市场' : undefined"
          @click="goMarket"
          @keydown.enter.prevent="goMarket"
          @keydown.space.prevent="goMarket"
        >
          <BrandGlyph kind="store" :size="16" />
          <span v-if="!isCollapsed" class="sidebar-label truncate">插件市场</span>
        </div>

        <!-- 插件市场下的分类列表 -->
        <div class="sidebar-category-list flex flex-col" style="gap: 2px">
          <!-- 加载中骨架 -->
          <template v-if="categoriesStore.loading || (!categoriesStore.loaded && !categoriesStore.error)">
            <div
              v-for="i in 4"
              :key="'skeleton-' + i"
              class="sidebar-item sidebar-category-item"
              aria-hidden="true"
              style="opacity: 0.4"
            >
              <div class="w-4 h-4 rounded bg-[var(--rc-text-muted)] opacity-30 flex-shrink-0"></div>
              <div
                v-if="!isCollapsed"
                class="h-3 rounded bg-[var(--rc-text-muted)] opacity-30"
                :style="{ width: (40 + i * 12) + 'px' }"
              ></div>
            </div>
          </template>
          <template v-else-if="categoriesStore.error">
            <div
              class="sidebar-item sidebar-category-item"
              role="button"
              tabindex="0"
              :aria-current="undefined"
              :title="isCollapsed ? '重试分类' : undefined"
              @click="retryCategories"
              @keydown.enter.prevent="retryCategories"
              @keydown.space.prevent="retryCategories"
            >
              <RotateCwIcon class="w-4 h-4" />
              <span v-if="!isCollapsed" class="sidebar-label truncate">重试分类</span>
            </div>
          </template>
          <template v-else>
            <div
              v-for="c in categoryItems"
              :key="c.name"
              class="sidebar-item sidebar-category-item"
              role="button"
              tabindex="0"
              :aria-current="isCategoryActive(c.name) ? 'page' : undefined"
              :class="{ active: isCategoryActive(c.name) }"
              :title="isCollapsed ? c.name : undefined"
              @click="selectCategory(c.name)"
              @keydown.enter.prevent="selectCategory(c.name)"
              @keydown.space.prevent="selectCategory(c.name)"
            >
              <BrandGlyph :kind="CATEGORY_GLYPHS[c.name] || 'folder'" :size="16" />
              <span v-if="!isCollapsed" class="sidebar-label truncate">{{ c.name }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 底部区：用户头像昵称、反馈建议、设置、关于、收起/展开按钮 -->
      <div
        class="mt-auto border-t flex-shrink-0 flex flex-col"
        style="
          padding-top: 8px;
          border-color: var(--rc-border);
          gap: 2px;
        "
      >
        <!-- 用户头像与昵称（位于反馈建议按钮上方；官方版显示，开源版为空） -->
        <component
          :is="extraComponent"
          v-for="(extraComponent, index) in headerExtraComponents"
          :key="index"
          :collapsed="isCollapsed"
        />

        <div
          v-if="feedbackEntry.visible"
          class="sidebar-item is-quiet"
          role="button"
          tabindex="0"
          :aria-current="isFeedbackActive ? 'page' : undefined"
          :class="{ active: isFeedbackActive }"
          :title="isCollapsed ? feedbackEntry.title : undefined"
          @click="openFeedback"
          @keydown.enter.prevent="openFeedback"
          @keydown.space.prevent="openFeedback"
        >
          <MessageSquareIcon class="w-4 h-4" />
          <span v-if="!isCollapsed" class="sidebar-label flex items-center gap-1.5 flex-1 min-w-0">
            <span class="truncate">{{ feedbackEntry.title }}</span>
            <span
              v-if="hasUnreadFeedback"
              class="unread-dot ml-auto"
            ></span>
          </span>
          <span
            v-else-if="hasUnreadFeedback"
            class="unread-dot is-collapsed-dot"
          ></span>
        </div>

        <div
          class="sidebar-item"
          role="button"
          tabindex="0"
          :aria-current="isSettingsActive ? 'page' : undefined"
          :class="{ active: isSettingsActive }"
          :title="isCollapsed ? '设置' : undefined"
          @click="goAdvancedSettings"
          @keydown.enter.prevent="goAdvancedSettings"
          @keydown.space.prevent="goAdvancedSettings"
        >
          <SettingsIcon class="w-4 h-4" />
          <template v-if="!isCollapsed">
            <span class="sidebar-label flex-1 truncate">设置</span>
            <ShortcutKeys :combo="settingsKey" class="sidebar-kbd" />
          </template>
        </div>

        <div
          class="sidebar-item is-quiet"
          role="button"
          tabindex="0"
          :aria-current="isAboutActive ? 'page' : undefined"
          :class="{ active: isAboutActive }"
          :title="isCollapsed ? '关于' : undefined"
          @click="goAbout"
          @keydown.enter.prevent="goAbout"
          @keydown.space.prevent="goAbout"
        >
          <InfoIcon class="w-4 h-4" />
          <span v-if="!isCollapsed" class="sidebar-label truncate">关于</span>
        </div>
      </div>
    </nav>

    <!-- 侧边栏右边界上下居中的收起/展开按钮 -->
    <button
      type="button"
      class="sidebar-toggle-btn"
      :aria-label="isCollapsed ? '展开侧边栏' : '收起侧边栏'"
      :aria-expanded="!isCollapsed"
      :title="isCollapsed ? `展开侧边栏 (${toggleSidebarHint})` : `收起侧边栏 (${toggleSidebarHint})`"
      @click="toggleSidebar"
    >
      <ChevronRightIcon v-if="isCollapsed" class="w-3.5 h-3.5" />
      <ChevronLeftIcon v-else class="w-3.5 h-3.5" />
    </button>
  </aside>
</template>

<style scoped>
.sidebar-root {
  position: relative;
  z-index: 10;
  width: 168px;
  background-color: var(--rc-side);
  border-right: 1px solid var(--rc-border);
  color: var(--rc-text-primary);
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: width;
}

.sidebar-root.is-collapsed {
  width: 56px;
}

.sidebar-content {
  width: 100%;
  padding: 12px 8px;
  overflow: hidden;
}

.sidebar-root.is-collapsed .sidebar-content {
  padding: 12px 8px;
}

.sidebar-category-item {
  padding-left: 12px;
}

.sidebar-item {
  position: relative;
  height: 32px;
}

.sidebar-item:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1.5px var(--rc-accent);
}

.sidebar-root.is-collapsed .sidebar-item,
.sidebar-root.is-collapsed .sidebar-category-item {
  justify-content: center;
  padding: 0;
  gap: 0;
}

.sidebar-root.is-collapsed .sidebar-item::before {
  position: absolute;
  left: 3px;
}

.unread-dot {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
  flex-shrink: 0;
}

.unread-dot.is-collapsed-dot {
  position: absolute;
  top: 7px;
  right: 9px;
}

.sidebar-item.is-quiet:not(.active) {
  color: var(--rc-text-muted);
}

.sidebar-kbd {
  margin-left: auto;
  opacity: 0.85;
}

.sidebar-toggle-btn {
  position: absolute;
  top: 50%;
  right: 0;
  transform: translate(50%, -50%);
  z-index: 20;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--rc-border);
  border-radius: 9999px;
  background-color: var(--rc-surface);
  color: var(--rc-text-muted);
  box-shadow: var(--rc-shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.08));
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  user-select: none;
}

.sidebar-toggle-btn:hover {
  background-color: var(--rc-surface-hover);
  border-color: var(--rc-border-strong, var(--rc-border));
  color: var(--rc-text-primary);
}

.sidebar-toggle-btn svg {
  flex-shrink: 0;
  color: currentColor;
  transition: color 0.15s ease;
}
</style>
