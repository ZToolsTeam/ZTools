<script setup>
import { ref, computed, watch } from 'vue'

import { generateQrcode, checkQrcodeStatus, deviceLogin } from '@/api/auth'
import { useUserStore } from '@/stores/user'
import { useUIStore } from '@/stores/ui'
import { useToast } from '@/composables/useToast'

const userStore = useUserStore()
const uiStore = useUIStore()
const { toastSuccess, toastError } = useToast()

const loading = ref(false)
const deviceLoading = ref(false)
// 设备号模拟登录只在开发版出现，正式包里不显示（后台正式环境也已关闭该接口）
const showDeviceLogin = import.meta.env.DEV
const error = ref('')
const qrcodeUrl = ref('')
const sceneId = ref('')
const status = ref('pending')
const expiresAt = ref(null)

let pollTimer = null

const dialogVisible = computed({
  get: () => uiStore.showLoginModal,
  set: (val) => {
    if (!val) uiStore.closeLoginModal()
  }
})

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

    // 开始轮询
    startPolling()
  } catch (err) {
    error.value = err.message || '生成二维码失败'
  } finally {
    loading.value = false
  }
}

// 开始轮询检查扫码状态
const startPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
  }

  pollTimer = setInterval(async () => {
    try {
      const result = await checkQrcodeStatus(sceneId.value)
      status.value = result.status

      if (result.status === 'confirmed') {
        // 登录成功
        stopPolling()
        // 更新用户状态
        await userStore.checkLoginStatus()
        toastSuccess('登录成功！')

        // 延迟一小会儿关闭，体验更好
        setTimeout(() => {
          uiStore.closeLoginModal()
          resetState()
        }, 1000)
      } else if (result.status === 'expired') {
        // 二维码过期，停止轮询
        stopPolling()
      }
    } catch (err) {
      console.error('检查二维码状态失败:', err)
    }
  }, 2000) // 每2秒检查一次
}

// 停止轮询
const stopPolling = () => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// 重置状态
const resetState = () => {
  loading.value = false
  deviceLoading.value = false
  error.value = ''
  qrcodeUrl.value = ''
  sceneId.value = ''
  status.value = 'pending'
  expiresAt.value = null
}

// 开发测试：设备号一键模拟登录（免手机扫码）
const handleDeviceLogin = async () => {
  if (!showDeviceLogin || deviceLoading.value) return
  deviceLoading.value = true
  stopPolling()

  try {
    await deviceLogin('ZTOOLS-TEST-DEVICE-0001', 'AI测试专用设备号')
    status.value = 'confirmed'
    await userStore.checkLoginStatus()
    toastSuccess('测试设备号登录成功！')
    setTimeout(() => {
      uiStore.closeLoginModal()
      resetState()
    }, 800)
  } catch (err) {
    console.error('设备号登录失败:', err)
    toastError(err.message || '设备登录失败')
    startPolling()
  } finally {
    deviceLoading.value = false
  }
}

// 关闭处理
const handleClose = () => {
  stopPolling()
  resetState()
}

// 监听弹窗显示状态
watch(dialogVisible, (newVal) => {
  if (newVal) {
    // 弹窗打开时生成二维码
    generateQrcodeHandler()
  } else {
    // 弹窗关闭时清理
    handleClose()
  }
})
</script>

<template>
  <a-modal
    v-model:open="dialogVisible"
    width="340px"
    :footer="null"
    :centered="true"
    :closable="true"
    class="login-modal"
    @cancel="handleClose"
  >
    <div class="login-content">
      <!-- 顶部图标和标题 -->
      <div class="login-header">
        <div class="wechat-icon">
          <i class="fa fa-wechat"></i>
        </div>
        <h2 class="login-title">微信扫码登录</h2>
        <p class="login-subtitle">安全快捷，无需注册</p>
      </div>

      <!-- 二维码容器 -->
      <div class="qrcode-wrapper">
        <div class="qrcode-container">
          <!-- 加载中 -->
          <div v-if="loading" class="qrcode-loading">
            <div class="loading-spinner"></div>
            <span class="loading-text">正在生成二维码...</span>
          </div>

          <!-- 错误状态 -->
          <div v-else-if="error" class="qrcode-error">
            <div class="error-icon">
              <i class="fa fa-exclamation-circle"></i>
            </div>
            <p class="error-text">{{ error }}</p>
            <button class="retry-btn" @click="generateQrcodeHandler">
              <i class="fa fa-refresh"></i>
              重新生成
            </button>
          </div>

          <!-- 二维码显示 -->
          <template v-else-if="qrcodeUrl">
            <div
              class="qrcode-image"
              :class="{ 'is-inactive': status !== 'pending' }"
            >
              <img :src="qrcodeUrl" alt="扫码登录" />
            </div>

            <!-- 已扫码覆盖层 -->
            <div v-if="status === 'scanned'" class="qrcode-overlay scanned">
              <div class="overlay-icon success">
                <i class="fa fa-check"></i>
              </div>
              <p class="overlay-text">扫码成功</p>
              <p class="overlay-hint">请在手机上确认登录</p>
            </div>

            <!-- 已过期覆盖层 -->
            <div v-if="status === 'expired'" class="qrcode-overlay expired">
              <div class="overlay-icon warning">
                <i class="fa fa-clock-o"></i>
              </div>
              <p class="overlay-text">二维码已过期</p>
              <button class="refresh-btn" @click="generateQrcodeHandler">
                <i class="fa fa-refresh"></i>
                点击刷新
              </button>
            </div>

            <!-- 登录成功覆盖层 -->
            <div v-if="status === 'confirmed'" class="qrcode-overlay confirmed">
              <div class="overlay-icon success">
                <i class="fa fa-check"></i>
              </div>
              <p class="overlay-text">登录成功</p>
            </div>
          </template>
        </div>
      </div>

      <!-- 底部提示与快捷测试登录 -->
      <div class="login-footer">
        <div v-if="status === 'pending'" class="footer-tips">
          <span class="tip-step">打开微信</span>
          <i class="fa fa-angle-right tip-arrow"></i>
          <span class="tip-step">扫一扫</span>
          <i class="fa fa-angle-right tip-arrow"></i>
          <span class="tip-step">关注登录</span>
        </div>

        <!-- 开发测试 / AI 免扫码快速登录 -->
        <div v-if="showDeviceLogin" class="device-login-box">
          <button
            type="button"
            class="device-login-link"
            :disabled="deviceLoading"
            title="使用测试设备号一键模拟登录，免物理手机扫码"
            @click="handleDeviceLogin"
          >
            <i class="fa" :class="deviceLoading ? 'fa-spinner fa-spin' : 'fa-laptop'"></i>
            <span>{{ deviceLoading ? '正在模拟登录...' : '开发测试：设备号一键模拟登录' }}</span>
          </button>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.login-content {
  padding: 0;
}

