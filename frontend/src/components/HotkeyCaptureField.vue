<script setup>
import { XIcon } from '@lucide/vue'
import { nextTick, ref, watch } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'

/**
 * 快捷键录入框（启动快捷键、插件功能快捷键弹窗共用）：显示已绑定的组合键，点击进入录入，
 * 录入时聚焦隐藏输入框接收按键，右侧清除按钮。按键如何解析、保存与冲突检测由调用方处理（监听 keydown）。
 */
const props = defineProps({
  hotkey: { type: String, default: '' },
  recording: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  // 录入中的显示：isKeys 为 true 时是已按下的组合键（键帽），否则是提示语
  recordingText: { type: String, default: '' },
  recordingIsKeys: { type: Boolean, default: false },
  waitText: { type: String, default: '按下快捷键' },
  emptyText: { type: String, default: '未设置' }
})
const emit = defineEmits(['start', 'cancel', 'keydown', 'clear'])
const input = ref(null)

// 进入录入时聚焦隐藏输入框，按键才会进到这里
watch(
  () => props.recording,
  async (recording) => {
    if (!recording) return
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
  event.preventDefault()
  event.stopPropagation()
  if (props.recording) emit('keydown', event)
}

const onBlur = () => {
  if (props.recording) emit('cancel')
}

// 已按下的修饰键以 "...+" 结尾，键帽只显示真正按下的键，末尾补一个省略号表示还在等待主键
const pendingKeys = (text) => text.replace(/\.\.\.$/, '').replace(/\+$/, '')
</script>

<template>
  <div class="hotkey-field">
    <div
      class="hotkey-recorder"
      :class="{ recording, loading, disabled }"
      :aria-disabled="disabled || undefined"
      @click="onClick"
    >
      <input
        ref="input"
        class="hotkey-hidden-input"
        readonly
        :tabindex="recording ? 0 : -1"
        :aria-label="hotkey ? `当前快捷键 ${hotkey}，点击重新录入` : '点击录入快捷键'"
        @keydown="onKeydown"
        @blur="onBlur"
      />
      <template v-if="recording">
        <span v-if="loading" class="recording-text">保存中…</span>
        <span v-else-if="recordingText && recordingIsKeys" class="recording-keys">
          <ShortcutKeys :combo="pendingKeys(recordingText)" />
          <span v-if="recordingText.endsWith('...')" class="recording-more" aria-hidden="true">…</span>
        </span>
        <span v-else class="recording-text">
          <span class="recording-dot" aria-hidden="true"></span>
          {{ recordingText || waitText }}
        </span>
      </template>
      <ShortcutKeys v-else-if="hotkey" class="hotkey-keys" :combo="hotkey" />
      <span v-else class="no-hotkey">{{ emptyText }}</span>
    </div>

    <button
      v-if="hotkey && !recording"
      type="button"
      class="clear-btn"
      title="清除快捷键"
      aria-label="清除快捷键"
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
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.hotkey-recorder:hover {
  border-color: var(--rc-border-highlight);
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
  font-size: 12px;
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

.no-hotkey {
  color: var(--rc-text-muted);
  font-size: 12px;
}

.clear-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.clear-btn:hover {
  background: var(--rc-error-subtle);
  color: var(--rc-error);
}
</style>
