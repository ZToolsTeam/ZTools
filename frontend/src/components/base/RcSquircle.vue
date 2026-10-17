<script setup>
import { computed, ref } from 'vue'
import BrandGlyph from './BrandGlyph.vue'
import { glyphHue, isGlyph } from '@/utils/brandIcons'

/**
 * 插件 / 分类图标底块。
 * 优先级：品牌图形 glyph（官方插件，统一线性 + 大地色）> 插件自带图片 src > 字体图标 icon > 默认立方体。
 * 圆角固定为边长的 28%，与积木 Z 标志的方块比例一致。
 */
const props = defineProps({
  src: { type: String, default: '' },
  icon: { type: String, default: '' },
  glyph: { type: String, default: '' },
  size: { type: [Number, String], default: 38 },
  // 兼容旧调用：圆角已统一按尺寸计算，这两个参数不再生效
  rounded: { type: String, default: '' },
  color: { type: String, default: '' }
})

const imageFailed = ref(false)
const imageLoaded = ref(false)

const sizePx = computed(() => {
  const n = typeof props.size === 'number' ? props.size : parseFloat(props.size)
  return Number.isFinite(n) && n > 0 ? n : 38
})
const hasGlyph = computed(() => isGlyph(props.glyph))
const showImage = computed(() => !hasGlyph.value && !!props.src && !imageFailed.value)
const hue = computed(() => (hasGlyph.value ? glyphHue(props.glyph) : 'neutral'))

const tileStyle = computed(() => ({
  width: `${sizePx.value}px`,
  height: `${sizePx.value}px`,
  minWidth: `${sizePx.value}px`,
  minHeight: `${sizePx.value}px`,
  borderRadius: `${Math.round(sizePx.value * 0.28)}px`,
  background: `var(--rc-h-${hue.value}-bg)`,
  color: `var(--rc-h-${hue.value}-fg)`
}))
const glyphSize = computed(() => Math.round(sizePx.value * 0.58))
const faSize = computed(() => `${Math.round(sizePx.value * 0.44)}px`)

const onImgError = () => {
  imageFailed.value = true
}

const onImgLoad = () => {
  imageLoaded.value = true
}
</script>

<template>
  <div class="rc-squircle-container" :style="tileStyle">
    <BrandGlyph v-if="hasGlyph" :kind="glyph" :size="glyphSize" />

    <template v-else>
      <!-- 第三方插件自带图标：内缩留白放进中性底块，避免满铺溢出 -->
      <img
        v-if="showImage"
        :src="src"
        class="rc-squircle-img"
        :class="{ 'is-loaded': imageLoaded }"
        alt=""
        loading="lazy"
        @load="onImgLoad"
        @error="onImgError"
      />
      <div v-if="!showImage || !imageLoaded" class="rc-squircle-fallback">
        <i v-if="icon && icon.startsWith('fa') && icon !== 'fa-cube'" :class="['fa fa-fw', icon]" :style="{ fontSize: faSize }"></i>
        <BrandGlyph v-else kind="cube" :size="glyphSize" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.rc-squircle-container {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  user-select: none;
  box-shadow: inset 0 0 0 1px var(--rc-h-line);
}

.rc-squircle-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 18%;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.rc-squircle-img.is-loaded {
  opacity: 1;
}

.rc-squircle-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
