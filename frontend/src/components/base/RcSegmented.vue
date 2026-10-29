<script setup>
/**
 * 分段切换，所有页面的标签切换都用它。两种版式：
 * - chips（默认）：无外框的一排标签（主页已安装 / 收藏、插件市场分类与来源、反馈类型），选中项带余烬橙方块标记；
 * - marker：带外框的分段按钮（设置页的选项），选中项带余烬橙方块标记。
 * 选项可带 count（数量）、hint（补充说明）与 dot（标签右上角的提醒小圆点，如「有新回复」，dotLabel 给读屏用）。
 * 选中项文字加粗时宽度会变，标签用隐藏的粗体副本预留宽度，切换时按钮尺寸始终不变。
 */
const props = defineProps({
  modelValue: { type: [String, Number, Boolean], required: true },
  options: {
    type: Array,
    required: true,
    // [ { label: '已安装', value: 'installed', count: 7, hint: '400×300' }, ... ]
  },
  variant: { type: String, default: 'chips', validator: (v) => ['chips', 'marker'].includes(v) },
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
    class="seg-group"
    :class="`is-${variant}`"
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
      <span class="seg-marker" aria-hidden="true"></span>
      <span class="seg-label" :data-label="opt.label">{{ opt.label }}</span>
      <span v-if="opt.dot" class="seg-dot" role="img" :aria-label="opt.dotLabel || '有新内容'"></span>
      <!-- count 为 null 表示数量还在统计：先占住位置，数字出来时按钮不跳动 -->
      <span v-if="opt.count === null" class="seg-count is-pending" aria-hidden="true"></span>
      <span v-else-if="opt.count !== undefined" class="seg-count">{{ opt.count }}</span>
      <span v-if="opt.hint" class="seg-hint">{{ opt.hint }}</span>
    </button>
  </div>
</template>

<style scoped>
/* ---------- 共用 ---------- */
.seg-group {
  display: inline-flex;
  flex-wrap: wrap;
}

.seg-btn {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--rc-text-muted);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.seg-btn:hover {
  color: var(--rc-text-primary);
}

.seg-btn.active {
  color: var(--rc-text-primary);
  font-weight: 600;
}

.seg-btn:focus-visible {
  outline: 2px solid var(--rc-accent);
  outline-offset: 1px;
}

/* 粗体占位：按粗体宽度撑开标签，选中加粗时不改变按钮宽度 */
.seg-label {
  display: inline-flex;
  flex-direction: column;
}

.seg-label::after {
  content: attr(data-label);
  height: 0;
  overflow: hidden;
  visibility: hidden;
  font-weight: 600;
  user-select: none;
  pointer-events: none;
}

.seg-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}

.seg-btn.active .seg-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

/* 数量按 3 位数预留宽度、等宽数字：999 以内数字变化不会改变按钮宽度 */
.seg-count {
  box-sizing: border-box;
  min-width: calc(3ch + 10px);
  padding: 0 5px;
  border-radius: var(--rc-radius-full);
  background: var(--rc-surface-hover);
  color: var(--rc-text-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.seg-count.is-pending {
  visibility: hidden;
}

.seg-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--rc-text-faint);
  font-variant-numeric: tabular-nums;
}

/* ---------- chips：无外框标签 ---------- */
.is-chips {
  gap: 2px;
}

.is-chips .seg-btn {
  height: 32px;
  gap: 8px;
  padding: 0 12px 0 8px;
  border-radius: var(--rc-radius-md);
  color: var(--rc-text-secondary);
  font-size: 13px;
}

.is-chips .seg-btn:hover {
  background: var(--rc-surface-hover);
}

.is-chips .seg-btn.active {
  background: var(--rc-surface-active);
}

/* ---------- marker：带外框分段 ---------- */
.is-marker {
  padding: 3px;
  gap: 2px;
  border-radius: 9px;
  border: 1px solid var(--rc-border-highlight);
}

.is-marker .seg-btn {
  height: 28px;
  gap: 7px;
  padding: 0 12px 0 9px;
  border-radius: 6px;
  font-size: 13px;
}

.is-marker .seg-btn.active {
  background: var(--rc-surface-active);
}

/* 提醒小圆点：贴在标签右上角，不占宽度，出现 / 消失时按钮不跳动 */
.seg-btn {
  position: relative;
}

.seg-dot {
  position: absolute;
  top: 5px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rc-error);
}
</style>
