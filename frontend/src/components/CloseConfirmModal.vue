<script setup>
import { RcButton, RcDialog } from '@/components/base'
import { ref, watch, computed, onBeforeUnmount } from 'vue'
import { isComposingEvent } from '@/utils/keymap'

import { useUIStore } from '@/stores/ui'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
const ui = useUIStore()
// 默认勾选"下次不再询问"，让用户选择后不再打扰
const doNotAskAgain = ref(true)
let isResolving = false
const dialogVisible = computed({
  get: () => ui.showCloseConfirm,
  set: (val) => {
    if (!val) ui.closeCloseConfirm()
  }
})

watch(dialogVisible, (v) => {
  if (v) {
    isResolving = false
    window.addEventListener('keydown', handleWindowEscape, true)
    return
  }
  window.removeEventListener('keydown', handleWindowEscape, true)
  // 弹窗关闭后重置为默认选中状态，下次打开仍保持默认勾选
  doNotAskAgain.value = true
}, { immediate: true })

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowEscape, true)
})

function handleWindowEscape(event) {
  if (!dialogVisible.value || event.key !== 'Escape' || isComposingEvent(event)) return
  event.preventDefault()
  event.stopPropagation()
  void onCancel()
}

const onMinimize = async () => {
  if (isResolving) return
  isResolving = true
  try {
    // 如果勾选了"下次不再询问"，保存配置：关闭退出确认 + 开启最小化到托盘
    if (doNotAskAgain.value && window?.ztools?.settings?.set) {
      await window.ztools.settings.set('closeConfirm', false)
      await window.ztools.settings.set('minimizeToTray', true)
      // 通知设置页面刷新
      window.dispatchEvent(new CustomEvent('ztools-settings-changed'))
    }
    if (window?.ztools?.win?.sendCloseConfirmResult) {
      await window.ztools.win.sendCloseConfirmResult({
        confirmed: false,
        doNotAskAgain: !!doNotAskAgain.value,
        action: 'minimize'
      })
    }
  } finally {
    ui.closeCloseConfirm()
  }
}
const onCancel = async () => {
  if (isResolving) return
  isResolving = true
  try {
    if (window?.ztools?.win?.sendCloseConfirmResult) {
      await window.ztools.win.sendCloseConfirmResult({
        confirmed: false,
        doNotAskAgain: false,
        action: 'cancel'
      })
    }
  } finally {
    ui.closeCloseConfirm()
  }
}
const onExit = async () => {
  if (isResolving) return
  isResolving = true
  try {
    if (doNotAskAgain.value && window?.ztools?.settings?.set) {
      await window.ztools.settings.set('closeConfirm', false)
      await window.ztools.settings.set('minimizeToTray', false)
      // 通知设置页面刷新
      window.dispatchEvent(new CustomEvent('ztools-settings-changed'))
    }
    if (window?.ztools?.win?.sendCloseConfirmResult) {
      await window.ztools.win.sendCloseConfirmResult({
        confirmed: true,
        doNotAskAgain: !!doNotAskAgain.value,
        action: 'exit'
      })
    }
  } finally {
    ui.closeCloseConfirm()
  }
}
</script>

<template>
  <RcDialog
    v-model:open="dialogVisible"
    :title="t('modals.closeConfirm.title')"
    :width="420"
    :mask="false"
    :mask-closable="false"
    wrap-class-name="close-confirm-modal"
    @cancel="onCancel"
  >
    <a-checkbox v-model:checked="doNotAskAgain">{{ t('modals.closeConfirm.doNotAskAgain') }}</a-checkbox>
    <template #footer>
      <div class="close-confirm-footer">
        <RcButton variant="danger" size="md" @click="onExit">{{ t('modals.closeConfirm.exitNow') }}</RcButton>
        <RcButton variant="primary" size="md" @click="onMinimize">{{ t('modals.closeConfirm.minimizeToTray') }}</RcButton>
      </div>
    </template>
  </RcDialog>
</template>

<style scoped>
.close-confirm-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
</style>
