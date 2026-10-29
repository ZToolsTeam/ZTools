<script setup>
import { CircleXIcon, SearchIcon, XIcon } from '@lucide/vue'
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useUIStore } from '@/stores/ui'
import { usePluginsStore } from '@/stores/plugins'
import { useCommandSearch } from '@/composables/useCommandSearch'
import { useToast } from '@/composables/useToast'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { RcButton } from '@/components/base'
import SearchResultRow from '@/components/SearchResultRow.vue'
import { currentGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { executeDeclarativeNoViewCommand } from '@/utils/declarativePluginLoader'


const props = defineProps({
  modelValue: String,
  placeholder: String
})
const emit = defineEmits(['update:modelValue', 'search'])

const uiStore = useUIStore()
const pluginsStore = usePluginsStore()
const { success: toastSuccess, error: toastError } = useToast()

const localValue = ref(props.modelValue || '')
const inputRef = ref(null)
const isFocused = ref(false)
const hintDismissed = ref(false)
const isDropdownOpen = ref(false)
const activeIndex = ref(0)

const {
  query: searchQuery,
  matchedPlugins,
  filteredItems,
  search,
  clearSearch,
  recordUsage,
  highlightParts
} = useCommandSearch({ enableFileSearch: true })

// 候选命令列表：最多前 8 条（插件命令、本地应用与文件），最后一条固定是「在插件市场搜索」
const candidateCommands = computed(() => {
  const source = filteredItems?.value ?? matchedPlugins?.value ?? []
  const keyword = localValue.value.trim()
  if (!keyword) return source.slice(0, 8)
  return [
    ...source.slice(0, 8),
    {
      key: 'market-search',
      type: 'market-search',
      name: `在插件市场搜索「${keyword}」`,
      description: '查找可以安装的插件',
      badge: '插件市场',
      actionLabel: '搜索',
      faIcon: 'fa-search',
      omitFromFrecencyTracking: true
    }
  ]
})

// 候选变少时（文件结果到达）选中项不能落到列表外
watch(() => candidateCommands.value.length, (length) => {
  if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
})

// 键盘上下选择时把选中行滚进可见区域
const rowElements = new Map()
function registerRowEl(index, el) {
  const node = el?.$el ?? el
  if (node) rowElements.set(index, node)
  else rowElements.delete(index)
}
watch(activeIndex, (index) => {
  nextTick(() => rowElements.get(index)?.scrollIntoView?.({ block: 'nearest' }))
})

// 输入只更新下拉候选；跳到插件市场要按 Enter 或选「在插件市场搜索」（插件市场页里的实时筛选由 Header 负责）
watch(localValue, (newVal) => {
  emit('update:modelValue', newVal)
  search(newVal)
  activeIndex.value = 0

  if (isFocused.value && newVal && newVal.trim()) {
    isDropdownOpen.value = true
  }
})

// 同步外部值变化
watch(
  () => props.modelValue,
  (newVal) => {
    if (newVal !== localValue.value) {
      localValue.value = newVal || ''
    }
  }
)

const handleEnter = () => {
  isDropdownOpen.value = false
  emit('search', localValue.value)
}

const onFocus = () => {
  isFocused.value = true
  uiStore.focusSearch()
  if (localValue.value && localValue.value.trim()) {
    isDropdownOpen.value = true
  }
}

const onBlur = () => {
  isFocused.value = false
  // 延时关闭以允许点击候选条目
  setTimeout(() => {
    isDropdownOpen.value = false
  }, 220)
}

const tryGeekLauncher = () => {
  hintDismissed.value = true
  isDropdownOpen.value = false
  switchWindowMode(WINDOW_MODES.LAUNCHER, { initialQuery: localValue.value })
}

const dismissHint = () => {
  hintDismissed.value = true
}

const focusInput = () => {
  inputRef.value?.focus?.()
  inputRef.value?.input?.focus?.()
  uiStore.focusSearch()
}

async function executeCandidate(item) {
  if (!item) return
  if (item.type === 'market-search') {
    isDropdownOpen.value = false
    emit('search', localValue.value)
    return
  }
  if (!item.omitFromFrecencyTracking) {
    recordUsage(item.key || item.pluginId)
  }
  isDropdownOpen.value = false

  try {
    if (item.type === 'inline-calculator' || item.type === 'inline-color') {
      const copied = await item.action?.()
      if (copied === false) throw new Error('复制结果失败，请重试')
      toastSuccess?.(`已复制结果: ${item.answer}`)
    } else if (item.type === 'file') {
      const bridge = typeof window.__ztoolsLauncher?.openPath === 'function'
        ? window.__ztoolsLauncher
        : window.ztools?.shell
      if (typeof bridge?.openPath !== 'function') throw new Error('文件打开接口不可用')
      const res = await bridge.openPath(item.path)
      if (res !== true && res?.success !== true) {
        throw new Error(res?.error?.message || res?.error || '打开文件失败')
      }
    } else if (item.mode === 'no-view' && item.pluginId) {
      // 无界面命令直接执行并提示结果；打开页面视图只会得到一个空白的“未识别视图”页
      await pluginsStore.markRecent?.(item.pluginId)
      const res = await executeDeclarativeNoViewCommand(item.pluginId, { featureCode: item.featureCode || '', query: searchQuery.value })
      toastSuccess?.(res?.message || `${item.name || item.title} 已执行`)
    } else if (item.pluginId) {
      const result = await pluginsStore.openPlugin(item.pluginId, { featureCode: item.featureCode })
      if (result?.cancelled) return
      if (result?.success === false) throw new Error(result.error?.message || result.error || result.message || '启动插件失败，请重试')
      if (result?.isDeclarative) uiStore.focusDeclarative()
      else uiStore.focusGrid()
    } else if (typeof item.action === 'function') {
      await item.action()
    }
  } catch (error) {
    toastError?.(error?.message || '执行命令失败，请重试')
  }
}

// 统一快捷键注册
useKeymap(KEYMAP_SCOPES.GLOBAL, {
  'Ctrl+F': () => {
    focusInput()
    return true
  }
})

useKeymap(KEYMAP_SCOPES.SEARCH, {
  'ArrowDown': () => {
    if (!isFocused.value || !isDropdownOpen.value || candidateCommands.value.length === 0) return false
    activeIndex.value = (activeIndex.value + 1) % candidateCommands.value.length
    return true
  },
  'ArrowUp': () => {
    if (!isFocused.value || !isDropdownOpen.value || candidateCommands.value.length === 0) return false
    activeIndex.value = (activeIndex.value - 1 + candidateCommands.value.length) % candidateCommands.value.length
    return true
  },
  'Enter': () => {
    if (isFocused.value && isDropdownOpen.value && candidateCommands.value[activeIndex.value]) {
      executeCandidate(candidateCommands.value[activeIndex.value])
      return true
    }
    return false
  },
  'Escape': () => {
    if (isFocused.value && isDropdownOpen.value) {
      isDropdownOpen.value = false
      uiStore.focusGrid()
      inputRef.value?.blur?.()
      return true
    }
    return false
  }
})

defineExpose({ focusInput })
</script>

<template>
  <div class="relative w-full">
    <a-input
      ref="inputRef"
      v-model:value="localValue"
      :placeholder="placeholder || '搜索插件、命令与文件'"
      allow-clear
      @press-enter="handleEnter"
      @focus="onFocus"
      @blur="onBlur"
      class="rc-search-input"
      style="
        height: 34px;
        border-radius: 9px;
        font-size: 13px;
      "
    >
      <template #prefix>
        <SearchIcon class="w-4 h-4 mr-1 text-[var(--rc-text-muted)]" aria-hidden="true" />
      </template>
      <template #suffix>
        <ShortcutKeys class="hidden sm:inline-flex" combo="Ctrl+F" />
      </template>
      <template #clearIcon><CircleXIcon class="input-clear-icon" aria-hidden="true" /></template>
    </a-input>

    <!-- 下拉命令面板：结果行与悬浮条相同（名称独占一行，路径或说明在第二行），比输入框更宽，长名称能看全 -->
    <transition name="dropdown-fade">
      <div v-if="isDropdownOpen && candidateCommands.length > 0" class="search-dropdown">
        <div class="search-dropdown-head">
          <span>命令与快捷启动</span>
          <span>↑↓ 选择 · ↵ 执行</span>
        </div>

        <div class="search-dropdown-list custom-scrollbar">
          <SearchResultRow
            v-for="(item, idx) in candidateCommands"
            :key="item.key || item.pluginId || idx"
            :ref="el => registerRowEl(idx, el)"
            :item="item"
            :active="activeIndex === idx"
            :parts="highlightParts(item)"
            @mousedown.prevent="executeCandidate(item)"
            @mouseenter="activeIndex = idx"
          />
        </div>
      </div>
    </transition>

    <!-- 搜索情境提示：引导全局唤起悬浮条 -->
    <transition name="hint-fade">
      <div
        v-if="currentGlobalWakeHotkey && isFocused && localValue && !hintDismissed && !isDropdownOpen"
        class="search-hint absolute left-0 right-0 top-full mt-1.5 select-none"
      >
        <span class="truncate">
          在任何地方按 <ShortcutKeys :combo="currentGlobalWakeHotkey" /> 也能直接搜索
        </span>
        <div class="flex items-center gap-1 flex-shrink-0">
          <RcButton variant="primary" size="xs" class="search-hint-btn" @mousedown.prevent="tryGeekLauncher">
            试一试
          </RcButton>
          <button type="button" class="search-hint-close" title="关闭提示" aria-label="关闭提示" @mousedown.prevent="dismissHint">
            <XIcon class="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
/* a-input 的根元素就是 affix-wrapper，直接带上组件作用域 */
.rc-search-input.ant-input-affix-wrapper {
  background-color: var(--rc-surface) !important;
  border-color: var(--rc-border-highlight) !important;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.rc-search-input :deep(.ant-input) {
  font-size: 13px;
  background: transparent !important;
  color: var(--rc-text-primary);
  caret-color: var(--rc-accent);
}

.rc-search-input :deep(.ant-input::placeholder) {
  color: var(--rc-text-faint);
}

.rc-search-input.ant-input-affix-wrapper:hover {
  border-color: var(--rc-border-highlight) !important;
}

/* 聚焦：余烬橙光晕（全站除标志外唯一的光晕） */
.rc-search-input.ant-input-affix-wrapper-focused {
  border-color: transparent !important;
  box-shadow: var(--rc-focus-ring) !important;
}

.search-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 40;
  /* 至少与输入框同宽，最多 600px；工作台最窄 900px 时右侧仍留出边距 */
  width: max(100%, min(600px, calc(100vw - 300px)));
  margin-top: 6px;
  overflow: hidden;
  user-select: none;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-lg);
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-lg);
  color: var(--rc-text-primary);
}

.search-dropdown-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  border-bottom: 1px solid var(--rc-border);
  font-size: 11px;
  font-weight: 600;
  color: var(--rc-text-faint);
}

.search-dropdown-list {
  max-height: min(440px, 62vh);
  overflow-y: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.search-hint {
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  border-radius: var(--rc-radius-md);
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-md);
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.search-hint-close {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--rc-text-faint);
  cursor: pointer;
}

.search-hint-close:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.hint-fade-enter-active,
.hint-fade-leave-active,
.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.hint-fade-enter-from,
.hint-fade-leave-to,
.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
