<template>
  <div class="h-full flex flex-col overflow-hidden bg-slate-950 text-slate-100 select-none">
    <!-- 顶部一体化可拖拽窗口标题与面包屑栏 (自动避让 Windows 原生最小化/最大化/关闭按钮区) -->
    <div
      class="flex items-center justify-between border-b border-white/10 bg-slate-900/75 backdrop-blur-xl flex-shrink-0"
      :style="{
        height: '42px',
        paddingLeft: '14px',
        paddingRight: isWindowsPlatform ? '142px' : '14px',
        WebkitAppRegion: 'drag'
      }"
    >
      <div class="flex items-center gap-2.5 min-w-0" style="-webkit-app-region: no-drag">
        <button
          v-if="!effectiveIsPopout"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 transition-all border border-white/10 cursor-pointer"
          title="返回我的插件 (Esc)"
          @click="goBack"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>工作台</span>
        </button>

        <span
          v-else
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
          title="当前处于独立常驻窗口模式，按 Esc 不会误关窗口"
        >
          <i class="fa fa-window-restore text-[11px]"></i>
          <span>独立窗口</span>
        </span>

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
          <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/20 text-sky-300 border border-sky-500/30 flex-shrink-0">
            {{ plugin.isInstalledDeclarative ? 'V2 声明式扩展' : '官方标杆' }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2 flex-shrink-0" style="-webkit-app-region: no-drag">
        <!-- 主窗口模式：提供【独立窗口弹出】按钮 (携带当前搜索/筛选状态无缝接力) -->
        <button
          v-if="!effectiveIsPopout && plugin"
          type="button"
          class="declarative-popout-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-sky-300 bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 transition-all cursor-pointer"
          title="弹出为独立常驻窗口，自动携带当前搜索与选中状态 (Ctrl+Shift+O)"
          @click="handlePopout"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          <span>独立窗口</span>
        </button>

        <!-- 独立窗口模式：提供【窗口置顶】与【收回工作台】控制 -->
        <template v-if="effectiveIsPopout">
          <button
            type="button"
            class="declarative-pin-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border cursor-pointer"
            :class="isAlwaysOnTop
              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
              : 'bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 border-white/10'"
            title="切换独立窗口始终置顶 (Always on Top)"
            @click="toggleAlwaysOnTop"
          >
            <i class="fa fa-thumb-tack text-[11px]"></i>
            <span>{{ isAlwaysOnTop ? '已置顶' : '置顶' }}</span>
          </button>

          <button
            type="button"
            class="declarative-dock-btn flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 border border-white/10 transition-all cursor-pointer"
            title="收回至主工作台视图"
            @click="dockBackToMain"
          >
            <span>收回工作台</span>
          </button>
        </template>
      </div>
    </div>

    <!-- 主体区域：声明式统一渲染器 (零外边距占满视口) -->
    <div class="flex-1 overflow-hidden p-2 bg-slate-950/90">
      <template v-if="plugin && plugin.command">
        <DeclarativeView
          ref="declarativeViewRef"
          :key="targetPluginId"
          :rootComponent="plugin.command"
          :hideRootTitle="true"
          :isPopout="effectiveIsPopout"
          :initialSnapshot="initialSnapshot"
          @exit="handleExit"
        />
      </template>

      <!-- 动态加载中或异常状态处理 (Beyond Happy Path: 非法或不存在的插件ID) -->
      <div
        v-else
        class="h-full flex flex-col items-center justify-center text-center p-8 bg-slate-900/40 rounded-2xl border border-white/10"
      >
        <div
          v-if="loadingDynamic"
          class="mb-4 flex items-center gap-2 text-xs text-sky-400 font-mono"
        >
          <i class="fa fa-spinner fa-spin"></i>
          <span>正在加载声明式插件组件...</span>
        </div>
        <div class="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center text-2xl mb-4">
          <i class="fa fa-exclamation-triangle"></i>
        </div>
        <h3 class="text-base font-semibold text-slate-200 mb-1">未找到指定的声明式应用</h3>
        <p class="text-xs text-slate-400 max-w-md mb-3">
          插件标识符 “<code class="text-sky-300 font-mono">{{ targetPluginId || pluginId }}</code>” 未在官方标杆应用注册表中注册，或者其组件未能成功加载。
        </p>
        <p
          v-if="loadError"
          class="text-xs text-rose-400 font-mono max-w-md mb-5 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20"
        >
          {{ loadError }}
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getActivePinia } from 'pinia'
import { useUIStore } from '@/stores/ui'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import { ROUTES, routeUtils } from '@/router/routes'
import { win as nativeWin } from '@/api/apiserver'

const props = defineProps({
  pluginId: {
    type: String,
    default: ''
  },
  isPopout: {
    type: Boolean,
    default: false
  }
})

const route = useRoute()
const router = useRouter()

