<script setup>
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useToast } from '@/composables/useToast'
import { useThemeStore } from '@/stores/theme'

/** 设置页「外观」卡片：跟随系统 / 浅色 / 深色。白天黑夜自动切换交给操作系统（如 macOS 外观“自动”） */
const themeStore = useThemeStore()
const { isDark, mode: themeMode } = storeToRefs(themeStore)
const { error } = useToast()
const themeSaving = ref(false)

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

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
</script>

<template>
  <div class="settings-card">
    <div class="card-header">
      <h2 class="card-title">外观</h2>
    </div>

    <div class="settings-list">
      <div class="theme-switcher" role="radiogroup" aria-label="界面主题">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          role="radio"
          class="theme-btn"
          :class="{ active: themeMode === option.value }"
          :aria-checked="themeMode === option.value"
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
  </div>
</template>

<style scoped>
/* 主题选择：选中项用余烬橙方块标记 */
.theme-switcher {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  padding-top: 4px;
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

/* 预览卡用 data-theme 固定展示「雾白 / 墨黑」两套真实配色，不随当前主题变化 */
.theme-preview {
  background: var(--rc-canvas);
  box-shadow: inset 0 0 0 1px var(--rc-border);
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
</style>
