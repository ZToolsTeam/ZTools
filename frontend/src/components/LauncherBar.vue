<template>
  <div
    class="launcher-window-root flex flex-col h-screen w-screen overflow-hidden p-3 select-none"
    @keydown="handleKeyDown"
  >
    <!-- 极客悬浮窗卡片主体 (Mica / Acrylic 亚克力毛玻璃质感) -->
    <div
      class="flex-1 flex flex-col rounded-2xl overflow-hidden border shadow-2xl transition-all duration-200"
      :class="[
        isDark
          ? 'bg-slate-900/90 border-white/15 shadow-black/80 text-slate-100 backdrop-blur-2xl'
          : 'bg-white/95 border-slate-200/90 shadow-slate-900/25 text-slate-800 backdrop-blur-2xl'
      ]"
    >
      <!-- 声明式运行时形态 (当激活官方标杆扩展时直接秒开) -->
      <template v-if="activeDeclarativePlugin && activeDeclarativePlugin.command">
        <div class="flex-1 flex flex-col overflow-hidden p-2">
          <DeclarativeView
            :rootComponent="activeDeclarativePlugin.command"
            @exit="exitDeclarative"
          />
        </div>
      </template>

      <!-- 常规悬浮搜索与候选条目流 -->
      <template v-else>
        <!-- 1. 顶部大号极简搜索栏 -->
        <div
          class="flex items-center px-4 py-3.5 border-b gap-3"
          :class="[isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-100 bg-slate-50/60']"
        >
        <!-- 搜索图标 -->
        <svg
          class="w-5 h-5 flex-shrink-0"
          :class="[isDark ? 'text-sky-400' : 'text-sky-600']"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>

        <!-- 搜索输入框 -->
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          placeholder="搜索插件、工具与命令... (↑↓ 选择，Enter 启动)"
          class="flex-1 bg-transparent text-base font-normal outline-none placeholder:text-slate-400 transition-all"
          :class="[isDark ? 'text-white' : 'text-slate-900']"
          autocomplete="off"
          spellcheck="false"
          @input="onQueryChange"
        />

        <!-- 清空按钮 -->
        <button
          v-if="query"
          class="p-1 rounded-full text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors"
          title="清空 (Esc)"
          @click="clearQuery"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <!-- 安全感回流通道：一键展开完整工作台 -->
        <button
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border shadow-sm cursor-pointer ml-1"
          :class="[
            isDark
              ? 'bg-white/10 hover:bg-white/20 text-slate-200 border-white/10'
              : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
          ]"
          title="展开为完整应用中心大窗口 (Ctrl+M)"
          @click="expandToDashboard"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          <span>展开工作台</span>
          <kbd class="px-1 py-0.2 rounded text-[10px] font-mono opacity-70 bg-black/20">Ctrl+M</kbd>
        </button>

        <!-- 关闭/隐藏工具条 -->
        <button
          class="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-white/10 transition-colors cursor-pointer"
          title="关闭工具条 (Esc)"
          @click="hideLauncher"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <!-- 2. 中间候选列表与智能匹配 -->
      <div
        ref="listContainerRef"
        class="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1 focus:outline-none"
        tabindex="-1"
      >
        <template v-if="filteredItems.length > 0">
          <div
            v-for="(item, index) in filteredItems"
            :key="item.key || item.pluginId || index"
            :ref="el => registerItemEl(index, el)"
            class="flex items-center justify-between px-3.5 py-2.5 rounded-xl cursor-pointer transition-all duration-100"
            :class="[
              activeIndex === index
                ? isDark
                  ? 'bg-sky-500/20 text-white font-medium border border-sky-400/30 shadow-sm'
                  : 'bg-sky-50 text-sky-950 font-medium border border-sky-200 shadow-sm'
                : isDark
                  ? 'text-slate-300 hover:bg-white/5 border border-transparent'
                  : 'text-slate-700 hover:bg-slate-100/70 border border-transparent'
            ]"
            @mouseenter="activeIndex = index"
            @click="executeItem(item)"
          >
            <!-- 左侧图标与文本 (专业精美图标系统，拒绝粗糙单字) -->
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <!-- 渐变色 Squircle 图标容器 -->
              <div
                class="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm flex-shrink-0 shadow-sm"
                :style="{ background: item.iconGradient || 'linear-gradient(135deg, #0ea5e9, #38bdf8)' }"
              >
                <!-- 若有图片 URL -->
                <img
                  v-if="item.icon && (item.icon.startsWith('http') || item.icon.startsWith('data:') || item.icon.startsWith('ztools:'))"
                  :src="item.icon"
                  class="w-5 h-5 object-contain rounded"
                  alt=""
                />
                <!-- 否则使用专业的 FontAwesome 矢量图标 -->
                <i v-else :class="['fa', item.faIcon || 'fa-cube']"></i>
              </div>

              <!-- 标题与副标题 -->
              <div class="flex items-baseline gap-2 min-w-0">
                <span class="truncate text-sm font-medium">{{ item.name || item.title }}</span>
                <span
                  v-if="item.description || item.subtitle"
                  class="text-xs truncate max-w-[340px]"
                  :class="[isDark ? 'text-slate-400' : 'text-slate-500']"
                >
                  {{ item.description || item.subtitle }}
                </span>
              </div>
            </div>

            <!-- 右侧标签与按键操作提示 -->
            <div class="flex items-center gap-2.5 flex-shrink-0 text-xs">
              <span
                v-if="item.badge"
                class="px-2 py-0.5 rounded-md text-[11px] font-medium"
                :class="[
                  isDark
                    ? 'bg-white/10 text-slate-300 border border-white/10'
                    : 'bg-slate-200/70 text-slate-700 border border-slate-200'
                ]"
              >
                {{ item.badge }}
              </span>
              <span
                v-if="activeIndex === index"
                class="flex items-center gap-1 font-mono text-[11px] opacity-80"
                :class="[isDark ? 'text-sky-300' : 'text-sky-700']"
              >
                <span>{{ item.actionLabel || '启动' }}</span>
                <kbd class="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/20 font-bold">↵</kbd>
              </span>
            </div>
          </div>
        </template>

        <!-- 搜索无结果时的空状态引导 -->
        <div
          v-else
          class="flex flex-col items-center justify-center py-10 text-center px-4"
          :class="[isDark ? 'text-slate-400' : 'text-slate-500']"
        >
          <svg class="w-9 h-9 mb-2 opacity-50 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
          <p class="text-sm font-medium mb-1">未在已安装应用中找到 “{{ query }}”</p>
          <p class="text-xs text-slate-400 mb-3">按 Enter 可直接前往插件市场搜索并下载此工具</p>
          <button
            class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-sky-500 hover:bg-sky-600 text-white transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm"
            @click="searchInMarket"
          >
            <span>在插件中心搜索 “{{ query }}”</span>
            <kbd class="px-1.5 bg-white/20 rounded font-mono text-[10px]">↵</kbd>
          </button>
        </div>
      </div>

      <!-- 3. 底部极客状态栏 -->
      <div
        class="px-4 py-2.5 border-t flex items-center justify-between text-xs"
        :class="[isDark ? 'border-white/10 bg-black/40 text-slate-400' : 'border-slate-100 bg-slate-50 text-slate-500']"
      >
        <div class="flex items-center gap-4">
          <div class="flex items-center gap-1.5">
            <kbd class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-white/10">↑↓</kbd>
            <span>选择</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-white/10">↵</kbd>
            <span>启动</span>
          </div>
          <div class="flex items-center gap-1.5">
            <kbd class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-white/10">Ctrl+M</kbd>
            <span>展开大窗口</span>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            class="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 transition-colors cursor-pointer"
            @click="toggleActionPanel"
          >
            <span>动作面板</span>
            <kbd class="px-1 py-0.5 rounded font-mono text-[10px] bg-white/10">Ctrl+K</kbd>
          </button>
          <div class="flex items-center gap-1">
            <kbd class="px-1.5 py-0.5 rounded font-mono text-[10px] bg-white/10">Esc</kbd>
            <span>退出</span>
          </div>
        </div>
      </div>
      </template>
    </div>

    <!-- 动作面板弹窗 (ActionPanelModal) -->
    <ActionPanelModal
      v-if="actionPanelVisible"
      :visible="actionPanelVisible"
      :actions="activeItemActions"
      @close="actionPanelVisible = false"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { usePluginsStore } from '@/stores/plugins'
