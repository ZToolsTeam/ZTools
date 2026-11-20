<script setup>
import { SpinnerIcon } from '@/utils/appIcons'
import { computed } from 'vue'
import ShortcutKeys from './ShortcutKeys.vue'

const props = defineProps({
  variant: {
    type: String,
    default: 'ghost',
    validator: (v) => ['ghost', 'primary', 'soft', 'secondary', 'danger'].includes(v)
  },
  size: {
    type: String,
    default: 'sm',
    validator: (v) => ['xs', 'sm', 'md'].includes(v)
  },
  icon: { type: [Object, Function], default: null },
  kbd: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['click'])

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'h-6 px-2 text-[length:var(--rc-fs-caption)] leading-4 gap-1 rounded-[var(--rc-radius-sm)]'
    case 'md':
      return 'h-9 px-3.5 text-[length:var(--rc-fs-emph)] leading-5 gap-2 rounded-[var(--rc-radius-md)] font-medium'
    case 'sm':
    default:
      return 'h-7 px-2.5 text-[length:var(--rc-fs-small)] leading-4 gap-1.5 rounded-[var(--rc-radius-sm)] font-medium'
  }
})

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'bg-[var(--rc-accent-fill)] text-[var(--rc-accent-contrast)] hover:bg-[var(--rc-accent-fill-hover)] border-transparent shadow-sm'
    // 淡强调：浅橙底 + 橙字，用于需要醒目但不必用实心橙的入口（登录、插件底栏主动作）
    case 'soft':
      return 'rc-btn-soft bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] border-[var(--rc-border-highlight)]'
    case 'danger':
      return 'rc-btn-danger bg-[var(--rc-error-subtle)] text-[var(--rc-error)] border-transparent'
    // 次按钮：描边比卡片深一档，放在卡片、灰色面板或暗色底上都有清晰轮廓
    case 'secondary':
      return 'bg-[var(--rc-surface)] text-[var(--rc-text-primary)] border-[var(--rc-border-highlight)] hover:bg-[var(--rc-surface-active)]'
    case 'ghost':
    default:
      return 'rc-btn-ghost text-[var(--rc-text-primary)]'
  }
})

// 键帽全站保持中性灰（淡强调、危险按钮也一样）；只有实心主按钮的键帽跟随按钮上的白字着色，否则灰键帽压在橙底上看不清
const kbdTone = computed(() => (props.variant === 'primary' ? 'onAccent' : 'default'))

const handleClick = (e) => {
  if (props.disabled || props.loading) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  emit('click', e)
}
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center justify-center select-none border transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    :class="[sizeClasses, variantClasses]"
    :disabled="disabled || loading"
    @click="handleClick"
  >
    <SpinnerIcon v-if="loading" class="text-xs" />
    <component :is="icon" v-else-if="icon" aria-hidden="true" />
    <slot></slot>
    <ShortcutKeys v-if="kbd" :combo="kbd" :tone="kbdTone" />
  </button>
</template>

<style scoped>
.rc-btn-ghost {
  background: var(--rc-surface-subtle);
  border-color: var(--rc-border);
}

.rc-btn-ghost:hover:not(:disabled) {
  background: var(--rc-surface-hover);
  border-color: var(--rc-border-highlight);
}

/* 淡强调：悬停加深一档 */
.rc-btn-soft:hover:not(:disabled) {
  background: color-mix(in srgb, var(--rc-accent) 18%, transparent);
}

/* 危险操作：浅红底，悬停时加深一档（用 color-mix，CSS 变量不能直接用 Tailwind 的 /80 透明度写法） */
.rc-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--rc-error) 16%, transparent);
}

/* 键盘聚焦可见 */
button:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}
</style>
