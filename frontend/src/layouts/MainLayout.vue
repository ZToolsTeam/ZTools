<script setup>
import { computed, watch, onMounted } from 'vue'
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
          <transition name="fade" mode="out-in">
            <component :is="Component" :key="$route.fullPath" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- Raycast 风格全局底部状态与动作栏 (Action Bar) -->
    <footer
      v-if="!isDeclarativeView"
      class="border-t flex items-center justify-between select-none px-4"
      style="
        height: 36px;
        background: var(--rc-surface);
        border-color: var(--rc-border);
        font-size: 11px;
        color: var(--rc-text-secondary);
      "
    >
      <!-- 左侧快捷键动作提示 (动态联动声明式应用与当前页面) -->
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1.5 font-medium">
          <kbd class="rc-kbd text-[10px] px-1.5">↵</kbd>
          <span style="color: var(--rc-text-primary)">
            {{ isDeclarativeView ? (declarativePrimaryAction?.title || '执行') : '打开' }}
          </span>
        </div>
        <div
          v-if="route.name !== 'my'"
          class="flex items-center gap-1.5 cursor-pointer hover:opacity-85 transition-opacity"
          @click="handleBackToHome"
        >
          <kbd class="rc-kbd text-[10px] px-1.5">Esc</kbd>
          <span style="color: var(--rc-text-secondary)">
            {{ isDeclarativeView ? '返回工作台' : '返回主页' }}
          </span>
        </div>
      </div>

      <!-- 右侧动作命令提示与状态 (按规范呈现“动作”、“Ctrl+F 搜索”与“侧栏切换”) -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors hover:bg-[var(--rc-surface-hover)] cursor-pointer"
          style="border: 1px solid var(--rc-border-subtle, var(--rc-border)); background: var(--rc-surface-subtle); color: var(--rc-text-secondary);"
          @click="uiStore.toggleSidebar"
          :title="uiStore.isSidebarCollapsed ? '展开分类侧栏' : '收起分类侧栏'"
        >
          <span class="text-xs font-medium">{{ uiStore.isSidebarCollapsed ? '展开侧栏' : '收起侧栏' }}</span>
          <kbd class="rc-kbd text-[10px] ml-1">Ctrl B</kbd>
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors hover:bg-[var(--rc-surface-hover)] cursor-pointer"
          style="border: 1px solid var(--rc-border); background: var(--rc-surface-subtle); color: var(--rc-text-primary);"
          @click="openGlobalActions"
        >
          <span class="text-xs font-medium">动作</span>
          <kbd class="rc-kbd text-[10px] ml-1">Ctrl K</kbd>
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors hover:bg-[var(--rc-surface-hover)] cursor-pointer"
          style="border: 1px solid var(--rc-border); background: var(--rc-surface-subtle); color: var(--rc-text-primary);"
          @click="openSearchOrActions"
        >
          <span class="text-xs font-medium">Ctrl+F 搜索</span>
        </button>
      </div>
    </footer>

    <!-- 登录弹窗 -->
    <LoginModal v-if="isOnline" />
  </div>
</template>

<style scoped>
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
