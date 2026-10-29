<script setup>
/**
 * 统一状态标签。
 * variant：soft（浅色底，详情页状态、冲突类型）/ dot（小色点 + 灰阶文字，列表里的处理状态）/ text（只有文字颜色，卡片角落等紧凑位置）
 * tone：neutral / accent / success / warning / error / info，颜色全部来自主题语义变量。
 */
defineProps({
  tone: {
    type: String,
    default: 'neutral',
    validator: (v) => ['neutral', 'accent', 'success', 'warning', 'error', 'info'].includes(v)
  },
  variant: { type: String, default: 'soft', validator: (v) => ['soft', 'dot', 'text'].includes(v) }
})
</script>

<template>
  <span class="rc-tag" :class="[`is-${variant}`, `tone-${tone}`]"><slot /></span>
</template>

<style scoped>
.rc-tag {
  --tag-fg: var(--rc-text-muted);
  --tag-bg: var(--rc-kbd-bg);
  --tag-dot: var(--rc-text-faint);
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}

.tone-accent { --tag-fg: var(--rc-accent-text); --tag-bg: var(--rc-accent-subtle); --tag-dot: var(--rc-accent); }
.tone-success { --tag-fg: var(--rc-success); --tag-bg: var(--rc-success-subtle); --tag-dot: var(--rc-success); }
.tone-warning { --tag-fg: var(--rc-warning); --tag-bg: var(--rc-warning-subtle); --tag-dot: var(--rc-warning); }
.tone-error { --tag-fg: var(--rc-error); --tag-bg: var(--rc-error-subtle); --tag-dot: var(--rc-error); }
.tone-info { --tag-fg: var(--rc-h-slate-fg); --tag-bg: var(--rc-h-slate-bg); --tag-dot: var(--rc-h-slate-fg); }

.is-soft {
  height: 20px;
  padding: 0 7px;
  border-radius: 5px;
  background: var(--tag-bg);
  color: var(--tag-fg);
}

.is-dot {
  gap: 6px;
  color: var(--rc-text-secondary);
  font-size: 12px;
}

.is-dot::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tag-dot);
}

.is-text {
  color: var(--tag-fg);
  font-size: 11px;
}

.is-text.tone-neutral {
  color: var(--rc-text-faint);
}
</style>
