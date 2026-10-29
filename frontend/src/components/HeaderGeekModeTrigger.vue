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
      :title="`切到悬浮条 ${switchLabel}`"
      aria-label="切到悬浮条"
      @click="triggerGeekMode"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="9" width="18" height="6" rx="2" />
        <path d="M7 12h6" />
      </svg>
      <span class="launcher-trigger-text">悬浮条</span>
      <!-- 这里显示的是「切到悬浮条」本身的快捷键；全局唤醒键在悬停说明里介绍 -->
      <ShortcutKeys combo="Ctrl+M" />
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
            <div class="guide-head-text">
              <span class="guide-title">悬浮搜索条</span>
              <span class="guide-sub">收起工作台，只留屏幕中央一条搜索框</span>
            </div>
          </div>

          <!-- 微型悬浮条预览：光标在占位文字前，与真实输入框一致 -->
          <div class="guide-preview" aria-hidden="true">
            <div class="guide-bar">
              <SearchIcon class="guide-bar-icon" />
              <span class="guide-caret"></span>
              <span class="guide-placeholder">搜索插件、命令与文件</span>
            </div>
          </div>

          <dl class="guide-keys">
            <div class="guide-key-row">
              <dt>随处唤起</dt>
              <dd>
                <ShortcutKeys v-if="wakeHotkey" :combo="wakeHotkey" />
                <span v-else class="guide-key-off">未开启，可在设置中开启</span>
              </dd>
            </div>
            <div class="guide-key-row">
              <dt>回到工作台</dt>
              <dd><ShortcutKeys combo="Ctrl+M" /></dd>
            </div>
          </dl>

          <RcButton variant="primary" size="md" class="guide-btn" @click="triggerGeekMode">切到悬浮条</RcButton>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { SearchIcon } from '@lucide/vue'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { RcButton } from '@/components/base'
import BrandMark from './BrandMark.vue'
import { switchWindowMode, WINDOW_MODES } from '@/utils/windowMode'
import { shortcutLabel } from '@/utils/platform'
import { currentGlobalWakeHotkey, refreshCurrentGlobalWakeHotkey } from '@/utils/globalWakeHotkey'

// 显示用户实际设置的唤醒键，而不是写死的默认值
const wakeHotkey = currentGlobalWakeHotkey
const switchLabel = shortcutLabel('Ctrl+M')
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  box-shadow: var(--rc-shadow-lg);
}

.guide-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.guide-head :deep(svg) {
  margin-top: 2px;
}

.guide-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.guide-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-text-primary);
}

.guide-sub {
  font-size: 12px;
  color: var(--rc-text-muted);
}

/* 预览：浅色画布上居中放一条缩小的悬浮条 */
.guide-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px 14px;
  border-radius: var(--rc-radius-md);
  background: var(--rc-canvas);
}

.guide-bar {
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--rc-surface);
  border: 1px solid var(--rc-border-highlight);
  box-shadow: var(--rc-shadow-lg);
  color: var(--rc-text-faint);
  font-size: 11.5px;
}

.guide-bar-icon {
  flex-shrink: 0;
  margin-right: 7px;
  font-size: 13px;
  color: var(--rc-text-muted);
}

.guide-caret {
  flex-shrink: 0;
  width: 1.5px;
  height: 13px;
  margin-right: 1px;
  border-radius: 1px;
  background: var(--rc-accent);
  animation: guide-blink 1.1s steps(2, start) infinite;
}

.guide-placeholder {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.guide-keys {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}

.guide-key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 22px;
}

.guide-key-row dt {
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.guide-key-row dd {
  margin: 0;
  display: inline-flex;
}

.guide-key-off {
  font-size: 11px;
  color: var(--rc-text-faint);
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
