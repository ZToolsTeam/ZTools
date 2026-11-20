<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RcButton } from '@/components/base'
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
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
  <div class="rc-page event-page">
    <header class="page-header">
      <h1 class="page-title">{{ t('eventMonitor.title') }}</h1>
      <p class="page-subtitle">{{ t('eventMonitor.subtitle') }}</p>
    </header>

    <div class="event-toolbar">
      <RcButton variant="secondary" @click="clear">{{ t('common.clear') }}</RcButton>
      <RcButton variant="secondary" @click="emitTest">{{ t('eventMonitor.emitTest') }}</RcButton>
      <RcButton variant="secondary" @click="setDark(true)">{{ t('eventMonitor.systemDark') }}</RcButton>
      <RcButton variant="secondary" @click="setDark(false)">{{ t('eventMonitor.systemLight') }}</RcButton>
      <span class="event-count">{{ t('eventMonitor.total', { count: events.length }) }}</span>
    </div>

    <div class="event-list">
      <div v-for="(e, idx) in events" :key="idx" class="event-item">
        <div class="event-meta">
          {{ new Date(e.timestamp).toLocaleString() }} · {{ e.type }}
        </div>
        <pre class="event-body">{{ format(e) }}</pre>
      </div>
      <div v-if="!events.length" class="event-empty">{{ t('eventMonitor.empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 外框与标题间距由全局 .rc-page / .page-header 提供 */
.event-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.event-count {
  margin-left: auto;
  font-size: var(--rc-fs-small);
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
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
}

.event-body {
  margin: 0;
  color: var(--rc-text-secondary);
  font-family: var(--rc-font-mono);
  font-size: var(--rc-fs-small);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.event-empty {
  padding: 40px 0;
  text-align: center;
  font-size: var(--rc-fs-body);
  color: var(--rc-text-muted);
}
</style>
