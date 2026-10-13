<script setup lang="ts">
import { ref, onMounted } from 'vue'

const count = ref(0)
const pluginInfo = ref({
  id: '{{ID}}',
  name: '{{NAME}}',
  description: '{{DESCRIPTION}}'
})

onMounted(() => {
  // 接入 ZTools 插件生命周期
  if ((window as any).ztoolsPlugin?.onPluginEnter) {
    ;(window as any).ztoolsPlugin.onPluginEnter((action: any) => {
      console.log('[{{ID}}] 插件唤起:', action)
    })
  }
})

const handleAction = async () => {
  count.value++
  const ztools = (window as any).ztools
  if (ztools?.sys?.toast) {
    await ztools.sys.toast('success', `点击了 ${count.value} 次`)
  } else {
    alert(`点击了 ${count.value} 次`)
  }
}
</script>

<template>
  <main class="plugin-container">
    <header class="plugin-header">
      <h1 class="plugin-title">{{ pluginInfo.name }}</h1>
      <p class="plugin-desc">{{ pluginInfo.description }}</p>
    </header>

    <section class="plugin-card">
      <p class="counter-text">当前点击次数：<strong>{{ count }}</strong></p>
      <button class="action-btn" @click="handleAction">
        点击触发 Toast 测试
      </button>
    </section>
  </main>
</template>

<style scoped>
.plugin-container {
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.plugin-header {
  margin-bottom: 24px;
}

.plugin-title {
  font-size: 24px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--plugin-text, #333333);
}

.plugin-desc {
  font-size: 14px;
  margin: 0;
  color: var(--plugin-text-secondary, #666666);
}

.plugin-card {
  padding: 20px;
  border-radius: 8px;
  background: var(--plugin-panel-bg, #ffffff);
  border: 1px solid var(--plugin-border, #e5e7eb);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.counter-text {
  font-size: 16px;
  margin: 0 0 16px 0;
  color: var(--plugin-text, #333333);
}

.action-btn {
  padding: 8px 18px;
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  background-color: var(--plugin-primary, #1677ff);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.action-btn:hover {
  opacity: 0.9;
}
</style>
