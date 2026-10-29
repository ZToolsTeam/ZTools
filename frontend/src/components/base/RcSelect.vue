<script setup>
import { CheckIcon, ChevronDownIcon, XIcon } from '@lucide/vue'
import { Select } from 'ant-design-vue'
import { computed, useAttrs } from 'vue'

/**
 * 统一下拉选择：客户端各页面与插件的 Form.Dropdown / List.Dropdown 都用它。
 * 底层是 antd Select（键盘选择、搜索、分组、虚拟滚动沿用其行为），图标换成 Lucide，外观由下方样式统一。
 * 用法与 a-select 相同：v-model:value、options（分组写 { label, options: [...] }）、show-search、size 等原样透传。
 * size：small（工具栏、筛选条，高 26）/ middle（表单，高 32，默认）。
 */
defineOptions({ inheritAttrs: false })
const props = defineProps({
  popupClassName: { type: String, default: '' },
  // 弹出列表默认不跟随选择框宽度：至少与选择框同宽，选项文字更长时自动加宽，不截断
  dropdownMatchSelectWidth: { type: [Boolean, Number], default: false }
})
const attrs = useAttrs()
const popupClass = computed(() => ['rc-select-popup', props.popupClassName].filter(Boolean).join(' '))
</script>

<template>
  <Select
    v-bind="attrs"
    :class="['rc-select', attrs.class]"
    :popup-class-name="popupClass"
    :dropdown-match-select-width="dropdownMatchSelectWidth"
  >
    <template #suffixIcon><ChevronDownIcon class="rc-select-arrow" aria-hidden="true" /></template>
    <template #clearIcon><XIcon aria-hidden="true" /></template>
    <template #removeIcon><XIcon aria-hidden="true" /></template>
    <template #menuItemSelectedIcon><CheckIcon class="rc-select-check" aria-hidden="true" /></template>
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps || {}" />
    </template>
  </Select>
</template>

<style scoped>
/* 弹出层渲染在组件外（挂到 body），这里的选择器用 :global() 生效 */
/* ---------- 选择框 ---------- */
:global(.rc-select.ant-select .ant-select-selector) {
  border-color: var(--rc-border) !important;
  border-radius: var(--rc-radius-md) !important;
  background: var(--rc-surface) !important;
  color: var(--rc-text-primary);
  box-shadow: none !important;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease !important;
}

:global(.rc-select.ant-select:not(.ant-select-disabled):hover .ant-select-selector) {
  border-color: var(--rc-border-highlight) !important;
}

:global(.rc-select.ant-select-focused .ant-select-selector),
:global(.rc-select.ant-select-open .ant-select-selector) {
  border-color: var(--rc-accent) !important;
  box-shadow: var(--rc-focus-ring) !important;
}

:global(.rc-select.ant-select .ant-select-selection-item) {
  font-size: 13px;
}

:global(.rc-select.ant-select-sm .ant-select-selection-item),
:global(.rc-select.ant-select-sm .ant-select-selection-placeholder) {
  font-size: 12px;
}

:global(.rc-select.ant-select .ant-select-selection-placeholder) {
  color: var(--rc-text-faint);
}

:global(.rc-select .ant-select-arrow),
:global(.rc-select .ant-select-clear) {
  color: var(--rc-text-muted);
  background: transparent;
}

:global(.rc-select .rc-select-arrow) {
  font-size: 14px;
  transition: transform 0.2s ease;
}

:global(.rc-select.ant-select-open .rc-select-arrow) {
  transform: rotate(180deg);
}

/* ---------- 弹出列表 ---------- */
:global(.rc-select-popup.ant-select-dropdown) {
  padding: 4px;
  border: 1px solid var(--rc-border);
  border-radius: 10px;
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-lg);
}

:global(.rc-select-popup .ant-select-item) {
  min-height: 30px;
  padding: 5px 8px 5px 10px;
  border-radius: 6px;
  color: var(--rc-text-secondary);
  font-size: 13px;
  line-height: 20px;
}

:global(.rc-select-popup .ant-select-item-option-active:not(.ant-select-item-option-disabled)) {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

:global(.rc-select-popup .ant-select-item-option-selected:not(.ant-select-item-option-disabled)) {
  background: transparent;
  color: var(--rc-text-primary);
  font-weight: 600;
}

:global(.rc-select-popup .ant-select-item-option-selected.ant-select-item-option-active:not(.ant-select-item-option-disabled)) {
  background: var(--rc-surface-hover);
}

:global(.rc-select-popup .ant-select-item-option-state) {
  display: inline-flex;
  align-items: center;
}

:global(.rc-select-popup .rc-select-check) {
  font-size: 14px;
  color: var(--rc-accent);
  stroke-width: 2.25;
}

:global(.rc-select-popup .ant-select-item-group) {
  min-height: 26px;
  padding: 8px 10px 2px;
  color: var(--rc-text-faint);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}

:global(.rc-select-popup .ant-select-item-option-grouped) {
  padding-left: 10px;
}

:global(.rc-select-popup .ant-select-item-empty) {
  color: var(--rc-text-muted);
  font-size: 12px;
}
</style>
