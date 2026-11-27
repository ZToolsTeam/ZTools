<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { HardDriveIcon, RotateCwIcon, Trash2Icon } from '@lucide/vue'
import { RcAlert, RcButton, RcTag } from '@/components/base'
import { useToast } from '@/composables/useToast'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const { success: toastSuccess, error: toastError } = useToast()

const loading = ref(false)
const cleaningExpired = ref(false)
const cleaningIds = ref(new Set())
const loadError = ref('')
const actionError = ref('')
const items = ref([])
const totalSizeBytes = ref(0)

let loadGeneration = 0
let ipcRequestSeq = 0
let isUnmounted = false

/** 将字节数格式化为易读磁盘占用字符串（显式处理 0 字节） */
function formatBytes(rawBytes) {
  const num = Number(rawBytes)
  if (!Number.isFinite(num) || num <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = num
  let unitIdx = 0
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024
    unitIdx += 1
  }
  const formatted = unitIdx === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)
  return `${formatted} ${units[unitIdx]}`
}

/** 统一解包 IPC 响应信封，若宿主返回 success:false 则抛出规范 Error */
function unwrapIpcResponse(response, fallbackKey) {
  if (response && typeof response === 'object' && response.success === false) {
    const errMessage =
      (response.error && response.error.message) ||
      (typeof response.error === 'string' ? response.error : '') ||
      t(fallbackKey)
    const err = new Error(errMessage)
    err.code = (response.error && response.error.code) || response.code
    throw err
  }
  if (response && typeof response === 'object' && response.success === true && 'data' in response) {
    return response.data
  }
  return response
}

/** 统一调用 tool_commonlibs_list / tool_commonlibs_clean（优先走 window.ztools.toolRuntime，兼容直调 __ztoolsElectron.ipc） */
async function invokeCommonLibsIpc(method, params = {}) {
  const runtime = typeof window !== 'undefined' ? window.ztools?.toolRuntime : null
  if (method === 'tool_commonlibs_list' && typeof runtime?.listCommonLibs === 'function') {
    const res = await runtime.listCommonLibs()
    return unwrapIpcResponse(res, 'settings.commonLibs.loadFailed')
  }
  if (method === 'tool_commonlibs_clean' && typeof runtime?.cleanCommonLibs === 'function') {
    const res = await runtime.cleanCommonLibs(params)
    return unwrapIpcResponse(res, 'settings.commonLibs.cleanFailed')
  }

  const directIpc = typeof window !== 'undefined' ? window.__ztoolsElectron?.ipc?.[method] : null
  if (typeof directIpc === 'function') {
    const res = await directIpc(params)
    return unwrapIpcResponse(
      res,
      method === 'tool_commonlibs_list' ? 'settings.commonLibs.loadFailed' : 'settings.commonLibs.cleanFailed'
    )
  }

  const transportMethod = typeof window !== 'undefined'
    ? window.__ztoolsElectron?.transport?.methods?.[method]
    : null
  if (typeof transportMethod === 'function') {
    ipcRequestSeq += 1
    const messageId = `commonlibs_${Date.now()}_${ipcRequestSeq}`
    const res = await transportMethod({ messageId, params })
    return unwrapIpcResponse(
      res,
      method === 'tool_commonlibs_list' ? 'settings.commonLibs.loadFailed' : 'settings.commonLibs.cleanFailed'
    )
  }

  throw new Error(t('settings.commonLibs.ipcUnavailable'))
}

/** 根据后端状态枚举映射徽章色调与词条键 */
function resolveStatusMeta(status) {
  switch (status) {
    case 'ready':
      return { tone: 'success', label: t('settings.commonLibs.status.ready') }
    case 'unreferenced':
      return { tone: 'warning', label: t('settings.commonLibs.status.unreferenced') }
    case 'revoked':
      return { tone: 'error', label: t('settings.commonLibs.status.revoked') }
    case 'corrupted':
      return { tone: 'error', label: t('settings.commonLibs.status.corrupted') }
    default:
      return { tone: 'neutral', label: t('settings.commonLibs.status.unknown') }
  }
}

