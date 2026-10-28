<script setup>
import { PictureOutlined } from '@ant-design/icons-vue'
import { computed } from 'vue'

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
</script>

<template>
  <!-- 插件截图区 -->
  <div v-if="screenshots && screenshots.length > 0" class="screenshots-section">
    <h3 class="section-title">
      <PictureOutlined  />
      插件截图
    </h3>
    <div class="screenshots-grid" :class="gridClass">
      <a-image-preview-group>
        <div
          v-for="(screenshot, index) in screenshots"
          :key="index"
          class="screenshot-item"
        >
          <div class="screenshot-wrapper">
            <a-image
              :src="screenshot.url"
              :alt="screenshot.title || `截图 ${index + 1}`"
              class="screenshot-image"
            />
          </div>
          <p v-if="screenshot.title" class="screenshot-title">
            {{ screenshot.title }}
          </p>
        </div>
      </a-image-preview-group>
    </div>
  </div>

  <!-- 截图占位（如果没有截图） -->
  <div v-else class="screenshots-section">
    <h3 class="section-title">
      <PictureOutlined  />
      插件截图
    </h3>
    <div class="empty-screenshots">
      <div v-for="i in 3" :key="i" class="empty-item">
        <div class="empty-icon">
          <PictureOutlined  />
        </div>
        <p>暂无截图</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screenshots-section {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
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
  color: var(--zt-text);
  margin: 0 0 12px;
}

.section-title :deep(.anticon) {
  color: var(--zt-primary);
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
  border-radius: 12px;
  overflow: hidden;
  background: var(--color-background-secondary);
  aspect-ratio: 16 / 10;
  cursor: zoom-in;
}

.screenshot-wrapper :deep(.ant-image) {
  display: block;
  width: 100%;
  height: 100%;
}

.screenshot-wrapper :deep(.ant-image-img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.screenshot-wrapper:hover :deep(.ant-image-img) {
  transform: scale(1.03);
}

.screenshot-title {
  font-size: 13px;
  color: var(--zt-text-secondary);
  text-align: center;
  margin: 10px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 空状态 */
.empty-screenshots {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

@media (max-width: 640px) {
  .empty-screenshots {
    grid-template-columns: 1fr;
  }
}

.empty-item {
  aspect-ratio: 16 / 10;
  border-radius: 12px;
  background: var(--color-background-secondary);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.empty-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: var(--color-background);
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-icon :deep(.anticon) {
  font-size: 20px;
  color: var(--zt-text-disabled);
}

.empty-item p {
  font-size: 13px;
  color: var(--zt-text-disabled);
  margin: 0;
}
</style>
