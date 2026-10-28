<script setup>
import { AppstoreAddOutlined, DeleteOutlined, DownloadOutlined, GithubOutlined, LoadingOutlined, PlayCircleOutlined, ReloadOutlined, SafetyCertificateOutlined, StarFilled, StarOutlined, StopOutlined } from '@ant-design/icons-vue'
import { computed, ref } from 'vue'

import { downloadPluginUpdate } from '@/api/apiserver'
import { usePluginsStore } from '@/stores/plugins'

const props = defineProps({
  plugin: { type: Object, required: true },
  isInstalled: { type: Boolean, default: false },
  downloading: { type: Boolean, default: false },
  installFailed: { type: Boolean, default: false },
  updateInfo: { type: Object, default: null }, // 从父组件接收更新信息
  showFavorite: { type: Boolean, default: false }, // 是否显示收藏按钮
  isFavorite: { type: Boolean, default: false } // 是否已收藏
})
const emit = defineEmits([
  'open',
  'open-app',
  'download',
  'toggle-favorite'
])

const pluginsStore = usePluginsStore()

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
    console.error('[PluginCard] 卸载下架插件失败:', err)
  }
}

// 根据 props 计算是否有更新
const hasUpdate = computed(() => props.updateInfo?.hasUpdate)
const currentUpdateInfo = computed(() => props.updateInfo)
// 更新状态由 store 的 downloadingSet 驱动，安装完成事件会自动清除
const isUpdating = computed(() => pluginsStore.downloadingSet.has(String(props.plugin.pluginId)))

const formatSize = (v) => {
  if (v == null) return '未知大小'
  if (typeof v === 'number') {
    const KB = 1024,
      MB = 1024 * 1024
    if (v >= MB) return (v / MB).toFixed(1) + ' MB'
    if (v >= KB) return Math.round(v / KB) + ' KB'
    return v + ' B'
  }
  // 字符串：若已包含单位则直接展示
  return String(v)
}
const sizeText = computed(() => formatSize(props.plugin.size))

// 处理卡片点击
const onCardBodyClick = (e) => {
  // 防御性编程：如果点击的是按钮或按钮内部元素，不再处理
  const btn = e?.target?.closest('button')
  if (btn) return

  const pluginId = props.plugin.pluginId
  emit('open', pluginId)
}

// 处理动作按钮点击（安装/打开）
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

