<script setup>
import { DownloadIcon, EllipsisIcon, PinIcon } from '@lucide/vue'
import { computed } from 'vue'
import { RcSquircle, RcTag } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { usePluginIcon } from '@/composables/usePluginIcon'

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
  revokedText: { type: String, default: '已下架' },
  hasUpdate: { type: Boolean, default: false },
  installed: { type: Boolean, default: true },
  /** 插件启动快捷键（触发器中保存的写法，如 'Alt+V'、'CommandOrControl+Shift+J'、'DoubleCtrl'） */
  hotkey: { type: String, default: '' }
})

const emit = defineEmits(['open', 'menu'])

const { pluginGlyph, fallbackGlyph, displayIconUrl, iconFailed } = usePluginIcon(() => props.plugin)

const badgeStatus = computed(() => {
  if (props.revoked) return { text: props.revokedText || '已下架', tone: 'error' }
  if (props.hasUpdate) return { text: '可更新', tone: 'accent' }
  return null
})

// 双击修饰键无法拆成键帽，用文字表达
const doubleTapLabel = computed(() => {
  const match = /^double\s*\+?\s*(ctrl|control|alt|option|shift|cmd|command)$/i.exec(props.hotkey.trim())
  return match ? `双击 ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` : ''
})

// 第二行副标题：未安装收藏项明确提示，已安装优先显示插件简介，缺失时回退分类名保持双行高度稳定
const subtitle = computed(() => {
  if (!props.installed && !props.revoked) {
    return '未安装 · 点击查看详情'
  }
  const desc = String(props.plugin?.description || '').trim()
  if (desc) return desc
  const cat = String(props.plugin?.category || '').trim()
  return cat || '点击立即打开'
})

const title = computed(() => {
  const name = props.plugin?.name || props.plugin?.pluginId || ''
  const desc = props.plugin?.description || ''
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
    <span class="tile-marker" aria-hidden="true"></span>

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
        <span class="tile-name">{{ plugin.name || plugin.pluginId }}</span>
        <span v-if="pinned" class="tile-pin" title="已固定" aria-label="已固定">
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
          title="尚未安装"
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
        title="更多操作"
        aria-label="更多操作"
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
  padding: 10px 12px;
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
    border-color 0.15s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
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
  transition: opacity 0.15s ease;
}

.plugin-tile.is-uninstalled:hover .tile-icon-wrap {
  opacity: 1;
}

.plugin-tile:focus-visible,
.plugin-tile.is-focused {
  outline: none;
  border-color: transparent;
  background: color-mix(in srgb, var(--rc-accent) 3.5%, var(--rc-surface));
  box-shadow: var(--rc-focus-ring);
}

.plugin-tile.is-revoked {
  opacity: 0.6;
}

/* 右上角积木标记：键盘聚焦时点亮，悬停显示快捷菜单按钮时自动隐退避免重叠 */
.tile-marker {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  background: transparent;
  pointer-events: none;
  transition: opacity 0.14s ease;
}

.is-focused .tile-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.plugin-tile:hover .tile-marker,
.plugin-tile:focus-within .tile-more-btn:focus-visible ~ .tile-marker {
  opacity: 0;
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
  font-size: 13px;
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
  font-size: 12px;
  line-height: 16px;
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.is-uninstalled .tile-desc {
  color: var(--rc-text-faint);
}

/* 右侧状态与悬浮更多按钮同槽叠放：常态展示标签/键帽，悬停切换为「···」快捷菜单入口 */
.tile-side {
  position: relative;
  flex-shrink: 0;
  min-width: 24px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
}

.tile-meta {
  display: inline-flex;
  align-items: center;
  transition: opacity 0.14s ease;
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
    opacity 0.14s ease,
    background-color 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease;
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
