<script setup>
import { ref, watch } from 'vue'
import { RcSquircle } from '@/components/base'
import { resolveItemGlyph, resolveKeywordGlyph } from '@/utils/brandIcons'

// 悬浮条与工作台搜索下拉共用的一行结果：名称独占一行，路径或说明在第二行，类型标签靠右
const props = defineProps({
  item: { type: Object, required: true },
  active: { type: Boolean, default: false },
  /** 名称的高亮片段（搜索内核排序时已算好命中区间） */
  parts: { type: Array, default: () => [] }
})

const iconFailed = ref(false)
watch(() => props.item?.icon, () => {
  iconFailed.value = false
})

function isImageIcon(icon) {
  return typeof icon === 'string' && /^(https?:|data:image\/|ztools:)/.test(icon)
}
</script>

<template>
  <div class="launcher-row" :class="{ 'is-active': active }">
    <span class="launcher-marker" aria-hidden="true"></span>
    <img
      v-if="item.isApplication && isImageIcon(item.icon) && !iconFailed"
      :src="item.icon"
      class="launcher-app-icon"
      alt=""
      @error="iconFailed = true"
    />
    <RcSquircle
      v-else
      :glyph="resolveItemGlyph(item)"
      :fallback-glyph="resolveKeywordGlyph(item.name || item.title)"
      :src="!item.isApplication && isImageIcon(item.icon) ? item.icon : ''"
      :size="28"
    />
    <div class="launcher-row-text">
      <!-- 片段写在同一行，避免模板换行产生多余空格 -->
      <span class="launcher-row-title" :title="item.name || item.title"><template v-for="(part, partIndex) in (parts.length ? parts : [{ text: item.name || item.title || '', hit: false }])" :key="partIndex"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
      <span v-if="item.description || item.subtitle" class="launcher-row-desc" :title="item.path || item.description || item.subtitle">
        {{ item.description || item.subtitle }}
      </span>
    </div>
    <span v-if="item.badge" class="launcher-row-tag">{{ item.badge }}</span>
  </div>
</template>

<style scoped>
.launcher-row {
  height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px 0 8px;
  border-radius: 10px;
  cursor: pointer;
}

.launcher-row.is-active {
  background: var(--rc-surface-active);
}

.launcher-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.launcher-row.is-active .launcher-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.launcher-app-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  object-fit: contain;
}

.launcher-row-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.launcher-row-title {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 18px;
  font-size: 14px;
  font-weight: 500;
  color: var(--rc-text-primary);
  white-space: nowrap;
}

.launcher-row-title mark {
  padding: 0;
  background: transparent;
  color: var(--rc-accent-text);
}

.launcher-row-desc {
  max-width: 100%;
  line-height: 15px;
  font-size: 11px;
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.launcher-row-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rc-text-faint);
}
</style>
