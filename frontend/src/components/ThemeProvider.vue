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
    // 与 theme.css 的积木 Z × 余烬橙标记保持一致（Ant Design 需要具体色值，不能用 CSS 变量）
    // 主色取实心按钮填充色（theme.css --rc-accent-fill），配白字；与自绘按钮一致
    colorPrimary: isDarkMode.value ? '#ec5a2d' : '#f0582a',
    colorLink: isDarkMode.value ? '#ff8a63' : '#c2410c',
    colorTextLightSolid: '#ffffff',
    borderRadius: 8,
    fontSize: 13,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
    colorBgBase: isDarkMode.value ? '#0b0b0c' : '#f4f3f0',
    colorBgContainer: isDarkMode.value ? '#141416' : '#ffffff',
    colorBgElevated: isDarkMode.value ? '#1a1a1d' : '#ffffff',
    colorBorder: isDarkMode.value ? '#2c2c31' : '#dbd8d2',
    colorBorderSecondary: isDarkMode.value ? '#202024' : '#e7e5e0',
    colorTextBase: isDarkMode.value ? '#f2f2f0' : '#18181b',
    colorSuccess: isDarkMode.value ? '#a3c783' : '#4b6a30',
    colorWarning: isDarkMode.value ? '#f0b955' : '#8f5b00',
    colorError: isDarkMode.value ? '#f97066' : '#b42318',
    colorInfo: isDarkMode.value ? '#93b4d6' : '#38556f'
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
