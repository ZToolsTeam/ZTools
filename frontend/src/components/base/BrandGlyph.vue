<script setup>
import { computed } from 'vue'
import { GLYPHS, isGlyph } from '@/utils/brandIcons'

/** 渲染品牌线性图形（不含底块），线宽随尺寸换算，保证 14–40px 下视觉粗细接近 1.5px */
const props = defineProps({
  kind: { type: String, required: true },
  size: { type: Number, default: 16 }
})

const elements = computed(() => (isGlyph(props.kind) ? GLYPHS[props.kind] : GLYPHS.cube))
const strokeWidth = computed(() => Math.round(Math.min(2.4, Math.max(1.6, 36 / props.size)) * 100) / 100)
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <component :is="tag" v-for="([tag, attrs], index) in elements" :key="index" v-bind="attrs" />
  </svg>
</template>
