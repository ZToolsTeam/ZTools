<template>
  <!-- 盒模型与 PluginCard3D 紧凑卡对齐（1px 边框、12px×14px 内边距、36px 图标、约 40px 双行文本），骨架→内容不跳动 -->
  <div
    class="border animate-pulse"
    style="
      border-radius: var(--rc-radius-lg);
      padding: 12px 14px;
      background-color: var(--rc-surface);
      border-color: var(--rc-border);
    "
  >
    <div class="flex items-center" style="gap: var(--spacing-md)">
      <div
        style="
          width: 36px;
          height: 36px;
          flex-shrink: 0;
          border-radius: var(--rc-radius-md);
          background-color: var(--rc-canvas);
        "
      ></div>
      <div
        class="flex-1"
        style="display: flex; flex-direction: column; gap: var(--spacing-sm); padding: 2px 0"
      >
        <div
          class="h-4"
          style="
            width: 50%;
            border-radius: var(--rc-radius-xs);
            background-color: var(--rc-canvas);
          "
        ></div>
        <div
          class="h-3"
          style="
            width: 33%;
            border-radius: var(--rc-radius-xs);
            background-color: var(--rc-canvas);
          "
        ></div>
      </div>
    </div>
  </div>
</template>
