<script>
let pendingFocusPluginId = ''

export function queueBundledPluginFocus(pluginId) {
  pendingFocusPluginId = typeof pluginId === 'string' ? pluginId.trim().toLowerCase() : ''
}
</script>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { RcButton, RcSquircle, RcTag } from '@/components/base'
import { usePluginsStore } from '@/stores/plugins'
import { useToast } from '@/composables/useToast'
import { getBundledPluginEntries, isBundledPlugin } from '@/utils/bundledPlugins'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'

const pluginsStore = usePluginsStore()
const { toastSuccess, toastError } = useToast()

const highlightedId = ref('')
const rowRefs = new Map()
const buttonRefs = new Map()
let highlightTimer = null
let isUnmounted = false

const bundledItems = computed(() =>
  getBundledPluginEntries().filter((item) => isPluginSupportedOnCurrentPlatform(item))
)

const isHidden = (pluginId) => pluginsStore.isBundledHidden(pluginId)
const isToggling = (pluginId) => pluginsStore.isTogglingBundled(pluginId)

function setRowRef(pluginId, el) {
  const key = String(pluginId || '').toLowerCase()
  if (!key) return
  if (el) rowRefs.set(key, el)
  else rowRefs.delete(key)
}

function setActionBtnRef(pluginId, compOrEl) {
  const key = String(pluginId || '').toLowerCase()
  if (!key) return
  const dom = compOrEl?.$el || compOrEl
  if (dom) buttonRefs.set(key, dom)
  else buttonRefs.delete(key)
}

function clearHighlightTimer() {
  if (highlightTimer) {
    clearTimeout(highlightTimer)
    highlightTimer = null
  }
}

async function focusPlugin(rawPluginId) {
  const key = String(rawPluginId || '').trim().toLowerCase()
  if (!key || !isBundledPlugin(key)) return false
  await nextTick()
  if (isUnmounted) return false
  const rowEl = rowRefs.get(key)
  if (!rowEl) return false

  clearHighlightTimer()
  highlightedId.value = key
  rowEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  const btnEl = buttonRefs.get(key)
  const focusable = btnEl?.tagName === 'BUTTON' ? btnEl : btnEl?.querySelector?.('button')
  focusable?.focus?.({ preventScroll: true })

  highlightTimer = setTimeout(() => {
    if (!isUnmounted) {
      highlightedId.value = ''
    }
    highlightTimer = null
  }, 2200)
  return true
}

async function toggleBundled(item) {
  const pid = item.pluginId
  if (!pid || isToggling(pid)) return
  const currentlyHidden = isHidden(pid)
  try {
    if (currentlyHidden) {
      const res = await pluginsStore.restoreBundledPlugin(pid)
      if (!isUnmounted && res?.success) {
        toastSuccess(`已还原「${item.name}」`)
      }
    } else {
      const res = await pluginsStore.hideBundledPlugin(pid)
      if (!isUnmounted && res?.success) {
        toastSuccess(`已卸载「${item.name}」，可随时在此还原`)
      }
    }
    await nextTick()
    if (!isUnmounted) {
      const key = String(pid).toLowerCase()
      const btnEl = buttonRefs.get(key)
      const focusable = btnEl?.tagName === 'BUTTON' ? btnEl : btnEl?.querySelector?.('button')
      focusable?.focus?.({ preventScroll: true })
    }
  } catch (err) {
    if (!isUnmounted) {
      toastError((currentlyHidden ? '还原失败: ' : '卸载失败: ') + (err?.message || err))
    }
  }
}

onMounted(() => {
  pluginsStore.ensureHiddenBundledLoaded().catch((err) => {
    console.warn('[BundledPluginsSettings] 初始化内置插件隐藏状态失败:', err)
  })
  if (pendingFocusPluginId) {
    const target = pendingFocusPluginId
    pendingFocusPluginId = ''
    void focusPlugin(target)
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
  clearHighlightTimer()
  rowRefs.clear()
  buttonRefs.clear()
})

defineExpose({
  focusPlugin
})
</script>

<template>
  <div class="settings-card" data-testid="bundled-plugins-settings">
    <div class="card-header">
      <h2 class="card-title">内置插件</h2>
      <p class="card-desc">随客户端提供的基础工具，卸载后将从已安装列表与搜索结果中隐藏，本地数据保留且可随时还原</p>
    </div>

    <div class="bundled-list">
      <div
        v-for="item in bundledItems"
        :key="item.pluginId"
        :ref="(el) => setRowRef(item.pluginId, el)"
        class="bundled-item"
        :class="{
          'is-hidden-plugin': isHidden(item.pluginId),
          'is-highlighted': highlightedId === item.pluginId.toLowerCase()
        }"
        :data-plugin-id="item.pluginId"
      >
        <div class="bundled-main">
          <div class="bundled-icon" :class="{ 'is-muted': isHidden(item.pluginId) }">
            <RcSquircle
              :glyph="resolvePluginGlyph(item)"
              :fallback-glyph="resolveKeywordGlyph(item.name)"
              :size="32"
            />
          </div>
          <div class="bundled-text">
            <div class="bundled-title-row">
              <span class="bundled-name">{{ item.name }}</span>
              <RcTag v-if="isHidden(item.pluginId)" class="bundled-status-tag">已卸载</RcTag>
            </div>
            <span class="bundled-desc">{{ item.description }}</span>
          </div>
        </div>

        <div class="bundled-action">
          <RcButton
            v-if="isHidden(item.pluginId)"
            :ref="(el) => setActionBtnRef(item.pluginId, el)"
            variant="primary"
            size="xs"
            :icon="RotateCcwIcon"
            :loading="isToggling(item.pluginId)"
            :data-testid="`bundled-restore-${item.pluginId}`"
            @click="toggleBundled(item)"
          >
            还原
          </RcButton>
          <RcButton
            v-else
            :ref="(el) => setActionBtnRef(item.pluginId, el)"
            variant="danger"
            size="xs"
            :icon="Trash2Icon"
            :loading="isToggling(item.pluginId)"
            :data-testid="`bundled-uninstall-${item.pluginId}`"
            @click="toggleBundled(item)"
          >
            卸载
          </RcButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--rc-text-muted);
  line-height: 1.5;
}

.bundled-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bundled-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  transition: border-color 0.2s ease, background-color 0.2s ease, opacity 0.2s ease;
}

.bundled-item:hover {
  border-color: var(--rc-border-highlight);
}

.bundled-item.is-highlighted {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
}

.bundled-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.bundled-icon {
  flex-shrink: 0;
  transition: opacity 0.2s ease;
}

.bundled-icon.is-muted {
  opacity: 0.5;
}

.bundled-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.bundled-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bundled-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.is-hidden-plugin .bundled-name {
  color: var(--rc-text-secondary);
}

.bundled-status-tag {
  flex-shrink: 0;
}

.bundled-desc {
  font-size: 12px;
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bundled-action {
  flex-shrink: 0;
}
</style>