const formattedTotalSize = computed(() => formatBytes(totalSizeBytes.value))
const isBusy = computed(() => loading.value || cleaningExpired.value || cleaningIds.value.size > 0)

/** 加载已缓存的 CommonLibs 工具池清单 */
async function loadInventory() {
  const generation = ++loadGeneration
  loading.value = true
  loadError.value = ''
  try {
    const data = await invokeCommonLibsIpc('tool_commonlibs_list', {})
    if (isUnmounted || generation !== loadGeneration) return
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      throw new Error(t('settings.commonLibs.invalidResponse'))
    }
    items.value = data.items
    const computedTotal = data.items.reduce((acc, item) => acc + (Number(item?.sizeBytes) || 0), 0)
    totalSizeBytes.value =
      typeof data.totalSizeBytes === 'number' && Number.isFinite(data.totalSizeBytes)
        ? data.totalSizeBytes
        : computedTotal
  } catch (err) {
    if (isUnmounted || generation !== loadGeneration) return
    const reason = resolveErrorMessage(err, 'common.unknownError')
    loadError.value = t('settings.commonLibs.loadFailedWithReason', { reason })
  } finally {
    if (!isUnmounted && generation === loadGeneration) {
      loading.value = false
    }
  }
}

/** 手动清理单个未引用或已撤销的引擎版本 */
async function cleanSingleTool(item) {
  const toolId = item?.toolId
  if (!toolId || !item.canManualClean || cleaningIds.value.has(toolId) || cleaningExpired.value) return
  actionError.value = ''
  const nextSet = new Set(cleaningIds.value)
  nextSet.add(toolId)
  cleaningIds.value = nextSet

  try {
    const result = await invokeCommonLibsIpc('tool_commonlibs_clean', { toolId })
    if (isUnmounted) return
    const removed = Array.isArray(result?.removedToolIds) ? result.removedToolIds : []
    const reclaimed = formatBytes(result?.reclaimedBytes ?? 0)
    if (removed.includes(toolId)) {
      toastSuccess(t('settings.commonLibs.cleanSingleSuccess', { toolId, size: reclaimed }))
    } else {
      toastSuccess(t('settings.commonLibs.cleanSkipped', { toolId }))
    }
    await loadInventory()
  } catch (err) {
    if (isUnmounted) return
    const reason = resolveErrorMessage(err, 'common.unknownError')
    const msg = t('settings.commonLibs.cleanFailedWithReason', { reason })
    actionError.value = msg
    toastError(msg)
  } finally {
    if (!isUnmounted) {
      const cleaned = new Set(cleaningIds.value)
      cleaned.delete(toolId)
      cleaningIds.value = cleaned
    }
  }
}

/** 触发过期引擎 GC 回收 */
async function cleanExpiredTools() {
  if (cleaningExpired.value || loading.value) return
  actionError.value = ''
  cleaningExpired.value = true
  try {
    const result = await invokeCommonLibsIpc('tool_commonlibs_clean', { runGc: true })
    if (isUnmounted) return
    const removedCount = Array.isArray(result?.removedToolIds) ? result.removedToolIds.length : 0
    const reclaimed = formatBytes(result?.reclaimedBytes ?? 0)
    if (removedCount > 0) {
      toastSuccess(t('settings.commonLibs.cleanExpiredSuccess', { count: removedCount, size: reclaimed }))
    } else {
      toastSuccess(t('settings.commonLibs.cleanExpiredNone'))
    }
    await loadInventory()
  } catch (err) {
    if (isUnmounted) return
    const reason = resolveErrorMessage(err, 'common.unknownError')
    const msg = t('settings.commonLibs.cleanFailedWithReason', { reason })
    actionError.value = msg
    toastError(msg)
  } finally {
    if (!isUnmounted) {
      cleaningExpired.value = false
    }
  }
}

onMounted(() => {
  isUnmounted = false
  void loadInventory()
})

onBeforeUnmount(() => {
  isUnmounted = true
  loadGeneration += 1
})

defineExpose({
  loadInventory,
  formatBytes
})
</script>

