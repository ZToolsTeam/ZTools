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
      <!--
        面包屑：插件名 / 子页面标题。返回入口只在底栏（「返回工作台 Esc」/「返回 Esc」），这里不再重复；
        独立窗口的 Esc 提示也只在底栏显示一处。
      -->
      <nav class="flex items-center gap-2 min-w-0" aria-label="当前位置" style="-webkit-app-region: no-drag">
        <div v-if="headerPluginMeta" class="flex items-center gap-2 min-w-0">
          <RcSquircle :glyph="resolvePluginGlyph(headerPluginMeta.pluginId || headerPluginMeta.id || targetPluginId)" :fallback-glyph="resolveKeywordGlyph(headerPluginMeta.name || headerPluginMeta.title)" :size="22" />
          <span class="text-sm font-semibold text-[var(--rc-text-primary)] truncate" :title="headerPluginMeta.featureExplain || headerPluginMeta.name">{{ headerPluginMeta.name }}</span>
        </div>
        <template v-if="viewTitle">
          <span class="text-[var(--rc-text-faint)] flex-shrink-0" aria-hidden="true">/</span>
          <span class="text-sm text-[var(--rc-text-secondary)] truncate" data-decl-page-subtitle>{{ viewTitle }}</span>
        </template>
      </nav>

      <div class="flex items-center gap-2 flex-shrink-0" style="-webkit-app-region: no-drag">
        <!-- 主窗口模式：提供【独立窗口弹出】按钮 (携带当前搜索/筛选状态无缝接力) -->
        <button
          v-if="!effectiveIsPopout && headerPluginMeta"
          type="button"
          class="declarative-popout-btn flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] border border-[var(--rc-border)] transition-all cursor-pointer"
          title="弹出为独立常驻窗口，自动携带当前搜索与选中状态 (Ctrl+Shift+O)"
          @click="handlePopout"
        >
          <ExternalLinkIcon class="w-3.5 h-3.5" aria-hidden="true" />
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
            <PinIcon class="text-[11px]" />
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
      <!-- 独立窗口取交接状态期间（≤ 2 秒，与插件加载并行）先不挂载，避免插件用初始值渲染一帧再被替换 -->
      <template v-if="plugin && plugin.command && !handoffPending">
        <DeclarativeView
          ref="declarativeViewRef"
          :key="`${targetPluginId}:${targetFeatureCode}:${handoffMountKey}`"
          :rootComponent="plugin.command"
          :hideRootTitle="true"
          :isPopout="effectiveIsPopout"
          :initialSnapshot="initialSnapshot"
          :initialPopoutState="handoffSeed"
          :hostTitleBar="true"
          @exit="handleExit"
          @title-change="onViewTitleChange"
        />
      </template>

      <!-- 异步加载过渡占位：保持与画布同底色，杜绝在加载期间闪出警告图标或未找到报错卡片 -->
      <div
        v-else-if="loadingDynamic || handoffPending"
        data-test="declarative-loading-placeholder"
        class="h-full w-full bg-[var(--rc-canvas)]"
      />

      <!-- 异常状态处理 (Beyond Happy Path: 非法或不存在的插件ID) -->
      <DeclEmptyState
        v-else
        class="bg-[var(--rc-surface)] rounded-2xl border border-[var(--rc-border)]"
        :title="errorTitle"
        :description="errorDescription"
      >
        <template #icon>
          <TriangleAlertIcon class="w-5 h-5" aria-hidden="true" />
        </template>
        <template v-if="loadError && !unsupportedOfficial && !hiddenPlugin" #description>
          插件「<code class="font-mono text-[var(--rc-text-secondary)]">{{ targetPluginId || pluginId }}</code>」没有注册或加载失败。
          <span class="block mt-2 font-mono text-[var(--rc-error)] break-all">{{ loadError }}</span>
        </template>
        <button
          type="button"
          class="declarative-error-back-btn h-8 px-3.5 rounded-[var(--rc-radius-md)] text-xs font-medium bg-[var(--rc-surface-hover)] hover:bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] border border-[var(--rc-border)] transition-colors cursor-pointer"
          @click="goBack"
        >
          返回我的插件列表
        </button>
      </DeclEmptyState>
    </div>
  </div>
</template>

