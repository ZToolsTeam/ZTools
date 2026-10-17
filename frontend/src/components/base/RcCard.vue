<script setup>
defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  padding: { type: String, default: 'p-4' },
  hover: { type: Boolean, default: false }
})
</script>

<template>
  <div
    class="rc-card rounded-xl transition-all duration-150 overflow-hidden"
    :class="[
      padding,
      hover ? 'hover:border-[var(--rc-border-highlight)] hover:shadow-sm' : ''
    ]"
  >
    <div v-if="title || subtitle || $slots.header" class="flex items-center justify-between pb-3 mb-3 border-b border-[var(--rc-border)]/60">
      <div>
        <h3 v-if="title" class="text-xs font-semibold text-[var(--rc-text-primary)] m-0">
          {{ title }}
        </h3>
        <p v-if="subtitle" class="text-[11px] text-[var(--rc-text-secondary)] m-0 mt-0.5">
          {{ subtitle }}
        </p>
      </div>
      <div v-if="$slots.headerAction">
        <slot name="headerAction"></slot>
      </div>
    </div>
    <slot></slot>
  </div>
</template>

<style scoped>
.rc-card {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
}

:global(.dark) .rc-card {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
}
</style>
