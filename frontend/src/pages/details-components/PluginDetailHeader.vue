<script setup>
import { StarFilledIcon } from '@/utils/appIcons'
import PluginActions from './PluginActions.vue'

const props = defineProps({
  plugin: {
    type: Object,
    required: true
  },
  isInstalled: Boolean,
  canUninstall: {
    type: Boolean,
    default: true
  },
  canCreateShortcut: {
    type: Boolean,
    default: true
  },
  hasUpdate: Boolean,
  downloading: Boolean,
  creatingShortcut: Boolean,
  installFailed: Boolean,
  isFavorite: Boolean,
  downloadProgress: Number,
  downloadPhase: String,
  libIndex: Number,
  libTotal: Number,
  updateInfo: {
    type: Object,
    default: null
  },
  // 当前插件绑定的快捷键文本
  hotkeyText: {
    type: String,
    default: ''
  },
  // 留言数；为 null 时不显示留言入口（开源版没有留言）
  commentsCount: {
    type: Number,
    default: null
  },
  isRevoked: {
    type: Boolean,
    default: false
  },
  revokedReason: {
    type: String,
    default: ''
  },
  installError: {
    type: String,
    default: ''
  },
  // 评分汇总 { average: number|null, count }；为 null 时不显示评分（开源版没有评分）
  ratingSummary: {
    type: Object,
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

import { usePluginIcon } from '@/composables/usePluginIcon'
import { PlatformLogos, RcSquircle, RcTag } from '@/components/base'
import { computed } from 'vue'
import { normalizeCategoryNames } from '@/utils/pluginCategories'
import { formatBytes } from '@/utils/formatBytes'
import { getPluginPlatforms } from '@/utils/platform'

const { pluginGlyph, fallbackGlyph, displayIconUrl, iconFailed } = usePluginIcon(() => props.plugin)

/**
 * 名称下方一行元信息：开发者 · 版本 · 分类 · 大小 · 安装量 / 内置 · 评分，最后是支持的平台标志。
 * 每项只在有真实数据时出现，不显示「未知」「N/A」这类占位，也不与其它位置重复。
 */
const metaItems = computed(() => {
  const p = props.plugin || {}
  const items = []
  if (p.author) items.push({ key: 'author', text: p.author })
  if (p.version) items.push({ key: 'version', text: `v${p.version}` })
  const category = normalizeCategoryNames(p.category).join(' · ')
  if (category) items.push({ key: 'category', text: category })
  const size = formatBytes(p.size ?? p.fileSize ?? p.file_size)
  if (size) items.push({ key: 'size', text: size, title: p.builtin ? '随客户端分发的文件大小' : '安装包大小' })
  if (p.builtin || p.bundled) {
    items.push({ key: 'builtin', text: '随客户端内置' })
  } else {
    const downloads = Number(p.downloads)
    if (Number.isFinite(downloads) && downloads > 0) items.push({ key: 'downloads', text: `${downloads.toLocaleString('zh-CN')} 次安装` })
  }
  return items
})

const hasPlatforms = computed(() => (getPluginPlatforms(props.plugin) || []).length > 0)

// 只展示真实评分汇总：人数足够时显示「4.6（23 人评分）」，人数不足（average 为 null）时如实说明；没有汇总时不显示
const rating = computed(() => {
  const summary = props.ratingSummary
  if (!summary || typeof summary !== 'object') return null
  const value = Number(summary.average)
  const count = Math.max(0, Math.floor(Number(summary.count) || 0))
  if (summary.average === null || summary.average === undefined || !Number.isFinite(value) || value <= 0 || value > 5) {
    return { score: '', text: '评分人数不足', title: count > 0 ? `已有 ${count} 人评分，满 3 人后显示平均分` : '还没有人评分' }
  }
  const score = value.toFixed(1)
  return { score, text: `${score}（${count} 人评分）`, title: `平均 ${score} / 5，${count} 人评分` }
})
</script>

<template>
  <div class="detail-header">
    <!-- 顶部信息区 -->
    <div class="header-top">
      <!-- 插件图标：官方插件用品牌线性图形，第三方插件用自带图标 -->
      <RcSquircle
        :glyph="pluginGlyph"
        :fallback-glyph="fallbackGlyph"
        :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
        :size="64"
      />

      <!-- 插件信息 -->
      <div class="plugin-info">
        <div class="title-row">
          <h1 class="plugin-name">{{ plugin.name }}</h1>
          <!-- 只放需要用户留意的状态；「已安装」由右侧「打开」按钮表达 -->
          <RcTag
            v-if="plugin.revoked || isRevoked"
            tone="error"
            class="status-tag"
            :title="revokedReason || plugin.revoked_reason || '该插件已被官方下架禁用'"
          >已下架</RcTag>
          <RcTag v-if="hasUpdate" tone="accent" class="status-tag">有新版本</RcTag>
          <RcTag v-else-if="updateInfo?.incompatible" tone="warning" class="status-tag" :title="updateInfo.incompatReason">需升级客户端</RcTag>
        </div>
        <ul v-if="metaItems.length || rating || hasPlatforms" class="plugin-meta">
          <li v-for="item in metaItems" :key="item.key" :class="`meta-${item.key}`" :title="item.title">{{ item.text }}</li>
          <li v-if="rating" class="meta-rating" :title="rating.title">
            <StarFilledIcon v-if="rating.score" class="meta-star" aria-hidden="true" />{{ rating.text }}
          </li>
          <li v-if="hasPlatforms" class="meta-platform"><PlatformLogos :plugin="plugin" /></li>
        </ul>
      </div>

      <!-- 操作按钮 -->
      <PluginActions
        :isInstalled="isInstalled"
        :canUninstall="canUninstall"
        :canCreateShortcut="canCreateShortcut"
        :hasUpdate="hasUpdate"
        :downloading="downloading"
        :creatingShortcut="creatingShortcut"
        :installFailed="installFailed"
        :installError="installError"
        :isRevoked="plugin.revoked || isRevoked"
        :revokedReason="revokedReason || plugin.revoked_reason || ''"
        :isFavorite="isFavorite"
        :downloadProgress="downloadProgress"
        :downloadPhase="downloadPhase"
        :libIndex="libIndex"
        :libTotal="libTotal"
        :hotkeyText="hotkeyText"
        :commentsCount="commentsCount"
        @open="$emit('open')"
        @update="$emit('update')"
        @uninstall="$emit('uninstall')"
        @download="$emit('download')"
        @toggle-favorite="$emit('toggle-favorite')"
        @create-shortcut="$emit('create-shortcut')"
        @set-hotkey="$emit('set-hotkey')"
        @show-comments="$emit('show-comments')"
      />
    </div>

  </div>
</template>

<style scoped>
.detail-header {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 12px;
}

.header-top {
  display: flex;
  align-items: center;
  gap: 16px;
}

.plugin-info {
  flex: 1;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.plugin-name {
  margin: 0;
  color: var(--rc-text-primary);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 28px;
}





/* 元信息：一行，用间隔点分隔 */
.plugin-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--rc-text-muted);
  font-size: 13px;
  line-height: 20px;
}

.plugin-meta li {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}

.plugin-meta li + li::before {
  content: '·';
  margin: 0 8px;
  color: var(--rc-text-faint);
}

.plugin-meta .meta-author {
  color: var(--rc-text-secondary);
}

.plugin-meta .meta-version,
.plugin-meta .meta-size {
  font-variant-numeric: tabular-nums;
}

.meta-platform {
  font-size: 13px;
}

.meta-star {
  margin-right: 3px;
  font-size: 12px;
  color: var(--rc-accent);
}

@media (max-width: 600px) {
  .header-top {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .title-row,
  .plugin-meta {
    justify-content: center;
  }
}
</style>
