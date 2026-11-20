<script setup>
import { BanIcon, DownloadIcon, RotateCcwIcon, RotateCwIcon, StarIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { GithubLogo, StarFilledIcon } from '@/utils/appIcons'
import { computed, ref } from 'vue'
import { downloadPluginUpdate } from '@/api/apiserver'
import { usePluginsStore } from '@/stores/plugins'
import { isCommunityPluginItem, isOfficialPluginItem } from '@/utils/storeCatalogManager'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { isBundledPlugin } from '@/utils/bundledPlugins'
import { getPluginPlatforms } from '@/utils/platform'
import { track } from '@edition'
import { useAppI18n } from '@/i18n'
import { getLocalizedPluginName, getLocalizedPluginDescription } from '@/utils/pluginI18n'

const { t } = useAppI18n()

const props = defineProps({
  plugin: { type: Object, required: true },
  isInstalled: { type: Boolean, default: false },
  downloading: { type: Boolean, default: false },
  installFailed: { type: Boolean, default: false },
  updateInfo: { type: Object, default: null },
  showFavorite: { type: Boolean, default: false },
  isFavorite: { type: Boolean, default: false },
  // 评分汇总 { average: number|null, count }；只有 average 有值时显示（开源版没有评分，始终不传）
  ratingSummary: { type: Object, default: null },
})

const emit = defineEmits([
  'open',
  'open-app',
  'download',
  'toggle-favorite'
])

const pluginsStore = usePluginsStore()
const isDownloading = computed(() => props.downloading)
const isBundled = computed(() => isBundledPlugin(props.plugin?.pluginId || props.plugin?.id))

const pluginName = computed(() => getLocalizedPluginName(props.plugin))
const pluginDesc = computed(() => getLocalizedPluginDescription(props.plugin) || t('common.noDescription'))

const isRevoked = computed(() =>
  Boolean(props.plugin.revoked || pluginsStore.isRevoked(props.plugin.pluginId))
)
const revokedReason = computed(() =>
  props.plugin.revoked_reason || props.plugin.revokedReason || pluginsStore.getRevokedReason(props.plugin.pluginId) || t('market.revokedDefaultReason')
)
// 插件目录里的新版本不再支持当前系统时也会禁用，文案与官方下架区分开
const isPlatformUnsupported = computed(() =>
  !props.plugin.revoked && pluginsStore.getRevokedKind(props.plugin.pluginId) === 'platform'
)
const revokedLabel = computed(() => (isPlatformUnsupported.value ? t('market.card.platformUnsupported') : t('market.card.revoked')))
const uninstallHint = computed(() =>
  isPlatformUnsupported.value ? t('market.card.uninstallHintPlatform') : t('market.card.uninstallHintRevoked')
)
// 官方标记以目录署名为准（与插件市场「官方 / 社区」筛选一致）：
// 目录明确标为社区的不显示官方；只有没写署名的条目（如随客户端内置的插件）才参考官方名单
const isOfficial = computed(() => {
  const plugin = props.plugin
  if (plugin?.is_official === true) return true
  if (plugin?.is_official === false) return false
  if (isOfficialPluginItem(plugin)) return true
  if (isCommunityPluginItem(plugin)) return false
  return isOfficialPlugin(plugin.pluginId || plugin.id)
})
const hasPlatforms = computed(() => (getPluginPlatforms(props.plugin) || []).length > 0)
const ratingText = computed(() => {
  const summary = props.ratingSummary
  if (!summary || summary.average === null || summary.average === undefined) return ''
  const value = Number(summary.average)
  return Number.isFinite(value) && value > 0 && value <= 5 ? value.toFixed(1) : ''
})
const installError = computed(() =>
  pluginsStore.getInstallError(props.plugin.pluginId)
)

const handleUninstall = async (e) => {
  e?.stopPropagation()
  e?.preventDefault()
  const pluginId = props.plugin.pluginId
  try {
    await pluginsStore.uninstallPlugin(pluginId)
  } catch (err) {
    console.error('[PluginCard3D] 卸载下架插件失败:', err)
  }
}

const hasUpdate = computed(() => props.updateInfo?.hasUpdate && !props.updateInfo?.incompatible)
const isIncompatible = computed(() => props.updateInfo?.hasUpdate && props.updateInfo?.incompatible)
const incompatReason = computed(() => props.updateInfo?.incompatReason || '')
const currentUpdateInfo = computed(() => props.updateInfo)
// 更新状态由 store 的 downloadingSet 驱动，安装完成事件会自动清除
const isUpdating = computed(() => pluginsStore.downloadingSet.has(String(props.plugin.pluginId)))

const onCardBodyClick = (e) => {
  const btn = e?.target?.closest('button')
  if (btn) return
  const pluginId = props.plugin.pluginId
  emit('open', pluginId)
}

const handleActionClick = (e) => {
  e?.stopPropagation()
  e?.preventDefault()
  if (isRevoked.value) return
  const pluginId = props.plugin.pluginId
  if (props.isInstalled) {
    emit('open-app', pluginId)
  } else {
    emit('download', pluginId)
  }
}

const handleUpdate = async (e) => {
  e?.stopPropagation()
  e?.preventDefault()
  if (!hasUpdate.value || !currentUpdateInfo.value || isUpdating.value) return
  const pluginId = props.plugin.pluginId
  // 通过 store 标记下载中并上报用户发起插件更新，安装完成事件会自动清除状态
  pluginsStore.startDownload(pluginId)
  track('plugin_update', pluginId)
  try {
    await downloadPluginUpdate(pluginId, currentUpdateInfo.value)
    // downloadPluginUpdate 只是启动了下载，更新完成由 plugin_install_complete 事件驱动
  } catch (error) {
    console.error('插件更新失败:', error)
    pluginsStore.endDownload(pluginId)
  }
}

const handleToggleFavorite = (e) => {
  e?.stopPropagation()
  e?.preventDefault()
  const pluginId = props.plugin.pluginId
  emit('toggle-favorite', pluginId)
}


// 图标优先级：远程 icon URL > 本地 localIconPath > FA 图标（公共逻辑）
import { usePluginIcon } from '@/composables/usePluginIcon'
import { PlatformLogos, RcSquircle, RcButton } from '@/components/base'
const { pluginGlyph, fallbackGlyph, displayIconUrl, iconFailed, showImgOverlay, onIconLoad, onIconError } = usePluginIcon(() => props.plugin)
</script>

<template>
  <div class="plugin-card-3d-container">
    <div class="card-compact cursor-pointer" @click="onCardBodyClick">
      <div class="flex items-center" style="gap: var(--spacing-md)">
        <!-- 左侧图标：官方插件用品牌线性图形，第三方插件放进中性底块 -->
        <div class="card-icon-wrap">
          <RcSquircle
            :glyph="pluginGlyph"
            :fallback-glyph="fallbackGlyph"
            :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
            :size="36"
          />
        </div>

        <!-- 中间信息 -->
        <div
          class="flex-1 min-w-0"
          style="gap: var(--spacing-xs); display: flex; flex-direction: column"
        >
          <div class="flex items-center min-w-0" style="gap: var(--spacing-xs)">
            <span class="card-title" :title="pluginName">{{ pluginName }}</span>
            <!-- 支持的平台跟在名称后面，图标角上只保留官方标记 -->
            <PlatformLogos v-if="hasPlatforms" :plugin="plugin" class="card-platforms" />
            <span
              v-if="ratingText"
              class="card-rating"
              :title="t('market.card.ratingTooltip', { score: ratingText, count: ratingSummary.count })"
              :aria-label="t('market.card.ratingAria', { score: ratingText })"
            >
              <StarFilledIcon class="card-rating-star" aria-hidden="true" />{{ ratingText }}
            </span>
            <span
              v-if="isRevoked"
              class="card-mark-status is-revoked"
              :title="revokedReason"
              :aria-label="revokedLabel"
            >
              <BanIcon  aria-hidden="true" />
            </span>
            <span
              v-else-if="isIncompatible"
              class="card-mark-status is-incompat"
              :title="incompatReason || t('market.card.upgradeRequired')"
              :aria-label="t('market.card.upgradeRequired')"
            >
              <TriangleAlertIcon  aria-hidden="true" />
            </span>
          </div>
          <p class="card-desc">{{ pluginDesc }}</p>
        </div>

        <!-- 右侧操作 -->
        <div
          class="flex items-center flex-shrink-0"
          style="gap: var(--spacing-xs)"
        >
          <!-- 源码/GitHub 跳转按钮：官方插件隐藏，展示官方认证；社区插件展示源码按钮 -->
          <a
            v-if="!isOfficial && (plugin.homepage_url || plugin.homepage || plugin.github_url)"
            :href="plugin.homepage_url || plugin.homepage || plugin.github_url"
            target="_blank"
            class="card-icon-btn"
            :title="t('market.card.viewSource')"
            @click.stop
          >
            <GithubLogo  />
          </a>

          <button
            v-if="showFavorite"
            class="card-icon-btn"
            :class="{ 'is-active': isFavorite }"
            :title="isFavorite ? t('common.unfavorite') : t('market.card.addFavorite')"
            @click.stop="handleToggleFavorite"
          >
            <component :is="isFavorite ? StarFilledIcon : StarIcon" aria-hidden="true" />
          </button>

          <button
            v-if="hasUpdate"
            class="card-icon-btn update"
            :title="t('common.update')"
            :aria-label="t('common.update')"
            :disabled="isUpdating"
            @click.stop="handleUpdate"
          >
            <RotateCwIcon  :class="{ 'animate-spin': isUpdating }" />
          </button>

          <!-- 已下架插件：禁用启动，标红提示 [已下架]，引导一键安全卸载 -->
          <template v-if="isRevoked">
            <RcButton
            class="card-action"
              v-if="isInstalled"
              size="xs"
              variant="danger"
              :icon="Trash2Icon"
              :title="uninstallHint"
              @click.stop="handleUninstall"
            >
              {{ t('common.uninstall') }}
            </RcButton>
            <RcButton
            class="card-action"
              v-else
              size="xs"
              variant="ghost"
              :disabled="true"
              :icon="BanIcon"
              style="opacity: 0.6; color: var(--rc-error)"
              :title="revokedReason"
            >
              {{ revokedLabel }}
            </RcButton>
          </template>
          <RcButton
            class="card-action"
            v-else-if="isDownloading"
            size="xs"
            variant="secondary"
            :loading="true"
          >
            {{ t('common.installing') }}
          </RcButton>
          <RcButton
            class="card-action"
            v-else-if="installFailed && !isInstalled"
            size="xs"
            variant="danger"
            :icon="RotateCwIcon"
            :title="installError || t('market.card.installFailedRetry')"
            @click.stop="handleActionClick"
          >
            {{ t('common.retry') }}
          </RcButton>
          <RcButton
            class="card-action"
            v-else-if="isInstalled"
            size="xs"
            variant="secondary"
            @click.stop="handleActionClick"
          >
            {{ t('common.open') }}
          </RcButton>
          <RcButton
            class="card-action"
            v-else-if="isBundled"
            size="xs"
            variant="secondary"
            :icon="RotateCcwIcon"
            @click.stop="handleActionClick"
          >
            {{ t('common.restore') }}
          </RcButton>
          <RcButton
            class="card-action"
            v-else
            size="xs"
            variant="secondary"
            :icon="DownloadIcon"
            @click.stop="handleActionClick"
          >
            {{ t('common.install') }}
          </RcButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-card-3d-container {
  min-width: 0;
}

/* 紧凑卡片 */
.card-compact {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-lg);
  padding: 12px 14px;
  transition: border-color var(--rc-dur) ease, background-color var(--rc-dur) ease;
}

