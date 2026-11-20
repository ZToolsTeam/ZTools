<script setup>
import { ExternalLinkIcon, RotateCwIcon } from '@lucide/vue'
import { ref, computed, onMounted } from 'vue'
import { formatVersionForDisplay } from '@/utils/versionDisplay'
import { RcButton, RcCard } from '@/components/base'
import BrandMark from '@/components/BrandMark.vue'
import { isUpdateUnsupported } from '@/composables/useAppUpdate'
import { isMacOS, isWindows } from '@/utils/platform'
import { EDITION, isOnline } from '@edition'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const appVersion = ref('--')
const checking = ref(false)
const isOfficialEdition = EDITION === 'commercial'
const platformName = computed(() => isMacOS() ? 'macOS' : isWindows() ? 'Windows' : t('about.unknownPlatform'))
const nativeLanguages = computed(() => isMacOS() ? 'C++ / Objective-C++' : isWindows() ? 'C++' : t('about.nativeByPlatform'))
const currentYear = new Date().getFullYear()
const repositories = computed(() => [
  { label: t('about.clientRepo'), name: 'ZTools', url: 'https://github.com/ZToolsTeam/ZTools' },
  { label: t('about.pluginRepo'), name: 'ZTools-extensions', url: 'https://github.com/ZToolsTeam/ZTools-extensions' }
])

onMounted(async () => {
  try {
    if (window.ztools && window.ztools.sys) {
      const ver = await window.ztools.sys.getCurrentVersion()
      appVersion.value = formatVersionForDisplay(ver.appVersion)
    }
  } catch (e) {
    console.error('获取版本号失败:', e)
  }
})

async function handleCheckUpdate() {
  if (checking.value) return
  checking.value = true
  try {
    if (window.ztools && window.ztools.update) {
      const result = await window.ztools.update.check()
      if (!result.success) {
        window.__ztoolsToast?.('error', t('about.checkFailed'))
        return
      }
      if (result.app) {
        window.__showUpdateNotification?.('app', result.app)
      } else if (result.web) {
        try {
          const ok = await window.__silentWebUpdate?.(result.web)
          if (!ok) window.__ztoolsToast?.('error', t('about.webUpdateIncomplete'))
        } catch (error) {
          console.error('Web 更新失败:', error)
          window.__ztoolsToast?.('error', t('about.webUpdateFailed', { reason: error.message || t('common.unknownError') }))
        }
      } else {
        window.__ztoolsToast?.('success', t('about.alreadyLatest'))
      }
    }
  } catch (e) {
    if (isUpdateUnsupported(e)) {
      window.__ztoolsToast?.('info', t('about.updateUnsupported'))
      return
    }
    console.error('检查更新失败:', e)
    window.__ztoolsToast?.('error', t('about.checkFailed'))
  } finally {
    checking.value = false
  }
}

function handleOpenLink(url) {
  if (window.ztools && window.ztools.shell) {
    window.ztools.shell.openExternal(url)
  }
}
</script>

<template>
  <div class="about-page-container rc-page min-h-full flex flex-col items-center justify-center select-none">
    <div class="w-full max-w-lg flex flex-col items-center text-center gap-6">
      <!-- App Brand & Identity -->
      <div class="flex flex-col items-center gap-3">
        <!-- 与应用图标一致：墨黑底板 + 积木 Z（底板在两种主题下都保持深色） -->
        <div class="about-app-icon">
          <BrandMark :size="40" />
        </div>
        <div class="flex flex-col items-center">
          <h1 class="about-brand font-bold tracking-tight text-[var(--rc-text-primary)] m-0">
            ZTools
          </h1>
          <p class="about-tagline text-[var(--rc-text-secondary)] mt-1 m-0">
            {{ t('about.tagline') }}
          </p>
        </div>
      </div>

      <!-- Version & Action -->
      <div class="flex items-center gap-2">
        <div class="about-version inline-flex items-center gap-2 px-3 py-1 rounded-full font-mono bg-[var(--rc-surface)] border border-[var(--rc-border)] text-[var(--rc-text-secondary)]">
          <span>{{ t('about.version', { version: appVersion }) }}</span>
        </div>
        <RcButton
          v-if="isOnline"
          size="sm"
          variant="ghost"
          :icon="RotateCwIcon"
          :loading="checking"
          @click="handleCheckUpdate"
        >
          {{ checking ? t('about.checking') : t('about.checkUpdate') }}
        </RcButton>
        <RcButton
          v-else
          size="sm"
          variant="ghost"
          @click="handleOpenLink('https://github.com/ZToolsTeam/ZTools/releases')"
        >
          {{ t('about.downloadLatest') }}
        </RcButton>
      </div>

      <!-- Specs & Open Source Card -->
      <RcCard class="w-full text-left" padding="p-0">
        <div class="about-specs divide-y divide-[var(--rc-border-subtle)]">
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">{{ t('about.coreArch') }}</span>
            <span class="font-medium text-[var(--rc-text-primary)]">Electron + Vue 3</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">{{ t('about.nativeComponents') }}</span>
            <span class="font-medium text-[var(--rc-text-primary)]">{{ nativeLanguages }}</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">{{ t('about.edition') }}</span>
            <span class="font-medium text-[var(--rc-text-primary)]">{{ isOfficialEdition ? t('about.editionOfficial') : t('about.editionOss') }} · {{ platformName }}</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">{{ t('about.license') }}</span>
            <span class="font-medium text-[var(--rc-text-primary)]">GPL-3.0-only</span>
          </div>
          <div v-for="repository in repositories" :key="repository.url" class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">{{ repository.label }}</span>
            <button
              type="button"
              class="text-[var(--rc-accent-text)] hover:underline inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0"
              @click="handleOpenLink(repository.url)"
            >
              GitHub / {{ repository.name }}
              <ExternalLinkIcon class="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        </div>
      </RcCard>

      <!-- Footer Copyright -->
      <div class="about-footer text-[var(--rc-text-muted)] mt-2">
        <p class="m-0">© {{ currentYear }} ZTools Team.</p>
        <p class="m-0 mt-0.5 opacity-80">
          {{ isOfficialEdition ? t('about.footerOfficial') : t('about.footerOss') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-app-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--rc-radius-xl);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--rc-app-icon-background);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rc-app-icon-ink) 8%, transparent), var(--rc-shadow-md);
  /* 底板固定深色，标志墨色与光晕按暗色规范渲染 */
  --rc-mark-ink: var(--rc-app-icon-ink);
  --rc-mark-glow-soft: 0.7;
  --rc-mark-glow-core: 0.9;
}

.about-page-container {
  background: var(--rc-canvas);
}

/* 居中品牌页：品牌名与全站页面标题同档，其余文字走字号 token */
.about-brand {
  font-size: var(--rc-fs-title);
  line-height: 1.25;
}

.about-tagline,
.about-version {
  font-size: var(--rc-fs-small);
}

.about-specs {
  font-size: var(--rc-fs-body);
}

.about-footer {
  font-size: var(--rc-fs-caption);
}
</style>
