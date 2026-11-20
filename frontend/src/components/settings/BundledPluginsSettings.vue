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
import { getLocalizedPluginDescription, getLocalizedPluginName } from '@/utils/pluginI18n'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
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
        toastSuccess(t('settings.bundled.restoredToast', { name: getLocalizedPluginName(item) }))
      }
    } else {
      const res = await pluginsStore.hideBundledPlugin(pid)
      if (!isUnmounted && res?.success) {
        toastSuccess(t('settings.bundled.uninstalledToast', { name: getLocalizedPluginName(item) }))
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
      toastError(
        t(currentlyHidden ? 'settings.bundled.restoreFailed' : 'settings.bundled.uninstallFailed', {
          reason: err?.message || err
        })
      )
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
      <h2 class="card-title">{{ t('settings.bundled.title') }}</h2>
      <p class="card-desc">{{ t('settings.bundled.desc') }}</p>
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
              <span class="bundled-name">{{ getLocalizedPluginName(item) }}</span>
              <RcTag v-if="isHidden(item.pluginId)" class="bundled-status-tag">{{ t('settings.bundled.uninstalledTag') }}</RcTag>
            </div>
            <span class="bundled-desc">{{ getLocalizedPluginDescription(item) }}</span>
          </div>
        </div>

        <div class="bundled-action">
          <RcButton
            v-if="isHidden(item.pluginId)"
            :ref="(el) => setActionBtnRef(item.pluginId, el)"
            variant="secondary"
            size="xs"
            :icon="RotateCcwIcon"
            :loading="isToggling(item.pluginId)"
            :data-testid="`bundled-restore-${item.pluginId}`"
            @click="toggleBundled(item)"
          >
            {{ t('settings.bundled.restore') }}
          </RcButton>
          <RcButton
            v-else
            :ref="(el) => setActionBtnRef(item.pluginId, el)"
            variant="secondary"
            size="xs"
            class="bundled-uninstall-btn"
            :icon="Trash2Icon"
            :loading="isToggling(item.pluginId)"
            :data-testid="`bundled-uninstall-${item.pluginId}`"
            @click="toggleBundled(item)"
          >
            {{ t('settings.bundled.uninstall') }}
          </RcButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-desc {
  margin: 4px 0 0;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  line-height: 1.5;
}

/* 与设置页其它分区同一种「分组标题 + 细线 + 细线分隔的行」，不再一行一张卡片 */
.bundled-list {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  border-top: 1px solid var(--rc-border);
  /* 让高亮行的 z-index:-1 背景留在列表内，不落到页面背景之下 */
  isolation: isolate;
}

.bundled-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 64px;
  padding: 12px 0;
  border-bottom: 1px solid var(--rc-border);
  transition: background-color var(--rc-dur-slow) ease, opacity var(--rc-dur-slow) ease;
}

/* 从别处深链定位到某个插件时，用伪元素在行后铺一层强调底（左右各外扩 8px），行本身的盒子与分隔线不变 */
.bundled-item {
  position: relative;
}

.bundled-item.is-highlighted::before {
  content: '';
  position: absolute;
  inset: 0 -8px;
  z-index: -1;
  border-radius: var(--rc-radius-md);
  background: var(--rc-accent-subtle);
  pointer-events: none;
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
  transition: opacity var(--rc-dur-slow) ease;
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
  font-size: var(--rc-fs-body);
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
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bundled-action {
  flex-shrink: 0;
}

/* 每行都有「卸载」，常态用中性次按钮，避免一屏九个红按钮；悬停或键盘聚焦时才露出危险色 */
.bundled-uninstall-btn:hover:not(:disabled),
.bundled-uninstall-btn:focus-visible {
  color: var(--rc-error);
  border-color: color-mix(in srgb, var(--rc-error) 40%, var(--rc-border-highlight));
  background: var(--rc-error-subtle);
}
</style>
