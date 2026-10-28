<script setup>
import { ArrowUpOutlined, DeleteOutlined, DownloadOutlined, EllipsisOutlined, ExportOutlined, LoadingOutlined, MessageOutlined, PlayCircleOutlined, ReloadOutlined, StarFilled, StarOutlined, StopOutlined } from '@ant-design/icons-vue'
import BrandGlyph from '@/components/base/BrandGlyph.vue'
defineProps({
  isInstalled: Boolean,
  // 内置插件随客户端提供，不能卸载
  canUninstall: {
    type: Boolean,
    default: true
  },
  // 桌面快捷方式只有 Windows 支持
  canCreateShortcut: {
    type: Boolean,
    default: true
  },
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
  // 留言数；为 null 时不显示留言入口（开源版没有留言）
  commentsCount: {
    type: Number,
    default: null
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
    <a-tooltip v-if="commentsCount !== null" title="查看留言" placement="top">
      <a-button type="default" @click="$emit('show-comments')">
        <MessageOutlined class="mr-1" />
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
        <StopOutlined class="mr-2" /> 已下架
      </a-button>
    </a-tooltip>

    <!-- 正常已安装且无更新：打开 -->
    <a-button
      v-else-if="isInstalled && !hasUpdate"
      type="primary"
      @click="$emit('open')"
    >
      <PlayCircleOutlined class="mr-2" /> 打开
    </a-button>

    <!-- 已安装且有更新：更新 -->
    <a-button
      v-else-if="isInstalled && hasUpdate"
      type="primary"
      :loading="downloading"
      @click="$emit('update')"
    >
      <ArrowUpOutlined v-if="!downloading" class="mr-2" />
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
        <ReloadOutlined class="mr-2" /> 重试
      </a-button>
    </a-tooltip>

    <!-- 未安装：一键静默安装 -->
    <a-button
      v-else-if="!isInstalled"
      type="primary"
      :loading="downloading"
      @click="$emit('download')"
    >
      <DownloadOutlined v-if="!downloading" class="mr-2" />
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
      <component :is="isFavorite ? StarFilled : StarOutlined" aria-hidden="true" />
    </a-button>
    <a-dropdown v-if="isInstalled" :trigger="['click']" placement="bottomRight">
      <a-button type="default" title="更多操作">
        <EllipsisOutlined  />
      </a-button>
      <template #overlay>
        <a-menu class="plugin-actions-menu min-w-[180px]">
          <a-menu-item key="hotkey" @click="$emit('set-hotkey')">
            <BrandGlyph kind="keyboard" :size="14" class="mr-2" />
            <span>{{ hotkeyText ? `快捷键：${hotkeyText}` : '设置快捷键' }}</span>
          </a-menu-item>
          <a-menu-item
            v-if="canCreateShortcut"
            key="shortcut"
            :disabled="creatingShortcut"
            @click="$emit('create-shortcut')"
          >
            <component :is="creatingShortcut ? LoadingOutlined : ExportOutlined" class="mr-2" aria-hidden="true" />
            <span>{{ creatingShortcut ? '正在生成...' : '生成桌面快捷方式' }}</span>
          </a-menu-item>
          <a-menu-divider v-if="canUninstall" />
          <a-menu-item v-if="canUninstall" key="uninstall" @click="$emit('uninstall')">
            <span class="text-[var(--rc-error)]">
              <DeleteOutlined class="mr-2" />
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
.is-favorite :deep(.anticon) {
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
