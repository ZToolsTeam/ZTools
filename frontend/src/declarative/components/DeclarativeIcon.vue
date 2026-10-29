<template>
  <span
    class="inline-flex items-center justify-center flex-shrink-0"
    :style="customStyle"
  >
    <!-- DataURL 或外链图片 -->
    <img
      v-if="isImageSource"
      :src="imageUrl"
      class="w-full h-full object-contain"
      alt=""
    />
    <!-- 内置图标（线性描边；圆点类为实心）；未知图标名显示中性圆角方块轮廓 -->
    <svg
      v-else
      class="w-full h-full"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      :data-icon="shape.fallback ? 'fallback' : iconKey"
    >
      <path v-if="shape.fill" :d="shape.fill" fill="currentColor" stroke="none" />
      <path v-for="(d, i) in shape.strokes" :key="i" :d="d" />
    </svg>
  </span>
</template>

<script setup>
import { computed } from "vue";
import { normalizeIconName, resolveIconShape } from "../icons.js";
import { resolveThemeColor } from "../colors.js";

const props = defineProps({
  icon: {
    type: [String, Object],
    default: ""
  },
  size: {
    type: Number,
    default: 18
  },
  tintColor: {
    type: String,
    default: ""
  }
});

const rawSource = computed(() => {
  if (!props.icon) return "";
  if (typeof props.icon === "string") return props.icon;
  if (typeof props.icon === "object" && typeof props.icon.source === "string") return props.icon.source;
  return "";
});

const iconKey = computed(() => normalizeIconName(rawSource.value));

const isImageSource = computed(() => {
  const k = rawSource.value.trim().toLowerCase();
  return k.startsWith("data:") || k.startsWith("http://") || k.startsWith("https://");
});

const imageUrl = computed(() => rawSource.value.trim());

const shape = computed(() => resolveIconShape(rawSource.value));

// Color.* 语义色按深色主题写死，必须经 resolveThemeColor 换成跟随主题的变量
const tint = computed(
  () =>
    resolveThemeColor(props.tintColor) ||
    (props.icon && typeof props.icon === "object" ? resolveThemeColor(props.icon.tintColor) : "")
);

const customStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  color: tint.value || "inherit"
}));
</script>
