<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  src: { type: String, default: '' },
  icon: { type: String, default: '' },
  size: { type: [Number, String], default: 38 },
  rounded: { type: String, default: 'rounded-[10px]' },
  color: { type: String, default: 'text-[var(--rc-accent)]' }
})

const imageFailed = ref(false)
const imageLoaded = ref(false)

const computedSizeStyle = computed(() => {
  const s = typeof props.size === 'number' ? `${props.size}px` : props.size
  return {
    width: s,
    height: s,
    minWidth: s,
    minHeight: s
  }
})

const onImgError = () => {
  imageFailed.value = true
}

const onImgLoad = () => {
  imageLoaded.value = true
}
</script>

<template>
  <div
    class="rc-squircle-container flex items-center justify-center flex-shrink-0 select-none overflow-hidden transition-all duration-150"
    :class="[rounded]"
    :style="computedSizeStyle"
  >
    <!-- 真实图片图标：带内缩留白，防止粗暴满铺溢出 -->
    <img
      v-if="src && !imageFailed"
      :src="src"
      class="w-full h-full object-contain p-1.5 transition-opacity duration-150"
      :class="[imageLoaded ? 'opacity-100' : 'opacity-0', rounded]"
      @load="onImgLoad"
      @error="onImgError"
      alt="icon"
      loading="lazy"
    />

    <!-- 矢量/字体图标 Fallback：微光单色，拒绝粗暴实心大色块 -->
    <div
      v-if="!src || imageFailed || !imageLoaded"
      class="flex items-center justify-center w-full h-full text-center"
      :class="[color]"
      style="font-size: calc(v-bind('computedSizeStyle.width') * 0.44);"
    >
      <i v-if="icon && icon.startsWith('fa')" :class="['fa fa-fw', icon]"></i>
      <svg
        v-else
        class="w-[50%] h-[50%]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.rc-squircle-container {
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
}

:global(.dark) .rc-squircle-container {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
