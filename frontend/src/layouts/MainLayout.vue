<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useRoute, useRouter } from 'vue-router'

import Header from '@/components/Header.vue'
import Sidebar from '@/components/Sidebar.vue'

import { useNavStore, isWorkbenchRouteName } from '@/stores/nav'
import { useUIStore } from '@/stores/ui'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'
import { OPEN_SETTINGS_SHORTCUT, SHELL_SHORTCUTS, TOGGLE_MODE_SHORTCUT } from '@/utils/shellShortcuts'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { layoutExtraComponents } from '@edition'
import { ROUTES } from '@/router/routes'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const uiStore = useUIStore()
const categoriesStore = useCategoriesStore()
const pluginsStore = usePluginsStore()

const mainScrollRef = ref(null)
const activePage = ref(null)
const workbenchScrollPositions = new Map()

const isDeclarativeView = computed(() => route.name === 'declarative')

function onMainScroll(event) {
  if (isDeclarativeView.value) return
  const target = event?.target || mainScrollRef.value
  if (target && typeof target.scrollTop === 'number' && route.fullPath) {
    workbenchScrollPositions.set(route.fullPath, target.scrollTop)
  }
}

// 插件市场页只换搜索词、设置页只换查询参数时均复用同一页面实例，避免清理一次性深链参数时被 keep-alive 切回旧状态
const routeViewKey = computed(() => {
  if (route.name === ROUTES.ADVANCED_SETTINGS.name) return ROUTES.ADVANCED_SETTINGS.name
  if (route.name !== ROUTES.LIST.name) return route.fullPath
  const { q: _q, ...rest } = route.query
  return router.resolve({ name: ROUTES.LIST.name, params: route.params, query: rest }).fullPath
})

// 启动后预取分类与插件目录：分类给插件市场用；目录统计会同时同步下架状态，主页上已安装插件的「已下架」标记依赖它
onMounted(() => {
  categoriesStore.fetchCategories()
  pluginsStore.refreshCategoryCounts()
})

// 根据路由同步导航状态、记录打开插件前的工作台路由，并在进出未分离插件时保存/恢复主内容区滚动位置
watch(
  () => ({
    name: route.name,
    category: route.params.category,
    path: route.path,
    fullPath: route.fullPath,
    params: route.params,
    query: route.query
  }),
  (toRoute, fromRoute) => {
    if (toRoute.name === 'list') {
      nav.setCategory(toRoute.category)
    } else if (toRoute.name) {
      nav.setPage(toRoute.name)
    }

    if (isWorkbenchRouteName(toRoute.name)) {
      nav.recordWorkbenchRoute(toRoute)
      if (fromRoute?.name === 'declarative') {
        nav.markEnteredDeclarative(false)
        const savedScrollTop = workbenchScrollPositions.get(toRoute.fullPath) ?? 0
        nextTick(() => {
          if (mainScrollRef.value) {
            mainScrollRef.value.scrollTop = savedScrollTop
          }
        })
      }
    } else if (toRoute.name === 'declarative') {
      if (fromRoute && isWorkbenchRouteName(fromRoute.name)) {
        if (
          fromRoute.fullPath &&
          !workbenchScrollPositions.has(fromRoute.fullPath) &&
          mainScrollRef.value &&
          typeof mainScrollRef.value.scrollTop === 'number'
        ) {
          workbenchScrollPositions.set(fromRoute.fullPath, mainScrollRef.value.scrollTop)
        }
        nav.markEnteredDeclarative(true)
      } else {
        nav.markEnteredDeclarative(false)
      }
    }
  },
  { immediate: true }
)

const openSearchOrActions = () => {
  window.__ztoolsFocusHomeSearch?.()
  uiStore.focusSearch()
}

const openGlobalActions = () => {
  uiStore.toggleGlobalActionPanel()
}

const handleBackToHome = () => {
  nav.setPage('my')
  router.push('/')
}

const goBackFromDetails = () => {
  if (window.history.state?.back) router.back()
  else handleBackToHome()
}

// 底栏左侧「打开 ↵」与右侧「动作 Ctrl+K」只在支持插件卡片交互的主页和插件市场显示
const showCardActions = computed(() => route.name === 'my' || (route.name === 'list' && activePage.value?.hasCardActions))
const isDetails = computed(() => route.name === 'details')

