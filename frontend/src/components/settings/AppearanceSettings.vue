<script setup>
import { computed, nextTick, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useToast } from '@/composables/useToast'
import { useThemeStore } from '@/stores/theme'
import { ACCENT_OPTIONS, THEME_MODES } from '@/constants/themes'

/** 设置页「外观」卡片：跟随系统 / 浅色 / 深色 + 6 款固定主题色（无自定义取色器） */
const themeStore = useThemeStore()
const { isDark, mode: themeMode, accent: accentTheme } = storeToRefs(themeStore)
const { error } = useToast()
const themeSaving = ref(false)
const accentSaving = ref(false)
const themeSwitcherRef = ref(null)
const accentSwitcherRef = ref(null)

const THEME_LABELS = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

const themeOptions = THEME_MODES.map((value) => ({
  value,
  label: THEME_LABELS[value]
}))

const accentOptions = ACCENT_OPTIONS

// WAI-ARIA radiogroup 游走焦点下标
const activeThemeIndex = computed(() => {
  const idx = themeOptions.findIndex((opt) => opt.value === themeMode.value)
  return idx >= 0 ? idx : 0
})

const activeAccentIndex = computed(() => {
  const idx = accentOptions.findIndex((opt) => opt.value === accentTheme.value)
  return idx >= 0 ? idx : 0
})

// 预览卡：浅色、深色固定；“跟随系统”选中时显示当前实际颜色，
// 未选中时显示半浅半深（客户端固定了深浅色时拿不到系统本身的深浅色）
const previewThemes = (value) => {
  if (value === 'light' || value === 'dark') return [value]
  return themeMode.value === value ? [isDark.value ? 'dark' : 'light'] : ['light', 'dark']
}

const pickTheme = async (value) => {
  if (themeMode.value === value || themeSaving.value) return
  themeSaving.value = true
  try {
    await themeStore.setTheme(value)
  } catch (err) {
    error('主题设置保存失败：' + (err?.message || '未知错误'))
  } finally {
    themeSaving.value = false
  }
}

const pickAccent = async (value) => {
  if (accentTheme.value === value || accentSaving.value) return
  accentSaving.value = true
  try {
    await themeStore.setAccent(value)
  } catch (err) {
    error('主题色设置保存失败：' + (err?.message || '未知错误'))
  } finally {
    accentSaving.value = false
  }
}

// 统一处理单选组方向键循环导航与按钮焦点跟随（保存禁用期间忽略）
const handleRadioGroupKeydown = async (event, { containerRef, options, activeIndex, saving, onPick }) => {
  if (saving || !options.length || event.ctrlKey || event.metaKey || event.altKey) return

  const container = containerRef.value
  const buttons = container ? Array.from(container.querySelectorAll('button[role="radio"]')) : []
  const targetBtn = event.target?.closest?.('button[role="radio"]')
  const currentIndex = targetBtn ? buttons.indexOf(targetBtn) : -1
  const idx = currentIndex >= 0 ? currentIndex : activeIndex

  let nextIndex = -1
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      nextIndex = (idx + 1) % options.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIndex = (idx - 1 + options.length) % options.length
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = options.length - 1
      break
    default:
      return
  }

  event.preventDefault()
  event.stopPropagation()
  buttons[nextIndex]?.focus?.()

  const nextOpt = options[nextIndex]
  if (nextOpt) {
    await onPick(nextOpt.value)
    // 保存期间按钮短暂进入 disabled 会导致浏览器重置焦点，保存完成后恢复当前聚焦按钮
    await nextTick()
    const currentContainer = containerRef.value
    if (
      currentContainer &&
      typeof document !== 'undefined' &&
      (!document.activeElement ||
        document.activeElement === document.body ||
        currentContainer.contains(document.activeElement))
    ) {
      const updatedButtons = currentContainer.querySelectorAll('button[role="radio"]')
      updatedButtons[nextIndex]?.focus?.()
    }
  }
}

const onThemeKeydown = (event) => {
  void handleRadioGroupKeydown(event, {
    containerRef: themeSwitcherRef,
    options: themeOptions,
    activeIndex: activeThemeIndex.value,
    saving: themeSaving.value,
    onPick: pickTheme
  })
}

const onAccentKeydown = (event) => {
  void handleRadioGroupKeydown(event, {
    containerRef: accentSwitcherRef,
    options: accentOptions,
    activeIndex: activeAccentIndex.value,
    saving: accentSaving.value,
    onPick: pickAccent
  })
}
</script>

