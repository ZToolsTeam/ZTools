<template>
  <RcDialog
    v-model:open="visible"
    :title="t('modals.update.title')"
    :aria-label="t('modals.update.title')"
    :description="`${updateType === 'app' ? t('modals.update.appUpdate') : t('modals.update.webUpdate')} · v${version}`"
    :width="480"
    :closable="!force && !updating"
    :keyboard="!force && !updating"
    :mask-closable="false"
    destroy-on-close
    @cancel="dismiss"
  >
    <template #icon>
      <CircleArrowUpIcon class="update-heading-icon" aria-hidden="true" />
    </template>

    <div class="update-body">
      <div v-if="changelog" class="update-changelog" v-html="formattedChangelog"></div>
      <p v-else class="update-empty">{{ t('modals.update.emptyChangelog') }}</p>

      <p v-if="!updating && updateType === 'app'" class="update-install-hint">
        {{ t('modals.update.restartHint') }}
      </p>

      <div v-if="updating" class="update-progress" aria-live="polite">
        <div class="update-progress-row">
          <span>{{ progress < 100 ? t('modals.update.downloading') : t('modals.update.verifying') }}</span>
          <strong>{{ progress }}%</strong>
        </div>
        <div class="update-progress-track" role="progressbar" :aria-label="t('modals.update.progressAria')" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100">
          <div class="update-progress-value" :style="{ width: `${progress}%` }"></div>
        </div>
      </div>

      <p v-if="updateError" class="update-error" role="alert">{{ updateError }}</p>
    </div>

    <template #footer>
      <div v-if="!updating" class="update-actions">
        <button v-if="!force && !updating" type="button" class="update-skip" @click="skipVersion">{{ t('modals.update.skipVersion') }}</button>
        <div class="update-primary-actions">
          <RcButton v-if="!force && !updating" variant="secondary" size="md" class="update-btn-ghost" @click="remindLater">{{ t('modals.update.remindLater') }}</RcButton>
          <RcButton variant="primary" size="md" class="update-btn-primary" :loading="updating" @click="doUpdate">
            {{ t('modals.update.updateNow') }}
          </RcButton>
        </div>
      </div>
      <div v-else class="update-actions">
        <RcButton v-if="progress < 100" variant="secondary" size="md" class="update-btn-ghost" :disabled="cancelling" @click="cancelInProgress">{{ t('modals.update.cancelUpdate') }}</RcButton>
        <span v-else class="update-install-hint" role="status">{{ t('modals.update.preparingInstall') }}</span>
      </div>
    </template>
  </RcDialog>
</template>

<script setup>
import { RcButton, RcDialog } from '@/components/base'
import { CircleArrowUpIcon } from '@lucide/vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useUpdateStore } from '@/stores/update'
import { useAppUpdate } from '@/composables/useAppUpdate'
import { renderMarkdown } from '@/declarative/markdown'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()

// 更新偏好存储 key（LevelDB，pluginId = __system__）
const SKIP_VERSION_KEY = 'update:skipVersion'
const REMIND_AFTER_KEY = 'update:remindAfter'
const SYSTEM_PLUGIN_ID = '__system__'
// 稍后提醒间隔：3天（毫秒）
const REMIND_LATER_MS = 3 * 24 * 60 * 60 * 1000

const visible = ref(false)
const version = ref('')
const changelog = ref('')
const updateType = ref('web')
const force = ref(false)
const updating = ref(false)
const progress = ref(0)
const updateError = ref('')
const operationId = ref('')
const cancelling = ref(false)

// 复用宿主的安全 Markdown 渲染器，兼容旧接口使用字面量 \n 的说明。
const formattedChangelog = computed(() => renderMarkdown(String(changelog.value).replace(/\\n/g, '\n')))

const updateStore = useUpdateStore()
const { downloadAndInstall, silentWebUpdate, cancelUpdate } = useAppUpdate()

let pendingType = null
let pendingData = null
let actionRevision = 0
let cancellationTask = null

/**
 * 从 LevelDB 读取更新偏好，判断是否应该展示通知
 * @param {string} ver - 新版本号
 * @param {boolean} isForce - 是否强制更新
 * @returns {Promise<boolean>} true=应该展示
 */