import { useThemeStore } from '@/stores/theme'
import { switchWindowMode, WINDOW_MODES, windowModeState } from '@/utils/windowMode'
import { getOfficialPlugin, isOfficialPlugin } from '@/utils/officialPlugins'
import { routeUtils } from '@/router/routes'
import { useCommandSearch } from '@/composables/useCommandSearch'
import { useKeymap, KEYMAP_SCOPES, dispatchKeyEvent } from '@/utils/keymap'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import DeclarativeView from '@/declarative/DeclarativeView.vue'

const router = useRouter()
const pluginsStore = usePluginsStore()
const themeStore = useThemeStore()
const isDark = computed(() => themeStore.isDark)

const inputRef = ref(null)
const listContainerRef = ref(null)
const activeIndex = ref(0)
const actionPanelVisible = ref(false)
const activeDeclarativePlugin = ref(null)
const itemElements = new Map()

const {
  query,
  fileResults,
  filteredItems,
  search,
  clearSearch,
  recordUsage
} = useCommandSearch({ enableFileSearch: true })

function registerItemEl(index, el) {
  if (el) itemElements.set(index, el)
  else itemElements.delete(index)
}

// 当前聚焦项的 ActionPanel 动作
const activeItemActions = computed(() => {
  const item = filteredItems.value[activeIndex.value]
  if (!item) return []

  if (item.type === 'file') {
    return [
      {
        type: 'Action',
        props: {
          title: item.isDir ? '打开文件夹' : '打开文件',
          onAction: () => {
            actionPanelVisible.value = false
            openFile(item.path)
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '在资源管理器中定位',
          shortcut: { modifiers: ['Ctrl'], key: 'Enter' },
          onAction: () => {
            actionPanelVisible.value = false
            showInFolder(item.path)
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '复制文件绝对路径',
          shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'C' },
          onAction: () => {
            actionPanelVisible.value = false
            navigator.clipboard.writeText(item.path).catch(() => {})
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '复制文件名',
          shortcut: { modifiers: ['Ctrl'], key: 'C' },
          onAction: () => {
            actionPanelVisible.value = false
            navigator.clipboard.writeText(item.name).catch(() => {})
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '展开为完整工作台',
          shortcut: { modifiers: ['Ctrl'], key: 'M' },
          onAction: () => {
            actionPanelVisible.value = false
            expandToDashboard()
          }
        }
      }
    ]
  }

  const actions = [
    {
      type: 'Action',
      props: {
        title: item.actionLabel || '执行操作',
        onAction: () => {
          actionPanelVisible.value = false
          executeItem(item)
        }
      }
    }
  ]

  if (item.pluginId) {
    actions.push({
      type: 'Action',
      props: {
        title: '在完整工作台查看详情',
        shortcut: { modifiers: ['Ctrl'], key: 'O' },
        onAction: () => {
          actionPanelVisible.value = false
          expandToDashboard()
          router.push(`/details/${item.pluginId}`)
        }
      }
    })
  }

  actions.push({
    type: 'Action',
    props: {
      title: '展开为完整应用中心大窗口',
      shortcut: { modifiers: ['Ctrl'], key: 'M' },
      onAction: () => {
        actionPanelVisible.value = false
        expandToDashboard()
      }
    }
  })

  return actions
})

function scrollToActiveItem() {
  nextTick(() => {
    const el = itemElements.get(activeIndex.value)
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
}

function onQueryChange() {
  activeIndex.value = 0
  scrollToActiveItem()
  search(query.value)
}

function clearQuery() {
  clearSearch()
  activeIndex.value = 0
}

function exitDeclarative() {
  activeDeclarativePlugin.value = null
  nextTick(() => {
    inputRef.value?.focus()
  })
}

// 统一注册极客工具条按键 (PAGE 作用域)
useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowDown': () => {
    if (activeDeclarativePlugin.value) return false
    if (filteredItems.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % filteredItems.value.length
      scrollToActiveItem()
      return true
    }
    return false
  },
  'ArrowUp': () => {
    if (activeDeclarativePlugin.value) return false
    if (filteredItems.value.length > 0) {
      activeIndex.value = (activeIndex.value - 1 + filteredItems.value.length) % filteredItems.value.length
      scrollToActiveItem()
      return true
    }
    return false
  },
  'Enter': () => {
    if (activeDeclarativePlugin.value) return false
    if (filteredItems.value.length > 0) {
      executeItem(filteredItems.value[activeIndex.value])
      return true
    } else if (query.value.trim()) {
      searchInMarket()
      return true
    }
    return false
  },
  'Ctrl+Enter': () => {
    if (activeDeclarativePlugin.value) return false
    const cur = filteredItems.value[activeIndex.value]
    if (cur && cur.type === 'file') {
      showInFolder(cur.path)
      return true
    } else if (cur) {
      executeItem(cur)
      return true
    }
    return false
  },
  'Ctrl+K': () => {
    if (activeDeclarativePlugin.value) return false
    toggleActionPanel()
    return true
  },
  'Ctrl+M': () => {
    expandToDashboard()
    return true
  },
  'Escape': () => {
    if (activeDeclarativePlugin.value) return false
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
      return true
    } else if (query.value) {
      clearQuery()
      return true
    } else {
      hideLauncher()
      return true
    }
  }
})

function handleKeyDown(e) {
  dispatchKeyEvent(e)
}

async function openFile(filePath) {
  hideLauncher()
  if (window.__ztoolsLauncher?.openPath) {
    await window.__ztoolsLauncher.openPath(filePath).catch(() => {})
  } else if (window.ztools?.shell?.openPath) {
    await window.ztools.shell.openPath(filePath).catch(() => {})
  }
}

async function showInFolder(filePath) {
  hideLauncher()
  if (window.__ztoolsLauncher?.showItemInFolder) {
    await window.__ztoolsLauncher.showItemInFolder(filePath).catch(() => {})
  } else if (window.ztools?.shell?.showItemInFolder) {
    await window.ztools.shell.showItemInFolder(filePath).catch(() => {})
  }
}

function executeItem(item) {
  if (!item) return
  recordUsage(item.key || item.pluginId)
  if (item.type === 'file') {
    openFile(item.path)
  } else if (typeof item.action === 'function') {
    item.action()
  } else if (item.pluginId) {
    launchPlugin(item.pluginId)
  }
}

async function launchPlugin(pluginId) {
  const official = getOfficialPlugin(pluginId)
  if (official) {
    // 官方标杆应用：直接在 Launcher 内秒开以声明式模式运行
    activeDeclarativePlugin.value = official
    return
  }

  hideLauncher()
  try {
    await pluginsStore.openPlugin(pluginId)
  } catch (err) {
    console.error('[Launcher] 启动插件失败:', err)
  }
}

function searchInMarket() {
  const q = query.value.trim()
  expandToDashboard()
  router.push({ name: 'list', query: { q } })
}

function toggleActionPanel() {
  actionPanelVisible.value = !actionPanelVisible.value
}

function expandToDashboard() {
  const currentDeclarative = activeDeclarativePlugin.value
  activeDeclarativePlugin.value = null
  if (window.__ztoolsLauncher?.expandToDashboard) {
    window.__ztoolsLauncher.expandToDashboard().catch(() => {})
  } else {
    switchWindowMode(WINDOW_MODES.DASHBOARD)
    if (router.currentRoute.value.path === '/launcher') {
      router.push('/')
    }
  }
  if (currentDeclarative) {
    router.push(routeUtils.toDeclarative(currentDeclarative.pluginId))
  }
}

function hideLauncher() {
  activeDeclarativePlugin.value = null
  if (window.__ztoolsLauncher?.hide) {
    window.__ztoolsLauncher.hide().catch(() => {})
  } else if (window.ztools?.window?.hide) {
    window.ztools.window.hide().catch(() => {})
  }
}

onMounted(async () => {
  window.__ztoolsOpenLauncherDeclarative = (pluginId) => {
    const official = getOfficialPlugin(pluginId)
    if (official) {
      activeDeclarativePlugin.value = official
    }
  }

  if (windowModeState.launcherInitialQuery) {
    query.value = windowModeState.launcherInitialQuery
  }

  await pluginsStore.init()
  await nextTick()
  inputRef.value?.focus()
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    delete window.__ztoolsOpenLauncherDeclarative
  }
})

watch(
  () => windowModeState.launcherInitialQuery,
  (val) => {
    if (val) {
      query.value = val
      onQueryChange()
    }
  }
)
</script>

<style scoped>
.launcher-window-root {
  background: transparent;
  box-sizing: border-box;
}

.custom-scrollbar::-webkit-scrollbar {
  width: 5px;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 4px;
}
</style>
