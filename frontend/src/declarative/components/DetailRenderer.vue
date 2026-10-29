<template>
  <!-- 模式 A：作为列表右侧的 Detail 预览分栏 (对齐 Raycast List.Item.Detail 规范：纵向上下排布，整宽预览) -->
  <!--
    正文与 Metadata 放在同一个滚动容器里依次排列：原来 Metadata 固定在底部、最多占 48% 高度，
    窗口较矮时正文的可视区被压得很小，最后几段内容紧贴 Metadata 被切掉一半，看起来像被遮住。
  -->
  <div
    v-if="isListDetail"
    class="flex flex-col h-full min-h-0 overflow-y-auto declarative-scrollbar select-text w-full"
    data-decl-detail-scroll
  >
    <div class="p-6 flex-shrink-0" data-decl-detail-body>
      <div v-if="descriptor.props?.isLoading" class="decl-detail-loading">
        <SpinnerIcon class="w-4 h-4" aria-hidden="true" />
        <span>加载中…</span>
      </div>
      <!-- 块间距由 .declarative-markdown 自己的样式控制 -->
      <div class="declarative-markdown" v-html="renderedHtml" />
    </div>

    <div
      v-if="metadataItems.length > 0"
      class="flex-shrink-0 border-t border-[var(--rc-border)] px-5 py-4 bg-[var(--rc-surface-subtle)]"
      data-decl-detail-metadata
    >
      <DetailMetadata :items="metadataItems" variant="inline" />
    </div>
  </div>

  <!-- 模式 B：独立 Detail 页面（左 Markdown 宽视口，右固定侧边栏）。动作统一由宿主底栏与 ⌘K 动作面板承担，页内不再重复一排按钮 -->
  <div v-else class="flex h-full overflow-hidden select-text w-full min-h-0">
    <div class="flex-1 overflow-y-auto declarative-scrollbar p-6 min-w-0">
      <div v-if="descriptor.props?.isLoading" class="decl-detail-loading">
        <SpinnerIcon class="w-4 h-4" aria-hidden="true" />
        <span>加载中…</span>
      </div>
      <div class="declarative-markdown" v-html="renderedHtml" />
    </div>

    <div
      v-if="metadataItems.length > 0"
      class="w-72 border-l border-[var(--rc-border)] bg-[var(--rc-surface-subtle)] px-5 py-4 overflow-y-auto declarative-scrollbar flex-shrink-0"
      data-decl-detail-metadata
    >
      <DetailMetadata :items="metadataItems" variant="sidebar" />
    </div>
  </div>
</template>

<script setup>
import { SpinnerIcon } from '@/utils/appIcons'
import { computed } from "vue";
import DetailMetadata from "./DetailMetadata.vue";
import { renderMarkdown } from "../markdown.js";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  },
  isListDetail: {
    type: Boolean,
    default: false
  },
  // 宿主传入的当前动作（保留接口兼容；动作只在底栏与动作面板中出现）
  actions: {
    type: Array,
    default: () => []
  }
});

defineEmits(["trigger-action", "open-action-panel"]);

const metadataItems = computed(() => {
  const children = props.descriptor.props?.metadata?.children;
  return Array.isArray(children) ? children : [];
});

/**
 * Markdown 渲染（先转义再生成白名单标签，用户原文原样显示）：实现见 ../markdown.js
 */
const renderedHtml = computed(() => renderMarkdown(props.descriptor.props?.markdown || ""));
</script>

<style scoped>
/* 加载提示与列表搜索栏的转圈一致：灰阶，不用强调色 */
.decl-detail-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--rc-text-muted);
}
</style>