async function shouldShowNotification(ver, isForce) {
  // 强制更新无视所有跳过设置
  if (isForce) return true
  if (!window.ztools?.db) return true

  try {
    // 检查是否跳过了此版本
    const skipResult = await window.ztools.db.get({
      _id: SKIP_VERSION_KEY,
      pluginId: SYSTEM_PLUGIN_ID
    })
    if (skipResult?.value === ver) {
      console.log(`[update] 版本 ${ver} 已被用户跳过，不展示通知`)
      return false
    }

    // 检查是否在"稍后提醒"冷却期内
    const remindResult = await window.ztools.db.get({
      _id: REMIND_AFTER_KEY,
      pluginId: SYSTEM_PLUGIN_ID
    })
    if (remindResult?.value) {
      const remindAfter = Number(remindResult.value)
      if (remindAfter > 0 && Date.now() < remindAfter) {
        console.log(`[update] 稍后提醒冷却中，${new Date(remindAfter).toLocaleString()} 后再提醒`)
        return false
      }
    }
  } catch (e) {
    // 读取失败不影响展示
    console.warn('[update] 读取更新偏好失败:', e)
  }
  return true
}

/**
 * 写入更新偏好到 LevelDB
 */
async function saveUpdatePref(key, value) {
  if (!window.ztools?.db) return
  try {
    await window.ztools.db.put({
      _id: key,
      pluginId: SYSTEM_PLUGIN_ID,
      value: String(value)
    })
  } catch (e) {
    console.warn('[update] 保存更新偏好失败:', e)
  }
}

/**
 * 清除更新偏好（用户选择立即更新时）
 */
async function clearUpdatePrefs() {
  if (!window.ztools?.db) return
  try {
    await window.ztools.db.delete({ _id: SKIP_VERSION_KEY, pluginId: SYSTEM_PLUGIN_ID })
    await window.ztools.db.delete({ _id: REMIND_AFTER_KEY, pluginId: SYSTEM_PLUGIN_ID })
  } catch (e) {
    console.warn('[update] 清除更新偏好失败:', e)
  }
}

async function show(type, data) {
  const ver = data.version || ''
  const isForce = data.force || false

  // 检查是否应该展示
  if (updating.value || !(await shouldShowNotification(ver, isForce)) || updating.value) return

  updateType.value = type
  actionRevision += 1
  version.value = ver
  changelog.value = data.changelog || ''
  force.value = isForce
  pendingType = type
  pendingData = data
  updating.value = false
  progress.value = 0
  updateError.value = ''
  operationId.value = ''
  visible.value = true
}

function dismiss() {
  if (updating.value) return
  actionRevision += 1
  visible.value = false
  pendingType = null
  pendingData = null
}

function handleUpdateProgress(envelope) {
  const payload = envelope?.payload || {}
  if (!updating.value || payload.type !== 'app') return
  if (operationId.value && payload.operationId !== operationId.value) return
  if (typeof payload.percent === 'number') {
    progress.value = Math.max(0, Math.min(100, Math.floor(payload.percent)))
  }
  if (!operationId.value && typeof payload.operationId === 'string') {
    operationId.value = payload.operationId
  }
}

function cancelInProgress() {
  if (cancelling.value || progress.value >= 100) return
  cancelling.value = true
  cancellationTask = (async () => {
    try {
      const result = await cancelUpdate()
      if (result?.installing) {
        progress.value = 100
        return
      }
      actionRevision += 1
      updating.value = false
      visible.value = false
      pendingType = null
      pendingData = null
    } catch (error) {
      updateError.value = error.message || t('modals.update.cancelFailed')
    } finally {
      cancelling.value = false
    }
  })()
  void cancellationTask.finally(() => { cancellationTask = null })
}

/**
 * 此版本不再提醒
 */
async function skipVersion() {
  await saveUpdatePref(SKIP_VERSION_KEY, version.value)
  dismiss()
}

/**
 * 稍后提醒（3天后）
 */
async function remindLater() {
  await saveUpdatePref(REMIND_AFTER_KEY, Date.now() + REMIND_LATER_MS)
  dismiss()
}

