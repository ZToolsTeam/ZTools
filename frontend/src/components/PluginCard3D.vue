<script setup>
import { AppleOutlined, DeleteOutlined, DownloadOutlined, GlobalOutlined, GithubOutlined, ReloadOutlined, SafetyCertificateOutlined, StarFilled, StarOutlined, StopOutlined, WarningOutlined, WindowsOutlined } from '@ant-design/icons-vue'
import { computed, ref } from 'vue'
import { downloadPluginUpdate } from '@/api/apiserver'
import { usePluginsStore } from '@/stores/plugins'
import { isOfficialPluginItem } from '@/utils/storeCatalogManager'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { getPluginPlatformLabel } from '@/utils/platform'

const props = defineProps({
  plugin: { type: Object, required: true },
  isInstalled: { type: Boolean, default: false },
  downloading: { type: Boolean, default: false },
  installFailed: { type: Boolean, default: false },
  updateInfo: { type: Object, default: null },
  showFavorite: { type: Boolean, default: false },
  isFavorite: { type: Boolean, default: false },
})

const emit = defineEmits([
  'open',
  'open-app',
  'download',
  'toggle-favorite'
])

const pluginsStore = usePluginsStore()
const isDownloading = computed(() => props.downloading)

const isRevoked = computed(() =>
  Boolean(props.plugin.revoked || pluginsStore.isRevoked(props.plugin.pluginId))
)
const revokedReason = computed(() =>
  props.plugin.revoked_reason || props.plugin.revokedReason || pluginsStore.getRevokedReason(props.plugin.pluginId) || '该插件已被官方下架禁用'
)
// 插件目录里的新版本不再支持当前系统时也会禁用，文案与官方下架区分开
const isPlatformUnsupported = computed(() =>
  !props.plugin.revoked && pluginsStore.getRevokedKind(props.plugin.pluginId) === 'platform'
)
const revokedLabel = computed(() => (isPlatformUnsupported.value ? '不支持当前系统' : '已下架'))
const uninstallHint = computed(() =>
  isPlatformUnsupported.value ? '当前系统已不再支持该插件，可以卸载' : '该插件已被官方下架，建议立即安全卸载'
)
const isOfficial = computed(() =>
  isOfficialPluginItem(props.plugin) || isOfficialPlugin(props.plugin.pluginId || props.plugin.id)
)
const platformLabel = computed(() => getPluginPlatformLabel(props.plugin))
const platformIcon = computed(() => {
  switch (platformLabel.value) {
    case '跨平台': return GlobalOutlined
    case '仅 Windows': return WindowsOutlined
    case '仅 macOS': return AppleOutlined
    default: return null
  }
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
  // 通过 store 标记下载中，安装完成事件会自动清除
  pluginsStore.startDownload(pluginId)
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
import { RcSquircle, RcButton } from '@/components/base'
const { pluginIcon, pluginGlyph, displayIconUrl, iconFailed, showImgOverlay, onIconLoad, onIconError } = usePluginIcon(() => props.plugin)
</script>

<template>
  <div class="plugin-card-3d-container">
    <div class="card-compact cursor-pointer" @click="onCardBodyClick">
      <div class="flex items-center" style="gap: var(--spacing-md)">
        <!-- 左侧图标：官方插件用品牌线性图形，第三方插件放进中性底块 -->
        <div class="card-icon-wrap">
          <RcSquircle
            :glyph="pluginGlyph"
            :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
            :icon="pluginIcon"
            :size="36"
          />
          <!-- 官方标记放在图标角上，标题行不再为四个字让位 -->
          <span
            v-if="isOfficial"
            class="card-mark-official"
            title="官方自营"
            aria-label="官方自营"
          >
            <SafetyCertificateOutlined  aria-hidden="true" />
          </span>
          <span
            v-if="platformIcon"
            class="card-mark-platform"
            :class="{ 'is-stacked': isOfficial }"
            :title="platformLabel"
            :aria-label="platformLabel"
          >
            <component :is="platformIcon" aria-hidden="true" />
          </span>
        </div>

        <!-- 中间信息 -->
        <div
          class="flex-1 min-w-0"
          style="gap: var(--spacing-xs); display: flex; flex-direction: column"
        >
          <div class="flex items-center min-w-0" style="gap: var(--spacing-xs)">
            <span class="card-title" :title="plugin.name">{{ plugin.name }}</span>
            <span
              v-if="isRevoked"
              class="card-mark-status is-revoked"
              :title="revokedReason"
              :aria-label="revokedLabel"
            >
              <StopOutlined  aria-hidden="true" />
            </span>
            <span
              v-else-if="isIncompatible"
              class="card-mark-status is-incompat"
              :title="incompatReason || '需升级'"
              aria-label="需升级"
            >
              <WarningOutlined  aria-hidden="true" />
            </span>
          </div>
          <p class="card-desc">{{ plugin.description || '暂无描述' }}</p>
        </div>

        <!-- 右侧操作 -->
        <div
          class="flex items-center flex-shrink-0"
          style="gap: var(--spacing-xs)"
        >
          <!-- 源码/GitHub 跳转按钮：自营插件隐藏，展示官方认证；社区插件展示源码按钮 -->
          <a
            v-if="!isOfficial && (plugin.homepage_url || plugin.homepage || plugin.github_url)"
            :href="plugin.homepage_url || plugin.homepage || plugin.github_url"
            target="_blank"
            class="card-icon-btn"
            title="查看源码仓库"
            @click.stop
          >
            <GithubOutlined  />
          </a>

          <button
            v-if="showFavorite"
            class="card-icon-btn"
            :class="{ 'is-active': isFavorite }"
            :title="isFavorite ? '取消收藏' : '添加收藏'"
            @click.stop="handleToggleFavorite"
          >
            <component :is="isFavorite ? StarFilled : StarOutlined" aria-hidden="true" />
          </button>

          <button
            v-if="hasUpdate"
            class="card-icon-btn update"
            title="更新"
            aria-label="更新"
            :disabled="isUpdating"
            @click.stop="handleUpdate"
          >
            <ReloadOutlined  :class="{ 'fa-spin': isUpdating }" />
          </button>

          <!-- 已下架插件：禁用启动，标红提示 [已下架]，引导一键安全卸载 -->
          <template v-if="isRevoked">
            <RcButton
              v-if="isInstalled"
              size="xs"
              variant="danger"
              :icon="DeleteOutlined"
              :title="uninstallHint"
              @click.stop="handleUninstall"
            >
              卸载
            </RcButton>
            <RcButton
              v-else
              size="xs"
              variant="ghost"
              :disabled="true"
              :icon="StopOutlined"
              style="opacity: 0.6; color: var(--rc-error)"
              :title="revokedReason"
            >
              {{ revokedLabel }}
            </RcButton>
          </template>
          <RcButton
            v-else-if="isDownloading"
            size="xs"
            variant="ghost"
            :loading="true"
          >
            安装中
          </RcButton>
          <RcButton
            v-else-if="installFailed && !isInstalled"
            size="xs"
            variant="danger"
            :icon="ReloadOutlined"
            :title="installError || '安装失败，点击重试'"
            @click.stop="handleActionClick"
          >
            重试
          </RcButton>
          <RcButton
            v-else-if="isInstalled"
            size="xs"
            variant="ghost"
            @click.stop="handleActionClick"
          >
            打开
          </RcButton>
          <RcButton
            v-else
            size="xs"
            variant="secondary"
            :icon="DownloadOutlined"
            @click.stop="handleActionClick"
          >
            安装
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
  border-radius: var(--rc-radius-lg, 12px);
  padding: 12px 14px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.card-compact:hover {
  border-color: var(--rc-border-highlight);
}

/* 标题 */
.card-title {
  min-width: 0;
  flex: 0 1 auto;
  font-size: 14px;
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

.card-mark-status {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
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

/* 官方标记：盾形小标落在图标角上，悬停说明「官方自营」 */
.card-mark-official {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 9px;
  line-height: 1;
  color: var(--rc-text-secondary);
  background: var(--rc-kbd-bg);
  box-shadow: 0 0 0 2px var(--rc-surface);
  cursor: help;
}

/* 平台标记：与官方盾标错开，悬停说明「跨平台 / 仅 Windows / 仅 macOS」 */
.card-mark-platform {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 9px;
  line-height: 1;
  color: var(--rc-text-secondary);
  background: var(--rc-kbd-bg);
  box-shadow: 0 0 0 2px var(--rc-surface);
  cursor: help;
}

.card-mark-platform.is-stacked {
  bottom: auto;
  top: -3px;
}

.card-desc {
  min-width: 0;
  font-size: 12px;
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
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  transition: all 0.15s ease;
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
