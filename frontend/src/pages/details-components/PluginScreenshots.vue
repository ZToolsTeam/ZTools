<script setup>
import { ChevronLeftIcon, ChevronRightIcon, ImageIcon } from '@lucide/vue'
import { computed, onUnmounted, ref, watch } from 'vue'
import { RcDialog } from '@/components/base'
import { isComposingEvent } from '@/utils/keymap'

const props = defineProps({
  screenshots: {
    type: Array,
    default: () => []
  }
})

// 根据截图数量计算网格列数
const gridClass = computed(() => {
  const count = props.screenshots?.length || 0
  if (count === 1) return 'grid-cols-1'
  if (count === 2) return 'grid-cols-2'
  if (count === 3) return 'grid-cols-3'
  if (count === 4) return 'grid-cols-2 lg:grid-cols-4'
  return 'grid-cols-2 lg:grid-cols-3'
})

// 大图查看：统一用 RcDialog，只保留看图需要的「上一张 / 下一张 / 关闭」
const viewerOpen = ref(false)
const viewerIndex = ref(0)
const current = computed(() => props.screenshots?.[viewerIndex.value] || null)
const total = computed(() => props.screenshots?.length || 0)

const openViewer = (index) => {
  viewerIndex.value = index
  viewerOpen.value = true
}
const step = (delta) => {
  if (total.value < 2) return
  viewerIndex.value = (viewerIndex.value + delta + total.value) % total.value
}
// 对话框打开时页面快捷键已停用（keymap 识别到对话框），这里只处理左右切换
const onViewerKeydown = (event) => {
  if (isComposingEvent(event)) return
  if (event.key === 'ArrowLeft') step(-1)
  else if (event.key === 'ArrowRight') step(1)
  else return
  event.preventDefault()
}
watch(viewerOpen, (open, _old, onCleanup) => {
  if (!open) return
  window.addEventListener('keydown', onViewerKeydown)
  onCleanup(() => window.removeEventListener('keydown', onViewerKeydown))
})
onUnmounted(() => window.removeEventListener('keydown', onViewerKeydown))
</script>

<template>
  <!-- 插件截图区 -->
  <div v-if="screenshots && screenshots.length > 0" class="screenshots-section">
    <h3 class="section-title">
      <ImageIcon  />
      插件截图
    </h3>
    <div class="screenshots-grid" :class="gridClass">
      <div
        v-for="(screenshot, index) in screenshots"
        :key="index"
        class="screenshot-item"
      >
        <button
          type="button"
          class="screenshot-wrapper"
          :aria-label="`查看大图：${screenshot.title || `截图 ${index + 1}`}`"
          @click="openViewer(index)"
        >
          <img
            :src="screenshot.url"
            :alt="screenshot.title || `截图 ${index + 1}`"
            :width="screenshot.width"
            :height="screenshot.height"
            class="screenshot-image"
            loading="lazy"
          />
        </button>
        <p v-if="screenshot.title" class="screenshot-title">
          {{ screenshot.title }}
        </p>
      </div>
    </div>

    <RcDialog v-model:open="viewerOpen" :width="960" wrap-class-name="screenshot-viewer">
      <figure v-if="current" class="viewer">
        <div class="viewer-stage">
          <img :src="current.url" :alt="current.title || `截图 ${viewerIndex + 1}`" class="viewer-image" />
        </div>
        <figcaption class="viewer-bar">
          <button v-if="total > 1" type="button" class="viewer-nav" aria-label="上一张" @click="step(-1)">
            <ChevronLeftIcon aria-hidden="true" />
          </button>
          <span class="viewer-caption">
            <span v-if="current.title" class="viewer-title">{{ current.title }}</span>
            <span class="viewer-count">{{ viewerIndex + 1 }} / {{ total }}</span>
          </span>
          <button v-if="total > 1" type="button" class="viewer-nav" aria-label="下一张" @click="step(1)">
            <ChevronRightIcon aria-hidden="true" />
          </button>
        </figcaption>
      </figure>
    </RcDialog>
  </div>

  <!-- 没有截图时不渲染占位卡，详情 Tab 紧跟头部 -->
</template>

<style scoped>
.screenshots-section {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--rc-text-primary);
  margin: 0 0 12px;
}

.section-title :deep(.lucide) {
  color: var(--rc-text-muted);
}

/* 截图网格 */
.screenshots-grid {
  display: grid;
  gap: 16px;
}

.screenshots-grid.grid-cols-1 {
  grid-template-columns: 1fr;
}

.screenshots-grid.grid-cols-2 {
  grid-template-columns: repeat(2, 1fr);
}

.screenshots-grid.grid-cols-3 {
  grid-template-columns: repeat(3, 1fr);
}

@media (min-width: 1024px) {
  .screenshots-grid.lg\:grid-cols-3 {
    grid-template-columns: repeat(3, 1fr);
  }

  .screenshots-grid.lg\:grid-cols-4 {
    grid-template-columns: repeat(4, 1fr);
  }
}

@media (max-width: 640px) {
  .screenshots-grid.grid-cols-2,
  .screenshots-grid.grid-cols-3 {
    grid-template-columns: 1fr;
  }
}

/* 截图项 */
.screenshot-item {
  display: flex;
  flex-direction: column;
}

.screenshot-wrapper {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--rc-border-subtle);
  border-radius: 12px;
  overflow: hidden;
  background: var(--rc-canvas);
  aspect-ratio: 16 / 10;
  cursor: zoom-in;
}

.screenshot-wrapper:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.screenshot-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.screenshot-wrapper:hover .screenshot-image {
  transform: scale(1.03);
}

/* 大图查看 */
.viewer {
  margin: 0;
  padding-top: 28px;
}

.viewer-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  max-height: 70vh;
  border-radius: 10px;
  background: var(--rc-surface-subtle);
  overflow: hidden;
}

.viewer-image {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}

.viewer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

.viewer-caption {
  flex: 1;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 10px;
  min-width: 0;
}

.viewer-title {
  overflow: hidden;
  color: var(--rc-text-primary);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.viewer-count {
  color: var(--rc-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.viewer-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font-size: 16px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.viewer-nav:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.screenshot-title {
  font-size: 13px;
  color: var(--rc-text-secondary);
  text-align: center;
  margin: 10px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
