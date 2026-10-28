<script setup>
const props = defineProps({
  modelValue: { type: [String, Number, Boolean], required: true },
  options: {
    type: Array,
    required: true,
    // [ { label: '已安装', value: 'installed', count: 7, hint: '400×300' }, ... ]
  },
  size: { type: String, default: 'sm' },
  // pill：胶囊标签（主页）；marker：设置页分段按钮，选中项带余烬橙方块标记
  variant: { type: String, default: 'pill' },
  ariaLabel: { type: String, default: '' }
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
    v-if="variant === 'marker'"
    class="seg-group"
    role="radiogroup"
    :aria-label="ariaLabel || undefined"
  >
    <button
      v-for="opt in options"
      :key="String(opt.value)"
      type="button"
      role="radio"
      class="seg-btn"
      :class="{ active: modelValue === opt.value }"
      :aria-checked="modelValue === opt.value"
      @click="selectOption(opt)"
    >
      <span class="seg-marker" aria-hidden="true"></span>{{ opt.label }}<span v-if="opt.hint" class="seg-hint">{{ opt.hint }}</span>
    </button>
  </div>
  <div
    v-else
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
          : 'text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)]'
      ]"
      @click="selectOption(opt)"
    >
      <component :is="opt.icon" v-if="opt.icon" class="text-[11px]" aria-hidden="true" />
      <span>{{ opt.label }}</span>
      <span
        v-if="opt.count !== undefined"
        class="text-[10px] px-1 py-0.2 rounded-full opacity-70 font-mono"
        :class="modelValue === opt.value ? 'bg-[var(--rc-kbd-bg)]' : 'bg-[var(--rc-surface-hover)]'"
      >
        {{ opt.count }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.rc-segmented-container {
  background: var(--rc-kbd-bg);
  border: 1px solid transparent;
}

.rc-segmented-active {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  border: 1px solid var(--rc-border-highlight);
}

/* marker 变体 */
.seg-group {
  display: inline-flex;
  flex-wrap: wrap;
  padding: 3px;
  gap: 2px;
  border-radius: 9px;
  border: 1px solid var(--rc-border-highlight);
}

.seg-btn {
  height: 28px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px 0 9px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--rc-text-muted);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.seg-btn:hover {
  color: var(--rc-text-primary);
}

.seg-btn.active {
  background: var(--rc-surface-active);
  color: var(--rc-text-primary);
  font-weight: 600;
}

.seg-btn:focus-visible {
  outline: 2px solid var(--rc-accent);
  outline-offset: 1px;
}

.seg-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.seg-btn.active .seg-marker {
  background: var(--rc-accent);
  box-shadow: 0 0 8px rgba(255, 107, 61, 0.55);
}

.seg-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--rc-text-faint);
  font-variant-numeric: tabular-nums;
}
</style>
