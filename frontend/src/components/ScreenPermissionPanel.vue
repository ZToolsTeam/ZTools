<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { createScreenPermissionController } from '@/utils/screenPermissionController'

const state = ref({ loading: false, snapshot: null, error: '' })
const grantState = ref({ loading: false, grants: [], error: '' })
const revokingGrantIds = ref(new Set())
const canQuery = ref(false)
let controller
let sdkInstance
let grantEventListener
let grantQueryGeneration = 0
let panelActive = false

const labels = {
  'not-required': '系统原生支持，无需申请',
  'not-determined': '尚未申请',
  granted: '已允许',
  denied: '系统已拒绝',
  restricted: '受到系统限制',
  unknown: '状态未知'
}

const statusText = computed(() => labels[state.value.snapshot?.osPermission] ?? '尚未读取')
const isMac = computed(() => state.value.snapshot?.target.platform === 'macos')

const refreshGrants = async () => {
  if (!panelActive || !sdkInstance?.sys?.listCapabilityGrants) return
  const generation = ++grantQueryGeneration
  grantState.value = { ...grantState.value, loading: true, error: '' }
  try {
    const result = await sdkInstance.sys.listCapabilityGrants()
    if (result?.success !== true || !Array.isArray(result.grants)) throw new Error('INVALID_GRANT_LIST')
    if (!panelActive || generation !== grantQueryGeneration) return
    grantState.value = { loading: false, grants: result.grants, error: '' }
  } catch {
    if (!panelActive || generation !== grantQueryGeneration) return
    grantState.value = { ...grantState.value, loading: false, error: '获取已授权插件失败，请稍后重试。' }
  }
}

const revokeGrant = async grantId => {
  if (!panelActive || !sdkInstance?.sys?.revokeCapabilityGrant || revokingGrantIds.value.has(grantId)) return
  revokingGrantIds.value = new Set(revokingGrantIds.value).add(grantId)
  try {
    const result = await sdkInstance.sys.revokeCapabilityGrant(grantId)
    if (result?.success !== true || result.revoked !== true) {
      throw new Error(typeof result?.error?.message === 'string' ? result.error.message : '主程序未确认撤销操作')
    }
    if (!panelActive) return
    await refreshGrants()
  } catch (error) {
    if (panelActive) {
      const detail = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : '主程序未确认撤销操作'
      grantState.value = { ...grantState.value, error: `撤销失败：${detail}，请重试。` }
    }
  } finally {
    if (panelActive) {
      const next = new Set(revokingGrantIds.value)
      next.delete(grantId)
      revokingGrantIds.value = next
    }
  }
}

onMounted(() => {
  panelActive = true
  try {
    const sdk = window.ztools
    if (!sdk?.isElectron?.() || !sdk.sys?.getCapability || !sdk.events?.on || !sdk.events?.off) return
    sdkInstance = sdk
    controller = createScreenPermissionController(sdk, value => { state.value = value })
    canQuery.value = true
    void controller.start().catch(() => { state.value.error = '获取系统权限失败，请重试。' })
    grantEventListener = envelope => {
      if (envelope?.source?.kind === 'host' && envelope.payload?.capability === 'screen.capture') void refreshGrants()
    }
    sdk.events.on('runtime_permission_changed', grantEventListener)
    void refreshGrants()
  } catch {
    state.value.error = '获取系统权限失败，请重试。'
  }
})

onBeforeUnmount(() => {
  panelActive = false
  grantQueryGeneration += 1
  controller?.stop()
  if (grantEventListener) {
    try { sdkInstance?.events?.off?.('runtime_permission_changed', grantEventListener) } catch { /* teardown */ }
  }
})
</script>

<template>
  <div class="settings-card" data-testid="screen-permission-panel">
    <!-- 卡片头部 -->
    <div class="card-header">
      <h2 class="card-title">隐私与权限</h2>
    </div>

    <div class="settings-list">
      <!-- 屏幕截取权限 -->
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-text">
            <span class="setting-label">屏幕截取权限</span>
            <span class="setting-desc" data-testid="screen-permission-status">
              {{ statusText }}
            </span>
          </div>
        </div>
        <a-button
          size="small"
          :loading="state.loading"
          :disabled="!canQuery"
          @click="controller?.refresh()"
        >
          <i class="fa fa-refresh mr-1" :class="{ 'fa-spin': state.loading }"></i>
          重新检查
        </a-button>
      </div>

      <!-- 运行时授权保护 -->
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-text">
            <span class="setting-label">插件授权保护</span>
            <span class="setting-desc" data-testid="screen-authorization-status">
              窗口关闭自动释放，按插件单独管理
            </span>
          </div>
        </div>
        <span class="text-xs px-2 py-0.5 rounded bg-[var(--rc-surface-subtle)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)] select-none">
          临时授权
        </span>
      </div>

      <a-alert v-if="state.error" class="my-1 text-xs" type="warning" :message="state.error" show-icon />

      <!-- macOS 权限异常时的极简引导 -->
      <div v-if="isMac && state.snapshot?.osPermission === 'denied'" class="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--rc-warning-subtle)] border border-[var(--rc-border)] text-xs text-[var(--rc-warning)] my-1">
        <i class="fa fa-exclamation-triangle"></i>
        <span>请前往“系统设置 > 隐私与安全性 > 屏幕录制”允许 ZTools</span>
      </div>

      <!-- 已授权插件列表 -->
      <div class="pt-4 pb-2" data-testid="screen-permission-grants">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-semibold text-[var(--rc-text-primary)]">已授权插件</span>
          <a-button size="small" :loading="grantState.loading" @click="refreshGrants">
            <i class="fa fa-refresh mr-1" :class="{ 'fa-spin': grantState.loading }"></i>
            刷新
          </a-button>
        </div>

        <a-alert v-if="grantState.error" class="my-1 text-xs" type="warning" :message="grantState.error" show-icon />

        <div v-if="!grantState.loading && !grantState.error && grantState.grants.length === 0" class="py-3 text-center text-xs text-[var(--rc-text-secondary)] opacity-60">
          当前没有已授权的插件
        </div>

        <div
          v-for="grant in grantState.grants"
          :key="grant.grantId"
          data-testid="screen-permission-grant"
          class="flex items-center justify-between gap-3 p-2 rounded-lg bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] mt-1.5"
        >
          <div class="min-w-0 flex-1">
            <div data-testid="screen-permission-grant-plugin" class="text-xs font-medium text-[var(--rc-text-primary)] truncate">
              {{ grant.pluginName }}
            </div>
            <div class="text-[11px] text-[var(--rc-text-secondary)] opacity-70 mt-0.5">
              <code>{{ grant.pluginId }}</code> · <span data-testid="screen-permission-grant-capability">屏幕采集</span>
            </div>
          </div>
          <a-button
            data-testid="screen-permission-grant-revoke"
            danger
            size="small"
            :loading="revokingGrantIds.has(grant.grantId)"
            :disabled="grantState.loading || revokingGrantIds.has(grant.grantId)"
            @click="revokeGrant(grant.grantId)"
          >
            撤销
          </a-button>
        </div>
      </div>
    </div>
  </div>
</template>