<script setup>
import { ExternalLinkIcon, PinIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getActivePinia } from 'pinia'
import { useUIStore } from '@/stores/ui'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
import { isPluginSupportedOnCurrentPlatform, isMacOS, isWindows } from '@/utils/platform'
import { isModalOpen } from '@/utils/keymap'
import { getCachedDeclarativePlugin, loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import DeclEmptyState from '@/declarative/components/DeclEmptyState.vue'
import { RcSquircle } from '@/components/base'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'
import { ROUTES, routeUtils } from '@/router/routes'
const loadHostWinApi = () => import("@/api/apiserver")
const nativeWin = {
  async setSize(width, height, animate) {
    const mod = typeof window !== "undefined" ? (window.ztools?.window || window.ztools?.win) : null
    if (mod?.setSize) return await mod.setSize(width, height, animate)
    const api = await loadHostWinApi()
    return await api.win.setSize(width, height, animate)
  },
  async setAlwaysOnTop(flag) {
    const mod = typeof window !== "undefined" ? (window.ztools?.window || window.ztools?.win) : null
    if (mod?.setAlwaysOnTop) return await mod.setAlwaysOnTop(flag)
    const api = await loadHostWinApi()
    return await api.win.setAlwaysOnTop(flag)
  }
}
import { getBundledPluginEntry, resolveBundledReplacement, resolveBundledReplacementFeature } from '@/utils/bundledPlugins'
import { useDeclarativePluginSession } from '@/declarative/composables/useDeclarativePluginSession'
import { isHandoffId, requestPopoutWindow, takePopoutHandoff } from '@/declarative/popoutHandoff'

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

const rawRequestedPluginId = computed(() => {
  return String(props.pluginId || route?.params?.pluginId || '').trim()
})

const targetPluginId = computed(() => {
  // 已合并进内置插件的旧插件（如 notes → memo）直接显示保留的那个
  return resolveBundledReplacement(rawRequestedPluginId.value)
})

const targetFeatureCode = computed(() => {
  const explicit = typeof route?.query?.feature === 'string' ? route.query.feature.trim() : ''
  return resolveBundledReplacementFeature(rawRequestedPluginId.value, explicit)
})

// 直接打开路由（旧快捷方式、历史记录）也要拦住当前系统上不能工作的插件
const unsupportedOfficial = computed(() => {
  const official = getOfficialPlugin(targetPluginId.value) || getBundledPluginEntry(targetPluginId.value)
  return Boolean(official && !isPluginSupportedOnCurrentPlatform(official))
})

const hiddenPlugin = computed(() => Boolean(targetPluginId.value) && !isPluginVisible(targetPluginId.value))

const plugin = computed(() => {
  if (unsupportedOfficial.value || hiddenPlugin.value) return null
  return getOfficialPlugin(targetPluginId.value) || dynamicPlugin.value
})

// 当前显示的已安装声明式插件持有会话归属（加密存储、结束进程等需要知道「是哪个插件」的能力依赖它）
useDeclarativePluginSession(plugin)

// 子页面标题（由声明式视图上报），显示在面包屑插件名之后；根页面为空
const viewTitle = ref('')
function onViewTitleChange(title) {
  viewTitle.value = typeof title === 'string' ? title : ''
}
// 切换插件或功能时视图会重建，旧的子页面标题不能留在面包屑里
watch([targetPluginId, targetFeatureCode], () => {
  viewTitle.value = ''
})

// 异常状态文案：未开放 / 当前系统不可用 / 未找到或加载失败
const errorTitle = computed(() => {
  if (hiddenPlugin.value) return '该插件暂未开放'
  if (unsupportedOfficial.value) return '当前系统暂不可用'
  return '未找到指定的声明式应用'
})

const errorDescription = computed(() => {
  if (hiddenPlugin.value) return '这个插件还在完善中，完成真实功能验收后才会开放。'
  if (unsupportedOfficial.value) return loadError.value
  return `插件「${targetPluginId.value || props.pluginId}」没有注册或加载失败。`
})

const headerPluginMeta = computed(() => {
  if (unsupportedOfficial.value || hiddenPlugin.value) return null
  return plugin.value || getBundledPluginEntry(targetPluginId.value)
})

// ---------------------------------------------------------------------------
// 独立窗口交接状态（usePopoutState）：URL 里的 handoff=<一次性编号> 出现或变化时取一次。
// 复用已有独立窗口时只有 hash 变化、页面不重载，因此要监听编号变化并用新初值重新挂载根组件。
// ---------------------------------------------------------------------------
const handoffPending = ref(false)
const handoffSeed = shallowRef(null)
const handoffMountKey = ref(0)
let handoffToken = 0
let lastHandoffKey = ''

const routeHandoffId = computed(() => {
  const value = route?.query?.handoff
  return typeof value === 'string' ? value : ''
})

function showViewToast(title, style = 'FAILURE') {
  try {
    declarativeViewRef.value?.showToast?.({ title, style })
  } catch (err) {
    console.warn("[DeclarativePage] 视图已卸载，忽略 Toast:", err)
  }
}

// 交接结果的提示要等视图挂载后再显示（取状态可能早于插件代码加载完成）
const pendingHandoffNotice = ref('')
watch(
  [declarativeViewRef, pendingHandoffNotice],
  ([view, notice]) => {
    if (!view || !notice) return
    pendingHandoffNotice.value = ''
    showViewToast(notice)
  },
  { flush: 'post' }
)

watch(
  [routeHandoffId, targetPluginId, targetFeatureCode, effectiveIsPopout],
  async ([handoffId, pluginId, featureCode, isPopout]) => {
    const key = `${handoffId}|${pluginId}|${featureCode}`
    if (!isPopout || !isHandoffId(handoffId) || !pluginId) {
      handoffToken++
      lastHandoffKey = ''
      handoffPending.value = false
      handoffSeed.value = null
      return
    }
    if (key === lastHandoffKey) return
    lastHandoffKey = key
    const token = ++handoffToken
    handoffPending.value = true
    let result
    try {
      result = await takePopoutHandoff({ handoffId, pluginId, featureCode })
    } catch (error) {
      result = { status: 'failed', error }
    }
    if (token !== handoffToken) return
    handoffSeed.value = result.status === 'ok' ? result.seed : null
    handoffMountKey.value += 1
    handoffPending.value = false
    pendingHandoffNotice.value = result.status === 'failed' || result.status === 'timeout'
      ? '未能恢复弹出前的内容'
      : result.notice || ''
  },
  { immediate: true }
)

let currentLoadToken = 0

watch(
  [targetPluginId, targetFeatureCode],
  async ([id, featureCode]) => {
    const token = ++currentLoadToken
    loadError.value = ''

    if (id && !isPluginVisible(id)) {
      dynamicPlugin.value = null
      loadingDynamic.value = false
      loadError.value = '该插件暂未开放'
      return
    }

    if (unsupportedOfficial.value) {
      dynamicPlugin.value = null
      loadingDynamic.value = false
      const meta = getOfficialPlugin(id) || getBundledPluginEntry(id)
      loadError.value = `「${meta?.name || id}」在当前系统上暂不可用`
      return
    }

    if (!id || getOfficialPlugin(id)) {
      dynamicPlugin.value = null
      loadingDynamic.value = false
      return
    }

    const cached = getCachedDeclarativePlugin(id, { featureCode })
    if (cached) {
      dynamicPlugin.value = cached
      loadingDynamic.value = false
      return
    }

    dynamicPlugin.value = null
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

// 互斥：⌘⇧O 连按或重复点击时只发起一次弹出
let popoutInFlight = false

async function handlePopout() {
  const id = targetPluginId.value
  if (!id || popoutInFlight) return
  popoutInFlight = true
  try {
    const snap = declarativeViewRef.value?.getViewStateSnapshot?.() || {}
    const query = {}
    if (snap.searchText) query.q = String(snap.searchText)
    if (snap.segmentedValue) query.seg = String(snap.segmentedValue)
    if (snap.dropdownValue) query.drop = String(snap.dropdownValue)
    if (snap.selectedId) query.sel = String(snap.selectedId)
    if (targetFeatureCode.value) query.feature = targetFeatureCode.value

    // 只取导航栈根页面的 usePopoutState；旧实例在独立窗口加载成功之后才卸载，失败不丢内容
    const collected = declarativeViewRef.value?.getPopoutState?.() || null
    const result = await requestPopoutWindow({ pluginId: id, query, collected })
    if (result.outcome === 'opened') {
      // 单实例互斥接管：弹出独立窗口成功后，主窗口退回工作台首页（销毁主窗口内的轮询实例）
      router.push(ROUTES.HOME)
      return
    }
    if (result.outcome === 'kept') {
      // 主进程明确拒绝（窗口数上限等）：保持原样，内容不动
      if (result.error?.code !== 'CANCELLED') {
        showViewToast(`无法打开独立窗口：${result.error?.message || '未知错误'}`)
      }
      return
    }
    // 宿主不支持多窗口或建窗失败：同窗口放大到 popout 页，状态已放进本窗口内存，由新页面取走
    try {
      await nativeWin?.setSize?.(1140, 760, true)
    } catch (err) {
      console.warn("[DeclarativePage] 调整窗口尺寸失败:", err)
    }
    router.push(routeUtils.toPopout(id, result.query))
  } finally {
    popoutInFlight = false
  }
}

async function toggleAlwaysOnTop() {
  const nextVal = !isAlwaysOnTop.value
  isAlwaysOnTop.value = nextVal
  try {
    await nativeWin?.setAlwaysOnTop?.(nextVal)
  } catch (err) {
    isAlwaysOnTop.value = !nextVal
    console.warn("[DeclarativePage] 设置窗口置顶失败:", err)
  }
}

async function dockBackToMain() {
  if (isAlwaysOnTop.value) {
    isAlwaysOnTop.value = false
    try {
      await nativeWin?.setAlwaysOnTop?.(false)
    } catch (err) {
      console.warn("[DeclarativePage] 取消窗口置顶失败:", err)
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
