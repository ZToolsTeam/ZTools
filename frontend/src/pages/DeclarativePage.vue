<template>
  <div class="h-full flex flex-col overflow-hidden bg-slate-950 text-slate-100 select-none">
    <!-- 顶部工作台面包屑栏 -->
    <div
      class="flex items-center justify-between px-5 py-2.5 border-b border-white/10 bg-slate-900/60 backdrop-blur-xl flex-shrink-0"
    >
      <div class="flex items-center gap-3 min-w-0">
        <button
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 transition-all border border-white/10 cursor-pointer"
          title="返回我的插件 (Esc)"
          @click="goBack"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>工作台</span>
        </button>

        <span class="text-slate-600">/</span>

        <!-- 应用标题与语义图标 -->
        <div v-if="plugin" class="flex items-center gap-2 min-w-0">
          <div
            class="w-5 h-5 rounded-md flex items-center justify-center text-[10px] text-white flex-shrink-0"
            :style="{ background: plugin.iconGradient || 'linear-gradient(135deg, #0ea5e9, #38bdf8)' }"
          >
            <i :class="['fa', plugin.faIcon || 'fa-cube']"></i>
          </div>
          <span class="text-sm font-semibold text-white truncate">{{ plugin.name }}</span>
          <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/20 text-sky-300 border border-sky-500/30">
            官方标杆
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <span class="text-xs text-slate-400 font-mono hidden sm:inline">声明式渲染引擎</span>
        <button
          class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          title="关闭退出 (Esc)"
          @click="goBack"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 主体区域：声明式统一渲染器 -->
    <div class="flex-1 overflow-hidden p-3 bg-slate-950/80">
      <template v-if="plugin && plugin.command">
        <DeclarativeView
          :key="targetPluginId"
          :rootComponent="plugin.command"
          @exit="handleExit"
        />
      </template>

      <!-- 异常状态处理 (Beyond Happy Path: 非法或不存在的插件ID) -->
      <div
        v-else
        class="h-full flex flex-col items-center justify-center text-center p-8 bg-slate-900/40 rounded-2xl border border-white/10"
      >
        <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-2xl mb-4">
          <i class="fa fa-exclamation-triangle"></i>
        </div>
        <h3 class="text-base font-semibold text-slate-200 mb-1">未找到指定的声明式应用</h3>
        <p class="text-xs text-slate-400 max-w-md mb-5">
          插件标识符 “<code class="text-sky-300 font-mono">{{ pluginId }}</code>” 未在官方标杆应用注册表中注册，或者其组件未能成功加载。
        </p>
        <button
          class="declarative-error-back-btn px-4 py-2 rounded-xl text-xs font-medium bg-sky-500 hover:bg-sky-600 text-white transition-all shadow-md cursor-pointer"
          @click="goBack"
        >
          返回我的插件列表
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getActivePinia } from 'pinia'
import { useUIStore } from '@/stores/ui'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import { ROUTES } from '@/router/routes'

const props = defineProps({
  pluginId: {
    type: String,
    default: ''
  }
})

const route = useRoute()
const router = useRouter()

onMounted(() => {
  if (getActivePinia()) {
    useUIStore().focusDeclarative()
  }
})

onUnmounted(() => {
  if (getActivePinia()) {
    useUIStore().focusGrid()
  }
})

const targetPluginId = computed(() => {
  return String(props.pluginId || route.params.pluginId || '').trim()
})

const plugin = computed(() => {
  return getOfficialPlugin(targetPluginId.value)
})

function goBack() {
  router.push(ROUTES.HOME)
}

function handleExit() {
  goBack()
}
</script>
