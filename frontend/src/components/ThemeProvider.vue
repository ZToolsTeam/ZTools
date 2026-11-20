<script setup>
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { getActivePinia } from 'pinia'
import { ConfigProvider, theme as antdTheme } from 'ant-design-vue'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'
import { ANTD_THEME_TOKENS, normalizeAccent } from '@/constants/themes'
import { useLocaleStore } from '@/stores/locale'
import { i18n } from '@/i18n'

const localeStore = getActivePinia() ? useLocaleStore() : null
const antdLocale = computed(() => {
  const current = localeStore ? localeStore.locale : i18n.global.locale.value
  return current === 'en-US' ? enUS : zhCN
})

// 检测当前暗黑模式与固定主题色
const isDarkMode = ref(document.documentElement.classList.contains('dark'))
const currentAccent = ref(normalizeAccent(document.documentElement.dataset.accent))

// 使用 MutationObserver 监听 document.documentElement 的 class 与 data-accent 变化
let observer = null

const syncFromDom = () => {
  isDarkMode.value = document.documentElement.classList.contains('dark')
  currentAccent.value = normalizeAccent(document.documentElement.dataset.accent)
}

onMounted(() => {
  syncFromDom()
  observer = new MutationObserver(syncFromDom)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-accent']
  })
})

onUnmounted(() => {
  if (observer) {
    observer.disconnect()
    observer = null
  }
})

// 计算 Ant Design 主题配置（随深浅模式与 6 款固定主题色联动）
const themeConfig = computed(() => {
  const palette = ANTD_THEME_TOKENS[currentAccent.value] || ANTD_THEME_TOKENS.ember
  const modeTokens = isDarkMode.value ? palette.dark : palette.light
  return {
    algorithm: isDarkMode.value
      ? antdTheme.darkAlgorithm
      : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: modeTokens.colorPrimary,
      colorLink: modeTokens.colorLink,
      colorTextLightSolid: modeTokens.colorTextLightSolid,
      borderRadius: 8,
      fontSize: 13,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif',
      colorBgBase: modeTokens.colorBgBase,
      colorBgContainer: modeTokens.colorBgContainer,
      colorBgElevated: modeTokens.colorBgElevated,
      colorBorder: modeTokens.colorBorder,
      colorBorderSecondary: modeTokens.colorBorderSecondary,
      colorTextBase: modeTokens.colorTextBase,
      colorSuccess: isDarkMode.value ? '#a3c783' : '#4b6a30',
      colorWarning: isDarkMode.value ? '#f0b955' : '#8f5b00',
      colorError: isDarkMode.value ? '#f97066' : '#b42318',
      colorInfo: isDarkMode.value ? '#93b4d6' : '#38556f'
    }
  }
})

// 向子组件提供 isDarkMode 状态（可选）
provide('isDarkMode', isDarkMode)
</script>

<template>
  <ConfigProvider :locale="antdLocale" :theme="themeConfig">
    <slot></slot>
  </ConfigProvider>
</template>
