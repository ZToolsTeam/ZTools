<template>
  <!-- 模式 A：作为列表右侧的 Detail 预览分栏 (对齐 Raycast List.Item.Detail 规范：纵向上下排布，整宽预览) -->
  <div v-if="isListDetail" class="flex flex-col h-full overflow-hidden select-text w-full">
    <!-- 上半部：Markdown 预览区域 (占满右侧分栏整宽，绝不横向再切列) -->
    <div
      class="flex-1 overflow-y-auto declarative-scrollbar p-6 space-y-4 min-h-0"
      :class="{ 'border-b border-[var(--rc-border)]': metadataDescriptor }"
    >
      <div v-if="descriptor.props?.isLoading" class="flex items-center gap-2 text-[var(--rc-accent-text)] text-sm">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        <span>加载中...</span>
      </div>

      <!-- 渲染 Markdown 内容 (纯安全结构化渲染) -->
      <div class="declarative-markdown prose prose-invert max-w-none space-y-4 text-sm leading-relaxed" v-html="renderedHtml" />
    </div>

    <!-- 下半部：Metadata 属性栏 (对齐 Raycast Details.Metadata，占满右侧分栏整宽，每行左标题右数值) -->
    <div
      v-if="metadataDescriptor"
      class="flex-shrink-0 max-h-[48%] overflow-y-auto declarative-scrollbar p-5 bg-[var(--rc-surface-subtle)] space-y-2 text-xs"
    >
      <div
        v-for="(meta, mIdx) in metadataItems"
        :key="mIdx"
        class="space-y-1"
      >
        <!-- 分割线 -->
        <hr v-if="meta.type === 'Detail.Metadata.Separator'" class="border-[var(--rc-border)] my-2" />

        <!-- 标签项 Label (左名右值) -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.Label'"
          class="flex items-center justify-between py-1 text-xs gap-3"
        >
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ displayText(meta.props?.title) }}</span>
          <span class="text-[var(--rc-text-primary)] font-medium flex items-center gap-1.5 text-right min-w-0 truncate">
            <DeclarativeIcon v-if="meta.props?.icon" :icon="meta.props.icon" :size="14" />
            <span class="truncate">{{ displayText(meta.props?.text) }}</span>
          </span>
        </div>

        <!-- 链接 Link (左名右链) -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.Link'"
          class="flex items-center justify-between py-1 text-xs gap-3"
        >
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ displayText(meta.props?.title) }}</span>
          <a
            :href="meta.props?.target"
            target="_blank"
            class="text-[var(--rc-text-primary)] hover:underline flex items-center gap-1 text-right min-w-0 truncate"
          >
            <span class="truncate">{{ displayText(meta.props?.text) }}</span>
          </a>
        </div>

        <!-- TagList (左名右标签徽章) -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.TagList'"
          class="flex items-center justify-between py-1 text-xs gap-3"
        >
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ displayText(meta.props?.title) }}</span>
          <div class="flex flex-wrap justify-end gap-1.5 min-w-0">
            <span
              v-for="(tag, tIdx) in meta.children"
              :key="tIdx"
              class="px-2 py-0.5 rounded-md text-xs font-medium bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)] flex items-center gap-1"
            >
              <DeclarativeIcon v-if="tag.props?.icon" :icon="tag.props.icon" :size="12" />
              {{ displayText(tag.props?.text) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 模式 B：作为顶级独立的 Detail 页面 (对齐 Raycast NodeDetailView 规范：左 Markdown 宽视口，右固定侧边栏) -->
  <div v-else class="flex flex-col h-full overflow-hidden select-text w-full">
    <!-- 顶部可视化快捷操作按钮栏 -->
    <div
      v-if="quickActions.length > 0"
      class="px-5 py-2.5 border-b border-[var(--rc-border)] bg-[var(--rc-surface-subtle)] flex items-center justify-between gap-2 flex-wrap flex-shrink-0 select-none"
    >
      <div class="flex items-center gap-2 flex-wrap">
        <button
          v-for="(act, aIdx) in quickActions"
          :key="aIdx"
          type="button"
          class="px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 border cursor-pointer"
          :class="[
            act.props?.style === 'destructive'
              ? 'bg-[var(--rc-error-subtle)] text-[var(--rc-error)] border-[var(--rc-error)] hover:brightness-110'
              : aIdx === 0
              ? 'bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] border-[var(--rc-border-highlight)] shadow-sm hover:brightness-110'
              : 'bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] border-[var(--rc-border)] hover:bg-[var(--rc-surface-active)]'
          ]"
          :title="cleanUiText(act.props?.title)"
          @click="emit('trigger-action', act)"
        >
          <DeclarativeIcon v-if="act.props?.icon" :icon="act.props.icon" :size="14" />
          <span>{{ formatShortTitle(act.props?.title) }}</span>
        </button>
      </div>
      <button
        v-if="actions.length > quickActions.length"
        type="button"
        class="px-2.5 py-1 rounded-lg text-xs text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] transition-all cursor-pointer flex-shrink-0"
        title="查看全部可执行动作 (Ctrl+K)"
        @click="emit('open-action-panel')"
      >
        更多动作 ({{ actions.length }})
      </button>
    </div>

    <div class="flex-1 flex overflow-hidden w-full min-h-0">
      <!-- 主体 Markdown 区域 (占满左侧宽视口) -->
      <div class="flex-1 overflow-y-auto declarative-scrollbar p-6 space-y-4 min-w-0">
        <div v-if="descriptor.props?.isLoading" class="flex items-center gap-2 text-[var(--rc-text-secondary)] text-sm">
          <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span>加载中...</span>
        </div>

        <!-- 渲染 Markdown 内容 -->
        <div class="declarative-markdown prose prose-invert max-w-none space-y-4 text-sm leading-relaxed" v-html="renderedHtml" />
      </div>

      <!-- 右侧 Metadata 侧边栏 (固定宽 260px，独立滚动) -->
      <div
        v-if="metadataDescriptor"
        class="w-72 border-l border-[var(--rc-border)] bg-[var(--rc-surface-subtle)] p-5 overflow-y-auto declarative-scrollbar space-y-4 text-xs flex-shrink-0"
      >
        <div
          v-for="(meta, mIdx) in metadataItems"
          :key="mIdx"
          class="space-y-1"
        >
          <!-- 分割线 -->
          <hr v-if="meta.type === 'Detail.Metadata.Separator'" class="border-[var(--rc-border)] my-3" />

          <!-- 标签项 Label -->
          <div
            v-else-if="meta.type === 'Detail.Metadata.Label'"
            class="flex items-center justify-between py-1"
          >
            <span class="text-[var(--rc-text-muted)]">{{ displayText(meta.props?.title) }}</span>
            <span class="text-[var(--rc-text-primary)] font-medium flex items-center gap-1.5">
              <DeclarativeIcon v-if="meta.props?.icon" :icon="meta.props.icon" :size="14" />
              {{ displayText(meta.props?.text) }}
            </span>
          </div>

          <!-- 链接 Link -->
          <div
            v-else-if="meta.type === 'Detail.Metadata.Link'"
            class="flex items-center justify-between py-1"
          >
            <span class="text-[var(--rc-text-muted)]">{{ displayText(meta.props?.title) }}</span>
            <a
              :href="meta.props?.target"
              target="_blank"
              class="text-[var(--rc-text-primary)] hover:underline flex items-center gap-1"
            >
              {{ displayText(meta.props?.text) }}
            </a>
          </div>

          <!-- TagList -->
          <div
            v-else-if="meta.type === 'Detail.Metadata.TagList'"
            class="space-y-1.5 py-1"
          >
            <div class="text-[var(--rc-text-muted)]">{{ displayText(meta.props?.title) }}</div>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="(tag, tIdx) in meta.children"
                :key="tIdx"
                class="px-2 py-0.5 rounded-md text-xs font-medium bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)] flex items-center gap-1"
              >
                <DeclarativeIcon v-if="tag.props?.icon" :icon="tag.props.icon" :size="12" />
                {{ displayText(tag.props?.text) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import DeclarativeIcon from "./DeclarativeIcon.vue";
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
  actions: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(["trigger-action", "open-action-panel"]);

/** 插件固定界面文案（动作按钮标题）：去掉彩色 Emoji 并压缩空白 */
function cleanUiText(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 元数据的名称与取值可能是用户数据：原样显示，不删任何字符；换行显示为 ⏎ */
function displayText(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/\r\n|\r|\n/g, "⏎").replace(/\t/g, " ");
}

const quickActions = computed(() => {
  const list = Array.isArray(props.actions) ? props.actions : [];
  return list
    .filter((a) => {
      const t = String(a?.props?.title || "");
      return t && !t.includes("详情预览分栏") && !t.includes("Toggle Details") && !t.includes("右侧详情分栏");
    })
    .slice(0, 4);
});

function formatShortTitle(title) {
  if (!title) return "执行";
  return cleanUiText(String(title).replace(/\s*\([A-Za-z0-9\s/._+-]+\)\s*$/, "")) || cleanUiText(title);
}

const metadataDescriptor = computed(() => {
  return props.descriptor.props?.metadata || null;
});

const metadataItems = computed(() => {
  return metadataDescriptor.value?.children || [];
});

/**
 * Markdown 渲染（先转义再生成白名单标签，用户原文原样显示）：实现见 ../markdown.js
 */
const renderedHtml = computed(() => renderMarkdown(props.descriptor.props?.markdown || ""));
</script>
