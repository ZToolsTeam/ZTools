<script setup>
import { ArrowUpIcon, BanIcon, CirclePlayIcon, DownloadIcon, EllipsisIcon, ExternalLinkIcon, KeyboardIcon, MessageSquareIcon, RotateCcwIcon, RotateCwIcon, SettingsIcon, StarIcon, Trash2Icon } from '@lucide/vue'
import { computed } from 'vue'
import { SpinnerIcon, StarFilledIcon } from '@/utils/appIcons'
import { RcButton, RcMenu } from '@/components/base'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const props = defineProps({
  isInstalled: Boolean,
  isBundled: {
    type: Boolean,
    default: false
  },
  // 是否显示卸载菜单项（普通已装插件直接卸载，内置插件引导至设置页假卸载）
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

const emit = defineEmits([
  'open',
  'update',
  'uninstall',
  'download',
  'toggle-favorite',
  'create-shortcut',
  'set-hotkey',
  'show-comments'
])

// 「更多」菜单：快捷键（已绑定时右侧显示当前组合键）、桌面快捷方式（仅 Windows）、卸载（内置插件不能卸载）
const moreItems = computed(() => {
  const items = [{ key: 'hotkey', label: props.hotkeyText ? t('details.actions.editHotkey') : t('details.actions.setHotkey'), icon: KeyboardIcon, kbd: props.hotkeyText }]
  if (props.canCreateShortcut) {
    items.push({
      key: 'shortcut',
      label: props.creatingShortcut ? t('details.actions.creatingShortcut') : t('details.actions.createShortcut'),
      icon: props.creatingShortcut ? SpinnerIcon : ExternalLinkIcon,
      disabled: props.creatingShortcut
    })
  }
  if (props.canUninstall) {
    items.push({ type: 'separator' }, {
      key: 'uninstall',
      label: props.isBundled ? t('myPage.manageBundledTitle') : t('common.uninstall'),
      icon: props.isBundled ? SettingsIcon : Trash2Icon,
      danger: !props.isBundled
    })
  }
  return items
})

// 安装 / 更新进行中的按钮文案：依赖库阶段显示第几个，下载阶段显示百分比
const progressText = (verb) => {
  if (props.downloadPhase === 'library') {
    return t('details.actions.installingLib', { index: props.libIndex, total: props.libTotal, progress: props.downloadProgress })
  }
  return props.downloadProgress > 0
    ? t('details.actions.progressing', { verb, progress: props.downloadProgress })
    : t('details.actions.progressingEllipsis', { verb })
}

const MORE_EVENTS = { hotkey: 'set-hotkey', shortcut: 'create-shortcut', uninstall: 'uninstall' }
const onMoreSelect = (key) => {
  if (MORE_EVENTS[key]) emit(MORE_EVENTS[key])
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-end gap-2">
    <!-- 有留言时给一个滚动到「评价与留言」卡片的轻量入口；没有留言时不占位 -->
    <a-tooltip v-if="commentsCount > 0" :title="t('details.actions.viewComments')" placement="top">
      <RcButton variant="ghost" size="md" class="comments-entry" :icon="MessageSquareIcon" @click="$emit('show-comments')">
        {{ commentsCount }}
      </RcButton>
    </a-tooltip>

    <!-- 下架状态强拦截：置灰禁用并展示下架原因 -->
    <a-tooltip v-if="isRevoked" :title="revokedReason || t('market.revokedDefaultReason')">
      <RcButton variant="danger" size="md" :icon="BanIcon" disabled>{{ t('market.card.revoked') }}</RcButton>
    </a-tooltip>

    <!-- 正常已安装且无更新：打开 -->
    <RcButton v-else-if="isInstalled && !hasUpdate" variant="primary" size="md" :icon="CirclePlayIcon" @click="$emit('open')">
      {{ t('common.open') }}
    </RcButton>

    <!-- 已安装且有更新：更新 -->
    <RcButton
      v-else-if="isInstalled && hasUpdate"
      variant="primary"
      size="md"
      :icon="ArrowUpIcon"
      :loading="downloading"
      @click="$emit('update')"
    >
      {{ downloading ? progressText(t('common.update')) : t('common.update') }}
    </RcButton>

    <!-- 未安装且安装失败：展示重试及原因提示 -->
    <a-tooltip v-else-if="!isInstalled && installFailed && !downloading" :title="installError || t('market.card.installFailedRetry')">
      <RcButton variant="danger" size="md" :icon="RotateCwIcon" @click="$emit('download')">{{ t('common.retry') }}</RcButton>
    </a-tooltip>

    <!-- 已假卸载的内置插件：一键还原 -->
    <RcButton
      v-else-if="!isInstalled && isBundled"
      variant="primary"
      size="md"
      :icon="RotateCcwIcon"
      :loading="downloading"
      @click="$emit('download')"
    >
      {{ t('common.restore') }}
    </RcButton>

    <!-- 未安装：一键静默安装 -->
    <RcButton
      v-else-if="!isInstalled"
      variant="primary"
      size="md"
      :icon="DownloadIcon"
      :loading="downloading"
      @click="$emit('download')"
    >
      {{ downloading ? progressText(t('common.install')) : t('common.install') }}
    </RcButton>

    <RcButton
      variant="secondary"
      size="md"
      class="icon-only"
      :class="{ 'is-favorite': isFavorite }"
      :icon="isFavorite ? StarFilledIcon : StarIcon"
      :title="isFavorite ? t('common.unfavorite') : t('common.favorite')"
      :aria-label="isFavorite ? t('common.unfavorite') : t('common.favorite')"
      :aria-pressed="isFavorite"
      @click="$emit('toggle-favorite')"
    />
    <RcMenu v-if="isInstalled" :items="moreItems" @select="onMoreSelect">
      <RcButton variant="secondary" size="md" class="icon-only" :icon="EllipsisIcon" :title="t('common.moreActions')" :aria-label="t('common.moreActions')" />
    </RcMenu>
  </div>
</template>

<style scoped>
/* 已收藏：星标点亮为余烬橙，按钮本身保持中性 */
.is-favorite :deep(.lucide) {
  color: var(--rc-accent);
}

.comments-entry {
  color: var(--rc-text-muted);
}

/* 只有图标的按钮：正方形 */
.icon-only {
  width: 36px;
  padding: 0;
}
</style>
