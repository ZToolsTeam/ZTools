<template>
  <div
    class="relative inline-flex items-center"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- 切到悬浮条：图标按钮 + 快捷键，与设计稿一致 -->
    <button
      ref="triggerBtnRef"
      type="button"
      class="launcher-trigger"
      :title="wakeLabel ? `切到悬浮条 ${wakeLabel}` : '切到悬浮条'"
      aria-label="切到悬浮条"
      @click="triggerGeekMode"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="9" width="18" height="6" rx="2" />
        <path d="M7 12h6" />
      </svg>
      <span class="launcher-trigger-text">悬浮条</span>
      <ShortcutKeys v-if="wakeHotkey" :combo="wakeHotkey" />
    </button>

    <!-- 悬停引导浮层 -->
    <transition name="popover-fade">
      <div
        v-if="showGuidePopover"
        class="absolute right-0 top-full pt-2 w-72 z-50 text-xs select-none"
        @mouseenter="handleMouseEnter"
        @mouseleave="handleMouseLeave"
      >
        <!-- 透明过桥区，避免鼠标移向浮层时经过缝隙导致关闭 -->
        <div class="absolute -top-2.5 left-0 right-0 h-3 bg-transparent pointer-events-auto"></div>

        <div class="guide-card">
          <div class="guide-head">
            <BrandMark :size="16" />
            <span>悬浮搜索条</span>
          </div>

          <!-- 微型悬浮条预览 -->
          <div class="guide-preview">
            <div class="guide-bar">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <span>搜索插件、命令与文件</span>
              <span class="guide-caret"></span>
            </div>
            <span class="guide-hint">屏幕居中 · 全键盘操作 · 用完即走</span>
          </div>

          <p class="guide-text">
            收起工作台，换成屏幕中央的悬浮搜索条。<template v-if="wakeHotkey">在任何地方按
            <ShortcutKeys :combo="wakeHotkey" /> 都能唤起。</template><template v-else>全局唤醒快捷键已关闭，可在设置中开启。</template>
          </p>

          <div class="guide-foot">
            <span>按 <ShortcutKeys combo="Ctrl+M" /> 回到工作台</span>
            <button type="button" class="guide-btn" @click="triggerGeekMode">立即试用</button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import BrandMark from './BrandMark.vue'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { shortcutLabel } from '@/utils/platform'
import { currentGlobalWakeHotkey, refreshCurrentGlobalWakeHotkey } from '@/utils/globalWakeHotkey'

// 显示用户实际设置的唤醒键，而不是写死的默认值
const wakeHotkey = currentGlobalWakeHotkey
const wakeLabel = computed(() => (wakeHotkey.value ? shortcutLabel(wakeHotkey.value) : ''))
onMounted(() => { refreshCurrentGlobalWakeHotkey() })

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
.launcher-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 6px 0 8px;
  border: 1px solid transparent;
  border-radius: var(--rc-radius-md);
  background: transparent;
  color: var(--rc-text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.launcher-trigger:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.launcher-trigger:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.guide-card {
  padding: 14px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  box-shadow: var(--rc-shadow-lg);
}

.guide-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rc-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-text-primary);
}

.guide-preview {
  margin: 10px 0;
  padding: 10px;
  border-radius: var(--rc-radius-md);
  background: var(--rc-canvas);
  border: 1px solid var(--rc-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.guide-bar {
  width: 100%;
  height: 26px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 7px;
  background: var(--rc-surface);
  border: 1px solid var(--rc-border-highlight);
  box-shadow: var(--rc-focus-ring);
  color: var(--rc-text-muted);
  font-size: 11px;
}

.guide-caret {
  width: 1.5px;
  height: 12px;
  margin-left: auto;
  background: var(--rc-accent);
  animation: guide-blink 1s steps(2, start) infinite;
}

.guide-hint {
  font-size: 11px;
  color: var(--rc-text-faint);
}

.guide-text {
  margin-bottom: 12px;
  line-height: 1.6;
}

.guide-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--rc-text-faint);
}

.guide-btn {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: var(--rc-accent);
  color: var(--rc-accent-contrast);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.guide-btn:hover {
  background: var(--rc-accent-hover);
}

@keyframes guide-blink {
  to {
    visibility: hidden;
  }
}

@media (prefers-reduced-motion: reduce) {
  .guide-caret {
    animation: none;
  }
}

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
