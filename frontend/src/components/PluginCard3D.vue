<script setup>
import { computed, ref } from 'vue'
import { downloadPluginUpdate } from '@/api/apiserver'
import { usePluginsStore } from '@/stores/plugins'

const props = defineProps({
  plugin: { type: Object, required: true },
  isInstalled: { type: Boolean, default: false },
  downloading: { type: Boolean, default: false },
  installFailed: { type: Boolean, default: false },
  updateInfo: { type: Object, default: null },
  showFavorite: { type: Boolean, default: false },
  isFavorite: { type: Boolean, default: false },
  gradientType: { type: String, default: 'blue' }
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
const isOfficial = computed(() =>
  Boolean(props.plugin.is_official || props.plugin.isOfficial || props.plugin.isBuiltin || props.plugin.author === 'ZTools Official')
)
const officialBadge = computed(() =>
  props.plugin.official_badge || props.plugin.officialBadge || '官方自营'
)
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

const gradientClass = computed(() => `card-icon-${props.gradientType}`)

// 图标优先级：远程 icon URL > 本地 localIconPath > FA 图标（公共逻辑）
import { usePluginIcon } from '@/composables/usePluginIcon'
import { RcSquircle, RcButton } from '@/components/raycast'
const { pluginIcon, displayIconUrl, iconFailed, showImgOverlay, onIconLoad, onIconError } = usePluginIcon(() => props.plugin)
</script>

<template>
  <div class="plugin-card-3d-container">
    <div class="card-compact cursor-pointer" @click="onCardBodyClick">
      <div class="flex items-center" style="gap: var(--spacing-md)">
        <!-- 左侧图标：Raycast Squircle 统一暗微透容器，防止粗暴满铺溢出 -->
        <RcSquircle
          :src="displayIconUrl && !iconFailed ? displayIconUrl : ''"
          :icon="pluginIcon"
          :size="38"
          rounded="rounded-[10px]"
        />

        <!-- 中间信息 -->
        <div
          class="flex-1 min-w-0"
          style="gap: var(--spacing-xs); display: flex; flex-direction: column"
        >
          <div class="flex items-center" style="gap: var(--spacing-sm)">
            <span class="card-title">{{ plugin.name }}</span>
            <!-- 官方自营金标 -->
            <span
              v-if="isOfficial"
              class="card-badge-official text-[10px] font-medium text-amber-500 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 flex items-center gap-1"
              title="官方自营认证 · 官方技术支持"
            >
              <i class="fa fa-certificate text-[9px]"></i>
              {{ officialBadge }}
            </span>
            <span v-if="isRevoked" class="card-badge-revoked text-red-500 font-bold" :title="revokedReason">[已下架]</span>
            <span v-else-if="hasUpdate" class="card-badge-update">更新</span>
            <span v-else-if="isIncompatible" class="card-badge-incompat" :title="incompatReason">需升级</span>
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
            <i class="fa fa-github"></i>
          </a>
          <span
            v-else-if="isOfficial"
            class="card-icon-btn opacity-80 cursor-help"
            style="color: #eab308;"
            title="官方自营认证 · 官方技术支持"
          >
            <i class="fa fa-shield"></i>
          </span>

          <button
            v-if="showFavorite"
            class="card-icon-btn"
            :class="{ 'is-active': isFavorite }"
            :title="isFavorite ? '取消收藏' : '添加收藏'"
            @click.stop="handleToggleFavorite"
          >
            <i :class="isFavorite ? 'fa fa-star' : 'fa fa-star-o'"></i>
          </button>

          <button
            v-if="hasUpdate"
            class="card-icon-btn update"
            title="更新插件"
            :disabled="isUpdating"
            @click.stop="handleUpdate"
          >
            <i class="fa fa-refresh" :class="{ 'fa-spin': isUpdating }"></i>
          </button>

          <!-- 已下架插件：禁用启动，标红提示 [已下架]，引导一键安全卸载 -->
          <template v-if="isRevoked">
            <RcButton
              v-if="isInstalled"
              size="xs"
              variant="danger"
              icon="fa-trash-o"
              title="该插件已被官方下架，建议立即安全卸载"
              @click.stop="handleUninstall"
            >
              卸载
            </RcButton>
            <RcButton
              v-else
              size="xs"
              variant="ghost"
              :disabled="true"
              icon="fa-ban"
              style="opacity: 0.6; color: var(--color-error, #ff4d4f)"
              :title="revokedReason"
            >
              已下架
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
            icon="fa-refresh"
            :title="installError || '安装失败，点击重试'"
            @click.stop="handleActionClick"
          >
            重试
          </RcButton>
          <RcButton
            v-else-if="isInstalled"
            size="xs"
            variant="ghost"
            icon="fa-play"
            @click.stop="handleActionClick"
          >
            打开
          </RcButton>
          <RcButton
            v-else
            size="xs"
            variant="secondary"
            icon="fa-download"
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

/* 紧凑卡片 - Raycast Bento 风格 */
.card-compact {
  background: var(--rc-surface);
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-lg, 12px);
  padding: 12px 14px;
  transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.card-compact:hover {
  background: var(--rc-surface-subtle);
  border-color: var(--rc-border-highlight);
  transform: translateY(-1px);
  box-shadow: var(--rc-shadow-md);
}

/* 标题 */
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 下架标签 */
.card-badge-revoked {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

/* 更新标签 */
.card-badge-update {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: var(--rc-warning-subtle);
  color: var(--rc-warning);
  border: 1px solid var(--rc-border);
}

/* 不兼容标签（需升级） */
.card-badge-incompat {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: var(--rc-error-subtle);
  color: var(--rc-error);
  border: 1px solid var(--rc-border);
  cursor: help;
}

/* 描述 */
.card-desc {
  font-size: 12px;
  color: var(--rc-text-secondary);
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
  color: var(--rc-accent);
}

</style>
