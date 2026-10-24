<script setup>
import { ref, watch, computed } from 'vue'

import { useUIStore } from '@/stores/ui'

const ui = useUIStore()
// 默认勾选"下次不再询问"，让用户选择后不再打扰
const doNotAskAgain = ref(true)
const dialogVisible = computed({
  get: () => ui.showCloseConfirm,
  set: (val) => {
    if (!val) ui.closeCloseConfirm()
  }
})

watch(dialogVisible, (v) => {
  // 弹窗关闭后重置为默认选中状态，下次打开仍保持默认勾选
  if (!v) doNotAskAgain.value = true
})

const onMinimize = async () => {
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
  if (window?.ztools?.win?.sendCloseConfirmResult) {
    await window.ztools.win.sendCloseConfirmResult({
      confirmed: false,
      doNotAskAgain: false,
      action: 'cancel'
    })
  }
  ui.closeCloseConfirm()
}
const onExit = async () => {
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
  <a-modal
    v-model:open="dialogVisible"
    title="确定要退出 ZTools 吗？"
    width="420px"
    :mask="false"
    :mask-closable="false"
    :keyboard="false"
    :closable="true"
    wrap-class-name="close-confirm-modal"
    @cancel="onCancel"
  >
    <a-checkbox v-model:checked="doNotAskAgain">下次不再询问</a-checkbox>
    <template #footer>
      <div class="close-confirm-footer">
        <a-button danger @click="onExit">立即退出</a-button>
        <a-button type="primary" @click="onMinimize">最小化到托盘</a-button>
      </div>
    </template>
  </a-modal>
</template>

<style scoped>
.close-confirm-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  width: 100%;
}
</style>