<template>
  <div class="settings-card" data-testid="commonlibs-settings">
    <div class="card-header commonlibs-header">
      <div class="commonlibs-title-group">
        <h2 class="card-title">{{ t('settings.commonLibs.title') }}</h2>
        <p class="card-desc">{{ t('settings.commonLibs.desc') }}</p>
      </div>
      <div class="commonlibs-toolbar">
        <RcButton
          variant="secondary"
          size="sm"
          data-testid="commonlibs-refresh-btn"
          :loading="loading"
          :disabled="cleaningExpired"
          @click="loadInventory"
        >
          <RotateCwIcon class="commonlibs-btn-icon" :class="{ 'animate-spin': loading }" aria-hidden="true" />
          {{ t('common.refresh') }}
        </RcButton>
        <RcButton
          variant="secondary"
          size="sm"
          data-testid="commonlibs-clean-expired-btn"
          :loading="cleaningExpired"
          :disabled="isBusy"
          @click="cleanExpiredTools"
        >
          <Trash2Icon class="commonlibs-btn-icon" aria-hidden="true" />
          {{ t('settings.commonLibs.cleanExpired') }}
        </RcButton>
      </div>
    </div>

    <!-- 磁盘占用摘要栏 -->
    <div class="commonlibs-summary" data-testid="commonlibs-summary">
      <span class="commonlibs-summary-item">
        <HardDriveIcon class="commonlibs-summary-icon" aria-hidden="true" />
        {{ t('settings.commonLibs.totalUsage', { size: formattedTotalSize }) }}
      </span>
      <span class="commonlibs-summary-sep" aria-hidden="true">·</span>
      <span class="commonlibs-summary-count">
        {{ t('settings.commonLibs.versionCount', { count: items.length }) }}
      </span>
    </div>

    <!-- 加载错误提示 -->
    <div v-if="loadError" class="commonlibs-alert-wrap" data-testid="commonlibs-load-error">
      <RcAlert type="error" :message="loadError" show-icon />
      <RcButton variant="secondary" size="xs" data-testid="commonlibs-retry-btn" @click="loadInventory">
        {{ t('common.retry') }}
      </RcButton>
    </div>

    <!-- 清理操作错误提示 -->
    <RcAlert
      v-if="actionError"
      class="commonlibs-action-alert"
      type="error"
      data-testid="commonlibs-action-error"
      :message="actionError"
      show-icon
    />

    <!-- 加载中占位 -->
    <div v-if="loading && items.length === 0 && !loadError" class="commonlibs-empty" data-testid="commonlibs-loading">
      {{ t('common.loading') }}
    </div>

    <!-- 空状态（无数据时如实展示，绝不拼装假数据） -->
    <div
      v-else-if="!loading && !loadError && items.length === 0"
      class="commonlibs-empty"
      data-testid="commonlibs-empty"
    >
      <HardDriveIcon class="commonlibs-empty-icon" aria-hidden="true" />
      <p class="commonlibs-empty-title">{{ t('settings.commonLibs.emptyTitle') }}</p>
      <p class="commonlibs-empty-desc">{{ t('settings.commonLibs.emptyDesc') }}</p>
    </div>

    <!-- 已缓存引擎版本列表 -->
    <div v-else-if="items.length > 0" class="commonlibs-list" data-testid="commonlibs-list">
      <div
        v-for="item in items"
        :key="item.toolId"
        class="commonlibs-item"
        :data-testid="`commonlib-row-${item.toolId}`"
      >
        <div class="commonlibs-main">
          <div class="commonlibs-title-row">
            <span class="commonlibs-tool-id" data-testid="commonlib-tool-id">{{ item.toolId }}</span>
            <RcTag
              variant="soft"
              :tone="resolveStatusMeta(item.status).tone"
              data-testid="commonlib-status-tag"
            >
              {{ resolveStatusMeta(item.status).label }}
            </RcTag>
            <RcTag variant="soft" tone="neutral" data-testid="commonlib-arch-tag">
              {{ item.platformArch }}
            </RcTag>
          </div>

          <div class="commonlibs-meta-row">
            <span data-testid="commonlib-version">{{ t('settings.commonLibs.versionLabel', { version: item.version }) }}</span>
            <span class="commonlibs-dot" aria-hidden="true">·</span>
            <span data-testid="commonlib-size">{{ formatBytes(item.sizeBytes) }}</span>
          </div>

          <div class="commonlibs-refs" data-testid="commonlib-refs">
            <template v-if="item.referencedByCapabilities?.length || item.referencedByPlugins?.length">
              <span v-if="item.referencedByCapabilities?.length" class="commonlibs-ref-line">
                {{ t('settings.commonLibs.capabilitiesLabel', { list: item.referencedByCapabilities.join(', ') }) }}
              </span>
              <span v-if="item.referencedByPlugins?.length" class="commonlibs-ref-line">
                {{ t('settings.commonLibs.pluginsLabel', { list: item.referencedByPlugins.join(', ') }) }}
              </span>
            </template>
            <span v-else class="commonlibs-ref-idle">
              {{ t('settings.commonLibs.unreferencedHint') }}
            </span>
          </div>

          <div v-if="item.revokedReason" class="commonlibs-revoked-reason" data-testid="commonlib-revoked-reason">
            {{ t('settings.commonLibs.revokedReasonLabel', { reason: item.revokedReason }) }}
          </div>
        </div>

        <div class="commonlibs-actions">
          <RcButton
            v-if="item.canManualClean"
            variant="danger"
            size="sm"
            :data-testid="`commonlib-clean-btn-${item.toolId}`"
            :loading="cleaningIds.has(item.toolId)"
            :disabled="loading || cleaningExpired || cleaningIds.has(item.toolId)"
            @click="cleanSingleTool(item)"
          >
            {{ t('settings.commonLibs.cleanNow') }}
          </RcButton>
          <RcTag
            v-else
            variant="text"
            tone="neutral"
            :data-testid="`commonlib-in-use-${item.toolId}`"
          >
            {{ t('settings.commonLibs.inUse') }}
          </RcTag>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.commonlibs-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.commonlibs-title-group {
  min-width: 0;
  flex: 1;
}