// 处理更新按钮点击
const handleUpdate = async (e) => {
  e?.stopPropagation()
  e?.preventDefault()

  if (!hasUpdate.value || !currentUpdateInfo.value) return

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

// 处理收藏按钮点击
const handleToggleFavorite = (e) => {
  e?.stopPropagation()
  e?.preventDefault()

  const pluginId = props.plugin.pluginId
  emit('toggle-favorite', pluginId)
}

// 图标优先级：本地 icon.png（ztools://file/）> 后端 icon URL > FA 图标
// FA 图标始终作为底层渲染，图片加载成功后叠加覆盖，避免加载期间空白
const localIconPath = computed(() => props.plugin.localIconPath || '')
const remoteIconUrl = computed(() => props.plugin.icon || '')
const displayIconUrl = computed(() => localIconPath.value || remoteIconUrl.value)
const iconLoaded = ref(false)
const iconFailed = ref(false)
const showImgOverlay = computed(() => !!displayIconUrl.value && iconLoaded.value && !iconFailed.value)
const onIconLoad = () => { iconLoaded.value = true }
const onIconError = () => { iconFailed.value = true }
</script>

<template>
  <div class="plugin-card-container">
    <div
      class="plugin-card cursor-pointer border border-transparent"
      style="
        background-color: var(--color-surface);
        border-color: var(--color-border);
        border-radius: var(--radius-xl);
        padding: var(--spacing-md);
        transition: all var(--duration-standard) var(--easing-standard);
        box-shadow: var(--shadow-sm);
      "
      @click="onCardBodyClick"
    >
      <div class="flex items-center" style="gap: var(--spacing-md)">
        <!-- 1. 左侧图标区 -->
        <div
          class="flex items-center justify-center flex-shrink-0"
          style="
            width: 48px;
            height: 48px;
            border-radius: var(--radius-lg);
            background-color: var(--color-hover);
            overflow: hidden;
            position: relative;
          "
        >
          <!-- FA 图标始终作为底层，图片加载成功后叠加覆盖 -->
          <AppstoreAddOutlined

            style="font-size: 24px; color: var(--color-text-secondary)"
            :style="showImgOverlay ? 'opacity:0' : ''"
           />
          <img
            v-if="displayIconUrl && !iconFailed"
            :src="displayIconUrl"
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;"
            :style="showImgOverlay ? '' : 'opacity:0'"
            @load="onIconLoad"
            @error="onIconError"
          />
        </div>

        <!-- 2. 中间内容区 -->
        <div
          class="flex-1 min-w-0 flex flex-col justify-center"
          style="gap: var(--spacing-xs)"
        >
          <div class="flex items-center" style="gap: var(--spacing-sm)">
            <span
              class="font-bold truncate"
              style="font-size: var(--font-size-h4); color: var(--color-text)"
            >
              {{ plugin.name }}
            </span>
            <!-- 官方自营金标 -->
            <span
              v-if="isOfficial"
              class="flex-shrink-0 rounded font-medium flex items-center gap-1"
              style="
                padding: 0 5px;
                font-size: 11px;
                line-height: 18px;
                background: var(--rc-kbd-bg);
                color: var(--rc-text-muted);
              "
              title="官方自营认证 · 官方技术支持"
            >
              {{ officialBadge }}
            </span>
            <span
              v-if="isRevoked"
              class="flex-shrink-0 rounded font-bold"
              style="
                padding: 2px 6px;
                font-size: 10px;
                background-color: var(--rc-error-subtle);
                color: var(--rc-error);
              "
              :title="revokedReason"
            >
              {{ revokedLabel }}
            </span>
            <span
              v-else-if="hasUpdate"
              class="flex-shrink-0 rounded font-medium"
              style="
                padding: 2px 6px;
                font-size: 10px;
                background-color: rgba(var(--color-orange-rgb), 0.1);
                color: var(--color-orange);
              "
            >
              更新
            </span>
          </div>
          <div
            class="truncate"
            style="
              font-size: var(--font-size-body-s);
              color: var(--color-text-secondary);
            "
          >
            {{ plugin.description || '暂无描述' }}
          </div>
        </div>

        <!-- 3. 右侧操作区 -->
        <div class="flex items-center" style="gap: var(--spacing-sm)">
          <!-- 源码/GitHub 跳转按钮：自营插件隐藏，社区插件展示 -->
          <a
            v-if="!isOfficial && (plugin.homepage_url || plugin.homepage || plugin.github_url)"
            :href="plugin.homepage_url || plugin.homepage || plugin.github_url"
            target="_blank"
            class="flex items-center justify-center rounded-full transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover)]"
            style="width: 36px; height: 36px"
            title="查看源码仓库"
            @click.stop
          >
            <GithubOutlined class="text-base" />
          </a>
          <span
            v-else-if="isOfficial"
            class="flex items-center justify-center rounded-full text-[var(--rc-warning)] opacity-80 cursor-help"
            style="width: 32px; height: 32px"
            title="官方自营认证 · 官方技术支持"
          >
            <SafetyCertificateOutlined class="text-sm" />
          </span>

          <!-- 收藏按钮 -->
          <button
            v-if="showFavorite"
            class="flex items-center justify-center rounded-full transition-colors"
            style="width: 36px; height: 36px"
            :style="{
              color: isFavorite
                ? 'var(--color-orange)'
                : 'var(--color-text-secondary)'
            }"
            onmouseover="this.style.backgroundColor='var(--color-hover)'"
            onmouseout="this.style.backgroundColor='transparent'"
            :title="isFavorite ? '取消收藏' : '添加收藏'"
            @click.stop="handleToggleFavorite"
          >
            <component :is="isFavorite ? StarFilled : StarOutlined" aria-hidden="true" />
          </button>

          <!-- 更新按钮 -->
          <button
            v-if="hasUpdate"
            class="flex items-center justify-center rounded-full transition-colors"
            style="width: 36px; height: 36px; color: var(--color-orange)"
            onmouseover="this.style.backgroundColor='var(--color-hover)'"
            onmouseout="this.style.backgroundColor='transparent'"
            title="更新插件"
            @click.stop="handleUpdate"
          >
            <ReloadOutlined  />
          </button>

          <!-- 已下架插件：禁用启动，标红提示 [已下架]，引导一键安全卸载 -->
          <template v-if="isRevoked">
            <button
              v-if="isInstalled"
              class="flex items-center justify-center rounded px-2.5 py-1 text-xs text-[var(--rc-error)] border border-[var(--rc-error)] hover:bg-[var(--rc-error-subtle)] transition-colors"
              :title="uninstallHint"
              @click.stop="handleUninstall"
            >
              <DeleteOutlined class="mr-1" /> 安全卸载
            </button>
            <button
              v-else
              class="flex items-center justify-center rounded-full transition-colors"
              style="width: 36px; height: 36px; color: var(--rc-error); opacity: 0.6; cursor: not-allowed;"
              disabled
              :title="revokedReason"
            >
              <StopOutlined  />
            </button>
          </template>
          <button
            v-else
            class="flex items-center justify-center rounded-full transition-colors"
            style="width: 36px; height: 36px"
            :style="{
              color: isInstalled
                ? 'var(--color-success)'
                : 'var(--color-primary)'
            }"
            :disabled="downloading"
            onmouseover="this.style.backgroundColor='var(--color-hover)'"
            onmouseout="this.style.backgroundColor='transparent'"
            :title="downloading ? '安装中...' : installFailed ? (installError || '安装失败，点击重试') : isInstalled ? '打开' : '安装'"
            @click.stop="handleActionClick"
          >
            <LoadingOutlined v-if="downloading"  />
            <ReloadOutlined v-else-if="installFailed"  style="color: var(--rc-error)" />
            <DownloadOutlined v-else-if="!isInstalled"  />
            <PlayCircleOutlined v-else  />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plugin-card:hover {
  border-color: var(--color-primary) !important;
  box-shadow: var(--shadow-lg);
  transform: translateY(-4px);
}
</style>
