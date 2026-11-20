<script setup>
import { DownloadIcon, EllipsisIcon, PinIcon } from '@lucide/vue'
import { computed } from 'vue'
import { RcSquircle, RcTag } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { usePluginIcon } from '@/composables/usePluginIcon'
import { useAppI18n } from '@/i18n'
import { getLocalizedPluginName, getLocalizedPluginDescription, getLocalizedCategoryName } from '@/utils/pluginI18n'

const { t } = useAppI18n()

/**
 * 工作台「已安装 / 收藏」横向紧凑启动卡（方案 A）：
 * 左侧图标 + 中间双行（名称与置顶标记 + 单行简介/状态说明）+ 右侧状态/快捷键与悬停快捷菜单入口。
 * 点击卡片即打开（未安装收藏项进入详情页），悬停或聚焦右侧按钮可呼出快捷操作菜单。
 */
const props = defineProps({
  plugin: { type: Object, required: true },
  focused: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false },
  revoked: { type: Boolean, default: false },
  /** 禁用时的标签文字（官方下架为「已下架」，新版本不支持当前系统时为「不支持当前系统」） */
  revokedText: { type: String, default: '' },
  hasUpdate: { type: Boolean, default: false },
  installed: { type: Boolean, default: true },
  /** 插件启动快捷键（触发器中保存的写法，如 'Alt+V'、'CommandOrControl+Shift+J'、'DoubleCtrl'） */
  hotkey: { type: String, default: '' }
})

const emit = defineEmits(['open', 'menu'])

const { pluginGlyph, fallbackGlyph, displayIconUrl, iconFailed } = usePluginIcon(() => props.plugin)

const pluginName = computed(() => getLocalizedPluginName(props.plugin) || props.plugin?.pluginId || '')
const pluginDesc = computed(() => getLocalizedPluginDescription(props.plugin))

const badgeStatus = computed(() => {
  if (props.revoked) return { text: props.revokedText || t('market.card.revoked'), tone: 'error' }
  if (props.hasUpdate) return { text: t('myPage.tile.hasUpdate'), tone: 'accent' }
  return null
})

// 双击修饰键无法拆成键帽，用文字表达
const doubleTapLabel = computed(() => {
  const match = /^double\s*\+?\s*(ctrl|control|alt|option|shift|cmd|command)$/i.exec(props.hotkey.trim())
  return match ? t('myPage.tile.doubleTap', { key: `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` }) : ''
})

// 第二行副标题：未安装收藏项明确提示，已安装优先显示插件简介，缺失时回退分类名保持双行高度稳定
const subtitle = computed(() => {
  if (!props.installed && !props.revoked) {
    return t('myPage.tile.uninstalledHint')
  }
  const desc = pluginDesc.value
  if (desc) return desc
  const cat = String(props.plugin?.category || '').trim()
  return (cat ? getLocalizedCategoryName(cat) : '') || t('myPage.tile.clickToOpen')
})

const title = computed(() => {
  const name = pluginName.value
  const desc = pluginDesc.value
  return desc ? `${name}\n${desc}` : name
})

function onTileOpen() {
  emit('open', props.plugin)
}

function onContextMenu(event) {
  emit('menu', props.plugin, event)
}

function onMoreClick(event) {
  const rect = event.currentTarget?.getBoundingClientRect?.()
  emit('menu', props.plugin, event, { anchorRect: rect || null, source: 'button' })
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    class="plugin-tile"
    :class="{
      'is-focused': focused,
      'is-revoked': revoked,
      'is-uninstalled': !installed && !revoked
    }"
    :title="title"
    @click="onTileOpen"
    @keydown.enter.prevent="onTileOpen"
    @keydown.space.prevent="onTileOpen"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="tile-icon-wrap">
      <RcSquircle
        :glyph="pluginGlyph"
        :fallback-glyph="fallbackGlyph"
        :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
        :size="36"
      />
    </span>

    <span class="tile-body">
      <span class="tile-head">
        <span class="tile-name">{{ pluginName }}</span>
        <span v-if="pinned" class="tile-pin" :title="t('common.pinned')" :aria-label="t('common.pinned')">
          <PinIcon class="w-3 h-3" style="stroke-width: 2.2" aria-hidden="true" />
        </span>
      </span>
      <span class="tile-desc">{{ subtitle }}</span>
    </span>

    <span class="tile-side">
      <span class="tile-meta">
        <RcTag v-if="badgeStatus" variant="soft" :tone="badgeStatus.tone" class="tile-status">
          {{ badgeStatus.text }}
        </RcTag>
        <span
          v-else-if="!installed"
          class="tile-uninstalled-badge"
          :title="t('myPage.tile.notInstalled')"
          aria-hidden="true"
        >
          <DownloadIcon class="w-3 h-3" />
        </span>
        <RcTag v-else-if="doubleTapLabel" variant="text" class="tile-status">
          {{ doubleTapLabel }}
        </RcTag>
        <ShortcutKeys v-else-if="hotkey" class="tile-hotkey" :combo="hotkey" />
      </span>

      <button
        type="button"
        class="tile-more-btn"
        :title="t('common.moreActions')"
        :aria-label="t('common.moreActions')"
        @click.stop="onMoreClick"
        @keydown.enter.stop
        @keydown.space.stop
      >
        <EllipsisIcon class="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.plugin-tile {
  position: relative;
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 12px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-sm);
  color: var(--rc-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--rc-dur) ease,
    background-color var(--rc-dur) ease,
    box-shadow var(--rc-dur) ease;
}