.card-desc {
  margin: 4px 0 0;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  line-height: 1.5;
}

.commonlibs-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.commonlibs-btn-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.commonlibs-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface-subtle);
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
  font-variant-numeric: tabular-nums;
}

.commonlibs-summary-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--rc-text-primary);
  font-weight: 500;
}

.commonlibs-summary-icon {
  width: 14px;
  height: 14px;
  color: var(--rc-text-muted);
}

.commonlibs-summary-sep {
  color: var(--rc-text-faint);
}

.commonlibs-alert-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.commonlibs-alert-wrap > :first-child {
  flex: 1;
}

.commonlibs-action-alert {
  margin-top: 12px;
}

.commonlibs-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 16px;
  padding: 28px 16px;
  border: 1px dashed var(--rc-border);
  border-radius: var(--rc-radius-md);
  color: var(--rc-text-muted);
  text-align: center;
}

.commonlibs-empty-icon {
  width: 24px;
  height: 24px;
  color: var(--rc-text-faint);
}

.commonlibs-empty-title {
  margin: 0;
  font-size: var(--rc-fs-body);
  font-weight: 500;
  color: var(--rc-text-primary);
}

.commonlibs-empty-desc {
  margin: 0;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  max-width: 440px;
  line-height: 1.5;
}

.commonlibs-list {
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  border-top: 1px solid var(--rc-border);
}

.commonlibs-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--rc-border);
}

.commonlibs-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.commonlibs-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.commonlibs-tool-id {
  font-size: var(--rc-fs-body);
  font-weight: 600;
  color: var(--rc-text-primary);
  font-family: var(--rc-font-mono, monospace);
}

.commonlibs-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
  font-variant-numeric: tabular-nums;
}

.commonlibs-dot {
  color: var(--rc-text-faint);
}

.commonlibs-refs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--rc-fs-caption);
  color: var(--rc-text-muted);
}

.commonlibs-ref-line {
  word-break: break-word;
}

.commonlibs-ref-idle {
  color: var(--rc-text-faint);
}

.commonlibs-revoked-reason {
  font-size: var(--rc-fs-caption);
  color: var(--rc-error);
}

.commonlibs-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
