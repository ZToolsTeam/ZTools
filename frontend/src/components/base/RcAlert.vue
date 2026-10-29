<script setup>
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { Alert } from 'ant-design-vue'
import { computed, useAttrs } from 'vue'

/**
 * 统一提示条：antd Alert 的薄封装，按 type 换成对应的 Lucide 图标。用法与 a-alert 相同。
 */
defineOptions({ inheritAttrs: false })
const attrs = useAttrs()
const ICONS = { success: CircleCheckIcon, info: InfoIcon, warning: TriangleAlertIcon, error: CircleXIcon }
const icon = computed(() => ICONS[attrs.type] || InfoIcon)
</script>

<template>
  <Alert v-bind="attrs" :class="['rc-alert', attrs.class]">
    <template #icon><component :is="icon" class="rc-alert-icon" aria-hidden="true" /></template>
    <template #closeIcon><XIcon aria-hidden="true" /></template>
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps || {}" />
    </template>
  </Alert>
</template>

<style scoped>
/* antd Alert 的内部结构不带本组件的 scoped 标记，选择器用 :global() 并以 .rc-alert 限定范围 */
:global(.rc-alert.ant-alert) {
  border-radius: var(--rc-radius-md);
}

:global(.rc-alert .rc-alert-icon) {
  flex-shrink: 0;
  margin-inline-end: 8px;
  font-size: 14px;
}

:global(.rc-alert.ant-alert-with-description .rc-alert-icon) {
  font-size: 20px;
  margin-inline-end: 12px;
}
</style>
