<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RcButton } from '@/components/base'

const events = ref([])

const handler = (env) => {
  events.value.unshift(env)
  if (events.value.length > 200) events.value.length = 200
}
const clear = () => {
  events.value = []
}
const emitTest = () => {
  if (window?.ztools?.events?.emit) {
    window.ztools.events.emit('page.Test', { hello: 'world' })
  }
}
const setDark = async (dark) => {
  if (window?.ztools?.sys?.setDarkMode) {
    await window.ztools.sys.setDarkMode(dark)
  }
}
const format = (e) => {
  try {
    return JSON.stringify(e, null, 2)
  } catch {
    return String(e)
  }
}

onMounted(() => {
  if (window?.ztools?.events?.on) window.ztools.events.on('*', handler)
})
onBeforeUnmount(() => {
  if (window?.ztools?.events?.off) window.ztools.events.off('*', handler)
})
</script>

<template>
  <div class="event-page">
    <header class="page-header">
      <h1 class="page-title">事件监视器</h1>
      <p class="page-subtitle">实时显示宿主广播的全部事件，最多保留最近 200 条</p>
    </header>

    <div class="event-toolbar">
      <RcButton variant="secondary" @click="clear">清空</RcButton>
      <RcButton variant="secondary" @click="emitTest">发送测试事件</RcButton>
      <RcButton variant="secondary" @click="setDark(true)">系统暗黑</RcButton>
      <RcButton variant="secondary" @click="setDark(false)">系统明亮</RcButton>
      <span class="event-count">总计：{{ events.length }}</span>
    </div>

    <div class="event-list">
      <div v-for="(e, idx) in events" :key="idx" class="event-item">
        <div class="event-meta">
          {{ new Date(e.timestamp).toLocaleString() }} · {{ e.type }}
        </div>
        <pre class="event-body">{{ format(e) }}</pre>
      </div>
      <div v-if="!events.length" class="event-empty">暂无事件</div>
    </div>
  </div>
</template>

<style scoped>
.event-page {
  padding: 22px 32px 32px;
  color: var(--rc-text-primary);
}

.event-page .page-header {
  margin-bottom: 20px;
}

.event-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.event-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--rc-text-muted);
  font-variant-numeric: tabular-nums;
}

/* 事件列表：浅一级表面 + 等宽字体，深浅主题都由 --rc-* 变量决定 */
.event-list {
  max-height: 70vh;
  overflow: auto;
  padding: 4px 12px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-lg);
  background: var(--rc-surface-subtle);
}

.event-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--rc-border);
}

.event-item:last-child {
  border-bottom: none;
}

.event-meta {
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--rc-text-muted);
}

.event-body {
  margin: 0;
  color: var(--rc-text-secondary);
  font-family: var(--rc-font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.event-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--rc-text-muted);
}
</style>