/* 顶部标题区域 */
.login-header {
  text-align: center;
  margin-bottom: 6px;
}

.wechat-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 8px;
  background: linear-gradient(135deg, #07c160 0%, #06ad56 100%);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: white;
}

.login-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--zt-text);
  margin: 0 0 2px;
}

.login-subtitle {
  font-size: 12px;
  color: var(--zt-text-secondary);
  margin: 0;
}

/* 二维码区域 */
.qrcode-wrapper {
  display: flex;
  justify-content: center;
  margin-bottom: 10px;
}

.qrcode-container {
  width: 272px;
  height: 272px;
  background: var(--color-gray-100);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

/* 加载状态 */
.qrcode-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-gray-200);
  border-top-color: var(--zt-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-text {
  font-size: 13px;
  color: var(--zt-text-secondary);
}

/* 错误状态 */
.qrcode-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px;
  text-align: center;
}

.error-icon {
  width: 48px;
  height: 48px;
  background: var(--rc-error-subtle);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: var(--rc-error);
}

.error-text {
  font-size: 13px;
  color: var(--rc-error);
  margin: 0;
}

.retry-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--color-gray-100);
  border: none;
  border-radius: 8px;
  font-size: 13px;
  color: var(--zt-text);
  cursor: pointer;
  transition: all 0.2s ease;
}

.retry-btn:hover {
  background: var(--color-gray-200);
}

/* 二维码图片 */
.qrcode-image {
  width: 100%;
  height: 100%;
  padding: 12px;
  background: var(--color-surface);
  border-radius: 12px;
  transition: all 0.3s ease;
}

.qrcode-image.is-inactive {
  opacity: 0.3;
  filter: grayscale(1);
  transform: scale(0.95);
}

.qrcode-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* 覆盖层 */
.qrcode-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--color-surface);
  border-radius: 16px;
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.overlay-icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: inherit;
  animation: scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes scaleIn {
  from {
    transform: scale(0);
  }
  to {
    transform: scale(1);
  }
}

.overlay-icon.success {
  background: var(--rc-success-subtle);
  color: var(--rc-success);
}

.overlay-icon.warning {
  background: var(--rc-warning-subtle);
  color: var(--rc-warning);
}

.overlay-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--zt-text);
  margin: 0;
}

.overlay-hint {
  font-size: 13px;
  color: var(--zt-text-secondary);
  margin: 0;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  background: var(--rc-accent);
  border: none;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-accent-contrast);
  cursor: pointer;
  transition: all 0.3s ease;
}

.refresh-btn:hover {
  transform: translateY(-2px);
  background: var(--rc-accent-hover);
}

/* 底部提示 */
.login-footer {
  padding: 0;
}

.footer-tips {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--color-gray-100);
  border-radius: 8px;
  font-size: 12px;
  color: var(--zt-text-secondary);
}

.tip-step {
  white-space: nowrap;
}

.tip-arrow {
  font-size: 10px;
  color: var(--color-gray-400);
}

/* 开发测试快捷登录按钮 */
.device-login-box {
  margin-top: 8px;
  text-align: center;
}

.device-login-link {
  background: transparent;
  border: 1px dashed var(--color-gray-300);
  font-size: 11px;
  color: var(--zt-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  transition: all 0.2s ease;
  opacity: 0.85;
}

.device-login-link:hover:not(:disabled) {
  opacity: 1;
  color: var(--rc-accent-text);
  border-color: var(--rc-accent-text);
  background: var(--color-gray-100);
}

.device-login-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 响应式 */
@media (max-width: 480px) {
  .footer-tips {
    flex-wrap: wrap;
    gap: 6px;
  }
}

/* 弹窗容器样式覆盖（限定在 .login-modal 命名空间内） */
:global(.login-modal .ant-modal-content) {
  border-radius: 20px;
  overflow: hidden;
  background: var(--color-surface);
}

:global(.login-modal .ant-modal-header) {
  display: none;
}

:global(.login-modal .ant-modal-body) {
  padding: 14px;
}

:global(.login-modal .ant-modal-close) {
  top: 16px;
  right: 16px;
}

:global(.login-modal .ant-modal-close-x) {
  width: 32px;
  height: 32px;
  line-height: 32px;
  font-size: 14px;
  color: var(--zt-text-secondary);
  background: var(--color-gray-100);
  border-radius: 8px;
  transition: all 0.2s ease;
}

:global(.login-modal .ant-modal-close-x:hover) {
  background: var(--color-gray-200);
  color: var(--zt-text);
}
</style>
