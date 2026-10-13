<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  icon: { type: String, default: '' }
})
</script>

<template>
  <div class="rc-setting-row flex items-center justify-between py-3.5 px-4 border-b border-[var(--rc-border)]/60 last:border-b-0 hover:bg-[var(--rc-surface-hover)]/40 transition-colors">
    <div class="flex items-center gap-3 min-w-0 pr-4">
      <div
        v-if="icon"
        class="w-7 h-7 rounded-md flex items-center justify-center text-[var(--rc-text-secondary)] bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] flex-shrink-0"
      >
        <i :class="['fa', icon, 'text-xs']"></i>
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-xs font-semibold text-[var(--rc-text-primary)] leading-snug">
          {{ title }}
        </span>
        <span v-if="description" class="text-[11px] text-[var(--rc-text-secondary)] mt-0.5 leading-normal">
          {{ description }}
        </span>
      </div>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0">
      <slot></slot>
    </div>
  </div>
</template>
