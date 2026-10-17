<script setup>
defineProps({
  isInstalled: Boolean,
  hasUpdate: Boolean,
  downloading: Boolean,
  creatingShortcut: Boolean,
  installFailed: Boolean,
  installError: {
    type: String,
    default: ''
  },
  isRevoked: {
    type: Boolean,
    default: false
  },
  revokedReason: {
    type: String,
    default: ''
  },
  isFavorite: Boolean,
  downloadProgress: Number,
  downloadPhase: String,
  libIndex: Number,
  libTotal: Number,
  // 当前插件绑定的快捷键文本，空字符串表示未绑定
  hotkeyText: {
    type: String,
    default: ''
  },
  commentsCount: {
    type: Number,
    default: 0
  }
})

defineEmits([
  'open',
  'update',
  'uninstall',
  'download',
  'toggle-favorite',
  'create-shortcut',
  'set-hotkey',
  'show-comments'
])
</script>

<template>
  <div class="flex flex-wrap items-center justify-end gap-2">
    <a-tooltip title="查看留言" placement="top">
      <a-button type="default" @click="$emit('show-comments')">
        <i class="fa fa-comments-o mr-1"></i>
        <span>{{ commentsCount }}</span>
      </a-button>
    </a-tooltip>

    <!-- 下架状态强拦截：置灰禁用并展示下架原因 -->
    <a-tooltip v-if="isRevoked" :title="revokedReason || '该插件已被官方下架禁用'">
      <a-button
        type="default"
        disabled
        style="opacity: 0.6; color: var(--rc-error); border-color: var(--rc-error);"
      >
        <i class="fa fa-ban mr-2"></i> 已下架
      </a-button>
    </a-tooltip>

    <!-- 正常已安装且无更新：打开 -->
    <a-button
      v-else-if="isInstalled && !hasUpdate"
      type="primary"
      @click="$emit('open')"
    >
      <i class="fa fa-play mr-2"></i> 打开
    </a-button>

    <!-- 已安装且有更新：更新 -->
    <a-button
      v-else-if="isInstalled && hasUpdate"
      type="primary"
      :loading="downloading"
      @click="$emit('update')"
    >
      <i v-if="!downloading" class="fa fa-arrow-up mr-2"></i>
      {{
        downloading
          ? downloadPhase === 'library'
            ? `安装依赖库 (${libIndex}/${libTotal})... ${downloadProgress}%`
            : downloadProgress > 0
              ? `更新中 ${downloadProgress}%`
              : '更新中...'
          : '更新'
      }}
    </a-button>

    <!-- 未安装且安装失败：展示重试及原因提示 -->
    <a-tooltip v-else-if="!isInstalled && installFailed && !downloading" :title="installError || '安装失败，点击重试'">
      <a-button
        type="primary"
        danger
        @click="$emit('download')"
      >
        <i class="fa fa-refresh mr-2"></i> 重试
      </a-button>
    </a-tooltip>

    <!-- 未安装：一键静默安装 -->
    <a-button
      v-else-if="!isInstalled"
      type="primary"
      :loading="downloading"
      @click="$emit('download')"
    >
      <i v-if="!downloading" class="fa fa-download mr-2"></i>
      {{
        downloading
          ? downloadPhase === 'library'
            ? `安装依赖库 (${libIndex}/${libTotal})... ${downloadProgress}%`
            : downloadProgress > 0
              ? `安装中 ${downloadProgress}%`
              : '安装中...'
          : '安装'
      }}
    </a-button>
    <a-button
      type="default"
      :class="{ 'is-favorite': isFavorite }"
      @click="$emit('toggle-favorite')"
    >
      <i class="fa" :class="isFavorite ? 'fa-star' : 'fa-star-o'"></i>
    </a-button>
    <a-dropdown v-if="isInstalled" :trigger="['click']" placement="bottomRight">
      <a-button type="default" title="更多操作">
        <i class="fa fa-ellipsis-h"></i>
      </a-button>
      <template #overlay>
        <a-menu class="plugin-actions-menu min-w-[180px]">
          <a-menu-item key="hotkey" @click="$emit('set-hotkey')">
            <i class="fa fa-keyboard-o mr-2"></i>
            <span>{{ hotkeyText ? `快捷键：${hotkeyText}` : '设置快捷键' }}</span>
          </a-menu-item>
          <a-menu-item
            key="shortcut"
            :disabled="creatingShortcut"
            @click="$emit('create-shortcut')"
          >
            <i
              class="fa mr-2"
              :class="creatingShortcut ? 'fa-spinner fa-spin' : 'fa-share-square-o'"
            ></i>
            <span>{{ creatingShortcut ? '正在生成...' : '生成桌面快捷方式' }}</span>
          </a-menu-item>
          <a-menu-divider />
          <a-menu-item key="uninstall" @click="$emit('uninstall')">
            <span class="text-[var(--rc-error)]">
              <i class="fa fa-trash-o mr-2"></i>
              卸载
            </span>
          </a-menu-item>
        </a-menu>
      </template>
    </a-dropdown>
  </div>
</template>

<style scoped>
/* 已收藏：星标点亮为余烬橙，按钮本身保持中性 */
.is-favorite :deep(.fa) {
  color: var(--rc-accent);
}

:global(.plugin-actions-menu) {
  border: 1px solid var(--color-border);
  box-shadow: var(--rc-shadow-lg);
  margin-top: 4px;
}

:global(.plugin-actions-menu .ant-menu-item) {
  margin-inline: 4px;
  border-radius: 6px;
}

:global(.plugin-actions-menu .ant-menu-item-divider) {
  margin: 4px 8px;
  background-color: var(--color-border);
}
</style>
