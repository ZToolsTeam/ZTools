<script setup>
import { computed, watch, onMounted } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import Header from '@/components/Header.vue'
import Sidebar from '@/components/Sidebar.vue'
import LoginModal from '@/components/LoginModal.vue'

import { useNavStore } from '@/stores/nav'
import { useUIStore } from '@/stores/ui'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { isOnline } from '@/config/runtime-mode'
import { ROUTES } from '@/router/routes'


const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const uiStore = useUIStore()

const { declarativePrimaryAction } = storeToRefs(uiStore)

const isDeclarativeView = computed(() => route.name === 'declarative')

onMounted(() => {
  // console.log('MainLayout mounted')
})

// 根据路由同步导航状态：列表页同步分类，其它页面同步页面标识
watch(
  () => ({ name: route.name, category: route.params.category }),
  (r) => {
    if (r.name === 'list') {
      nav.setCategory(r.category)
    } else if (r.name) {
      nav.setPage(r.name)
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
  'Cmd+S': () => {
    uiStore.toggleSidebar()
    return true
  },
  'Ctrl+,': () => {
    nav.setPage('advanced-settings')
    if (route.name !== 'advanced-settings') router.push(ROUTES.ADVANCED_SETTINGS)
    return true
  },
  'Ctrl+M': () => {
    switchWindowMode(WINDOW_MODES.LAUNCHER).catch(() => {})
    return true
  },
  'Escape': () => {
    if (route.name === 'declarative') {
      router.push('/')
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
      <Sidebar v-if="!isDeclarativeView" :activeCategory="nav.currentCategory" />
      <main
        class="flex-1 overflow-y-auto custom-scrollbar"
        :style="{
          background: 'var(--rc-canvas)',
          padding: isDeclarativeView ? '0' : '14px 18px'
        }"
      >
        <router-view v-slot="{ Component }">
          <component :is="Component" :key="$route.fullPath" />
        </router-view>
      </main>
    </div>

    <!-- 底部动作栏：左侧当前可执行动作，右侧全局快捷键；按平台显示 ⌘ / Ctrl -->
    <footer v-if="!isDeclarativeView" class="action-bar select-none">
      <div class="flex items-center gap-4">
        <span class="action-hint is-primary">
          {{ isDeclarativeView ? (declarativePrimaryAction?.title || '执行') : '打开' }}
          <ShortcutKeys combo="Enter" />
        </span>
        <button
          v-if="route.name !== 'my'"
          type="button"
          class="action-hint"
          @click="handleBackToHome"
        >
          {{ isDeclarativeView ? '返回工作台' : '返回主页' }}
          <ShortcutKeys combo="Escape" />
        </button>
      </div>

      <div class="flex items-center gap-1">
        <button
          type="button"
          class="action-btn"
          :title="uiStore.isSidebarCollapsed ? '展开分类侧栏' : '收起分类侧栏'"
          @click="uiStore.toggleSidebar"
        >
          {{ uiStore.isSidebarCollapsed ? '展开侧栏' : '收起侧栏' }}
          <ShortcutKeys combo="Ctrl+B" />
        </button>
        <button type="button" class="action-btn" @click="openGlobalActions">
          动作
          <ShortcutKeys combo="Ctrl+K" />
        </button>
        <button type="button" class="action-btn" @click="openSearchOrActions">
          搜索
          <ShortcutKeys combo="Ctrl+F" />
        </button>
      </div>
    </footer>

    <!-- 登录弹窗 -->
    <LoginModal v-if="isOnline" />
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
