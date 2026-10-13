<script setup>
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { ConfigProvider, theme as antdTheme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'

// 检测当前是否为暗黑模式
const isDarkMode = ref(document.documentElement.classList.contains('dark'))

// 使用 MutationObserver 监听 document.documentElement 的 class 变化
let observer = null

onMounted(() => {
  observer = new MutationObserver(() => {
    isDarkMode.value = document.documentElement.classList.contains('dark')
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
})

onUnmounted(() => {
  if (observer) {
    observer.disconnect()
    observer = null
  }
})

// 计算 Ant Design 主题配置
const themeConfig = computed(() => ({
  algorithm: isDarkMode.value
    ? antdTheme.darkAlgorithm
    : antdTheme.defaultAlgorithm,
  token: {
    // 自定义 Ant Design Token 与 Raycast 双模设计标记对齐
    colorPrimary: isDarkMode.value ? '#38bdf8' : '#0284c7',
    borderRadius: 8,
    fontSize: 13,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
    colorSuccess: isDarkMode.value ? '#34d399' : '#10b981',
    colorWarning: isDarkMode.value ? '#fbbf24' : '#f59e0b',
    colorError: isDarkMode.value ? '#f87171' : '#ef4444',
    colorInfo: isDarkMode.value ? '#38bdf8' : '#0284c7'
  }
}))

// 向子组件提供 isDarkMode 状态（可选）
provide('isDarkMode', isDarkMode)
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <slot></slot>
  </ConfigProvider>
</template>
