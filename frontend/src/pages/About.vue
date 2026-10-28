<script setup>
import { ReloadOutlined } from '@ant-design/icons-vue'
import { ref, onMounted } from 'vue'
import { formatVersionForDisplay } from '@/utils/versionDisplay'
import { RcButton, RcCard } from '@/components/base'
import BrandMark from '@/components/BrandMark.vue'
import { isUpdateUnsupported } from '@/composables/useAppUpdate'

const appVersion = ref('--')
const webVersion = ref('--')
const checking = ref(false)

onMounted(async () => {
  try {
    if (window.ztools && window.ztools.sys) {
      const ver = await window.ztools.sys.getCurrentVersion()
      appVersion.value = formatVersionForDisplay(ver.appVersion)
      webVersion.value = formatVersionForDisplay(ver.webVersion)
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
        window.__ztoolsToast?.('error', '检查更新失败')
        return
      }
      if (result.app) {
        window.__showUpdateNotification?.('app', result.app)
      } else if (result.web) {
        try {
          const ok = await window.__silentWebUpdate?.(result.web)
          if (!ok) window.__ztoolsToast?.('error', 'Web 更新未完成，请稍后重试')
        } catch (error) {
          console.error('Web 更新失败:', error)
          window.__ztoolsToast?.('error', 'Web 更新失败: ' + (error.message || '未知错误'))
        }
      } else {
        window.__ztoolsToast?.('success', '当前已是最新版本')
      }
    }
  } catch (e) {
    if (isUpdateUnsupported(e)) {
      window.__ztoolsToast?.('info', '当前平台暂不支持应用内更新，请前往官网 www.ztools.cn 下载新版本')
      return
    }
    console.error('检查更新失败:', e)
    window.__ztoolsToast?.('error', '检查更新失败')
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
  <div class="about-page-container w-full h-full flex flex-col items-center justify-center p-8 select-none overflow-y-auto">
    <div class="w-full max-w-lg flex flex-col items-center text-center gap-6">
      <!-- App Brand & Identity -->
      <div class="flex flex-col items-center gap-3">
        <!-- 与应用图标一致：墨黑底板 + 积木 Z（底板在两种主题下都保持深色） -->
        <div class="about-app-icon">
          <BrandMark :size="40" />
        </div>
        <div class="flex flex-col items-center">
          <h1 class="text-2xl font-bold tracking-tight text-[var(--rc-text-primary)] m-0">
            ZTools
          </h1>
          <p class="text-xs text-[var(--rc-text-secondary)] mt-1 m-0">
            纯粹开源 · 免费极客 · 轻量宿主 · 极致性能
          </p>
        </div>
      </div>

      <!-- Version & Action -->
      <div class="flex items-center gap-2">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-mono bg-[var(--rc-surface)] border border-[var(--rc-border)] text-[var(--rc-text-secondary)]">
          <span>App v{{ appVersion }}</span>
          <span class="opacity-40">·</span>
          <span>Web v{{ webVersion }}</span>
        </div>
        <RcButton
          size="sm"
          variant="ghost"
          :icon="ReloadOutlined"
          :loading="checking"
          @click="handleCheckUpdate"
        >
          {{ checking ? '检查中...' : '检查更新' }}
        </RcButton>
      </div>

      <!-- Specs & Open Source Card -->
      <RcCard class="w-full text-left" padding="p-0">
        <div class="divide-y divide-[var(--rc-border)]/60 text-xs">
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">核心架构</span>
            <span class="font-medium text-[var(--rc-text-primary)]">Electron + Vue 3 + Rust Sidecar</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">硬件级索引引擎</span>
            <span class="font-medium text-[var(--rc-text-primary)]">ztools-indexer (NTFS MFT 毫秒级)</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">特权穿透通道</span>
            <span class="font-medium text-[var(--rc-text-primary)]">ztools-uiaccess (UIPI 穿透)</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">开源协议</span>
            <span class="font-medium text-[var(--rc-text-primary)]">GPL-3.0</span>
          </div>
          <div class="flex items-center justify-between py-3 px-4">
            <span class="text-[var(--rc-text-secondary)]">官方仓库</span>
            <button
              type="button"
              class="text-[var(--rc-accent-text)] hover:underline inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-xs"
              @click="handleOpenLink('https://github.com/ZToolsTeam/ZTools')"
            >
              GitHub / ZTools
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          </div>
        </div>
      </RcCard>

      <!-- Footer Copyright -->
      <div class="text-[11px] text-[var(--rc-text-muted)] mt-2">
        <p class="m-0">© 2026 ZTools Team. All rights reserved.</p>
        <p class="m-0 mt-0.5 opacity-80">Local-First · E2EE · No Trackers</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-app-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, #232327, #141416);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), var(--rc-shadow-md);
  /* 底板固定深色，标志墨色与光晕按暗色规范渲染 */
  --rc-mark-ink: #f2f2f0;
  --rc-mark-glow-soft: 0.7;
  --rc-mark-glow-core: 0.9;
}

.about-page-container {
  background: var(--rc-canvas);
  min-height: calc(100vh - 72px);
}
</style>
