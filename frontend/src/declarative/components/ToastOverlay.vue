<template>
  <div
    class="decl-toast-host absolute right-4 z-50 flex flex-col gap-2 pointer-events-none"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <transition-group name="toast-fade">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="declarative-mica-shell flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl pointer-events-auto border border-[var(--rc-border)] text-sm max-w-sm"
      >
        <!-- 状态图标 -->
        <span class="flex-shrink-0">
          <CheckIcon v-if="toast.style === 'SUCCESS'" class="w-5 h-5 text-[var(--rc-success)]" aria-hidden="true" />
          <XIcon v-else-if="toast.style === 'FAILURE'" class="w-5 h-5 text-[var(--rc-error)]" aria-hidden="true" />
          <SpinnerIcon v-else class="w-5 h-5 text-[var(--rc-accent-text)]" aria-hidden="true" />
        </span>

        <!-- 文本 -->
        <div class="flex-1 min-w-0">
          <div class="font-medium text-[var(--rc-text-primary)] truncate">{{ toast.title }}</div>
          <div v-if="toast.message" class="text-xs text-[var(--rc-text-muted)] mt-0.5 break-words">
            {{ toast.message }}
          </div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
// 浮在底部操作栏上方（底栏约 40px 高），不遮挡主动作按钮；读屏软件礼貌播报
import { CheckIcon, XIcon } from '@lucide/vue'
import { SpinnerIcon } from '@/utils/appIcons'
defineProps({
  toasts: {
    type: Array,
    default: () => []
  }
});
</script>

<style scoped>
.decl-toast-host {
  bottom: 52px;
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.toast-fade-enter-from {
  opacity: 0;
  transform: translateY(12px) scale(0.95);
}
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.95);
}
</style>