.card-compact:hover {
  border-color: var(--rc-border-highlight);
}

/* 标题 */
.card-title {
  min-width: 0;
  flex: 0 1 auto;
  font-size: var(--rc-fs-emph);
  font-weight: 500;
  line-height: 1.35;
  color: var(--rc-text-primary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  word-break: break-word;
}

/* 平台标志：名称后的小号灰色标志 */
.card-platforms {
  flex-shrink: 0;
  font-size: var(--rc-fs-caption);
  color: var(--rc-text-faint);
}

.card-rating {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: var(--rc-fs-caption);
  line-height: 1;
  color: var(--rc-text-muted);
  font-variant-numeric: tabular-nums;
}

.card-rating-star {
  font-size: var(--rc-fs-caption);
  color: var(--rc-accent);
}

/* 右侧操作按钮统一规格：同一 secondary 样式、同高同字号、固定最小宽度，
   有无图标（「安装」带下载图标、「打开」不带）视觉宽度一致，收藏星标列对齐 */
.card-action {
  min-width: 60px;
  white-space: nowrap;
}

.card-mark-status {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--rc-fs-caption);
  line-height: 1;
  cursor: help;
}

.card-mark-status.is-revoked,
.card-mark-status.is-incompat {
  color: var(--rc-error);
}

.card-icon-wrap {
  position: relative;
  flex-shrink: 0;
}

.card-desc {
  min-width: 0;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin: 0;
  line-height: 1.4;
}

/* 图标按钮 */
.card-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--rc-radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--rc-fs-small);
  transition: all var(--rc-dur) ease;
}

.card-icon-btn:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
  border-color: var(--rc-border);
}

.card-icon-btn.is-active {
  color: var(--rc-warning);
}

.card-icon-btn.is-active:hover {
  color: var(--rc-warning);
}

.card-icon-btn.update {
  color: var(--rc-accent-text);
}

</style>
