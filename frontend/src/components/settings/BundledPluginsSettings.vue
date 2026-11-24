<script>
let pendingFocusPluginId = ''

export function queueBundledPluginFocus(pluginId) {
  pendingFocusPluginId = typeof pluginId === 'string' ? pluginId.trim().toLowerCase() : ''
}
</script>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Switch as ASwitch } from 'ant-design-vue'
import { RcButton, RcSquircle } from '@/components/base'
import { vSwitchKeyboard } from '@/directives/switchKeyboard'
import { usePluginsStore } from '@/stores/plugins'
import { useToast } from '@/composables/useToast'
import { getBundledPluginEntries, isBundledPlugin } from '@/utils/bundledPlugins'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { getLocalizedPluginDescription, getLocalizedPluginName } from '@/utils/pluginI18n'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const pluginsStore = usePluginsStore()
const { toastSuccess, toastError } = useToast()

const highlightedId = ref('')
const loadFailed = ref(false)
const rowRefs = new Map()
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

function clearHighlightTimer() {
  if (highlightTimer) {
    clearTimeout(highlightTimer)
    highlightTimer = null
  }
}

async function loadVisibility() {
  loadFailed.value = false
  try {
    await pluginsStore.ensureHiddenBundledLoaded()
    return !isUnmounted
  } catch {
    if (!isUnmounted) loadFailed.value = true
    return false
  }
}

async function focusPlugin(rawPluginId) {
  const key = String(rawPluginId || '').trim().toLowerCase()
  if (!key || !isBundledPlugin(key)) return false
  if (!pluginsStore._hiddenBundledLoaded && !(await loadVisibility())) return false
  await nextTick()
  if (isUnmounted) return false
  const rowEl = rowRefs.get(key)
  if (!rowEl) return false

  clearHighlightTimer()
  highlightedId.value = key
  rowEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  rowEl.querySelector('[role="switch"]')?.focus({ preventScroll: true })

  highlightTimer = setTimeout(() => {
    if (!isUnmounted) {
      highlightedId.value = ''
    }
    highlightTimer = null
  }, 2200)
  return true
}

async function setVisible(item, visible) {
  const pid = item.pluginId
  if (isToggling(pid)) return
  try {
    const result = visible
      ? await pluginsStore.restoreBundledPlugin(pid)
      : await pluginsStore.hideBundledPlugin(pid)
    if (result.success && !isUnmounted) {
      toastSuccess(t(visible ? 'settings.bundled.shownToast' : 'settings.bundled.hiddenToast', {
        name: getLocalizedPluginName(item)
      }))
    }
  } catch (err) {
    if (!isUnmounted) {
      toastError(t(visible ? 'settings.bundled.showFailed' : 'settings.bundled.hideFailed', {
        reason: resolveErrorMessage(err, 'common.unknownError')
      }))
    }
  }
}

onMounted(async () => {
  if (!(await loadVisibility())) return
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

    <div v-if="loadFailed" class="bundled-load-error" role="alert">
      <span>{{ t('settings.loadFailed') }}</span>
      <RcButton variant="secondary" size="xs" @click="loadVisibility">{{ t('common.retry') }}</RcButton>
    </div>
    <div v-else-if="pluginsStore._hiddenBundledLoaded" class="bundled-list">
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
            <span class="bundled-name">{{ getLocalizedPluginName(item) }}</span>
            <span class="bundled-desc">{{ getLocalizedPluginDescription(item) }}</span>
          </div>
        </div>

        <ASwitch
          v-switch-keyboard
          size="small"
          class="bundled-switch"
          :checked="!isHidden(item.pluginId)"
          :aria-label="t('settings.bundled.visibilityLabel', { name: getLocalizedPluginName(item) })"
          :aria-busy="isToggling(item.pluginId)"
          :aria-disabled="isToggling(item.pluginId)"
          @change="setVisible(item, $event)"
        />
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

.bundled-desc {
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bundled-load-error {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  color: var(--rc-text-secondary);
}

.bundled-switch {
  flex-shrink: 0;
}
</style>