const declarativeViewRef = ref(null)
const dynamicPlugin = ref(null)
const loadingDynamic = ref(false)
const loadError = ref('')
const isAlwaysOnTop = ref(false)
const isWindowsPlatform = ref(
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
)

const effectiveIsPopout = computed(() => {
  return Boolean(
    props.isPopout ||
    route?.name === 'popout' ||
    route?.query?.popout === '1'
  )
})

const initialSnapshot = computed(() => {
  const q = route?.query
  if (!q || typeof q !== 'object') return null
  const searchText = typeof q.q === 'string' ? q.q : ''
  const segmentedValue = typeof q.seg === 'string' ? q.seg : ''
  const dropdownValue = typeof q.drop === 'string' ? q.drop : ''
  const selectedId = typeof q.sel === 'string' ? q.sel : ''
  if (!searchText && !segmentedValue && !dropdownValue && !selectedId) {
    return null
  }
  return { searchText, segmentedValue, dropdownValue, selectedId }
})

function handleKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
    if (!effectiveIsPopout.value && plugin.value) {
      e.preventDefault()
      handlePopout()
    }
  }
}

onMounted(() => {
  if (getActivePinia()) {
    useUIStore().focusDeclarative()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown)
  }
})

onUnmounted(() => {
  if (getActivePinia()) {
    useUIStore().focusGrid()
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeyDown)
  }
})

const targetPluginId = computed(() => {
  return String(props.pluginId || route?.params?.pluginId || '').trim()
})

const plugin = computed(() => {
  return getOfficialPlugin(targetPluginId.value) || dynamicPlugin.value
})

let currentLoadToken = 0

watch(
  targetPluginId,
  async (id) => {
    const token = ++currentLoadToken
    dynamicPlugin.value = null
    loadError.value = ''

    if (!id || getOfficialPlugin(id)) {
      loadingDynamic.value = false
      return
    }

    loadingDynamic.value = true
    try {
      const loaded = await loadInstalledDeclarativePlugin(id)
      if (token === currentLoadToken) {
        dynamicPlugin.value = loaded
      }
    } catch (err) {
      if (token === currentLoadToken) {
        dynamicPlugin.value = null
        loadError.value = err?.message || String(err) || '动态加载声明式插件失败'
      }
    } finally {
      if (token === currentLoadToken) {
        loadingDynamic.value = false
      }
    }
  },
  { immediate: true }
)

async function handlePopout() {
  const id = targetPluginId.value
  if (!id) return

  const snap = declarativeViewRef.value?.getViewStateSnapshot?.() || {}
  const query = {}
  if (snap.searchText) query.q = String(snap.searchText)
  if (snap.segmentedValue) query.seg = String(snap.segmentedValue)
  if (snap.dropdownValue) query.drop = String(snap.dropdownValue)
  if (snap.selectedId) query.sel = String(snap.selectedId)

  const searchParams = new URLSearchParams(query).toString()
  const hashRoute = `#/popout/${encodeURIComponent(id)}${searchParams ? `?${searchParams}` : ''}`
  const popoutUrl = `ztools://web/index.html${hashRoute}`

  try {
    if (typeof nativeWin?.open === 'function') {
      const res = await nativeWin.open(popoutUrl)
      if (res && res.success !== false) {
        // 单实例互斥接管：弹出独立窗口成功后，主窗口原子级退回工作台首页（销毁主窗口内的轮询实例）
        router.push(ROUTES.HOME)
        return
      }
    }
  } catch {
    // 若当前宿主进程尚未重启支持多窗口 IPC，则平滑切换至大尺寸独立常驻路由并扩容窗口
  }

  try {
    await nativeWin?.setSize?.(1140, 760, true)
  } catch {
    // 忽略非原生环境尺寸调整异常
  }
  router.push(routeUtils.toPopout(id, query))
}

async function toggleAlwaysOnTop() {
  const nextVal = !isAlwaysOnTop.value
  isAlwaysOnTop.value = nextVal
  try {
    await nativeWin?.setAlwaysOnTop?.(nextVal)
  } catch {
    // 忽略非原生环境置顶异常
  }
}

async function dockBackToMain() {
  if (isAlwaysOnTop.value) {
    isAlwaysOnTop.value = false
    try {
      await nativeWin?.setAlwaysOnTop?.(false)
    } catch {
      // ignore
    }
  }
  const snap = declarativeViewRef.value?.getViewStateSnapshot?.() || {}
  const query = {}
  if (snap.searchText) query.q = String(snap.searchText)
  if (snap.segmentedValue) query.seg = String(snap.segmentedValue)
  if (snap.dropdownValue) query.drop = String(snap.dropdownValue)
  if (snap.selectedId) query.sel = String(snap.selectedId)

  router.push({
    ...routeUtils.toDeclarative(targetPluginId.value),
    query
  })
}

function goBack() {
  router.push(ROUTES.HOME)
}

function handleExit() {
  if (effectiveIsPopout.value) return
  goBack()
}
</script>
