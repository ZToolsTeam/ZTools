<template>
  <div
    class="relative inline-flex items-center"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- 极客模式切换胶囊按钮 -->
    <button
      ref="triggerBtnRef"
      class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer border shadow-sm group select-none"
      :class="[
        isDark
          ? 'bg-gradient-to-r from-sky-500/10 to-indigo-500/10 hover:from-sky-500/20 hover:to-indigo-500/20 border-sky-400/25 text-sky-300 hover:text-white hover:border-sky-400/50'
          : 'bg-gradient-to-r from-sky-50 to-indigo-50 hover:from-sky-100 hover:to-indigo-100 border-sky-200 text-sky-700 hover:text-sky-900 hover:border-sky-300'
      ]"
      title="切换为极客悬浮条模式 (Alt+Space)"
      @click="triggerGeekMode"
    >
      <span class="text-amber-400 group-hover:scale-110 transition-transform">⚡</span>
      <span>极客条模式</span>
      <kbd
        class="hidden sm:inline-flex px-1 py-0.2 rounded text-[10px] font-mono transition-opacity"
        :class="[isDark ? 'bg-white/10 text-slate-300' : 'bg-white text-slate-600 border border-slate-200']"
      >
        Alt+Space
      </kbd>
    </button>

    <!-- 悬停引导浮层 (Hover Popover Guide) -->
    <transition name="popover-fade">
      <div
        v-if="showGuidePopover"
        class="absolute right-0 top-full pt-2 w-72 z-50 text-xs select-none"
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
      >
        <!-- 隐形透明交互安全桥 (Hit-test safe bridge)，消除缝隙导致事件中断 -->
        <div class="absolute -top-2.5 left-0 right-0 h-3 bg-transparent pointer-events-auto"></div>

        <!-- 卡片主体容器 -->
        <div
          class="rounded-xl p-3.5 shadow-2xl border backdrop-blur-xl"
          :class="[
            isDark
              ? 'bg-slate-900/95 border-white/15 text-slate-200 shadow-black/70'
              : 'bg-white/95 border-slate-200 text-slate-700 shadow-slate-900/15'
          ]"
        >
        <!-- 卡片头部 -->
        <div class="flex items-center justify-between pb-2 border-b" :class="[isDark ? 'border-white/10' : 'border-slate-100']">
          <div class="flex items-center gap-1.5 font-semibold" :class="[isDark ? 'text-white' : 'text-slate-900']">
            <span class="text-amber-400">⚡</span>
            <span>极客悬浮工具条</span>
          </div>
          <span class="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/10 text-sky-400 font-mono">极简悬浮模式</span>
        </div>

        <!-- 示意微动图效果 -->
        <div class="my-2.5 p-2 rounded-lg border flex flex-col items-center justify-center gap-1.5"
             :class="[isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200']">
          <!-- 微型浮动条预览 -->
          <div class="w-full h-6 rounded-md border flex items-center px-2 gap-1.5 shadow-inner"
               :class="[isDark ? 'bg-slate-800 border-sky-400/30 text-sky-300' : 'bg-white border-sky-300 text-sky-600']">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span class="font-mono text-[10px]">搜索工具...</span>
            <span class="w-1 h-3 bg-sky-400 animate-pulse ml-auto"></span>
          </div>
          <span class="text-[10px] text-slate-400">居中悬浮 · 全键盘盲打 · 秒开即走</span>
        </div>

        <!-- 文案说明 -->
        <p class="leading-relaxed mb-3" :class="[isDark ? 'text-slate-300' : 'text-slate-600']">
          收起大界面，切换为屏幕居中的极简快捷条。在桌面任何地方按下 <kbd class="px-1 py-0.5 rounded font-mono font-bold bg-sky-500/15 text-sky-400">Alt+Space</kbd> 随时唤醒！
        </p>

        <!-- 底部操作按钮 -->
        <div class="flex items-center justify-between pt-1">
          <span class="text-[11px] text-slate-400">随时可按 Ctrl+M 展开回大窗口</span>
          <button
            class="px-2.5 py-1 rounded-md bg-sky-500 hover:bg-sky-600 text-white font-medium text-xs transition-colors cursor-pointer shadow-sm flex items-center gap-1"
            @click="triggerGeekMode"
          >
            <span>立即试用</span>
            <span>➔</span>
          </button>
        </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { useThemeStore } from '@/stores/theme'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'

const themeStore = useThemeStore()
const isDark = computed(() => themeStore.isDark)

const triggerBtnRef = ref(null)
const showGuidePopover = ref(false)

let enterTimer = null
let leaveTimer = null

function clearTimers() {
  if (enterTimer) {
    clearTimeout(enterTimer)
    enterTimer = null
  }
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
}

function handleMouseEnter() {
  // 取消可能正在倒计时的关闭定时器，确保鼠标移入卡片时浮层持续稳定显示
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  // 已显示时无需重复触发延时
  if (showGuidePopover.value) return

  // 移入延时 150ms，避免无意识快速划过时出现闪烁
  if (!enterTimer) {
    enterTimer = setTimeout(() => {
      showGuidePopover.value = true
      enterTimer = null
    }, 150)
  }
}

function handleMouseLeave() {
  // 取消未触发的打开定时器
  if (enterTimer) {
    clearTimeout(enterTimer)
    enterTimer = null
  }
  // 离开缓冲延时 250ms，提供平滑过桥时间，防止用户鼠标移向“立即试用”按钮时浮层消失
  if (!leaveTimer) {
    leaveTimer = setTimeout(() => {
      showGuidePopover.value = false
      leaveTimer = null
    }, 250)
  }
}

function triggerGeekMode() {
  clearTimers()
  showGuidePopover.value = false
  switchWindowMode(WINDOW_MODES.LAUNCHER)
}

onBeforeUnmount(() => {
  clearTimers()
})
</script>

<style scoped>
.popover-fade-enter-active,
.popover-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.popover-fade-enter-from,
.popover-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
