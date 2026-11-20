<script setup>
/**
 * 工作台磁贴占位：盒模型与 PluginTile 横向双行启动卡严格一致（1px 边框、10px×12px（右侧 10px）内边距、36px 图标、18px+16px 双行文本），高度同为 58px。
 * 仅用于收藏详情加载中的占位，避免数据到达时页面跳动。
 */
</script>

<template>
  <div class="plugin-tile-skeleton" aria-hidden="true">
    <span class="skeleton-icon"></span>
    <span class="skeleton-body">
      <span class="skeleton-name">&nbsp;</span>
      <span class="skeleton-desc">&nbsp;</span>
    </span>
  </div>
</template>

<style scoped>
.plugin-tile-skeleton {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
}

.skeleton-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface-hover);
}

.skeleton-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skeleton-name,
.skeleton-desc {
  position: relative;
  display: block;
}

.skeleton-name {
  width: 52%;
  font-size: var(--rc-fs-body);
  line-height: 18px;
}

.skeleton-desc {
  width: 78%;
  font-size: var(--rc-fs-small);
  line-height: 16px;
}

.skeleton-name::after,
.skeleton-desc::after {
  content: '';
  position: absolute;
  inset: 50% 0 auto;
  transform: translateY(-50%);
  border-radius: var(--rc-radius-xs);
  background: var(--rc-surface-hover);
}

.skeleton-name::after {
  height: 10px;
}

.skeleton-desc::after {
  height: 8px;
}
</style>
