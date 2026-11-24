<script setup>
import { RcAlert, RcButton, RcTag } from '@/components/base'
import { RotateCwIcon, TriangleAlertIcon } from '@lucide/vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { createScreenPermissionController } from '@/utils/screenPermissionController'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const state = ref({ loading: false, snapshot: null, error: '' })
const grantState = ref({ loading: false, grants: [], error: '' })
const revokingGrantIds = ref(new Set())
const canQuery = ref(false)
let controller
let sdkInstance
let grantEventListener
let grantQueryGeneration = 0
let panelActive = false

const statusText = computed(() => {
  const keyMap = {
    'not-required': 'privacy.status.notRequired',
    'not-determined': 'privacy.status.notDetermined',
    granted: 'privacy.status.granted',
    denied: 'privacy.status.denied',
    restricted: 'privacy.status.restricted',
    unknown: 'privacy.status.unknown'
  }
  const key = keyMap[state.value.snapshot?.osPermission]
  return key ? t(key) : t('privacy.status.unread')
})
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
    grantState.value = { ...grantState.value, loading: false, error: t('privacy.loadGrantsFailed') }
  }
}

const revokeGrant = async grantId => {
  if (!panelActive || !sdkInstance?.sys?.revokeCapabilityGrant || revokingGrantIds.value.has(grantId)) return
  revokingGrantIds.value = new Set(revokingGrantIds.value).add(grantId)
  try {
    const result = await sdkInstance.sys.revokeCapabilityGrant(grantId)
    if (result?.success !== true || result.revoked !== true) {
      throw new Error(resolveErrorMessage(result, 'privacy.revokeUnconfirmed'))
    }
    if (!panelActive) return
    await refreshGrants()
  } catch (error) {
    if (panelActive) {
      const detail = resolveErrorMessage(error, 'privacy.revokeUnconfirmed')
      grantState.value = { ...grantState.value, error: t('privacy.revokeFailed', { detail }) }
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
    void controller.start().catch(() => { state.value.error = t('privacy.loadPermissionFailed') })
    grantEventListener = envelope => {
      if (envelope?.source?.kind === 'host' && envelope.payload?.capability === 'screen.capture') void refreshGrants()
    }
    sdk.events.on('runtime_permission_changed', grantEventListener)
    void refreshGrants()
  } catch {
    state.value.error = t('privacy.loadPermissionFailed')
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
      <h2 class="card-title">{{ t('privacy.title') }}</h2>
    </div>

    <div class="settings-list">
      <!-- 屏幕截取权限 -->
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-text">
            <span class="setting-label">{{ t('privacy.screenCapture') }}</span>
            <span class="setting-desc" data-testid="screen-permission-status">
              {{ statusText }}
            </span>
          </div>
        </div>
        <RcButton variant="secondary" size="sm" :loading="state.loading" :disabled="!canQuery" @click="controller?.refresh()">
          <RotateCwIcon class="mr-1" :class="{ 'animate-spin': state.loading }" />
          {{ t('privacy.recheck') }}
        </RcButton>
      </div>

      <!-- 运行时授权保护 -->
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-text">
            <span class="setting-label">{{ t('privacy.grantProtection') }}</span>
            <span class="setting-desc" data-testid="screen-authorization-status">
              {{ t('privacy.grantProtectionDesc') }}
            </span>
          </div>
        </div>
        <!-- 只读的模式说明，不是按钮：用纯文字标签，不做灰底块 -->
        <RcTag variant="text" class="select-none">{{ t('privacy.tempGrant') }}</RcTag>
      </div>

      <RcAlert v-if="state.error" class="perm-alert" type="warning" :message="state.error" show-icon />

      <!-- macOS 权限异常时的极简引导 -->
      <div v-if="isMac && state.snapshot?.osPermission === 'denied'" class="perm-warning">
        <TriangleAlertIcon aria-hidden="true" />
        <span>{{ t('privacy.macDeniedGuide') }}</span>
      </div>

      <!-- 已授权插件列表 -->
      <div class="perm-grants" data-testid="screen-permission-grants">
        <div class="perm-grants-header">
          <span class="perm-grants-title">{{ t('privacy.grantedPlugins') }}</span>
          <RcButton variant="secondary" size="sm" :loading="grantState.loading" @click="refreshGrants">
            <RotateCwIcon class="mr-1" :class="{ 'animate-spin': grantState.loading }" />
            {{ t('common.refresh') }}
          </RcButton>
        </div>

        <RcAlert v-if="grantState.error" class="perm-alert" type="warning" :message="grantState.error" show-icon />

        <div v-if="!grantState.loading && !grantState.error && grantState.grants.length === 0" class="perm-empty">
          {{ t('privacy.noGrants') }}
        </div>

        <div
          v-for="grant in grantState.grants"
          :key="grant.grantId"
          data-testid="screen-permission-grant"
          class="perm-grant"
        >
          <div class="min-w-0 flex-1">
            <div data-testid="screen-permission-grant-plugin" class="perm-grant-name">
              {{ grant.pluginName }}
            </div>
            <div class="perm-grant-meta">
              <code>{{ grant.pluginId }}</code> · <span data-testid="screen-permission-grant-capability">{{ t('privacy.capabilityScreenCapture') }}</span>
            </div>
          </div>
          <RcButton variant="danger" size="sm" data-testid="screen-permission-grant-revoke" :loading="revokingGrantIds.has(grant.grantId)" :disabled="grantState.loading || revokingGrantIds.has(grant.grantId)" @click="revokeGrant(grant.grantId)">
            {{ t('privacy.revoke') }}
          </RcButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perm-alert {
  margin: 12px 0;
  font-size: var(--rc-fs-small);
}

.perm-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  padding: 8px 12px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-warning-subtle);
  color: var(--rc-warning);
  font-size: var(--rc-fs-small);
}

.perm-grants {
  padding: 12px 0 8px;
}

/* 与上方设置分组同一种「标题 + 细线」 */
.perm-grants-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--rc-border);
}


.perm-grants-title {
  font-size: var(--rc-fs-small);
  font-weight: 600;
  color: var(--rc-text-primary);
}

.perm-empty {
  padding: 12px 0;
  text-align: center;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
}

.perm-grant {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  padding: 8px 10px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface-subtle);
}

.perm-grant-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--rc-fs-body);
  font-weight: 500;
  color: var(--rc-text-primary);
}

.perm-grant-meta {
  margin-top: 2px;
  font-size: var(--rc-fs-caption);
  color: var(--rc-text-muted);
}
</style>
