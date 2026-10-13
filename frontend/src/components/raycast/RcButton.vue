<script setup>
import { computed } from 'vue'

const props = defineProps({
  variant: {
    type: String,
    default: 'ghost',
    validator: (v) => ['ghost', 'primary', 'secondary', 'danger'].includes(v)
  },
  size: {
    type: String,
    default: 'sm',
    validator: (v) => ['xs', 'sm', 'md'].includes(v)
  },
  icon: { type: String, default: '' },
  kbd: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['click'])

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'xs':
      return 'h-6 px-2 text-[11px] gap-1 rounded-md'
    case 'md':
      return 'h-9 px-3.5 text-sm gap-2 rounded-lg font-medium'
    case 'sm':
    default:
      return 'h-7 px-2.5 text-xs gap-1.5 rounded-md font-medium'
  }
})

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'bg-[var(--rc-accent)] text-white hover:opacity-90 border-transparent shadow-sm'
    case 'danger':
      return 'bg-[var(--rc-error-subtle)] text-[var(--rc-error)] border-[var(--rc-error)]/20 hover:bg-[var(--rc-error-subtle)]/80'
    case 'secondary':
      return 'bg-[var(--rc-surface)] text-[var(--rc-text-primary)] border-[var(--rc-border)] hover:bg-[var(--rc-surface-hover)] hover:border-[var(--rc-border-highlight)]'
    case 'ghost':
    default:
      return 'rc-btn-ghost text-[var(--rc-text-primary)]'
  }
})

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
    <i v-if="loading" class="fa fa-spinner fa-spin text-xs"></i>
    <i v-else-if="icon && icon.startsWith('fa')" :class="['fa', icon]"></i>
    <slot></slot>
    <kbd
      v-if="kbd"
      class="rc-kbd inline-flex items-center text-[10px] px-1 py-0.2 rounded font-mono select-none"
    >
      {{ kbd }}
    </kbd>
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

:global(.dark) .rc-btn-ghost {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

:global(.dark) .rc-btn-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.16);
}
</style>
