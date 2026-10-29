<template>
  <div
    v-if="accessory.progress !== undefined"
    class="decl-acc-progress decl-progress-track bg-[var(--rc-border)]"
    role="progressbar"
    :aria-valuenow="progressValue"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div class="decl-acc-progress-fill" :style="{ width: `${Math.max(6, progressValue)}%`, backgroundColor: 'var(--rc-text-muted)' }" />
  </div>
  <span v-else-if="hasTag" class="decl-acc decl-acc-tag" :style="tagStyle">{{ displayText(tagText) }}</span>
  <span v-else-if="hasText" class="decl-acc decl-acc-text" :title="displayText(textValue)">{{ displayText(textValue) }}</span>
</template>

<script setup>
// 列表行右侧附件：单色进度条 / 中性或风险标签 / 文本。左右两栏共用，正文字体 + 等宽数字
import { computed } from "vue";
import { resolveThemeColor } from "../colors.js";
import { displayText } from "../uiText.js";

const props = defineProps({
  accessory: {
    type: Object,
    required: true
  }
});

const progressValue = computed(() => {
  const raw = props.accessory.progress;
  const n = Number(typeof raw === "object" && raw !== null ? raw.value : raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
});

const hasTag = computed(() => Boolean(props.accessory.tag));
const tagText = computed(() => {
  const tag = props.accessory.tag;
  return typeof tag === "object" && tag !== null ? tag.value : tag;
});

const hasText = computed(() => Boolean(props.accessory.text));
const textValue = computed(() => {
  const text = props.accessory.text;
  return typeof text === "object" && text !== null ? text.value : text;
});

// 与图标共用 resolveThemeColor：Color.Red、"red"、"raycast-red" 都按风险色显示；其余颜色保持灰阶（颜色只用来表示风险）
const tagStyle = computed(() => {
  const tag = props.accessory.tag;
  const rawColor = typeof tag === "object" && typeof tag?.color === "string" ? tag.color.toLowerCase() : "";
  const isDanger = resolveThemeColor(rawColor) === "var(--rc-error)" || rawColor.includes("danger") || rawColor.includes("ef4444");
  if (isDanger) {
    return { backgroundColor: "var(--rc-error-subtle)", borderColor: "var(--rc-error-subtle)", color: "var(--rc-error)" };
  }
  return { backgroundColor: "var(--rc-surface-hover)", borderColor: "var(--rc-border)", color: "var(--rc-text-secondary)" };
});
</script>

<style scoped>
.decl-acc {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
  padding: 1px 6px;
  border-radius: var(--rc-radius-sm);
  border: 1px solid transparent;
  font-family: var(--rc-font-sans);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.decl-acc-tag {
  font-weight: 500;
}

.decl-acc-text {
  color: var(--rc-text-muted);
  background: transparent;
}

.decl-acc-progress {
  width: 56px;
  height: 6px;
  border-radius: 9999px;
  overflow: hidden;
  flex-shrink: 0;
}

.decl-acc-progress-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.3s ease;
}
</style>
