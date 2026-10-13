<script setup>
import { computed, ref } from 'vue'
import PluginActions from './PluginActions.vue'

const props = defineProps({
  plugin: {
    type: Object,
    required: true
  },
  subtitle: {
    type: String,
    default: ''
  },
  isInstalled: Boolean,
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
  commentsCount: {
    type: Number,
    default: 0
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

// 图标优先级：远程 icon URL > 本地 localIconPath > FA 图标（公共逻辑）
import { usePluginIcon, getPluginGradient } from '@/composables/usePluginIcon'
const { pluginIcon, displayIconUrl, iconFailed, showImgOverlay, onIconLoad, onIconError } = usePluginIcon(() => props.plugin)

// 根据插件名称确定性生成渐变色（与列表页一致）
const gradientClass = computed(() => {
  return 'gradient-' + getPluginGradient(props.plugin?.name)
})
</script>

<template>
  <div class="detail-header">
    <!-- 顶部信息区 -->
    <div class="header-top">
      <!-- 插件图标：远程 icon URL > 本地 localIconPath > FA 图标 -->
      <div class="plugin-icon" :class="showImgOverlay ? 'plugin-icon-plain' : gradientClass" style="position:relative;">
        <i :class="['fa', pluginIcon]" :style="showImgOverlay ? 'opacity:0' : ''"></i>
        <img
          v-if="displayIconUrl && !iconFailed"
          :src="displayIconUrl"
          style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:inherit;"
          :style="showImgOverlay ? '' : 'opacity:0'"
          @load="onIconLoad"
          @error="onIconError"
        />
      </div>

      <!-- 插件信息 -->
      <div class="plugin-info">
        <h1 class="plugin-name">{{ plugin.name }}</h1>
        <p class="plugin-subtitle">{{ subtitle }}</p>

        <!-- 标签 -->
        <div class="plugin-tags">
          <span v-if="plugin.category" class="tag">{{ plugin.category }}</span>
          <span v-if="plugin.revoked || isRevoked" class="tag revoked" :title="revokedReason || plugin.revoked_reason || '该插件已被官方下架禁用'" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">已下架</span>
          <span v-if="isInstalled" class="tag installed">已安装</span>
          <span v-if="hasUpdate" class="tag update">有更新</span>
          <span v-else-if="updateInfo?.incompatible" class="tag incompat" :title="updateInfo.incompatReason">需升级</span>
        </div>
      </div>

      <!-- 操作按钮 -->
      <PluginActions
        :isInstalled="isInstalled"
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

    <!-- 统计信息 -->
    <div class="stats-grid">
      <div class="stat-item">
        <span class="stat-label">评分</span>
        <span class="stat-value">
          <span class="stars">
            <i
              v-for="i in 5"
              :key="i"
              class="fa"
              :class="
                i <= Math.round(plugin.rating || 0) ? 'fa-star' : 'fa-star-o'
              "
            ></i>
          </span>
          <span>{{ plugin.rating || 'N/A' }}</span>
        </span>
      </div>
      <div class="stat-item">
        <span class="stat-label">下载量</span>
        <span class="stat-value">{{ plugin.downloads || 0 }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">开发者</span>
        <span class="stat-value author">{{ plugin.author || '未知' }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">版本</span>
        <span class="stat-value">v{{ plugin.version }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">大小</span>
        <span class="stat-value">{{ plugin.size || '未知' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-header {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
}

/* 顶部信息区 */
.header-top {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
}

/* 插件图标 */
.plugin-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  color: white;
  flex-shrink: 0;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}

/* 展示真实图标时无渐变背景 */
.plugin-icon.plugin-icon-plain {
  background: var(--color-hover);
  box-shadow: none;
}

.plugin-icon.gradient-blue {
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
  box-shadow: 0 6px 20px rgba(45, 113, 255, 0.3);
}

.plugin-icon.gradient-green {
  background: linear-gradient(135deg, #4ed7c2 0%, #34d399 100%);
  box-shadow: 0 6px 20px rgba(78, 215, 194, 0.3);
}

.plugin-icon.gradient-orange {
  background: linear-gradient(135deg, #ffaf41 0%, #ff9500 100%);
  box-shadow: 0 6px 20px rgba(255, 175, 65, 0.3);
}

.plugin-icon.gradient-pink {
  background: linear-gradient(135deg, #ff6b9d 0%, #ff4081 100%);
  box-shadow: 0 6px 20px rgba(255, 107, 157, 0.3);
}

.plugin-icon.gradient-purple {
  background: linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%);
  box-shadow: 0 6px 20px rgba(139, 92, 246, 0.3);
}

.plugin-icon.gradient-cyan {
  background: linear-gradient(135deg, #22d3ee 0%, #06b6d4 100%);
  box-shadow: 0 6px 20px rgba(6, 182, 212, 0.3);
}

/* 插件信息 */
.plugin-info {
  flex: 1;
  min-width: 0;
}

.plugin-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--zt-text);
  margin: 0 0 4px;
  line-height: 1.3;
}

.plugin-subtitle {
  font-size: 13px;
  color: var(--zt-text-secondary);
  margin: 0 0 12px;
}

.plugin-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  background: var(--color-gray-100);
  color: var(--zt-text-secondary);
}

.tag.installed {
  background: rgba(78, 215, 194, 0.15);
  color: #10b981;
}

.tag.update {
  background: rgba(255, 175, 65, 0.15);
  color: #f59e0b;
}

.tag.incompat {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  cursor: help;
}

/* 统计信息网格 */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  background: var(--color-gray-100);
  border-radius: 10px;
}

.stat-label {
  font-size: 12px;
  color: var(--zt-text-secondary);
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--zt-text);
  display: flex;
  align-items: center;
  gap: 4px;
}

.stat-value.author {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stars {
  display: flex;
  gap: 2px;
}

.stars .fa {
  font-size: 11px;
  color: #fbbf24;
}

.stars .fa-star-o {
  color: #d1d5db;
}

/* 响应式 */
@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 600px) {
  .header-top {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .plugin-info {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .plugin-tags {
    justify-content: center;
  }

  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
