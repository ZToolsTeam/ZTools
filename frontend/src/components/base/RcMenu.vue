<script setup>
import { Dropdown } from 'ant-design-vue'
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { registerKeyHandler, KEYMAP_SCOPES } from '@/utils/keymap'
import ShortcutKeys from './ShortcutKeys.vue'

/**
 * 统一下拉菜单：点击触发按钮弹出，外观与插件卡片右键菜单一致（ContextMenu.vue）。
 * items：[{ key, label, icon?, hint?, kbd?, danger?, disabled? } | { type: 'separator' }]
 * 选中后关闭菜单并触发 select(key)。触发按钮放在默认插槽里。
 */
const props = defineProps({
  items: { type: Array, required: true },
  placement: { type: String, default: 'bottomRight' },
  minWidth: { type: Number, default: 200 }
})
const emit = defineEmits(['select'])
const open = ref(false)
const menuRef = ref(null)

const choose = (item) => {
  if (item.disabled) return
  open.value = false
  emit('select', item.key)
}

const getEnabledMenuItems = (container = menuRef.value) => {
  if (!container) return []
  return Array.from(container.querySelectorAll('.rc-menu-item:not(:disabled)'))
}

// 统一处理菜单内上下方向键、Home/End 循环聚焦与 Escape 关闭
const navigateMenuByKey = (key, target, container = menuRef.value) => {
  if (key === 'Escape' || key === 'Esc') {
    open.value = false
    return true
  }

  const items = getEnabledMenuItems(container)
  if (!items.length) return false

  const targetEl = target instanceof Element ? target : null
  const activeEl =
    typeof document !== 'undefined' &&
    document.activeElement instanceof Element &&
    container?.contains?.(document.activeElement)
      ? document.activeElement
      : null
  const currentItem =
    targetEl?.closest?.('.rc-menu-item:not(:disabled)') ||
    activeEl?.closest?.('.rc-menu-item:not(:disabled)')
  const currentIndex = currentItem ? items.indexOf(currentItem) : -1

  let nextIndex = -1
  switch (key) {
    case 'ArrowDown':
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0
      break
    case 'ArrowUp':
      nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = items.length - 1
      break
    default:
      return false
  }

  items[nextIndex]?.focus?.()
  return true
}

const onMenuKeydown = (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const handled = navigateMenuByKey(event.key, event.target, event.currentTarget || menuRef.value)
  if (handled) {
    event.preventDefault()
    event.stopPropagation()
  }
}

// 展开期间提升至 ACTION_PANEL 模态作用域，防止 Escape 穿透触发底层页面返回
const unregisterKeymap = registerKeyHandler(
  KEYMAP_SCOPES.ACTION_PANEL,
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return false
    return navigateMenuByKey(event.key, event.target, menuRef.value)
  },
  { modal: true }
)

watch(
  open,
  async (isOpen) => {
    if (!isOpen) {
      unregisterKeymap.deactivate()
      return
    }
    unregisterKeymap.activate()
    await nextTick()
    if (!open.value) return
    let items = getEnabledMenuItems()
    if (!items.length && typeof requestAnimationFrame === 'function') {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (!open.value) return
      items = getEnabledMenuItems()
    }
    items[0]?.focus?.()
  },
  { immediate: true, flush: 'sync' }
)

onUnmounted(() => {
  unregisterKeymap()
})
</script>

<template>
  <Dropdown v-model:open="open" :trigger="['click']" :placement="placement">
    <slot :open="open" />
    <template #overlay>
      <div
        ref="menuRef"
        class="rc-menu"
        role="menu"
        :style="{ minWidth: `${props.minWidth}px` }"
        @keydown="onMenuKeydown"
      >
        <template v-for="(item, index) in items" :key="item.key || `sep-${index}`">
          <div v-if="item.type === 'separator'" class="rc-menu-separator" role="separator"></div>
          <button
            v-else
            type="button"
            role="menuitem"
            class="rc-menu-item"
            :class="{ 'is-danger': item.danger }"
            :disabled="item.disabled"
            @click="choose(item)"
          >
            <component :is="item.icon" v-if="item.icon" class="rc-menu-icon" aria-hidden="true" />
            <span class="rc-menu-label">{{ item.label }}</span>
            <span v-if="item.hint" class="rc-menu-hint">{{ item.hint }}</span>
            <ShortcutKeys v-else-if="item.kbd" :combo="item.kbd" />
          </button>
        </template>
      </div>
    </template>
  </Dropdown>
</template>

<style scoped>
/* 弹出层渲染在组件外（挂到 body），这里的选择器用 :global() 生效 */
:global(.rc-menu) {
  padding: 4px;
  border: 1px solid var(--rc-border-highlight);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-lg);
  font-size: var(--rc-fs-body);
  user-select: none;
}

:global(.rc-menu-item) {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  color: var(--rc-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--rc-dur) ease;
}

:global(.rc-menu-item:hover:not(:disabled)),
:global(.rc-menu-item:focus-visible) {
  outline: none;
  background: var(--rc-surface-active);
}

:global(.rc-menu-item:disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}

:global(.rc-menu-item.is-danger) {
  color: var(--rc-error);
}

:global(.rc-menu-item.is-danger:hover:not(:disabled)),
:global(.rc-menu-item.is-danger:focus-visible:not(:disabled)) {
  background: var(--rc-error-subtle);
}

:global(.rc-menu-icon) {
  flex-shrink: 0;
  font-size: var(--rc-fs-title-sm);
  color: var(--rc-text-muted);
}

:global(.rc-menu-item.is-danger .rc-menu-icon) {
  color: inherit;
}

:global(.rc-menu-label) {
  flex: 1;
  white-space: nowrap;
}

:global(.rc-menu-hint) {
  color: var(--rc-text-faint);
  font-size: var(--rc-fs-small);
  font-variant-numeric: tabular-nums;
}

:global(.rc-menu-separator) {
  height: 1px;
  margin: 4px 6px;
  background: var(--rc-border);
}
</style>
