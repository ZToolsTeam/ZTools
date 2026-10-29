<template>
  <dl class="decl-meta" :class="`is-${variant}`">
    <template v-for="(meta, mIdx) in items" :key="mIdx">
      <hr v-if="meta.type === 'Detail.Metadata.Separator'" class="decl-meta-sep" />

      <div v-else-if="meta.type === 'Detail.Metadata.Label'" class="decl-meta-row">
        <dt class="decl-meta-key">{{ displayText(meta.props?.title) }}</dt>
        <dd class="decl-meta-value" :title="displayText(meta.props?.text)">
          <DeclarativeIcon v-if="meta.props?.icon" :icon="meta.props.icon" :size="14" class="decl-meta-icon" />
          <span class="decl-meta-text">{{ displayText(meta.props?.text) }}</span>
        </dd>
      </div>

      <div v-else-if="meta.type === 'Detail.Metadata.Link'" class="decl-meta-row">
        <dt class="decl-meta-key">{{ displayText(meta.props?.title) }}</dt>
        <dd class="decl-meta-value" :title="displayText(meta.props?.target || meta.props?.text)">
          <a
            :href="safeHref(meta.props?.target)"
            target="_blank"
            rel="noopener noreferrer"
            class="decl-meta-link decl-meta-text"
          >{{ displayText(meta.props?.text) }}</a>
        </dd>
      </div>

      <div v-else-if="meta.type === 'Detail.Metadata.TagList'" class="decl-meta-row is-tags">
        <dt class="decl-meta-key">{{ displayText(meta.props?.title) }}</dt>
        <dd class="decl-meta-tags">
          <span v-for="(tag, tIdx) in meta.children || []" :key="tIdx" class="decl-meta-tag">
            <DeclarativeIcon v-if="tag.props?.icon" :icon="tag.props.icon" :size="12" />
            {{ displayText(tag.props?.text) }}
          </span>
        </dd>
      </div>
    </template>
  </dl>
</template>

<script setup>
// Detail.Metadata 属性栏：列表详情分栏（底部整宽）与独立详情页（右侧栏）共用，长值单行截断、悬停看全文
import DeclarativeIcon from "./DeclarativeIcon.vue";
import { displayText } from "../uiText.js";

defineProps({
  items: {
    type: Array,
    default: () => []
  },
  /** inline：列表详情分栏底部（标签列表靠右）；sidebar：独立详情页右侧栏（标签列表换行到名称下方） */
  variant: {
    type: String,
    default: "inline"
  }
});

/** 链接只放行 http(s) / mailto，其余（如 javascript:）不生成可点击地址 */
function safeHref(target) {
  const href = typeof target === "string" ? target.trim() : "";
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : undefined;
}
</script>

<style scoped>
.decl-meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}

.decl-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 26px;
  min-width: 0;
}

.decl-meta-key {
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--rc-text-muted);
}

.decl-meta-value {
  margin: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--rc-text-primary);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.decl-meta-icon {
  flex-shrink: 0;
}

.decl-meta-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decl-meta-link {
  color: var(--rc-text-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.decl-meta-sep {
  margin: 6px 0;
  border: 0;
  border-top: 1px solid var(--rc-border);
}

.decl-meta-tags {
  margin: 0;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.decl-meta.is-sidebar .decl-meta-row.is-tags {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 0;
}

.decl-meta.is-sidebar .decl-meta-tags {
  justify-content: flex-start;
}

.decl-meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: var(--rc-radius-sm);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface-hover);
  color: var(--rc-text-secondary);
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
}
</style>
