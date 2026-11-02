<script setup>
/**
 * 工作台磁贴占位：盒模型与 PluginTile 一致（边框、内边距、36px 图标、16px 间距、13px 名称行），高度完全相同。
 * 用于收藏详情加载中的占位，以及给另一个标签预留高度，避免切换标签或数据到达时页面跳动。
 */
</script>

<template>
  <div class="plugin-tile-skeleton" aria-hidden="true">
    <span class="skeleton-icon"></span>
    <span class="skeleton-name">&nbsp;</span>
  </div>
</template>

<style scoped>
.plugin-tile-skeleton {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
  padding: 14px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
}

.skeleton-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--rc-surface-hover);
}

/* 与磁贴名称同字号，行高沿用继承值，占位条只画在行中间 */
.skeleton-name {
  position: relative;
  display: block;
  width: 55%;
  font-size: 13px;
}

.skeleton-name::after {
  content: '';
  position: absolute;
  inset: 50% 0 auto;
  height: 10px;
  transform: translateY(-50%);
  border-radius: 4px;
  background: var(--rc-surface-hover);
}
</style>