<template>
  <div class="settings-card">
    <div class="card-header">
      <h2 class="card-title">外观</h2>
    </div>

    <div class="settings-list">
      <div class="theme-switcher-section">
        <div
          ref="themeSwitcherRef"
          class="theme-switcher"
          role="radiogroup"
          aria-label="界面主题"
          @keydown="onThemeKeydown"
        >
          <button
            v-for="(option, index) in themeOptions"
            :key="option.value"
            type="button"
            role="radio"
            class="theme-btn"
            :class="{ active: themeMode === option.value }"
            :aria-checked="themeMode === option.value"
            :tabindex="index === activeThemeIndex ? 0 : -1"
            :disabled="themeSaving"
            @click="pickTheme(option.value)"
          >
            <div class="theme-preview-row" aria-hidden="true">
              <div
                v-for="preview in previewThemes(option.value)"
                :key="preview"
                class="theme-preview"
                :class="`${preview}-preview`"
                :data-theme="preview"
              >
                <div class="preview-bar"><span class="preview-mark"></span></div>
                <div class="preview-line" style="width: 70%"></div>
                <div class="preview-line" style="width: 45%"></div>
              </div>
            </div>
            <span class="theme-name"><span class="theme-marker" aria-hidden="true"></span>{{ option.label }}</span>
          </button>
        </div>
      </div>

      <div class="setting-item accent-setting-item">
        <div class="setting-info">
          <div class="setting-text">
            <span class="setting-label">主题色</span>
            <span class="setting-desc">用于标志、选中标记、主按钮与搜索框聚焦光晕</span>
          </div>
        </div>
        <div
          ref="accentSwitcherRef"
          class="accent-switcher"
          role="radiogroup"
          aria-label="主题色"
          @keydown="onAccentKeydown"
        >
          <button
            v-for="(item, index) in accentOptions"
            :key="item.value"
            type="button"
            role="radio"
            class="accent-btn"
            :class="{ active: accentTheme === item.value }"
            :aria-checked="accentTheme === item.value"
            :tabindex="index === activeAccentIndex ? 0 : -1"
            :disabled="accentSaving"
            :data-testid="`accent-option-${item.value}`"
            @click="pickAccent(item.value)"
          >
            <span class="accent-swatch" :data-accent="item.value" aria-hidden="true"></span>
            <span class="accent-label">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-switcher-section {
  padding: 12px 0 16px;
  border-bottom: 1px solid var(--rc-border);
}

/* 主题选择：选中项用当前主题强调色方块标记 */
.theme-switcher {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.theme-btn {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.theme-btn:hover {
  border-color: var(--rc-border-highlight);
}

.theme-btn.active {
  border-color: var(--rc-accent);
}

.theme-btn:focus-visible {
  outline: 2px solid var(--rc-accent);
  outline-offset: 2px;
}

.theme-preview-row {
  display: flex;
}

.theme-preview {
  flex: 1;
  min-width: 0;
  height: 78px;
  border-radius: 8px;
  padding: 10px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--rc-canvas);
  box-shadow: inset 0 0 0 1px var(--rc-border);
}

/* 半浅半深：两块拼成一张卡 */
.theme-preview + .theme-preview {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.theme-preview:has(+ .theme-preview) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.preview-bar {
  height: 14px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding-left: 5px;
  background: var(--rc-surface);
}

.preview-mark {
  width: 4px;
  height: 4px;
  border-radius: 1px;
  background: var(--rc-accent);
}

.preview-line {
  height: 6px;
  border-radius: 2px;
  background: var(--rc-border-highlight);
}

.theme-name {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  font-size: 13px;
}

.theme-btn.active .theme-name {
  color: var(--rc-text-primary);
  font-weight: 600;
}

.theme-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.theme-btn.active .theme-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

/* 6 款固定主题色选择器 */
.accent-switcher {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.accent-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;
}

.accent-btn:hover:not(:disabled) {
  border-color: var(--rc-border-highlight);
  color: var(--rc-text-primary);
}

.accent-btn.active {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
  color: var(--rc-text-primary);
  font-weight: 600;
}

.accent-btn:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.accent-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.accent-swatch {
  width: 11px;
  height: 11px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: var(--rc-accent);
  box-shadow: inset 0 0 0 1px var(--rc-h-line);
}

.accent-label {
  line-height: 1;
}
</style>
