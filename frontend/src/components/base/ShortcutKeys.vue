<script setup>
import { computed } from 'vue'
import { isSymbolKey, shortcutKeys } from '@/utils/platform'

/**
 * 快捷键展示：每个键一枚键帽，按平台显示（macOS ⌘ ⌥ ⇧，Windows Ctrl Alt Shift）。
 * combo 使用内部统一写法，例如 'Ctrl+K'、'Alt+Space'、'Enter'、'Escape'。
 */
const props = defineProps({
  combo: { type: String, required: true },
  /** inherit：放在彩色按钮上，键帽跟随文字颜色（半透明底 + 同色文字）；onAccent 为旧写法，等同 inherit */
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

.shortcut-keys.is-inherit .rc-kbd,
.shortcut-keys.is-onAccent .rc-kbd {
  background: color-mix(in srgb, currentColor 14%, transparent);
  border-color: color-mix(in srgb, currentColor 24%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 16%, transparent);
  color: inherit;
}
</style>