// 全局基础快捷键调度 (GLOBAL 作用域)
useKeymap(KEYMAP_SCOPES.GLOBAL, {
  [SHELL_SHORTCUTS.FOCUS_SEARCH]: () => {
    openSearchOrActions()
    return true
  },
  [SHELL_SHORTCUTS.ACTION_PANEL]: () => {
    if (!showCardActions.value) return false
    openGlobalActions()
    return true
  },
  [SHELL_SHORTCUTS.TOGGLE_SIDEBAR]: () => {
    uiStore.toggleSidebar()
    return true
  },
  [OPEN_SETTINGS_SHORTCUT]: () => {
    nav.setPage('advanced-settings')
    if (route.name !== 'advanced-settings') router.push(ROUTES.ADVANCED_SETTINGS)
    return true
  },
  [TOGGLE_MODE_SHORTCUT]: () => {
    Promise.resolve(switchWindowMode(WINDOW_MODES.LAUNCHER)).catch((err) =>
      console.warn('[MainLayout] 切换极客条模式失败:', err)
    )
    return true
  },
  'Escape': () => {
    if (route.name === 'declarative') {
      nav.exitDeclarativeToWorkbench(router)
      return true
    }
    // 详情页的 Esc 与页面左上角「返回」一致：回到来时的页面（通常是插件市场）
    if (route.name === 'details') {
      goBackFromDetails()
      return true
    }
    if (route.name !== 'my') {
      handleBackToHome()
      return true
    }
    return false
  }
})
</script>

<template>
  <div
    class="h-screen overflow-hidden flex flex-col"
    style="background: var(--rc-canvas); color: var(--rc-text-primary)"
  >
    <Header v-if="!isDeclarativeView" />
    <div class="flex flex-1 overflow-hidden">
      <Sidebar v-if="!isDeclarativeView" />
      <!-- 页面内边距统一由 .rc-page / --rc-page-pad-* 提供，main 自身不再叠加一层 -->
      <main
        ref="mainScrollRef"
        class="flex-1 overflow-y-auto custom-scrollbar"
        :style="{
          background: 'var(--rc-canvas)',
          padding: '0'
        }"
        @scroll.passive="onMainScroll"
      >
        <router-view v-slot="{ Component }">
          <keep-alive :exclude="['DeclarativePage']" :max="8">
            <component :is="Component" :key="routeViewKey" ref="activePage" />
          </keep-alive>
        </router-view>
      </main>
    </div>

    <!-- 底部动作栏：左侧当前可执行动作，右侧全局快捷键；按平台显示 ⌘ / Ctrl -->
    <footer v-if="!isDeclarativeView" class="action-bar select-none">
      <div class="flex items-center gap-4">
        <span v-if="showCardActions" class="action-hint is-primary">
          {{ t('common.open') }}
          <ShortcutKeys combo="Enter" />
        </span>
        <button
          v-if="route.name !== 'my'"
          type="button"
          class="action-hint"
          @click="isDetails ? goBackFromDetails() : handleBackToHome()"
        >
          {{ isDetails ? t('common.back') : t('nav.backToHome') }}
          <ShortcutKeys combo="Escape" />
        </button>
      </div>

      <div class="flex items-center gap-1">
        <button v-if="showCardActions" type="button" class="action-btn" @click="openGlobalActions">
          {{ t('nav.actions') }}
          <ShortcutKeys :combo="SHELL_SHORTCUTS.ACTION_PANEL" />
        </button>
        <button type="button" class="action-btn" @click="openSearchOrActions">
          {{ t('common.search') }}
          <ShortcutKeys :combo="SHELL_SHORTCUTS.FOCUS_SEARCH" />
        </button>
      </div>
    </footer>

    <!-- 版本附加的全局组件（官方版的登录弹窗，开源版没有） -->
    <component
      :is="extraComponent"
      v-for="(extraComponent, index) in layoutExtraComponents"
      :key="index"
    />
  </div>
</template>

<style scoped>
.action-bar {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 18px;
  border-top: 1px solid var(--rc-border);
  background: var(--rc-head);
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
}

.action-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--rc-text-muted);
  cursor: default;
}

button.action-hint {
  cursor: pointer;
}

button.action-hint:hover {
  color: var(--rc-text-primary);
}

.action-hint.is-primary {
  color: var(--rc-text-secondary);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  font: inherit;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: background-color var(--rc-dur) ease, color var(--rc-dur) ease;
}

.action-btn:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.fade-enter-active {
  transition: opacity 0.07s ease-in;
}
.fade-leave-active {
  transition: opacity 0.05s ease-out;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
