<script setup>
import { XIcon } from '@lucide/vue'
import { Modal } from 'ant-design-vue'
import { useId } from 'vue'

/**
 * 统一对话框。两种版式：
 * - default：左对齐标题 + 一行说明，用于设置、确认、表单类对话框；
 * - hero：居中图标块 + 大标题，顶部一层很淡的品牌色光晕，用于登录、扫码入群这类「一个焦点」的对话框。
 * 底层仍是 antd Modal（焦点约束、Esc、多层叠放沿用其行为），外观全部由主题变量决定。
 */
const open = defineModel('open', { type: Boolean, default: false })
defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  variant: { type: String, default: 'default', validator: (v) => ['default', 'hero'].includes(v) },
  width: { type: [Number, String], default: 400 },
  closable: { type: Boolean, default: true },
  maskClosable: { type: Boolean, default: true },
  keyboard: { type: Boolean, default: true },
  mask: { type: Boolean, default: true },
  destroyOnClose: { type: Boolean, default: false },
  wrapClassName: { type: String, default: '' }
})
const emit = defineEmits(['cancel'])
const titleId = useId()

// 关闭按钮与 Esc / 点遮罩走同一条路径：先通知调用方，再关闭
const close = (event) => {
  emit('cancel', event)
  open.value = false
}
</script>

<template>
  <Modal
    v-model:open="open"
    :width="width"
    :footer="null"
    :closable="false"
    :mask="mask"
    :mask-closable="maskClosable"
    :keyboard="keyboard"
    :destroy-on-close="destroyOnClose"
    :wrap-class-name="['rc-dialog-wrap', wrapClassName].filter(Boolean).join(' ')"
    centered
    @cancel="emit('cancel', $event)"
  >
    <div
      class="rc-dialog"
      :class="`is-${variant}`"
      role="document"
      :aria-labelledby="title ? titleId : undefined"
    >
      <button v-if="closable" type="button" class="rc-dialog-close" aria-label="关闭" @click="close">
        <XIcon aria-hidden="true" />
      </button>
      <header v-if="title || $slots.icon" class="rc-dialog-header">
        <div v-if="$slots.icon" class="rc-dialog-icon">
          <slot name="icon" />
        </div>
        <div class="rc-dialog-heading">
          <h2 v-if="title" :id="titleId" class="rc-dialog-title">{{ title }}</h2>
          <p v-if="description" class="rc-dialog-description">{{ description }}</p>
        </div>
      </header>
      <div class="rc-dialog-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="rc-dialog-footer">
        <slot name="footer" />
      </footer>
    </div>
  </Modal>
</template>

<style scoped>
.rc-dialog {
  position: relative;
}

/* ---------- 通用：关闭按钮 ---------- */
.rc-dialog-close {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--rc-radius-md);
  background: transparent;
  color: var(--rc-text-muted);
  font-size: 16px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.rc-dialog-close:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.rc-dialog-close:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.rc-dialog-title {
  margin: 0;
  color: var(--rc-text-primary);
  font-weight: 600;
}

.rc-dialog-description {
  margin: 0;
  color: var(--rc-text-muted);
}

/* ---------- default：左对齐 ---------- */
.is-default .rc-dialog-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 18px 52px 0 20px;
}

.is-default .rc-dialog-icon {
  display: inline-flex;
  font-size: 18px;
  color: var(--rc-text-secondary);
  margin-top: 2px;
}

.is-default .rc-dialog-title {
  font-size: 15px;
  line-height: 22px;
}

.is-default .rc-dialog-description {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 18px;
}

.is-default .rc-dialog-body {
  padding: 16px 20px 20px;
}

/* ---------- hero：居中、带光晕 ---------- */
.is-hero::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 200px;
  background:
    radial-gradient(60% 90% at 50% 0%, var(--rc-accent-subtle) 0%, transparent 100%);
  pointer-events: none;
}

.is-hero .rc-dialog-header {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 32px 0;
  text-align: center;
}

.is-hero .rc-dialog-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  margin-bottom: 16px;
  border: 1px solid var(--rc-border);
  border-radius: 15px;
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: var(--rc-text-primary);
  font-size: 24px;
}

.is-hero .rc-dialog-title {
  font-size: 18px;
  line-height: 26px;
  letter-spacing: -0.01em;
}

.is-hero .rc-dialog-description {
  margin-top: 6px;
  font-size: 13px;
  line-height: 20px;
}

.is-hero .rc-dialog-body {
  position: relative;
  padding: 24px 32px 28px;
}

/* ---------- 底部操作区 ---------- */
.rc-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--rc-border-subtle);
  background: var(--rc-surface-subtle);
}

/* antd 外壳：去掉自带内边距与底色，交给上面的结构 */
:global(.rc-dialog-wrap .ant-modal-content) {
  padding: 0 !important;
  overflow: hidden;
  border: 1px solid var(--rc-border);
  border-radius: 18px !important;
  background-color: var(--rc-surface) !important;
  box-shadow: var(--rc-shadow-lg), inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
}

:global(.rc-dialog-wrap .ant-modal-body) {
  padding: 0 !important;
}
</style>
