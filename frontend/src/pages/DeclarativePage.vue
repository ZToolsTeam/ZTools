<template>
  <div class="h-full flex flex-col overflow-hidden bg-[var(--rc-canvas)] text-[var(--rc-text-primary)] select-none">
    <!-- 顶部一体化可拖拽窗口标题与面包屑栏 (自动避让 Windows 原生最小化/最大化/关闭按钮区) -->
    <div
      class="flex items-center justify-between border-b border-[var(--rc-border)] bg-[var(--rc-head)] backdrop-blur-xl flex-shrink-0"
      :style="{
        // 标题栏高度与主进程 MAIN/POPOUT_TITLE_BAR_HEIGHT 一致：主窗口 52px、独立窗口 42px，系统按钮才能垂直居中
        height: effectiveIsPopout ? '42px' : '52px',
        // macOS 红绿灯位于左侧（x=18，3×12px + 2×8px），需要留出空间
        paddingLeft: isMacPlatform ? '86px' : '14px',
        paddingRight: isWindowsPlatform ? '142px' : '14px',
        WebkitAppRegion: 'drag'
      }"
    >
      <div class="flex items-center gap-2.5 min-w-0" style="-webkit-app-region: no-drag">
        <button
          v-if="!effectiveIsPopout"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] transition-all border border-[var(--rc-border)] cursor-pointer"
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
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-[var(--rc-success-subtle)] text-[var(--rc-success)] border border-[var(--rc-border)]"
          title="当前处于独立常驻窗口模式，按 Esc 不会误关窗口"
        >
          <i class="fa fa-window-restore text-[11px]"></i>
          <span>独立窗口</span>
        </span>

        <span class="text-[var(--rc-text-faint)]">/</span>

        <!-- 应用标题与语义图标 -->
        <div v-if="plugin" class="flex items-center gap-2 min-w-0">
          <RcSquircle :glyph="resolvePluginGlyph(plugin.pluginId || plugin.id || targetPluginId)" :icon="plugin.faIcon || 'fa-cube'" :size="22" />
          <span class="text-sm font-semibold text-[var(--rc-text-primary)] truncate">{{ plugin.name }}</span>
          <span class="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--rc-accent-subtle)] text-[var(--rc-accent-text)] border border-[var(--rc-border-highlight)] flex-shrink-0">
            {{ plugin.isInstalledDeclarative ? 'V2 声明式扩展' : '官方标杆' }}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-2 flex-shrink-0" style="-webkit-app-region: no-drag">
        <!-- 主窗口模式：提供【独立窗口弹出】按钮 (携带当前搜索/筛选状态无缝接力) -->
        <button
          v-if="!effectiveIsPopout && plugin"
          type="button"
          class="declarative-popout-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--rc-accent-text)] bg-[var(--rc-accent-subtle)] hover:bg-[var(--rc-accent-subtle)] border border-[var(--rc-border-highlight)] transition-all cursor-pointer"
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
              ? 'bg-[var(--rc-warning-subtle)] text-[var(--rc-warning)] border-[var(--rc-border)]'
              : 'bg-[var(--rc-surface-hover)] text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] border-[var(--rc-border)]'"
            title="切换独立窗口始终置顶 (Always on Top)"
            @click="toggleAlwaysOnTop"
          >
            <i class="fa fa-thumb-tack text-[11px]"></i>
            <span>{{ isAlwaysOnTop ? '已置顶' : '置顶' }}</span>
          </button>

          <button
            type="button"
            class="declarative-dock-btn flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] transition-all cursor-pointer"
            title="收回至主工作台视图"
            @click="dockBackToMain"
          >
            <span>收回工作台</span>
          </button>
        </template>
      </div>
    </div>

    <!-- 主体区域：声明式统一渲染器 (零外边距占满视口) -->
    <div class="flex-1 overflow-hidden p-2 bg-[var(--rc-canvas)]">
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
        class="h-full flex flex-col items-center justify-center text-center p-8 bg-[var(--rc-surface)] rounded-2xl border border-[var(--rc-border)]"
      >
        <div
          v-if="loadingDynamic"
          class="mb-4 flex items-center gap-2 text-xs text-[var(--rc-accent-text)] font-mono"
        >
          <i class="fa fa-spinner fa-spin"></i>
          <span>正在加载声明式插件组件...</span>
        </div>
        <div class="w-14 h-14 rounded-2xl bg-[var(--rc-warning-subtle)] text-[var(--rc-warning)] border border-[var(--rc-border)] flex items-center justify-center text-2xl mb-4">
          <i class="fa fa-exclamation-triangle"></i>
        </div>
        <template v-if="unsupportedOfficial">
          <h3 class="text-base font-semibold text-[var(--rc-text-primary)] mb-1">当前系统暂不可用</h3>
          <p class="text-xs text-[var(--rc-text-muted)] max-w-md mb-5">{{ loadError }}</p>
        </template>
        <h3 v-if="!unsupportedOfficial" class="text-base font-semibold text-[var(--rc-text-primary)] mb-1">未找到指定的声明式应用</h3>
        <p v-if="!unsupportedOfficial" class="text-xs text-[var(--rc-text-muted)] max-w-md mb-3">
          插件标识符 “<code class="text-[var(--rc-accent-text)] font-mono">{{ targetPluginId || pluginId }}</code>” 未在官方标杆应用注册表中注册，或者其组件未能成功加载。
        </p>
        <p
          v-if="loadError && !unsupportedOfficial"
          class="text-xs text-[var(--rc-error)] font-mono max-w-md mb-5 px-3 py-2 rounded-lg bg-[var(--rc-error-subtle)] border border-[var(--rc-error)]"
        >
          {{ loadError }}
        </p>
        <button
          class="declarative-error-back-btn px-4 py-2 rounded-xl text-xs font-medium bg-[var(--rc-accent)] hover:bg-[var(--rc-accent-hover)] text-[var(--rc-accent-contrast)] transition-all shadow-md cursor-pointer"
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
import { isPluginSupportedOnCurrentPlatform, isMacOS, isWindows } from '@/utils/platform'
import { isModalOpen } from '@/utils/keymap'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import { RcSquircle } from '@/components/base'
import { resolvePluginGlyph } from '@/utils/brandIcons'
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
const isMacPlatform = computed(() => isMacOS())
const isWindowsPlatform = computed(() => isWindows())

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
  if (isModalOpen()) return
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