.plugin-tile:hover {
  border-color: var(--rc-border-highlight);
  background: var(--rc-surface-subtle);
  box-shadow: var(--rc-shadow-md);
}

/* 收藏页未安装插件：虚线发丝边框 + 微降对比度表面，与已安装卡片一眼区分 */
.plugin-tile.is-uninstalled {
  border-style: dashed;
  border-color: var(--rc-border-highlight);
  background: var(--rc-surface-subtle);
  box-shadow: none;
}

.plugin-tile.is-uninstalled:hover {
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-sm);
}

.plugin-tile.is-uninstalled .tile-icon-wrap {
  opacity: 0.78;
  transition: opacity var(--rc-dur) ease;
}

.plugin-tile.is-uninstalled:hover .tile-icon-wrap {
  opacity: 1;
}

.plugin-tile:focus-visible {
  outline: none;
}

.plugin-tile.is-focused {
  outline: none;
  border-color: transparent;
  background: color-mix(in srgb, var(--rc-accent) 3.5%, var(--rc-surface));
  box-shadow: var(--rc-focus-ring);
}

.plugin-tile.is-revoked {
  opacity: 0.6;
}

.tile-icon-wrap {
  flex-shrink: 0;
  display: inline-flex;
}

.tile-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tile-head {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}

.tile-name {
  min-width: 0;
  font-size: var(--rc-fs-body);
  font-weight: 600;
  line-height: 18px;
  color: var(--rc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-pin {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  color: var(--rc-text-faint);
}

.tile-desc {
  min-width: 0;
  font-size: var(--rc-fs-small);
  line-height: 16px;
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.is-uninstalled .tile-desc {
  color: var(--rc-text-faint);
}

/* 右侧状态与悬浮更多按钮同槽叠放：常态展示标签/键帽，悬停切换为「···」快捷菜单入口。
   没有状态/键帽时右槽不占宽度，把空间让给简介；悬停或聚焦时才撑出按钮位 */
.tile-side {
  position: relative;
  flex-shrink: 0;
  /* 常态不占宽度，把空间留给描述；悬停出现的「···」按钮绝对定位盖在右侧，
     不改变槽宽，描述的省略位置就不会随悬停跳动 */
  min-width: 0;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
}

.tile-meta {
  display: inline-flex;
  align-items: center;
  transition: opacity var(--rc-dur) ease;
}

.tile-hotkey {
  flex-shrink: 0;
}

.tile-uninstalled-badge {
  width: 22px;
  height: 22px;
  border-radius: var(--rc-radius-sm);
  background: var(--rc-kbd-bg);
  border: 1px solid var(--rc-border);
  color: var(--rc-text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tile-more-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: var(--rc-radius-sm);
  border: 1px solid transparent;
  background: var(--rc-kbd-bg);
  color: var(--rc-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--rc-dur) ease,
    background-color var(--rc-dur) ease,
    border-color var(--rc-dur) ease,
    color var(--rc-dur) ease;
}

.plugin-tile:hover .tile-meta,
.tile-side:focus-within .tile-meta {
  opacity: 0;
}

.plugin-tile:hover .tile-more-btn,
.tile-more-btn:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.tile-more-btn:hover {
  background: var(--rc-surface-active);
  border-color: var(--rc-border-highlight);
  color: var(--rc-text-primary);
}

.tile-more-btn:focus-visible {
  outline: none;
  border-color: var(--rc-accent);
  color: var(--rc-text-primary);
}
</style>
