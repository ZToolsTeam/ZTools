<script setup>
import { InfoIcon, MessageSquareIcon, SettingsIcon } from '@lucide/vue'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useNavStore } from '@/stores/nav'
import { ROUTES } from '@/router/routes'
import { feedbackEntry, useFeedbackIndicator } from '@edition'
import { BrandGlyph } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'


const route = useRoute()
const router = useRouter()
const nav = useNavStore()
// 反馈入口的未读提示（官方版登录后拉取未读回复，开源版始终没有）
const { hasUnread: hasUnreadFeedback } = useFeedbackIndicator()

const settingsKey = 'Ctrl+,'

// 响应式路由与即时操作融合的高亮判断：点击瞬间即时高亮反馈，彻底消除假死与卡顿感
const isMyActive = computed(() => {
  if (nav.isInCategoryMode) return false
  if (nav.currentPage) return nav.currentPage === 'my'
  return route.name === 'my' || route.path === '/'
})
// 插件市场：列表页（含任意分类、搜索）都高亮这一项
const isMarketActive = computed(() => {
  if (nav.isInCategoryMode) return true
  if (nav.currentPage) return nav.currentPage === 'list'
  return route.name === 'list'
})

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

const goMyPage = () => {
  nav.setPage('my')
  router.push(ROUTES.HOME)
}
const goMarket = () => {
  nav.setCategory('')
  router.push({ ...ROUTES.LIST, params: { category: '' } })
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
  >
    <nav
      class="sidebar-content h-full flex flex-col overflow-y-auto custom-scrollbar"
      style="width: 208px; padding: 14px 10px"
    >
      <!-- 主导航：主页 / 插件市场。分类只在插件市场页顶部切换，侧栏不再重复列出 -->
      <div class="mb-3 flex flex-col" style="gap: 2px">
        <div class="sidebar-item" :class="{ active: isMyActive }" @click="goMyPage">
          <BrandGlyph kind="home" :size="16" />
          <span>主页</span>
        </div>
        <div class="sidebar-item" :class="{ active: isMarketActive }" @click="goMarket">
          <BrandGlyph kind="store" :size="16" />
          <span>插件市场</span>
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
          <MessageSquareIcon class="w-4 h-4" />
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
          <SettingsIcon class="w-4 h-4" />
          <span class="flex-1">设置</span>
          <ShortcutKeys :combo="settingsKey" class="sidebar-kbd" />
        </div>
        <div
          class="sidebar-item is-quiet"
          :class="{ active: isAboutActive }"
          @click="goAbout"
        >
          <InfoIcon class="w-4 h-4" />
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



.sidebar-item.is-quiet:not(.active) {
  color: var(--rc-text-muted);
}
.sidebar-kbd {
  margin-left: auto;
  opacity: 0.85;
}
</style>