const targetFeatureCode = computed(() => {
  return typeof route?.query?.feature === 'string' ? route.query.feature.trim() : ''
})

// 直接打开路由（旧快捷方式、历史记录）也要拦住当前系统上不能工作的插件
const unsupportedOfficial = computed(() => {
  const official = getOfficialPlugin(targetPluginId.value)
  return Boolean(official && !isPluginSupportedOnCurrentPlatform(official))
})

const plugin = computed(() => {
  if (unsupportedOfficial.value) return null
  return getOfficialPlugin(targetPluginId.value) || dynamicPlugin.value
})

let currentLoadToken = 0

watch(
  [targetPluginId, targetFeatureCode],
  async ([id, featureCode]) => {
    const token = ++currentLoadToken
    dynamicPlugin.value = null
    loadError.value = ''

    if (!id || getOfficialPlugin(id)) {
      loadingDynamic.value = false
      if (unsupportedOfficial.value) loadError.value = `「${getOfficialPlugin(id).name}」在当前系统上暂不可用`
      return
    }

    loadingDynamic.value = true
    try {
      const loaded = await loadInstalledDeclarativePlugin(id, { featureCode })
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
  if (targetFeatureCode.value) query.feature = targetFeatureCode.value

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
  if (targetFeatureCode.value) query.feature = targetFeatureCode.value

  router.push(routeUtils.toDeclarative(targetPluginId.value, query))
}

function goBack() {
  router.push(ROUTES.HOME)
}

function handleExit() {
  if (effectiveIsPopout.value) return
  goBack()
}
</script>
