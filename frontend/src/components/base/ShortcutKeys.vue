<script setup>
import { computed } from 'vue'
import { isSymbolKey, shortcutKeys } from '@/utils/platform'

/**
 * 快捷键展示：每个键一枚键帽，按平台显示（macOS ⌘ ⌥ ⇧，Windows Ctrl Alt Shift）。
 * combo 使用内部统一写法，例如 'Ctrl+K'、'Alt+Space'、'Enter'、'Escape'。
 */
const props = defineProps({
  combo: { type: String, required: true },
  /** onAccent：放在余烬橙实底按钮上时使用深色半透明键帽 */
  tone: { type: String, default: 'default' }
})

const keys = computed(() => shortcutKeys(props.combo))
const label = computed(() => keys.value.join(' '))
</script>

<template>
  <span v-if="keys.length" class="shortcut-keys" :class="`is-${tone}`" :aria-label="label" role="img">
    <kbd v-for="(key, index) in keys" :key="index" class="rc-kbd" :class="{ 'is-symbol': isSymbolKey(key) }" aria-hidden="true">{{ key }}</kbd>
  </span>
</template>

<style scoped>
.shortcut-keys {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  vertical-align: middle;
}

.shortcut-keys.is-onAccent .rc-kbd {
  background: rgba(26, 10, 4, 0.12);
  border-color: rgba(26, 10, 4, 0.16);
  box-shadow: inset 0 -1px 0 rgba(26, 10, 4, 0.16);
  color: var(--rc-accent-contrast);
}
</style>
