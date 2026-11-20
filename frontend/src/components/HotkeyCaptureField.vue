<script setup>
import { XIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  formatHotkeyForPlatform,
  isDoubleModifierHotkey,
  isSafeShortcutKeysCombo,
  notifyHotkeyRecorderActive
} from '@/utils/hotkeyRecorder'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()

/**
 * 快捷键录入框（启动快捷键、插件功能快捷键、全局唤醒共用）：显示已绑定的组合键，点击或键盘触发进入录入，
 * 录入时聚焦隐藏输入框接收按键，退出录入时主动失焦并将焦点归还外层触发容器，防止二次 Esc 被黑洞吞没。
 */
const props = defineProps({
  hotkey: { type: String, default: '' },
  recording: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  platform: { type: String, default: 'unknown' },
  // 未传时兼容旧调用方对双击修饰键的默认显示；显式传入 false 时以纯文本提示不支持
  supportsDoubleModifier: { type: Boolean, default: undefined },
  // 录入中的显示：isKeys 为 true 时是已按下的组合键（键帽），否则是提示语
  recordingText: { type: String, default: '' },
  recordingIsKeys: { type: Boolean, default: false },
  waitText: { type: String, default: '' },
  emptyText: { type: String, default: '' }
})
const emit = defineEmits(['start', 'cancel', 'keydown', 'clear'])
const recorder = ref(null)
const input = ref(null)
let notifiedActive = false

// 仅在确认是规范组合键（绝不含中文说明文字）时传给 <ShortcutKeys>
const canRenderHotkeyKeys = computed(() => {
  if (!props.hotkey) return false
  const allowDouble =
    props.supportsDoubleModifier === undefined
      ? true
      : Boolean(props.supportsDoubleModifier)
  if (isDoubleModifierHotkey(props.hotkey) && !allowDouble) {
    return false
  }
  return isSafeShortcutKeysCombo(
    props.hotkey,
    props.platform === 'unknown' ? 'windows' : props.platform,
    allowDouble
  )
})

const fallbackHotkeyText = computed(() => {
  if (!props.hotkey || canRenderHotkeyKeys.value) return ''
  if (isDoubleModifierHotkey(props.hotkey)) {
    return formatHotkeyForPlatform(
      props.hotkey,
      props.platform,
      Boolean(props.supportsDoubleModifier)
    )
  }
  return props.hotkey
})

const canRenderRecordingKeys = computed(
  () =>
    Boolean(props.recordingText) &&
    props.recordingIsKeys &&
    isSafeShortcutKeysCombo(
      pendingKeys(props.recordingText),
      props.platform === 'unknown' ? 'windows' : props.platform,
      props.supportsDoubleModifier !== false
    )
)

// 检查页面中是否存在除当前实例外的其他激活快捷键录入框，避免多输入框切换时后置释放冲掉新激活态
const hasOtherActiveRecorder = () => {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return false
  }
  const activeNodes = document.querySelectorAll('.hotkey-recorder.recording:not(.loading)')
  for (const node of activeNodes) {
    if (node !== recorder.value) return true
  }
  return false
}

const releaseRecorderActive = (deferCheck = true) => {
  if (!notifiedActive) return
  notifiedActive = false
  if (!deferCheck) {
    if (!hasOtherActiveRecorder()) notifyHotkeyRecorderActive(false)
    return
  }
  void nextTick(() => {
    if (!props.recording && !hasOtherActiveRecorder()) {
      notifyHotkeyRecorderActive(false)
    }
  })
}

/** 主动让隐藏输入框失焦，避免按 Esc 退出录制后焦点滞留在不可达输入框导致二次 Esc 失效 */
const blurInput = ({ restoreFocus = false } = {}) => {
  const inputEl = input.value
  const wasInputFocused =
    typeof document !== 'undefined' && Boolean(inputEl) && document.activeElement === inputEl
  inputEl?.blur?.()
  if (restoreFocus && wasInputFocused && !props.disabled && !props.loading) {
    recorder.value?.focus?.()
  }
}

const focusTrigger = () => {
  if (!props.disabled && !props.loading) {
    recorder.value?.focus?.()
  }
}

// 进入录入时聚焦隐藏输入框；退出录入时主动失焦并归还焦点给触发容器
watch(
  () => props.recording,
  async (recording, prevRecording) => {
    if (!recording) {
      releaseRecorderActive(true)
      if (prevRecording) {
        blurInput({ restoreFocus: true })
      } else {
        blurInput({ restoreFocus: false })
      }
      return
    }
    if (!notifiedActive) {
      notifiedActive = true
      notifyHotkeyRecorderActive(true)
    }
    await nextTick()
    input.value?.focus()
  },
  { immediate: true }
)

