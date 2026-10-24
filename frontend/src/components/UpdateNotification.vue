<template>
  <Transition name="update-slide">
    <div v-if="visible" class="update-notification">
      <!-- 顶部：图标 + 标题 + 版本标签 + 关闭 -->
      <div class="update-header">
        <div class="update-icon">
          <i class="fa fa-arrow-circle-up"></i>
        </div>
        <span class="update-title">发现新版本</span>
        <span class="update-tag">{{
          updateType === 'app' ? 'App' : 'Web'
        }}</span>
        <span class="update-ver">v{{ version }}</span>
        <button
          v-if="!force"
          class="update-close"
          @click="dismiss"
          aria-label="关闭"
        >
          <i class="fa fa-times"></i>
        </button>
      </div>

      <!-- 更新日志 -->
      <div v-if="changelog" class="update-changelog" v-html="formattedChangelog"></div>
      <div v-else class="update-changelog update-changelog--empty">
        新版本已就绪，建议立即更新
      </div>

      <p v-if="manualUpdate" class="update-changelog">
        下载完成后，退出 ZTools，打开 DMG，将应用拖入“应用程序”替换旧版。
      </p>

      <div v-if="updating && !manualUpdate" class="update-progress" aria-live="polite">
        <div class="update-progress-row">
          <span>正在下载更新</span>
          <strong>{{ progress }}%</strong>
        </div>
        <div class="update-progress-track">
          <div class="update-progress-value" :style="{ width: `${progress}%` }"></div>
        </div>
      </div>

      <div v-if="updateError" class="update-error">{{ updateError }}</div>

      <!-- 操作按钮 -->
      <div v-if="!updating || manualUpdate" class="update-actions">
        <template v-if="!force && !updating">
          <button class="update-btn-text" @click="skipVersion">
            此版本不再提醒
          </button>
          <button class="update-btn-ghost" @click="remindLater">
            稍后提醒
          </button>
        </template>
        <button class="update-btn-primary" :disabled="updating" @click="doUpdate">{{ manualUpdate ? '下载 macOS 安装包' : '立即更新' }}</button>
      </div>
      <div v-else class="update-actions">
        <button class="update-btn-ghost" @click="cancelInProgress">取消更新</button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useUpdateStore } from '@/stores/update'
import { useAppUpdate } from '@/composables/useAppUpdate'

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
const manualUpdate = ref(false)

/** 将 changelog 中的 \n 转换为 <br> 标签，并转义 HTML 特殊字符 */
const formattedChangelog = computed(() => {
  if (!changelog.value) return ''
  return changelog.value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\n/g, '<br>')
    .replace(/\n/g, '<br>')
})

const updateStore = useUpdateStore()
const { downloadAndInstall, openManualUpdate, silentWebUpdate, cancelUpdate } = useAppUpdate()

let pendingType = null
let pendingData = null
let actionRevision = 0

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
  if (!(await shouldShowNotification(ver, isForce))) return

  updateType.value = type
  actionRevision += 1
  manualUpdate.value = type === 'app' && data.manualUpdate === true
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
  actionRevision += 1
  cancelUpdate()
  updating.value = false
  updateError.value = '更新已取消'
  visible.value = false
  pendingType = null
  pendingData = null
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
  if (revision !== actionRevision) return

  if (type === 'app' && data.manualUpdate === true) {
    updating.value = true
    updateError.value = ''
    try {
      await openManualUpdate(data)
      updating.value = false
      dismiss()
      window.__ztoolsToast?.('info', '已打开 macOS 安装包下载，请完成手动替换')
    } catch (error) {
      updateError.value = error.message || '无法打开安装包下载'
    } finally {
      updating.value = false
    }
    return
  }

  if (type === 'app') {
    updating.value = true
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
      if (result?.operationId) operationId.value = result.operationId
      progress.value = 100
      updating.value = false
      visible.value = false
      pendingType = null
      pendingData = null
      window.__ztoolsToast?.('success', '安装器已启动，应用即将重启')
    } catch (err) {
      updating.value = false
      updateError.value = err.message || '未知错误'
      console.error('App 更新失败:', err)
      const cancelled = err.code === 'CANCELLED'
      window.__ztoolsToast?.(
        cancelled ? 'warning' : 'error',
        cancelled ? '已取消 UAC 授权，更新未安装' : '更新失败: ' + (err.message || '未知错误')
      )
    }
  } else {
    try {
      const started = await silentWebUpdate(data)
      if (!started) window.__ztoolsToast?.('error', 'Web 资源更新未完成')
    } catch (err) {
      console.error('Web 更新失败:', err)
      window.__ztoolsToast?.('error', 'Web 更新失败: ' + (err.message || '未知错误'))
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
.update-notification {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 9999;
  width: 340px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 顶部行：图标 标题 标签 版本号 关闭 */
.update-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.update-icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--gradient-blue-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  font-size: 14px;
  flex-shrink: 0;
}

.update-title {
  font-size: var(--font-size-body-m);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  white-space: nowrap;
}

.update-tag {
  padding: 0 6px;
  height: 18px;
  line-height: 18px;
  border-radius: 9px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  background: var(--rc-accent);
  color: var(--rc-accent-contrast);
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.update-ver {
  font-size: var(--font-size-body-s);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.update-close {
  margin-left: auto;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--color-text-disabled);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--duration-fast) var(--easing-smooth);
  font-size: 11px;
  flex-shrink: 0;
}

.update-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

/* 更新日志 */
.update-changelog {
  font-size: var(--font-size-body-s);
  color: var(--color-text-secondary);
  line-height: 1.6;
  max-height: 200px;
  overflow-y: auto;
}

.update-changelog--empty {
  color: var(--color-text-disabled);
  font-style: italic;
}

.update-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.update-progress-row {
  display: flex;
  justify-content: space-between;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body-s);
}

.update-progress-row strong {
  color: var(--color-primary);
}

.update-progress-track {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--color-border);
}

.update-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 120ms ease-out;
}

.update-error {
  color: var(--rc-error);
  font-size: var(--font-size-body-s);
  line-height: 1.4;
}

/* 按钮行 */
.update-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.update-btn-primary {
  height: 32px;
  padding: 0 20px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--rc-accent);
  color: var(--rc-accent-contrast);
  font-size: var(--font-size-body-s);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all var(--duration-fast) var(--easing-smooth);
}

.update-btn-primary:hover {
  background: var(--rc-accent-hover);
}

.update-btn-primary:active {
  transform: scale(0.97);
}

.update-btn-ghost {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-body-s);
  cursor: pointer;
  transition: all var(--duration-fast) var(--easing-smooth);
}

.update-btn-ghost:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: rgba(var(--color-primary-rgb), 0.04);
}

/* 文本按钮（此版本不再提醒） */
.update-btn-text {
  height: 32px;
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--color-text-disabled);
  font-size: var(--font-size-body-xs, 11px);
  cursor: pointer;
  transition: all var(--duration-fast) var(--easing-smooth);
  white-space: nowrap;
}

.update-btn-text:hover {
  color: var(--color-text-secondary);
}

/* 动画 */
.update-slide-enter-active {
  animation: slideUp 0.35s var(--easing-ease-out);
}

.update-slide-leave-active {
  animation: slideDown 0.25s var(--easing-smooth);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}

@keyframes slideDown {
  from {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.9);
  }
}
</style>
