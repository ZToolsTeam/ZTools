<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { XIcon } from '@lucide/vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { ROUTES } from '@/router/routes'
import { currentGlobalWakeHotkey, refreshCurrentGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { useAppI18n } from '@/i18n'

const STORAGE_KEY = 'ztools_wake_hotkey_mastered'
const CONFIG_KEY = 'ui.wake_hotkey_hint_dismissed'

const { t } = useAppI18n()
const route = useRoute()
const router = useRouter()

function readLocalDismissed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeLocalDismissed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // 忽略受限存储环境异常
  }
}

const dismissed = ref(readLocalDismissed())
const wakeHotkey = currentGlobalWakeHotkey

const isLandingRoute = computed(() => route.name === 'my' || route.name === 'list')
const visible = computed(() => !dismissed.value && isLandingRoute.value && Boolean(wakeHotkey.value))

function markMastered() {
  if (dismissed.value) return
  dismissed.value = true
  writeLocalDismissed()
  if (typeof window !== 'undefined' && typeof window.ztools?.config?.set === 'function') {
    Promise.resolve(window.ztools.config.set(CONFIG_KEY, 'true', false)).catch(() => {})
  }
}

function goShortcutSettings() {
  router.push({ name: ROUTES.ADVANCED_SETTINGS.name, query: { tab: 'shortcuts' } })
}

let offHotkeyTriggered = null
let isUnmounted = false

onMounted(() => {
  isUnmounted = false
  if (dismissed.value) return

  void refreshCurrentGlobalWakeHotkey()

  if (typeof window !== 'undefined' && typeof window.ztools?.config?.get === 'function') {
    Promise.resolve(window.ztools.config.get(CONFIG_KEY, 'false'))
      .then((raw) => {
        if (isUnmounted) return
        if (String(raw).trim().toLowerCase() === 'true') {
          dismissed.value = true
          writeLocalDismissed()
        }
      })
      .catch(() => {})
  }

  // 用户实际按下一次全局唤醒热键即视为已掌握，自动永久收起提示条
  if (typeof window !== 'undefined' && typeof window.ztools?.events?.on === 'function') {
    const handler = (data) => {
      const triggerId = data?.id || data?.payload?.id
      if (triggerId === 'global_wake_hotkey') {
        markMastered()
      }
    }
    const off = window.ztools.events.on('hotkey_triggered', handler)
    offHotkeyTriggered = typeof off === 'function'
      ? off
      : () => window.ztools?.events?.off?.('hotkey_triggered', handler)
  }
})

onBeforeUnmount(() => {
  isUnmounted = true
  if (typeof offHotkeyTriggered === 'function') {
    offHotkeyTriggered()
    offHotkeyTriggered = null
  }
})
</script>

<template>
  <div v-if="visible" class="wake-guide-wrap" role="status" data-testid="wake-hotkey-guide-banner">
    <div class="wake-guide-bar">
      <div class="wake-guide-main">
        <span class="wake-guide-dot" aria-hidden="true"></span>
        <span class="wake-guide-text">{{ t('wakeGuide.prefix') }}</span>
        <ShortcutKeys :combo="wakeHotkey" />
        <span class="wake-guide-text">{{ t('wakeGuide.suffix') }}</span>
      </div>
      <div class="wake-guide-actions">
        <button
          type="button"
          class="wake-guide-link"
          data-testid="wake-guide-change-btn"
          @click="goShortcutSettings"
        >
          {{ t('wakeGuide.changeHotkey') }}
        </button>
        <button
          type="button"
          class="wake-guide-close"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          data-testid="wake-guide-dismiss-btn"
          @click="markMastered"
        >
          <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wake-guide-wrap {
  padding: 10px var(--rc-page-pad-x, 24px) 0;
}

.wake-guide-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
  padding: 6px 12px;
  border-radius: var(--rc-radius-md);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
}

.wake-guide-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.wake-guide-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--rc-accent);
  flex-shrink: 0;
}

.wake-guide-text {
  color: var(--rc-text-secondary);
  line-height: 1.4;
}

.wake-guide-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.wake-guide-link {
  border: none;
  background: transparent;
  padding: 2px 6px;
  border-radius: var(--rc-radius-sm);
  font: inherit;
  color: var(--rc-accent-text, var(--rc-accent));
  cursor: pointer;
  transition: background-color var(--rc-dur) ease;
}

.wake-guide-link:hover {
  background: var(--rc-surface-hover);
}

.wake-guide-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: background-color var(--rc-dur) ease, color var(--rc-dur) ease;
}

.wake-guide-close:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}
</style>
