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
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ meta.props?.title }}</span>
          <span class="text-[var(--rc-text-primary)] font-medium flex items-center gap-1.5 text-right min-w-0 truncate">
            <DeclarativeIcon v-if="meta.props?.icon" :icon="meta.props.icon" :size="14" />
            <span class="truncate">{{ meta.props?.text }}</span>
          </span>
        </div>

        <!-- 链接 Link (左名右链) -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.Link'"
          class="flex items-center justify-between py-1 text-xs gap-3"
        >
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ meta.props?.title }}</span>
          <a
            :href="meta.props?.target"
            target="_blank"
            class="text-[var(--rc-accent-text)] hover:underline flex items-center gap-1 text-right min-w-0 truncate"
          >
            <span class="truncate">{{ meta.props?.text }}</span>
          </a>
        </div>

        <!-- TagList (左名右标签徽章) -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.TagList'"
          class="flex items-center justify-between py-1 text-xs gap-3"
        >
          <span class="text-[var(--rc-text-muted)] font-normal flex-shrink-0">{{ meta.props?.title }}</span>
          <div class="flex flex-wrap justify-end gap-1.5 min-w-0">
            <span
              v-for="(tag, tIdx) in meta.children"
              :key="tIdx"
              class="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] border border-[var(--rc-border-highlight)] flex items-center gap-1"
              :style="{ color: tag.props?.color, borderColor: tag.props?.color ? `${tag.props.color}40` : undefined }"
            >
              <DeclarativeIcon v-if="tag.props?.icon" :icon="tag.props.icon" :size="12" />
              {{ tag.props?.text }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 模式 B：作为顶级独立的 Detail 页面 (对齐 Raycast NodeDetailView 规范：左 Markdown 宽视口，右固定侧边栏) -->
  <div v-else class="flex h-full overflow-hidden select-text w-full">
    <!-- 主体 Markdown 区域 (占满左侧宽视口) -->
    <div class="flex-1 overflow-y-auto declarative-scrollbar p-6 space-y-4 min-w-0">
      <div v-if="descriptor.props?.isLoading" class="flex items-center gap-2 text-[var(--rc-accent-text)] text-sm">
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
          <span class="text-[var(--rc-text-muted)]">{{ meta.props?.title }}</span>
          <span class="text-[var(--rc-text-primary)] font-medium flex items-center gap-1.5">
            <DeclarativeIcon v-if="meta.props?.icon" :icon="meta.props.icon" :size="14" />
            {{ meta.props?.text }}
          </span>
        </div>

        <!-- 链接 Link -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.Link'"
          class="flex items-center justify-between py-1"
        >
          <span class="text-[var(--rc-text-muted)]">{{ meta.props?.title }}</span>
          <a
            :href="meta.props?.target"
            target="_blank"
            class="text-[var(--rc-accent-text)] hover:underline flex items-center gap-1"
          >
            {{ meta.props?.text }}
          </a>
        </div>

        <!-- TagList -->
        <div
          v-else-if="meta.type === 'Detail.Metadata.TagList'"
          class="space-y-1.5 py-1"
        >
          <div class="text-[var(--rc-text-muted)]">{{ meta.props?.title }}</div>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="(tag, tIdx) in meta.children"
              :key="tIdx"
              class="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] border border-[var(--rc-border-highlight)] flex items-center gap-1"
              :style="{ color: tag.props?.color, borderColor: tag.props?.color ? `${tag.props.color}40` : undefined }"
            >
              <DeclarativeIcon v-if="tag.props?.icon" :icon="tag.props.icon" :size="12" />
              {{ tag.props?.text }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import DeclarativeIcon from "./DeclarativeIcon.vue";

const props = defineProps({
  descriptor: {
    type: Object,
    required: true
  },
  isListDetail: {
    type: Boolean,
    default: false
  }
});

const metadataDescriptor = computed(() => {
  return props.descriptor.props?.metadata || null;
});

const metadataItems = computed(() => {
  return metadataDescriptor.value?.children || [];
});

/**
 * 极简、高效且安全的 Markdown 渲染器 (避免外部臃肿包)
 */
const renderedHtml = computed(() => {
  const md = props.descriptor.props?.markdown || "";
  if (!md) return "";

  // 1. 转义 HTML 字符防 XSS (但允许标准的 data:image/svg)
  let text = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 还原安全的 &nbsp; 实体空白
  text = text.replace(/&amp;nbsp;/g, "\u00A0");

  // 2. 代码块 ```code```（先用占位符暂存，防止代码块内部的 # 注释或空行被后续正则误转为标题/段落）
  const codeBlocks = [];
  text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre class="my-2 bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] rounded-xl p-3.5 font-mono text-xs overflow-x-auto text-[var(--rc-success)] leading-relaxed"><code>${code.trim()}</code></pre>`
    );
    return `@@ZTOOLS_CODE_BLOCK_${idx}@@`;
  });

  // 3. 行内代码 `code`
  text = text.replace(/`([^`\n]+)`/g, '<code class="bg-[var(--rc-surface-active)] px-1.5 py-0.5 rounded text-[var(--rc-warning)] text-xs font-mono">$1</code>');

  // 4. 图片 ![alt](src) (支持 SVG data URL)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    const cleanSrc = src.replace(/&amp;/g, "&");
    return `<div class="my-4 flex items-center justify-center p-4 bg-[var(--rc-surface-hover)] rounded-2xl border border-[var(--rc-border)]"><img src="${cleanSrc}" alt="${alt}" class="max-h-72 object-contain rounded-lg shadow-lg" /></div>`;
  });

  // 5. 链接 [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-[var(--rc-accent-text)] underline underline-offset-2">$1</a>');

  // 6. 水平分割线 ---
  text = text.replace(/^---+\s*$/gm, '<hr class="my-3 border-t border-[var(--rc-border)]" />');

  // 7. 引用块 > text
  text = text.replace(/^&gt;\s?(.*$)/gm, '<blockquote class="my-2 pl-3 border-l-2 border-[var(--rc-accent)] text-[var(--rc-text-secondary)] italic">$1</blockquote>');

  // 8. 标题 # ## ###
  text = text.replace(/^### (.*$)/gim, '<h3 class="text-base font-semibold text-[var(--rc-text-primary)] mt-4 mb-2">$1</h3>');
  text = text.replace(/^## (.*$)/gim, '<h2 class="text-lg font-bold text-[var(--rc-text-primary)] mt-5 mb-2.5 border-b border-[var(--rc-border)] pb-1.5">$1</h2>');
  text = text.replace(/^# (.*$)/gim, '<h1 class="text-xl font-bold text-[var(--rc-text-primary)] mb-3">$1</h1>');

  // 9. 加粗 **text** 与斜体 *text*
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-[var(--rc-text-primary)]">$1</strong>');

  // 10. 列表项 - item
  text = text.replace(/^- (.*$)/gm, '<div class="flex items-start gap-2 my-1"><span class="text-[var(--rc-text-muted)] select-none">•</span><span>$1</span></div>');

  // 11. 换行
  text = text.replace(/\n\n/g, '<div class="h-2"></div>');

  // 12. 还原代码块占位符
  text = text.replace(/@@ZTOOLS_CODE_BLOCK_(\d+)@@/g, (_, idxStr) => {
    return codeBlocks[Number(idxStr)] || "";
  });

  return text;
});
</script>
