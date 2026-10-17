<script setup>
import { computed, useId } from 'vue'

/**
 * ZTools 标志「积木 Z」：24 网格，方块边长 6、间距 1、圆角 1.7（边长的 28%）。
 * 三块墨色拼出 Z 的骨架，末块余烬橙表示「按一下，就到」。
 * 光晕强度跟随主题变量：暗色完整光晕、亮色淡光晕；尺寸 ≤ 16px 时去掉光晕保证清晰。
 */
const props = defineProps({
  size: { type: Number, default: 20 },
  glow: { type: Boolean, default: true }
})

const uid = useId()
const softId = `zt-mark-soft-${uid}`
const coreId = `zt-mark-core-${uid}`
const showGlow = computed(() => props.glow && props.size > 16)
</script>

<template>
  <svg
    class="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    overflow="visible"
    role="img"
    aria-label="ZTools"
  >
    <defs v-if="showGlow">
      <filter :id="softId" x="-150%" y="-150%" width="400%" height="400%">
        <feGaussianBlur stdDeviation="3.2" />
      </filter>
      <filter :id="coreId" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="1.1" />
      </filter>
    </defs>
    <template v-if="showGlow">
      <rect class="glow-soft" x="16" y="12.5" width="6" height="6" rx="1.7" :filter="`url(#${softId})`" />
      <rect class="glow-core" x="16" y="12.5" width="6" height="6" rx="1.7" :filter="`url(#${coreId})`" />
    </template>
    <rect class="ink" x="2" y="5.5" width="6" height="6" rx="1.7" />
    <rect class="ink" x="9" y="5.5" width="6" height="6" rx="1.7" />
    <rect class="ink" x="9" y="12.5" width="6" height="6" rx="1.7" />
    <rect class="lit" x="16" y="12.5" width="6" height="6" rx="1.7" />
  </svg>
</template>

<style scoped>
.brand-mark {
  flex-shrink: 0;
  display: block;
}

.ink {
  fill: var(--rc-mark-ink);
}

.lit,
.glow-soft,
.glow-core {
  fill: var(--rc-accent);
}

.glow-soft {
  opacity: var(--rc-mark-glow-soft);
}

.glow-core {
  opacity: var(--rc-mark-glow-core);
}
</style>
