<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { generateQrcode, checkQrcodeStatus } from '../api/auth'
import { useUserStore } from '@/stores/user'
import { useToast } from '@/composables/useToast'
import { ROUTES } from '@/router/routes'
import { RcButton, RcCard } from '@/components/base'

const router = useRouter()
const userStore = useUserStore()
const { toastSuccess } = useToast()

const loading = ref(false)
const error = ref('')
const qrcodeUrl = ref('')
const sceneId = ref('')
const status = ref('pending')
const expiresAt = ref(null)

let pollTimer = null

const handleClose = () => {
  stopPolling()
  router.push(ROUTES.HOME)
}

const handleGlobalKeydown = (e) => {
  if (e.key === 'Escape') {
    handleClose()
  }
}

// 生成二维码
const generateQrcodeHandler = async () => {
  loading.value = true
  error.value = ''

  try {
    const data = await generateQrcode()
    qrcodeUrl.value = data.qrcode_url
    sceneId.value = data.scene_id
    expiresAt.value = new Date(data.expires_at)
    status.value = 'pending'

    startPolling()
  } catch (err) {
    error.value = err.message || '生成二维码失败'
  } finally {
    loading.value = false
  }
}

const startPolling = () => {
  if (pollTimer) clearInterval(pollTimer)

  pollTimer = setInterval(async () => {
    try {
      const result = await checkQrcodeStatus(sceneId.value)
      status.value = result.status

      if (result.status === 'confirmed') {
        clearInterval(pollTimer)
        await userStore.checkLoginStatus()
        window.ztools?.analytics?.report('login_success')
        toastSuccess('登录成功！')
        router.push(ROUTES.HOME)
      } else if (result.status === 'expired') {
        clearInterval(pollTimer)
        window.ztools?.analytics?.report('login_fail', '', { error: 'qrcode_expired' })
      }
    } catch (err) {
      console.error('检查二维码状态失败:', err)
    }
  }, 2000)
}

const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  generateQrcodeHandler()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  stopPolling()
})
</script>

<template>
  <div class="login-page-container w-full h-full min-h-screen flex items-center justify-center p-4 relative select-none">
    <!-- 顶部返回/关闭按钮 -->
    <div class="absolute top-4 left-4">
      <RcButton size="sm" variant="ghost" icon="fa-arrow-left" kbd="Escape" @click="handleClose">
        返回主页
      </RcButton>
    </div>

    <!-- 沉浸式暗黑登录卡片 -->
    <RcCard class="w-full max-w-sm relative" padding="p-6">
      <button
        type="button"
        class="absolute top-4 right-4 w-7 h-7 rounded-md flex items-center justify-center text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] border-0 bg-transparent cursor-pointer transition-colors"
        @click="handleClose"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div class="flex flex-col items-center text-center">
        <!-- 头部图标 -->
        <div class="w-12 h-12 rounded-xl bg-[var(--rc-surface-subtle)] border border-white/[0.08] flex items-center justify-center text-[#07c160] mb-3 text-xl">
          <i class="fa fa-wechat"></i>
        </div>

        <h2 class="text-base font-semibold text-[var(--rc-text-primary)] m-0">
          微信扫码登录
        </h2>
        <p class="text-xs text-[var(--rc-text-secondary)] mt-1 mb-4">
          安全快捷 · 开启多端同步与云端扩展
        </p>

        <!-- 二维码展示区 -->
        <div class="w-[210px] h-[210px] rounded-lg bg-white p-2.5 flex items-center justify-center shadow-inner relative overflow-hidden">
          <div v-if="loading" class="flex flex-col items-center gap-2 text-[var(--rc-text-muted)] text-xs">
            <i class="fa fa-spinner fa-spin text-lg text-[var(--rc-accent-text)]"></i>
            <span>生成二维码...</span>
          </div>

          <div v-else-if="error" class="flex flex-col items-center gap-2 text-center p-2">
            <span class="text-xs text-[var(--rc-error)]">{{ error }}</span>
            <RcButton size="xs" variant="secondary" icon="fa-refresh" @click="generateQrcodeHandler">
              重试
            </RcButton>
          </div>

          <div v-else-if="status === 'expired'" class="absolute inset-0 bg-white/90 backdrop-blur-xs flex flex-col items-center justify-center gap-2">
            <span class="text-xs text-[var(--rc-text-secondary)] font-medium">二维码已失效</span>
            <RcButton size="xs" variant="primary" icon="fa-refresh" @click="generateQrcodeHandler">
              刷新
            </RcButton>
          </div>

          <img
            v-else-if="qrcodeUrl"
            :src="qrcodeUrl"
            class="w-full h-full object-contain"
            alt="login qrcode"
          />
        </div>

        <div class="text-[11px] text-[var(--rc-text-muted)] mt-4 space-y-0.5">
          <p class="m-0">使用微信扫描上方二维码</p>
          <p class="m-0 opacity-70">首次登录将自动创建账号</p>
        </div>
      </div>
    </RcCard>
  </div>
</template>

<style scoped>
.login-page-container {
  background: var(--rc-canvas);
}
</style>
