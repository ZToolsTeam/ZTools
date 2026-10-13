<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

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
  <div class="container mx-auto px-4 py-6 text-gray-800 dark:text-gray-100">
    <h1 class="text-xl font-bold mb-4">事件监视器</h1>
    <div class="mb-3 flex items-center gap-2">
      <button class="px-3 py-1 border rounded" @click="clear">清空</button>
      <button class="px-3 py-1 border rounded" @click="emitTest">
        发送测试事件
      </button>
      <button class="px-3 py-1 border rounded" @click="setDark(true)">
        系统暗黑
      </button>
      <button class="px-3 py-1 border rounded" @click="setDark(false)">
        系统明亮
      </button>
      <span class="text-sm text-gray-500">总计：{{ events.length }}</span>
    </div>
    <div
      class="bg-white dark:bg-slate-900 border dark:border-slate-700 rounded p-3 max-h-[70vh] overflow-auto text-sm"
    >
      <div
        class="border-b dark:border-slate-700 py-2 whitespace-pre-wrap break-words"
        v-for="(e, idx) in events"
        :key="idx"
      >
        <div class="text-xs text-gray-500">
          {{ new Date(e.timestamp).toLocaleString() }} · {{ e.type }}
        </div>
        <div>{{ format(e) }}</div>
      </div>
      <div v-if="!events.length" class="text-center text-gray-400 py-10">
        暂无事件
      </div>
    </div>
  </div>
</template>