const onClick = () => {
  if (props.disabled || props.loading || props.recording) return
  emit('start')
}

const onKeydown = (event) => {
  // 非录制态绝不截留按键事件，让 Esc 等按键正常冒泡关闭弹窗或回退
  if (!props.recording) return
  event.preventDefault()
  event.stopPropagation()
  emit('keydown', event)
}

const onBlur = () => {
  if (!props.recording) return
  emit('cancel')
  releaseRecorderActive(true)
}

// 已按下的修饰键以 "...+" 结尾，键帽只显示真正按下的键，末尾补一个省略号表示还在等待主键
onBeforeUnmount(() => {
  blurInput({ restoreFocus: false })
  releaseRecorderActive(false)
})
const pendingKeys = (text) => text.replace(/\.\.\.$/, '').replace(/\+$/, '')

defineExpose({ blurInput, focusTrigger })
</script>

<template>
  <div class="hotkey-field">
    <div
      ref="recorder"
      class="hotkey-recorder"
      :class="{ recording, loading, disabled }"
      role="button"
      :tabindex="disabled || loading || recording ? -1 : 0"
      :aria-disabled="disabled || undefined"
      :aria-label="hotkey ? t('hotkeyCapture.ariaCurrent', { hotkey }) : t('hotkeyCapture.ariaEmpty')"
      @click="onClick"
      @keydown.enter.self.prevent="onClick"
      @keydown.space.self.prevent="onClick"
    >
      <input
        ref="input"
        class="hotkey-hidden-input"
        readonly
        inputmode="none"
        autocomplete="off"
        spellcheck="false"
        :tabindex="recording ? 0 : -1"
        :style="{ pointerEvents: recording ? 'auto' : 'none' }"
        :aria-label="hotkey ? t('hotkeyCapture.inputAriaCurrent', { hotkey }) : t('hotkeyCapture.inputAriaEmpty')"
        @keydown="onKeydown"
        @blur="onBlur"
      />
      <template v-if="recording">
        <span v-if="loading" class="recording-text">{{ t('common.saving') }}</span>
        <span v-else-if="canRenderRecordingKeys" class="recording-keys">
          <ShortcutKeys :combo="pendingKeys(recordingText)" />
          <span v-if="recordingText.endsWith('...')" class="recording-more" aria-hidden="true">…</span>
        </span>
        <span v-else class="recording-text">
          <span class="recording-dot" aria-hidden="true"></span>
          {{ recordingText || waitText || t('hotkeyCapture.waitText') }}
        </span>
      </template>
      <ShortcutKeys v-else-if="canRenderHotkeyKeys" class="hotkey-keys" :combo="hotkey" />
      <span v-else-if="fallbackHotkeyText" class="unsupported-hotkey">{{ fallbackHotkeyText }}</span>
      <span v-else class="no-hotkey">{{ emptyText || t('hotkeyCapture.emptyText') }}</span>
    </div>

    <button
      v-if="hotkey && !recording"
      type="button"
      class="clear-btn"
      :title="t('hotkeyCapture.clearTitle')"
      :aria-label="t('hotkeyCapture.clearTitle')"
      @click.stop="emit('clear')"
    >
      <XIcon aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.hotkey-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hotkey-recorder {
  position: relative;
  min-width: 120px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface);
  cursor: pointer;
  transition: border-color var(--rc-dur) ease, background-color var(--rc-dur) ease;
}

.hotkey-recorder:hover {
  border-color: var(--rc-border-highlight);
}

.hotkey-recorder:focus-visible {
  outline: none;
  border-color: var(--rc-accent);
  box-shadow: var(--rc-focus-ring);
}

.hotkey-recorder.recording {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
  box-shadow: var(--rc-focus-ring);
}

.hotkey-recorder.loading {
  opacity: 0.6;
  pointer-events: none;
}

.hotkey-recorder.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.hotkey-hidden-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.recording-text {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--rc-accent-text);
  font-size: var(--rc-fs-small);
  font-weight: 500;
}

.recording-keys {
  display: flex;
  align-items: center;
  gap: 3px;
}

.recording-more {
  color: var(--rc-accent-text);
}

.recording-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: hotkey-recording-pulse 1s infinite;
}

@keyframes hotkey-recording-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.no-hotkey,
.unsupported-hotkey {
  color: var(--rc-text-muted);
  font-size: var(--rc-fs-small);
}

.clear-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--rc-radius-md);
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: background-color var(--rc-dur) ease, color var(--rc-dur) ease;
}

.clear-btn:hover {
  background: var(--rc-error-subtle);
  color: var(--rc-error);
}
</style>