async function doUpdate() {
  if (!pendingType || !pendingData || updating.value) return
  const type = pendingType
  const data = pendingData
  const revision = actionRevision

  // 在异步清理偏好前锁定按钮，避免重复打开下载或启动安装器。
  if (type === 'app') updating.value = true
  await clearUpdatePrefs()
  if (cancellationTask) await cancellationTask
  if (revision !== actionRevision) return

  if (type === 'app') {
    updating.value = true
    operationId.value = ''
    progress.value = 0
    updateError.value = ''
    try {
      updateStore.setUpdateInfo({
        hasUpdate: true,
        isMandatory: data.force || false,
        versionInfo: {
          version: data.version,
          changelog: data.changelog,
          fileSize: data.fileSize || 0,
          downloadUrl: data.downloadUrl || data.url || '',
          checksum: data.checksum || ''
        }
      })
      const result = await downloadAndInstall()
      if (cancellationTask) await cancellationTask
      if (revision !== actionRevision) return
      if (result?.operationId) operationId.value = result.operationId
      progress.value = 100
      updating.value = false
      visible.value = false
      pendingType = null
      pendingData = null
      window.__ztoolsToast?.('success', t('modals.update.readyToRestart'))
    } catch (err) {
      if (cancellationTask) await cancellationTask
      if (revision !== actionRevision) return
      updating.value = false
      updateError.value = err.message || t('common.unknownError')
      console.error('App 更新失败:', err)
      const cancelled = err.code === 'CANCELLED'
      window.__ztoolsToast?.(
        cancelled ? 'warning' : 'error',
        cancelled ? t('modals.update.updateCancelled') : t('modals.update.updateFailed', { reason: err.message || t('common.unknownError') })
      )
    }
  } else {
    try {
      const started = await silentWebUpdate(data)
      if (!started) window.__ztoolsToast?.('error', t('modals.update.webIncomplete'))
    } catch (err) {
      console.error('Web 更新失败:', err)
      window.__ztoolsToast?.('error', t('modals.update.webFailed', { reason: err.message || t('common.unknownError') }))
    }
  }
}

onMounted(() => {
  const events = window.ztools?.events
  if (!events) return
  Promise.resolve(events.subscribe?.('update_download_progress')).catch(error => {
    console.warn('[update] 订阅下载进度失败:', error)
  })
  events.on?.('update_download_progress', handleUpdateProgress)
})

onBeforeUnmount(() => {
  window.ztools?.events?.off?.('update_download_progress', handleUpdateProgress)
})

defineExpose({ show, dismiss })
</script>

<style scoped>
.update-heading-icon {
  color: var(--rc-accent);
}

/* 正文独立滚动，标题与操作栏始终可见。 */
.update-body {
  max-height: min(360px, calc(100dvh - 220px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding-inline-end: 16px;
  font-size: var(--rc-fs-body);
  line-height: 1.7;
  color: var(--rc-text-secondary);
  overflow-wrap: anywhere;
}

.update-changelog :deep(> * + *) {
  margin-top: 14px;
}

.update-changelog :deep(h1),
.update-changelog :deep(h2),
.update-changelog :deep(h3) {
  margin-bottom: 10px;
  padding: 0;
  border: 0;
  font-size: var(--rc-fs-body);
  line-height: 1.5;
  font-weight: 600;
}

.update-changelog :deep(.space-y-1 > * + *) {
  margin-top: 8px;
}

.update-empty {
  margin: 0;
}

.update-install-hint {
  margin: 20px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--rc-border-subtle);
  color: var(--rc-text-muted);
  font-size: var(--rc-fs-body);
  line-height: 1.7;
}

.update-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 20px;
}

.update-progress-row {
  display: flex;
  justify-content: space-between;
}

.update-progress-row strong {
  color: var(--rc-text-primary);
  font-variant-numeric: tabular-nums;
}

.update-progress-track {
  height: 4px;
  overflow: hidden;
  border-radius: var(--rc-radius-full);
  background: var(--rc-border);
}

.update-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--rc-accent);
  transition: width var(--rc-dur-fast) var(--rc-ease-out);
}

.update-error {
  margin: 14px 0 0;
  color: var(--rc-error);
}

.update-actions {
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.update-primary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.update-btn-primary,
.update-btn-ghost {
  flex-shrink: 0;
  white-space: nowrap;
}

.update-skip {
  min-height: 36px;
  padding: 0;
  border: none;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  color: var(--rc-text-muted);
  font-size: var(--rc-fs-small);
  cursor: pointer;
  white-space: nowrap;
}

.update-skip:hover {
  color: var(--rc-text-primary);
}

.update-skip:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}
</style>
