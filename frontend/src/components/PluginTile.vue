<script setup>
import { computed } from 'vue'
import { RcSquircle } from '@/components/base'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { usePluginIcon } from '@/composables/usePluginIcon'

/**
 * 工作台「常用」紧凑磁贴：图标 + 名称（+ 状态），对应设计稿 Dashboard 的 pinned 卡片。
 * 点击即打开（键盘优先：Enter 同样打开），更多操作走右键 / 动作面板，避免每张卡片堆满按钮。
 */
const props = defineProps({
  plugin: { type: Object, required: true },
  focused: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false },
  revoked: { type: Boolean, default: false },
  hasUpdate: { type: Boolean, default: false },
  installed: { type: Boolean, default: true },
  /** 插件启动快捷键（触发器中保存的写法，如 'Alt+V'、'CommandOrControl+Shift+J'、'DoubleCtrl'） */
  hotkey: { type: String, default: '' }
})

const emit = defineEmits(['open', 'menu'])

const { pluginIcon, pluginGlyph, displayIconUrl, iconFailed } = usePluginIcon(() => props.plugin)

const status = computed(() => {
  if (props.revoked) return { text: '已下架', tone: 'error' }
  if (props.hasUpdate) return { text: '可更新', tone: 'accent' }
  if (!props.installed) return { text: '未安装', tone: 'muted' }
  return null
})

// 双击修饰键无法拆成键帽，用文字表达
const doubleTapLabel = computed(() => {
  const match = /^double\s*\+?\s*(ctrl|control|alt|option|shift|cmd|command)$/i.exec(props.hotkey.trim())
  return match ? `双击 ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()}` : ''
})

const title = computed(() => {
  const name = props.plugin?.name || props.plugin?.pluginId || ''
  const desc = props.plugin?.description || ''
  return desc ? `${name}\n${desc}` : name
})
</script>

<template>
  <button
    type="button"
    class="plugin-tile"
    :class="{ 'is-focused': focused, 'is-revoked': revoked }"
    :title="title"
    @click="emit('open', plugin)"
    @contextmenu.prevent="emit('menu', plugin, $event)"
  >
    <span class="tile-marker" aria-hidden="true"></span>
    <span v-if="pinned" class="tile-pin" title="已固定" aria-label="已固定">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z" />
      </svg>
    </span>
    <RcSquircle
      :glyph="pluginGlyph"
      :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
      :icon="pluginIcon"
      :size="36"
    />
    <span class="tile-foot">
      <span class="tile-name">{{ plugin.name || plugin.pluginId }}</span>
      <span v-if="status" class="tile-status" :class="`is-${status.tone}`">{{ status.text }}</span>
      <span v-else-if="doubleTapLabel" class="tile-status is-muted">{{ doubleTapLabel }}</span>
      <ShortcutKeys v-else-if="hotkey" class="tile-hotkey" :combo="hotkey" />
    </span>
  </button>
</template>

<style scoped>
.plugin-tile {
  position: relative;
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
  color: var(--rc-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.plugin-tile:hover {
  border-color: var(--rc-border-highlight);
}

.plugin-tile:focus-visible,
.plugin-tile.is-focused {
  outline: none;
  border-color: transparent;
  box-shadow: var(--rc-focus-ring);
}

.plugin-tile.is-revoked {
  opacity: 0.6;
}

/* 右上角积木标记：键盘聚焦时点亮 */
.tile-marker {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  background: transparent;
}

.is-focused .tile-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.tile-pin {
  position: absolute;
  top: 9px;
  right: 24px;
  display: inline-flex;
  color: var(--rc-text-faint);
}

.tile-foot {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tile-name {
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile-hotkey {
  flex-shrink: 0;
}

.tile-status {
  flex-shrink: 0;
  font-size: 11px;
}

.tile-status.is-error {
  color: var(--rc-error);
}

.tile-status.is-accent {
  color: var(--rc-accent-text);
}

.tile-status.is-muted {
  color: var(--rc-text-faint);
}
</style>
