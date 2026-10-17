<script setup>
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useRouter } from 'vue-router'
import { useUIStore } from '@/stores/ui'
import { usePluginsStore } from '@/stores/plugins'
import { useCommandSearch } from '@/composables/useCommandSearch'
import { getHighlightPartsWithPinyin } from '@/utils/pinyinSearch'
import { useToast } from '@/composables/useToast'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { routeUtils } from '@/router/routes'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { RcSquircle } from '@/components/base'
import { resolveItemGlyph } from '@/utils/brandIcons'
import { DEFAULT_GLOBAL_WAKE_HOTKEY } from '@/utils/globalWakeHotkey'


const props = defineProps({
  modelValue: String,
  placeholder: String,
  debounce: { type: Number, default: 300 }
})
const emit = defineEmits(['update:modelValue', 'search'])

const router = useRouter()
const uiStore = useUIStore()
const pluginsStore = usePluginsStore()
const { success: toastSuccess } = useToast()

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

function highlightParts(text) {
  return getHighlightPartsWithPinyin(text, localValue.value)
}

function executeCandidate(item) {
  if (!item) return
  if (!item.omitFromFrecencyTracking) {
    recordUsage(item.key || item.pluginId)
  }
  isDropdownOpen.value = false

  if (item.type === 'inline-calculator' || item.type === 'inline-color') {
    Promise.resolve(item.action?.()).then(() => {
      toastSuccess?.(`已复制结果: ${item.answer}`)
    })
    return
  }

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
        <svg
          class="w-4 h-4 mr-1 text-[var(--rc-text-muted)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </template>
      <template #suffix>
        <ShortcutKeys class="hidden sm:inline-flex" combo="Ctrl+F" />
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
             style="border-color: var(--rc-border); color: var(--rc-text-faint);">
          <span>命令与快捷启动</span>
          <span class="text-[10px]">↑↓ 选择 · ↵ 执行</span>
        </div>

        <div class="overflow-y-auto p-1.5 space-y-1 custom-scrollbar" style="max-height: 260px;">
          <div
            v-for="(item, idx) in candidateCommands"
            :key="item.key || item.pluginId || idx"
            class="flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs"
            :class="{ 'is-active': activeIndex === idx }"
            :style="activeIndex === idx ? 'background: var(--rc-surface-active); color: var(--rc-text-primary);' : 'color: var(--rc-text-muted);'"
            @mousedown.prevent="executeCandidate(item)"
            @mouseenter="activeIndex = idx"
          >
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <span class="row-marker" aria-hidden="true"></span>
              <RcSquircle
                :glyph="resolveItemGlyph(item)"
                :src="typeof item.icon === 'string' && /^(https?:|data:image\/|ztools:)/.test(item.icon) ? item.icon : ''"
                :icon="item.faIcon || 'fa-cube'"
                :size="24"
              />
              <div class="flex items-baseline gap-1.5 min-w-0">
                <span class="font-medium text-[13px] truncate" style="color: var(--rc-text-primary)"><template v-for="(part, partIdx) in highlightParts(item.name || item.title)" :key="partIdx"><mark v-if="part.hit" class="bg-transparent text-[var(--rc-accent-text)] font-semibold">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
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
              <span v-if="activeIndex === idx" class="text-[11px]" style="color: var(--rc-text-secondary)">
                {{ item.actionLabel || '启动' }} ↵
              </span>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 搜索情境提示：引导全局唤起悬浮条 -->
    <transition name="hint-fade">
      <div
        v-if="isFocused && localValue && !hintDismissed && !isDropdownOpen"
        class="search-hint absolute left-0 right-0 top-full mt-1.5 select-none"
      >
        <span class="truncate">
          在任何地方按 <ShortcutKeys :combo="DEFAULT_GLOBAL_WAKE_HOTKEY" /> 也能直接搜索
        </span>
        <div class="flex items-center gap-1 flex-shrink-0">
          <button type="button" class="search-hint-btn" @mousedown.prevent="tryGeekLauncher">
            试一试
          </button>
          <button type="button" class="search-hint-close" title="关闭提示" aria-label="关闭提示" @mousedown.prevent="dismissHint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
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

.row-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.is-active .row-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
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

.search-hint-btn {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: var(--rc-accent);
  color: var(--rc-accent-contrast);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.search-hint-btn:hover {
  background: var(--rc-accent-hover);
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
