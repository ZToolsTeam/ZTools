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
import { useKeymap, KEYMAP_SCOPES, OPEN_SETTINGS_SHORTCUT } from '@/utils/keymap'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { layoutExtraComponents } from '@edition'
import { ROUTES } from '@/router/routes'


const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const uiStore = useUIStore()
const categoriesStore = useCategoriesStore()
const pluginsStore = usePluginsStore()

const mainScrollRef = ref(null)
const workbenchScrollPositions = new Map()

const isDeclarativeView = computed(() => route.name === 'declarative')

function onMainScroll(event) {
  if (isDeclarativeView.value) return
  const target = event?.target || mainScrollRef.value
  if (target && typeof target.scrollTop === 'number' && route.fullPath) {
    workbenchScrollPositions.set(route.fullPath, target.scrollTop)
  }
}

// 插件市场页只换搜索词时复用同一个页面（页面自己监听搜索词重新加载），其它情况按完整地址重建
const routeViewKey = computed(() => {
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
const showOpenHint = computed(() => route.name === 'my' || route.name === 'list')
const showActionPanelBtn = computed(() => route.name === 'my' || route.name === 'list')
const isDetails = computed(() => route.name === 'details')

// 全局基础快捷键调度 (GLOBAL 作用域)
useKeymap(KEYMAP_SCOPES.GLOBAL, {
  'Ctrl+F': () => {
    openSearchOrActions()
    return true
  },
  'Ctrl+K': () => {
    openGlobalActions()
    return true
  },
  'Ctrl+B': () => {
    uiStore.toggleSidebar()
    return true
  },
  'Cmd+B': () => {
    uiStore.toggleSidebar()
    return true
  },
  [OPEN_SETTINGS_SHORTCUT]: () => {
    nav.setPage('advanced-settings')
    if (route.name !== 'advanced-settings') router.push(ROUTES.ADVANCED_SETTINGS)
    return true
  },
  'Ctrl+M': () => {
    switchWindowMode(WINDOW_MODES.LAUNCHER).catch((err) => console.warn('[MainLayout] 切换极客条模式失败:', err))
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
      <main
        ref="mainScrollRef"
        class="flex-1 overflow-y-auto custom-scrollbar"
        :style="{
          background: 'var(--rc-canvas)',
          padding: isDeclarativeView ? '0' : '14px 18px'
        }"
        @scroll.passive="onMainScroll"
      >
        <router-view v-slot="{ Component }">
          <keep-alive :exclude="['DeclarativePage']" :max="8">
            <component :is="Component" :key="routeViewKey" />
          </keep-alive>
        </router-view>
      </main>
    </div>

    <!-- 底部动作栏：左侧当前可执行动作，右侧全局快捷键；按平台显示 ⌘ / Ctrl -->
    <footer v-if="!isDeclarativeView" class="action-bar select-none">
      <div class="flex items-center gap-4">
        <span v-if="showOpenHint" class="action-hint is-primary">
          打开
          <ShortcutKeys combo="Enter" />
        </span>
        <button
          v-if="route.name !== 'my'"
          type="button"
          class="action-hint"
          @click="isDetails ? goBackFromDetails() : handleBackToHome()"
        >
          {{ isDetails ? '返回' : '返回主页' }}
          <ShortcutKeys combo="Escape" />
        </button>
      </div>

      <div class="flex items-center gap-1">
        <button v-if="showActionPanelBtn" type="button" class="action-btn" @click="openGlobalActions">
          动作
          <ShortcutKeys combo="Ctrl+K" />
        </button>
        <button type="button" class="action-btn" @click="openSearchOrActions">
          搜索
          <ShortcutKeys combo="Ctrl+F" />
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
  font-size: 12px;
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
  border-radius: 6px;
  background: transparent;
  font: inherit;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
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
