<script setup>
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useUIStore } from '@/stores/ui'
import { usePluginsStore } from '@/stores/plugins'
import { useCommandSearch } from '@/composables/useCommandSearch'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { routeUtils } from '@/router/routes'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { RcSquircle } from '@/components/raycast'

const props = defineProps({
  modelValue: String,
  placeholder: String,
  debounce: { type: Number, default: 300 }
})
const emit = defineEmits(['update:modelValue', 'search'])

const router = useRouter()
const uiStore = useUIStore()
const pluginsStore = usePluginsStore()

const localValue = ref(props.modelValue || '')
const inputRef = ref(null)
const isFocused = ref(false)
const hintDismissed = ref(false)
const isDropdownOpen = ref(false)
const activeIndex = ref(0)
let debounceTimer = null

const {
  query: searchQuery,
  matchedPlugins,
  search,
  clearSearch,
  recordUsage
} = useCommandSearch({ enableFileSearch: false })

// 候选命令列表（最多展示前 8 条）
const candidateCommands = computed(() => {
  return (matchedPlugins.value || []).slice(0, 8)
})

// 防抖搜索与内核同步
watch(localValue, (newVal) => {
  emit('update:modelValue', newVal)
  search(newVal)
  activeIndex.value = 0

  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    emit('search', newVal)
  }, props.debounce)

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
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
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
  // 延时关闭以允许点击候选条目
  setTimeout(() => {
    isFocused.value = false
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

function executeCandidate(item) {
  if (!item) return
  recordUsage(item.key || item.pluginId)
  isDropdownOpen.value = false

  if (item.pluginId && isOfficialPlugin(item.pluginId)) {
    router.push(routeUtils.toDeclarative(item.pluginId))
    uiStore.focusDeclarative()
  } else if (item.pluginId) {
    pluginsStore.openPlugin(item.pluginId)
    uiStore.focusGrid()
  } else if (typeof item.action === 'function') {
    item.action()
  }
}

// 统一快捷键注册
useKeymap(KEYMAP_SCOPES.GLOBAL, {
  'Ctrl+F': () => {
    focusInput()
    return true
  }
})

useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowDown': () => {
    if (!isDropdownOpen.value || candidateCommands.value.length === 0) return false
    activeIndex.value = (activeIndex.value + 1) % candidateCommands.value.length
    return true
  },
  'ArrowUp': () => {
    if (!isDropdownOpen.value || candidateCommands.value.length === 0) return false
    activeIndex.value = (activeIndex.value - 1 + candidateCommands.value.length) % candidateCommands.value.length
    return true
  },
  'Enter': () => {
    if (isDropdownOpen.value && candidateCommands.value.length > 0 && candidateCommands.value[activeIndex.value]) {
      executeCandidate(candidateCommands.value[activeIndex.value])
      return true
    }
    return false
  },
  'Escape': () => {
    if (isDropdownOpen.value) {
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
      :placeholder="placeholder || '搜索插件与命令...'"
      allow-clear
      @press-enter="handleEnter"
      @focus="onFocus"
      @blur="onBlur"
      class="rc-search-input"
      style="
        height: 32px;
        border-radius: var(--rc-radius-md, 8px);
        font-size: 13px;
      "
    >
      <template #prefix>
        <svg
          class="w-4 h-4 mr-1 text-[var(--rc-text-muted)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </template>
      <template #suffix>
        <kbd class="rc-kbd select-none hidden sm:inline-flex">Ctrl F</kbd>
      </template>
    </a-input>

    <!-- 下拉命令面板 (Command Palette Dropdown) -->
    <transition name="dropdown-fade">
      <div
        v-if="isDropdownOpen && candidateCommands.length > 0"
        class="absolute left-0 right-0 top-full mt-1.5 rounded-xl border shadow-2xl z-40 overflow-hidden select-none"
        style="
          background: var(--rc-surface);
          border-color: var(--rc-border);
          color: var(--rc-text-primary);
          max-height: 320px;
        "
      >
        <div class="px-3 py-1.5 text-[11px] font-semibold border-b flex items-center justify-between"
             style="border-color: var(--rc-border); background: var(--rc-surface-subtle); color: var(--rc-text-secondary);">
          <span>命令与快捷启动</span>
          <span class="text-[10px] font-mono">↑↓ 选择 · ↵ 执行</span>
        </div>

        <div class="overflow-y-auto p-1.5 space-y-1 custom-scrollbar" style="max-height: 260px;">
          <div
            v-for="(item, idx) in candidateCommands"
            :key="item.key || item.pluginId || idx"
            class="flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs"
            :style="activeIndex === idx ? 'background: var(--rc-surface-hover); color: var(--rc-text-primary);' : 'color: var(--rc-text-secondary);'"
            @mousedown.prevent="executeCandidate(item)"
            @mouseenter="activeIndex = idx"
          >
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <RcSquircle
                :icon="item.faIcon || 'fa-cube'"
                :size="24"
                rounded="rounded-md"
              />
              <div class="flex items-baseline gap-1.5 min-w-0">
                <span class="font-medium text-[13px] truncate" style="color: var(--rc-text-primary)">
                  {{ item.name || item.title }}
                </span>
                <span v-if="item.description" class="text-[11px] truncate opacity-70 max-w-[280px]">
                  {{ item.description }}
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-shrink-0">
              <span v-if="item.badge" class="px-1.5 py-0.5 rounded text-[10px] font-mono"
                    style="background: var(--rc-surface-subtle); border: 1px solid var(--rc-border);">
                {{ item.badge }}
              </span>
              <span v-if="activeIndex === idx" class="font-mono text-[10px] text-sky-400">
                {{ item.actionLabel || '启动' }} ↵
              </span>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 搜索情境式智能提示 -->
    <transition name="hint-fade">
      <div
        v-if="isFocused && localValue && !hintDismissed && !isDropdownOpen"
        class="absolute left-0 right-0 top-full mt-1.5 px-3 py-1.5 rounded-lg border text-xs flex items-center justify-between z-30 shadow-lg select-none backdrop-blur-md"
        style="
          background: var(--rc-surface-translucent, rgba(22, 26, 33, 0.95));
          border-color: var(--rc-border-highlight, rgba(56, 189, 248, 0.3));
          color: var(--rc-text-primary);
        "
      >
        <div class="flex items-center gap-1.5 truncate mr-2">
          <span class="text-amber-400">💡</span>
          <span class="truncate">
            桌面任意位置按 <kbd class="px-1 py-0.2 rounded font-mono text-[10px] bg-sky-500/20 text-sky-400 font-semibold">Alt + Space</kbd> 也可秒开搜索
          </span>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button
            class="px-2 py-0.5 rounded bg-sky-500 hover:bg-sky-600 text-white font-medium text-[11px] transition-colors cursor-pointer"
            @mousedown.prevent="tryGeekLauncher"
          >
            试一试 ➔
          </button>
          <button
            class="text-slate-400 hover:text-slate-200 text-xs cursor-pointer p-0.5"
            title="关闭提示"
            @mousedown.prevent="dismissHint"
          >
            ✕
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.rc-search-input :deep(.ant-input) {
  font-size: 13px;
  background: transparent !important;
}

.rc-search-input :deep(.ant-input-affix-wrapper) {
  background-color: var(--rc-surface-subtle) !important;
  border-color: var(--rc-border) !important;
  transition: all 0.15s ease;
}

.rc-search-input :deep(.ant-input-affix-wrapper:hover) {
  border-color: var(--rc-border-highlight) !important;
}

.rc-search-input :deep(.ant-input-affix-wrapper-focused) {
  border-color: var(--rc-accent) !important;
  box-shadow: 0 0 0 2px var(--rc-accent-subtle) !important;
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
