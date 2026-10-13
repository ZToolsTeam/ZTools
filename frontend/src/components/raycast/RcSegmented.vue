<script setup>
const props = defineProps({
  modelValue: { type: [String, Number, Boolean], required: true },
  options: {
    type: Array,
    required: true,
    // [ { label: '已安装', value: 'installed', count: 7 }, ... ]
  },
  size: { type: String, default: 'sm' }
})

const emit = defineEmits(['update:modelValue', 'change'])

const selectOption = (opt) => {
  if (opt.value === props.modelValue) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
}
</script>

<template>
  <div
    class="rc-segmented-container inline-flex p-0.5 rounded-lg select-none"
    style="background: var(--rc-surface-subtle); border: 1px solid var(--rc-border);"
  >
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      type="button"
      class="rc-segmented-item flex items-center justify-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all duration-150 cursor-pointer"
      :class="[
        modelValue === opt.value
          ? 'rc-segmented-active text-[var(--rc-text-primary)] shadow-sm'
          : 'text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)]'
      ]"
      @click="selectOption(opt)"
    >
      <i v-if="opt.icon" :class="['fa', opt.icon, 'text-[11px]']"></i>
      <span>{{ opt.label }}</span>
      <span
        v-if="opt.count !== undefined"
        class="text-[10px] px-1 py-0.2 rounded-full opacity-70 font-mono"
        :class="modelValue === opt.value ? 'bg-white/10' : 'bg-black/5 dark:bg-white/5'"
      >
        {{ opt.count }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.rc-segmented-container {
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
}

.rc-segmented-active {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  border: 1px solid var(--rc-border-highlight);
}

:global(.dark) .rc-segmented-active {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
}
</style>
