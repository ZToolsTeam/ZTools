<template>
  <div class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
    <transition-group name="toast-fade">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="declarative-mica-shell flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl pointer-events-auto border border-white/10 text-sm max-w-sm"
      >
        <!-- 状态图标 -->
        <span class="flex-shrink-0">
          <svg
            v-if="toast.style === 'SUCCESS'"
            class="w-5 h-5 text-emerald-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <svg
            v-else-if="toast.style === 'FAILURE'"
            class="w-5 h-5 text-rose-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <svg
            v-else
            class="w-5 h-5 text-sky-400 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        </span>

        <!-- 文本 -->
        <div class="flex-1 min-w-0">
          <div class="font-medium text-slate-100 truncate">{{ toast.title }}</div>
          <div v-if="toast.message" class="text-xs text-slate-400 mt-0.5 break-words">
            {{ toast.message }}
          </div>
        </div>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
defineProps({
  toasts: {
    type: Array,
    default: () => []
  }
});
</script>

<style scoped>
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
