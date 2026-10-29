<script setup>
import { Dropdown } from 'ant-design-vue'
import { ref } from 'vue'
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

const choose = (item) => {
  if (item.disabled) return
  open.value = false
  emit('select', item.key)
}
</script>

<template>
  <Dropdown v-model:open="open" :trigger="['click']" :placement="placement">
    <slot :open="open" />
    <template #overlay>
      <div class="rc-menu" role="menu" :style="{ minWidth: `${props.minWidth}px` }">
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
  border-radius: 10px;
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-lg);
  font-size: 13px;
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
  border-radius: 6px;
  background: transparent;
  color: var(--rc-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
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

:global(.rc-menu-item.is-danger:hover:not(:disabled)) {
  background: var(--rc-error-subtle);
}

:global(.rc-menu-icon) {
  flex-shrink: 0;
  font-size: 16px;
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
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

:global(.rc-menu-separator) {
  height: 1px;
  margin: 4px 6px;
  background: var(--rc-border);
}
</style>
