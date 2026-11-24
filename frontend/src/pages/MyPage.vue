<script>
// 跨次挂载保留的首页状态：从插件返回时先按上次的样子直接画出来，
// 不再先闪「加载中」、也不会先按默认列数 / 默认顺序排一遍再跳到正确位置
const homeLayoutCache = { ready: false, gridColumns: 5, pinnedList: [], recentOrder: [], activeTab: 'plugins', showAllPlugins: false, focusedCardIndex: 0 }

/** 仅供测试：清空跨挂载缓存，模拟应用刚启动 */
export function resetHomeLayoutCache() {
  Object.assign(homeLayoutCache, { ready: false, gridColumns: 5, pinnedList: [], recentOrder: [], activeTab: 'plugins', showAllPlugins: false, focusedCardIndex: 0 })
}
</script>

<script setup>
import { SpinnerIcon } from '@/utils/appIcons'
import { confirmDialog } from '@/utils/confirmDialog'
import { ref, computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, watch } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useUserStore, cloudSync, onAuthRequired } from '@edition'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { usePluginInstall } from '@/composables/usePluginInstall'
import { useUIStore } from '@/stores/ui'
import PluginCard3D from '@/components/PluginCard3D.vue'
import PluginTile from '@/components/PluginTile.vue'
import PluginTileSkeleton from '@/components/PluginTileSkeleton.vue'
import { RcBannerLink, RcButton, RcEmpty, RcLoading, RcSegmented, RcSquircle } from '@/components/base'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'
import { formatRelativeTime } from '@/utils/relativeTime'
import { buildLaunchHotkeyMap } from '@/utils/launchHotkeyTargets'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import { Button } from 'ant-design-vue'
import { LayoutGridIcon, RocketIcon, StarIcon } from '@lucide/vue'
import { routeUtils, ROUTES } from '@/router/routes'
import { isClientProvidedPlugin } from '@/utils/officialPlugins'
import { isBundledPlugin } from '@/utils/bundledPlugins'
import { getHotkeyHostPlatform } from '@/utils/hotkeyRecorder'
import { useVisualGridNav } from '@/composables/useVisualGridNav'
import { SHELL_SHORTCUTS } from '@/utils/shellShortcuts'
import {
  useKeymap,
  registerKeyHandler,
  KEYMAP_SCOPES,
  dispatchKeyEvent,
  isComposingEvent,
  isModalOpen,
  isInteractiveControlTarget
} from '@/utils/keymap'
import { useAppI18n } from '@/i18n'
import { getLocalizedPluginName, getLocalizedPluginDescription, getLocalizedCategoryName } from '@/utils/pluginI18n'
import { resolveErrorMessage } from '@/utils/errorMessage'

const { t } = useAppI18n()

// Stores
const pluginsStore = usePluginsStore()
const { installWithFeedback } = usePluginInstall()
const userStore = useUserStore()
const uiStore = useUIStore()
const router = useRouter()
const hostPlatform = ref('unknown')
const {
  success,
  error,
  warning,
  info,
  toastError,
  toastSuccess,
  toastWarning
} = useToast()

const getPluginId = (pluginOrId) => {
  if (pluginOrId === null || pluginOrId === undefined) return ''
  if (typeof pluginOrId === 'object') {
    // 只使用 pluginId(业务标识符),不使用 id(数据库主键)
    return String(pluginOrId.pluginId || '').trim()
  }
  return String(pluginOrId).trim()
}

function normalizeOrderList(rawOrder) {
  if (Array.isArray(rawOrder)) {
    return rawOrder
      .map((id) => String(id || '').trim())
      .filter((id) => id !== '')
  }

  // 兼容旧格式：{ pluginId: index }
  if (rawOrder && typeof rawOrder === 'object') {
    return Object.entries(rawOrder)
      .map(([id, index]) => ({
        id: String(id || '').trim(),
        index: Number(index)
      }))
      .filter((item) => item.id !== '' && Number.isFinite(item.index))
      .sort((a, b) => a.index - b.index)
      .map((item) => item.id)
  }

  return []
}

function sortPluginsByCustomOrder(plugins, orderList) {
  if (!Array.isArray(orderList) || orderList.length === 0) return [...plugins]

  const orderMap = new Map(orderList.map((id, index) => [id, index]))
  return [...plugins].sort((a, b) => {
    const idA = getPluginId(a)
    const idB = getPluginId(b)
    const hasA = orderMap.has(idA)
    const hasB = orderMap.has(idB)

    if (hasA && hasB) return orderMap.get(idA) - orderMap.get(idB)
    if (hasA) return -1
    if (hasB) return 1
    return 0
  })
}

// 使用 Store 的状态
const installedSet = computed(() => pluginsStore.installedSet)
const updateMap = computed(() => pluginsStore.updateMap)
const downloadingSet = computed(() => pluginsStore.downloadingSet)
const installFailedSet = computed(() => pluginsStore.installFailedSet)

// State
const loading = ref(!homeLayoutCache.ready) // 首次进入才显示加载状态
const showDragTip = ref(true)
const syncing = ref(false)
const syncError = ref(null)
const selectedPlugin = ref(null)
const showMenu = ref(false)
const menuPosition = ref({ x: 0, y: 0 })
const draggingPlugin = ref(null)
const dragOverIndex = ref(null)
const recentOrder = ref([...homeLayoutCache.recentOrder])
const showAllPlugins = ref(Boolean(homeLayoutCache.showAllPlugins)) // 控制"我的插件"折叠/展开
const activeTab = ref(homeLayoutCache.activeTab || 'plugins') // 'plugins' | 'favorites' - 标签切换
const pinnedList = ref([...homeLayoutCache.pinnedList]) // 响应式固定列表
const focusedCardIndex = ref(Number(homeLayoutCache.focusedCardIndex) || 0) // 键盘流当前聚焦的卡片索引
const myPageRootRef = ref(null)
const isPageActive = ref(true)
const menuFocusedActionIndex = ref(0)

// Constants
const MAX_PINNED_COUNT = 8
const DEFAULT_ROWS = 2 // 「常用」默认显示行数
const RECENT_LIMIT = 5 // 「最近使用」最多显示条数

// 网格实际列数：auto-fill 会随窗口宽度变化，键盘上下移动与默认显示数量都以真实列数为准。
// 观察的是两个标签共用的内容区（始终存在），从其中任一磁贴网格读列数：两个标签宽度相同，列数也相同
const gridBodyRef = ref(null)
const gridColumns = ref(homeLayoutCache.gridColumns)
let gridObserver = null
let observedGridEl = null
let lastObservedWidth = null
let gridMeasureRafId = null
let hasMounted = false

function cancelPendingGridMeasure() {
  if (gridMeasureRafId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(gridMeasureRafId)
  }
  gridMeasureRafId = null
}

function measureGridColumns(container) {
  const el = container?.querySelector?.('.plugin-tile-grid')
  if (!el) return
  const template = getComputedStyle(el).gridTemplateColumns || ''
  const count = template.split(' ').filter((part) => part && part !== 'none').length
  if (count > 0 && count !== gridColumns.value) {
    gridColumns.value = count
    homeLayoutCache.gridColumns = count
  }
}

function scheduleMeasureGridColumns() {
  cancelPendingGridMeasure()
  if (typeof requestAnimationFrame !== 'function') {
    measureGridColumns(gridBodyRef.value)
    return
  }
  gridMeasureRafId = requestAnimationFrame(() => {
    gridMeasureRafId = null
    if (isUnmounted) return
    measureGridColumns(gridBodyRef.value)
  })
}

function syncObservedGridElement(el) {
  if (observedGridEl === el) return
  if (observedGridEl && gridObserver) {
    if (typeof gridObserver.unobserve === 'function') {
      gridObserver.unobserve(observedGridEl)
    } else {
      gridObserver.disconnect()
    }
  }
  observedGridEl = el || null
  lastObservedWidth = null
  cancelPendingGridMeasure()
  if (!el) return
  measureGridColumns(el)
  if (gridObserver) {
    gridObserver.observe(el)
  }
}

watch(
  gridBodyRef,
  (el) => {
    if (!hasMounted || isUnmounted) return
    syncObservedGridElement(el)
  },
  { flush: 'post' }
)
const DEBOUNCE_DELAY = 300

// Debounce timer
let reorderDebounceTimer = null
let isUnmounted = false

function isHomeSearchFocused() {
  const active = document.activeElement
  return !!active?.closest?.('.home-search-shell')
}

async function restoreHomeSearchFocusIfNeeded(shouldRestore) {
  if (!shouldRestore) return

  await nextTick()
  window.__ztoolsFocusHomeSearch?.()
}

// Computed - 判断是否为新用户（没有已安装插件且没有收藏）
const isNewUser = computed(() => {
  const hasInstalled = (pluginsStore.installedPlugins || []).length > 0
  const hasFavorites = pluginsStore.favorites.size > 0
  return !hasInstalled && !hasFavorites
})

// Computed - 已安装插件列表（按最近使用排序）
const installedPlugins = computed(() => {
  const plugins = pluginsStore.installedPlugins || []
  // 分离固定和未固定的插件
  const pinned = plugins.filter((p) => isPinned(getPluginId(p)))
  const unpinned = plugins.filter((p) => !isPinned(getPluginId(p)))
  const orderList = recentOrder.value

  // 固定插件：优先用 recentOrder，没有记录的按 pinnedList 中的固定先后顺序排
  const pinnedOrder = pinnedList.value
  const sortedPinned = [...pinned].sort((a, b) => {
    const idA = getPluginId(a)
    const idB = getPluginId(b)
    const recentIdxA = orderList.indexOf(idA)
    const recentIdxB = orderList.indexOf(idB)

    // 都在 recentOrder 中，按 recentOrder 排
    if (recentIdxA !== -1 && recentIdxB !== -1) return recentIdxA - recentIdxB
    // 只有一个在 recentOrder 中，有记录的排前面
    if (recentIdxA !== -1) return -1
    if (recentIdxB !== -1) return 1
    // 都不在 recentOrder 中，按 pinnedList 的固定先后顺序排
    const pinIdxA = pinnedOrder.indexOf(idA)
    const pinIdxB = pinnedOrder.indexOf(idB)
    return pinIdxA - pinIdxB
  })

  const sortedUnpinned = sortPluginsByCustomOrder(unpinned, orderList)

  return [...sortedPinned, ...sortedUnpinned]
})

// Computed - 当前标签显示的列表
const currentTabList = computed(() => {
  if (activeTab.value === 'plugins') {
    return installedPlugins.value
  } else {
    return favoritePlugins.value
  }
})

// Computed - 显示的插件（根据折叠状态）
const displayedPlugins = computed(() => {
  const all = currentTabList.value
  if (showAllPlugins.value) return all
  return all.slice(0, gridColumns.value * DEFAULT_ROWS)
})

// Computed - 是否有更多插件需要折叠
const hasMorePlugins = computed(() => {
  return currentTabList.value.length > gridColumns.value * DEFAULT_ROWS
})

// 收藏详情在首屏后才从市场接口加载：加载完之前只知道收藏了几个，用同样数量的占位磁贴，
// 不先显示「还没有收藏的插件」再突然冒出磁贴
const favoritesPending = computed(
  () => pluginsStore.favorites.size > 0 && !pluginsStore.favoritePluginsLoaded
)

// Computed - 插件数量
const installedCount = computed(() => installedPlugins.value.length)
const favoritesCount = computed(() =>
  favoritesPending.value ? pluginsStore.favorites.size : favoritePlugins.value.length
)

// 两个标签叠放在同一格里，内容区高度取较高的一个，切换标签时下面的区块不会跳动
const MY_PLUGIN_TABS = ['plugins', 'favorites']

// 标签显示真实磁贴：当前标签、收藏详情已就绪且有内容
function showsRealTiles(tab) {
  return tab === activeTab.value && !(tab === 'favorites' && favoritesPending.value) && displayedPlugins.value.length > 0
}

// 占位磁贴数（收起状态，0 表示空状态）：用于另一个标签预留高度，以及收藏详情加载中
function placeholderTileCount(tab) {
  const total = tab === 'plugins' ? installedCount.value : favoritesCount.value
  return Math.min(total, gridColumns.value * DEFAULT_ROWS)
}

// 切换标签时重置展开状态并钳制焦点索引
function switchTab(tab) {
  activeTab.value = tab
  showAllPlugins.value = false
  clampFocusedCardIndex()
}

function toggleShowAllPlugins() {
  showAllPlugins.value = !showAllPlugins.value
  if (!showAllPlugins.value) {
    clampFocusedCardIndex()
  }
}

// Computed - 收藏的插件（从 store 独立获取的完整数据）
const favoritePlugins = computed(() => {
  return pluginsStore.favoritePluginsList || []
})

// Computed - 推荐插件
// 最近使用：按打开记录倒序，只保留仍然安装着的插件
const recentPlugins = computed(() => {
  const byId = new Map((pluginsStore.installedPlugins || []).map((p) => [getPluginId(p), p]))
  const list = []
  // recents 是插件 ID 列表；recentItems getter 依赖市场数据 items，离线或未加载时为空，这里不用它
  for (const id of pluginsStore.recents || []) {
    const plugin = byId.get(id)
    if (plugin) list.push(plugin)
    if (list.length >= RECENT_LIMIT) break
  }
  return list
})

// 与 PluginCard3D 一致：updateMap 对每个插件都有记录，只有 hasUpdate 且兼容时才算可更新
function hasUsableUpdate(id) {
  const info = updateMap.value?.[id]
  return Boolean(info?.hasUpdate && !info?.incompatible)
}

// 插件启动快捷键：{ [pluginId]: 'Alt+V' }，与设置页 / 快捷键弹窗同源（触发器列表）
const launchHotkeys = ref({})
async function loadLaunchHotkeys() {
  try {
    if (!window.ztools?.trigger?.list) return
    const result = await window.ztools.trigger.list()
    const triggers = result?.data || result || []
    const map = buildLaunchHotkeyMap(triggers, getPluginFeatureHotkeyItemByTrigger)
    const next = {}
    for (const [id, entry] of Object.entries(map)) {
      if (entry.kind === 'plugin' && typeof entry.key === 'string' && entry.key) next[id] = entry.key
    }
    launchHotkeys.value = next
  } catch (error) {
    // 快捷键只是辅助信息，加载失败不影响工作台
    console.warn('[MyPage] 加载插件快捷键失败:', error)
  }
}

function recentTimeLabel(plugin) {
  return formatRelativeTime(pluginsStore.recentUsedAt?.[getPluginId(plugin)])
}

// 磁贴点击：已安装直接打开（与 Enter 一致），未安装的收藏项进入详情页
function onTileOpen(plugin) {
  const id = getPluginId(plugin)
  if (!id) return
  if (installedSet.value.has(id)) {
    handleOpenPlugin(id)
  } else {
    goDetails(id)
  }
}

const recommendedPlugins = computed(() => {
  return (pluginsStore.recommendedItems || [])
    .filter((p) => !pluginsStore.installedSet.has(getPluginId(p)))
    .slice(0, 8)
})

const activeTilePlugins = computed(() => {
  if (isNewUser.value) return []
  if (activeTab.value === 'favorites' && favoritesPending.value) return []
  return displayedPlugins.value
})

const activeRecentPlugins = computed(() => {
  if (isNewUser.value) return []
  return recentPlugins.value
})

// 统一三区块可导航条目列表：磁贴网格 -> 最近使用 -> 热门推荐
const navigableItems = computed(() => {
  const list = []
  const cols = Math.max(1, Number(gridColumns.value) || 4)
  for (const plugin of activeTilePlugins.value) {
    list.push({ plugin, section: 'tiles', cols })
  }
  for (const plugin of activeRecentPlugins.value) {
    list.push({ plugin, section: 'recents', cols: 1 })
  }
  for (const plugin of recommendedPlugins.value) {
    list.push({ plugin, section: 'recommended', cols: 2 })
  }
  return list
})

function recentNavIndex(rIdx) {
  return activeTilePlugins.value.length + rIdx
}

function recommendedNavIndex(recIdx) {
  return activeTilePlugins.value.length + activeRecentPlugins.value.length + recIdx
}

const pinnedCount = computed(() => {
  return (installedPlugins.value || []).filter((p) => isPinned(getPluginId(p)))
    .length
})

const canPin = computed(() => pinnedCount.value < MAX_PINNED_COUNT)

// Local config helpers (使用 ztools.config 持久化，不依赖 localStorage)
// 本地存储使用 my_page_settings.json，云端同步使用 user_settings.json

async function loadPinnedList() {
  try {
    if (window.ztools?.config) {
      const data = await window.ztools.config.get(
        'my-page.pinned',
        '[]',
        'my_page_settings.json'
      )
      const parsed = typeof data === 'string' ? JSON.parse(data) : data
      return Array.isArray(parsed) ? parsed : []
    }
  } catch (e) {
    // 读取失败返回 null：调用方保留当前列表，不把已有的固定项清空
    console.warn('加载固定列表失败:', e)
    return null
  }
  return []
}

function getPinnedList() {
  return pinnedList.value
}

async function savePinnedList(list) {
  try {
    pinnedList.value = [...list]
    if (window.ztools?.config) {
      await window.ztools.config.set(
        'my-page.pinned',
        JSON.stringify(list),
        false,
        'my_page_settings.json'
      )
    }
  } catch (e) {
    error(t('myPage.savePinnedFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
  }
}

function getRecentOrder() {
  return recentOrder.value
}

async function loadRecentOrder() {
  try {
    if (window.ztools?.config) {
      const data = await window.ztools.config.get(
        'my-page.recent-order',
        '[]',
        'my_page_settings.json'
      )
      const parsed = typeof data === 'string' ? JSON.parse(data) : data
      return normalizeOrderList(parsed)
    }
  } catch (e) {
    // 读取失败返回 null：调用方保留当前顺序，不把用户拖好的顺序打乱
    console.warn('加载排序失败:', e)
    return null
  }
  return []
}

async function saveRecentOrder(order) {
  try {
    const normalized = normalizeOrderList(order)
    recentOrder.value = normalized
    if (window.ztools?.config) {
      await window.ztools.config.set(
        'my-page.recent-order',
        JSON.stringify(normalized),
        false,
        'my_page_settings.json'
      )
    }
  } catch (e) {
    error(t('myPage.saveOrderFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
  }
}

// 注意：pinnedList 和 recentOrder 的初始化在 onMounted 中异步完成

// Plugin management
function isPinned(pluginId) {
  return getPinnedList().includes(pluginId)
}

// 将当前 installedPlugins 的顺序快照持久化到 recentOrder
// 确保固定/取消固定操作后排序不会因重启丢失
async function persistCurrentOrder() {
  const currentOrder = installedPlugins.value
    .map((item) => getPluginId(item))
    .filter((id) => id !== '')
  await saveRecentOrder(currentOrder)

  if (userStore.isLoggedIn) {
    syncOrderToCloud()
  }
}

async function pinPlugin(pluginId) {
  if (!canPin.value) {
    warning(t('myPage.maxPinnedWarning', { count: MAX_PINNED_COUNT }, MAX_PINNED_COUNT))
    return
  }

  const pinned = getPinnedList()
  if (!pinned.includes(pluginId)) {
    pinned.push(pluginId)
    await savePinnedList(pinned)
    // 固定后立即持久化当前排序，防止重启后丢失
    await persistCurrentOrder()
    success(t('common.pinned'))

    if (userStore.isLoggedIn) {
      syncPinnedToCloud()
    }
  }
}

async function unpinPlugin(pluginId) {
  const pinned = getPinnedList()
  const index = pinned.indexOf(pluginId)
  if (index > -1) {
    pinned.splice(index, 1)
    await savePinnedList(pinned)
    // 取消固定后立即持久化当前排序
    await persistCurrentOrder()
    success(t('common.unpin'))

    if (userStore.isLoggedIn) {
      syncPinnedToCloud()
    }
  }
}

function togglePin(pluginId) {
  if (isPinned(pluginId)) {
    unpinPlugin(pluginId)
  } else {
    pinPlugin(pluginId)
  }
}

// Drag and drop
// 标记是否已在 drop 中处理过，防止 dragend 重复执行
let dropHandled = false

function handleDragStart(plugin, index) {
  if (activeTab.value !== 'plugins') return
  draggingPlugin.value = plugin
  dragOverIndex.value = index
  dropHandled = false
  hideDragTip()
}

function handleDragOver(index) {
  if (activeTab.value !== 'plugins') return
  dragOverIndex.value = index
}

function handleDrop(index) {
  if (activeTab.value !== 'plugins') return
  dragOverIndex.value = index

  if (draggingPlugin.value && dragOverIndex.value !== null) {
    reorderPlugins(draggingPlugin.value, dragOverIndex.value)
  }
  dropHandled = true
  draggingPlugin.value = null
  dragOverIndex.value = null
}

function handleDragEnd() {
  if (activeTab.value !== 'plugins') {
    draggingPlugin.value = null
    dragOverIndex.value = null
    return
  }

  // 如果 drop 已经处理过，不再重复执行
  if (!dropHandled && draggingPlugin.value && dragOverIndex.value !== null) {
    reorderPlugins(draggingPlugin.value, dragOverIndex.value)
  }
  draggingPlugin.value = null
  dragOverIndex.value = null
  dropHandled = false
}

function reorderPlugins(plugin, toIndex) {
  const pluginId = getPluginId(plugin)
  if (!pluginId) return

  const allPlugins = installedPlugins.value || []
  if (!allPlugins.length) return

  const sourceIsPinned = isPinned(pluginId)
  const sourceGroup = allPlugins.filter(
    (item) => isPinned(getPluginId(item)) === sourceIsPinned
  )

  const fromGroupIndex = sourceGroup.findIndex(
    (item) => getPluginId(item) === pluginId
  )
  if (fromGroupIndex < 0) return

  const targetPlugin = displayedPlugins.value[toIndex] || allPlugins[toIndex]
  if (!targetPlugin) return

  const targetId = getPluginId(targetPlugin)
  if (!targetId) return

  // 固定与未固定分组不允许跨组拖拽，保持固定组始终在前
  if (isPinned(targetId) !== sourceIsPinned) return

  const toGroupIndex = sourceGroup.findIndex(
    (item) => getPluginId(item) === targetId
  )
  if (toGroupIndex < 0 || toGroupIndex === fromGroupIndex) return

  const reorderedGroup = [...sourceGroup]
  const [moved] = reorderedGroup.splice(fromGroupIndex, 1)
  reorderedGroup.splice(toGroupIndex, 0, moved)

  const pinnedGroup = sourceIsPinned
    ? reorderedGroup
    : allPlugins.filter((item) => isPinned(getPluginId(item)))
  const unpinnedGroup = sourceIsPinned
    ? allPlugins.filter((item) => !isPinned(getPluginId(item)))
    : reorderedGroup

  const nextOrder = [...pinnedGroup, ...unpinnedGroup]
    .map((item) => getPluginId(item))
    .filter((id) => id !== '')

  // 先更新内存顺序，保证拖拽后立即生效
  recentOrder.value = nextOrder

  if (reorderDebounceTimer) {
    clearTimeout(reorderDebounceTimer)
  }

  reorderDebounceTimer = setTimeout(async () => {
    await saveRecentOrder(nextOrder)
    success(t('myPage.orderSaved'))

    if (userStore.isLoggedIn) {
      syncOrderToCloud()
    }
    reorderDebounceTimer = null
  }, DEBOUNCE_DELAY)
}

// Menu handling
function showPluginMenu(plugin, event, meta = null) {
  event?.preventDefault?.()
  const incomingId = getPluginId(plugin)
  // 点击同一张卡片的快捷菜单按钮时，再次点击可收起菜单
  if (
    meta?.source === 'button' &&
    showMenu.value &&
    incomingId &&
    getPluginId(selectedPlugin.value) === incomingId
  ) {
    hideMenu()
    return
  }

  selectedPlugin.value = plugin
  if (meta?.anchorRect) {
    const viewportW = window.innerWidth || 1024
    const viewportH = window.innerHeight || 768
    menuPosition.value = {
      x: Math.max(8, Math.min(viewportW - 180, Math.round(meta.anchorRect.right - 152))),
      y: Math.max(8, Math.min(viewportH - 210, Math.round(meta.anchorRect.bottom + 6)))
    }
  } else {
    menuPosition.value = { x: event?.clientX ?? 0, y: event?.clientY ?? 0 }
  }
  showMenu.value = true
}

function hideMenu() {
  showMenu.value = false
  selectedPlugin.value = null
}

// Plugin actions
async function handleOpenPlugin(pluginId) {
  const id = getPluginId(pluginId)
  if (!id) return
  if (pluginsStore.isRevoked(id)) {
    const reason = pluginsStore.getRevokedReason(id) || t('market.revokedDefaultReason')
    toastError(t('market.cannotLaunch', { reason }))
    return
  }
  try {
    const res = await pluginsStore.openPlugin(id)
    if (res?.action === 'navigate_to_detail') {
      toastWarning(resolveErrorMessage(res, 'details.notInstalledReinstall'))
      router.push(routeUtils.toPluginDetails(res.pluginId || id))
    }
  } catch (e) {
    toastError(t('details.launchFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
  }
}

// 跳转到插件详情页
function goDetails(id) {
  router.push(routeUtils.toPluginDetails(id))
}

// 打开已安装的插件
async function openApp(id) {
  const pluginId = getPluginId(id)
  if (!pluginId) return

  if (pluginsStore.isRevoked(pluginId)) {
    const reason = pluginsStore.getRevokedReason(pluginId) || t('market.revokedDefaultReason')
    toastError(t('market.cannotLaunch', { reason }))
    return
  }

  try {
    const res = await pluginsStore.openPlugin(pluginId)

    if (res?.cancelled || res?.isDeclarative) return

    // 检查是否需要导航到详情页（插件已卸载的情况）
    if (res?.action === 'navigate_to_detail') {
      toastWarning(resolveErrorMessage(res, 'details.notInstalledReinstall'))
      router.push(routeUtils.toPluginDetails(res.pluginId || id))
      return
    }

    if (res?.success) {
      toastSuccess(t('market.pluginOpened'))
    } else {
      toastError(t('market.openFailed'))
    }
  } catch (e) {
    toastError(t('market.openFailedWithReason', { reason: resolveErrorMessage(e, 'common.unknownError') }))
  }
}

// 一键静默安装插件（支持并发互斥与自动进舞台）
function handleDownload(id) {
  return installWithFeedback(getPluginId(id))
}

// 插件更新完成回调（保留兼容性，实际由 handlePluginInstalled 处理）
function onPluginUpdated(pluginId) {
}

async function handleToggleFavorite(pluginId) {
  try {
    const id = getPluginId(pluginId)
    if (!id) {
      toastError(t('details.pluginIdMissing'))
      return
    }
    const wasFavorite = pluginsStore.isFavorite(id)
    await pluginsStore.toggleFavorite(id)
    toastSuccess(wasFavorite ? t('market.favoriteRemoved') : t('market.favoriteAdded'))
  } catch (e) {
    if (!onAuthRequired(e)) {
      console.error('toggleFavorite error:', e)
      toastError(t('market.operationFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
    }
  }
}

// 已安装且非宿主系统内置页的插件允许卸载（随客户端内置的 9 款基础插件引导至设置页假卸载；收藏页中尚未安装的插件不显示卸载）
function canUninstallPlugin(pluginId) {
  return (
    Boolean(pluginId) &&
    installedSet.value.has(pluginId) &&
    (isBundledPlugin(pluginId) || !isClientProvidedPlugin(pluginId))
  )
}

function navigateToBundledManage(pluginId) {
  if (showMenu.value) hideMenu()
  info(t('details.manageBundledInSettings'))
  router.push({
    ...ROUTES.ADVANCED_SETTINGS,
    query: { manageBundled: pluginId }
  })
}

function handleUninstallPlugin(pluginId, options = {}) {
  if (!pluginId || !installedSet.value.has(pluginId)) {
    if (showMenu.value) hideMenu()
    return
  }
  if (!canUninstallPlugin(pluginId)) {
    // 键盘 Delete 触发时菜单并没有打开，不能顺手清掉当前选中的插件
    if (showMenu.value) hideMenu()
    toastError(t('details.builtinCannotUninstall'))
    return
  }
  if (isBundledPlugin(pluginId)) {
    if (options.source === 'menu') {
      navigateToBundledManage(pluginId)
      return
    }
    confirmDialog({
      title: t('myPage.manageBundledTitle'),
      content: t('myPage.manageBundledContent'),
      okText: t('myPage.goToSettings'),
      cancelText: t('common.cancel'),
      onOk() {
        navigateToBundledManage(pluginId)
      }
    })
    return
  }
  confirmDialog({
    title: t('myPage.confirmUninstallTitle'),
    content: t('myPage.confirmUninstallContent'),
    okText: t('common.uninstall'),
    cancelText: t('common.cancel'),
    async onOk() {
      hideMenu()
      try {
        const result = await pluginsStore.uninstallPlugin(pluginId)
        if (!result?.success) {
          throw new Error(resolveErrorMessage(result, 'common.unknownError'))
        }
        clampFocusedCardIndex()
        toastSuccess(t('market.uninstallSuccess'))
      } catch (e) {
        toastError(t('market.uninstallFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
      }
    }
  })
}

// Navigation
function goToMarket() {
  router.push({ name: 'list' })
}

// Event handlers
function getEventPayload(eventOrEnvelope) {
  if (eventOrEnvelope?.payload && typeof eventOrEnvelope.payload === 'object') {
    return eventOrEnvelope.payload
  }

  return eventOrEnvelope || {}
}

function handlePluginInstalled(event) {
  const payload = getEventPayload(event)
  if (!pluginsStore.acceptsInstallEvent(payload)) return
  const pluginId = payload.pluginId
  if (pluginId) {
    if (payload.success) {
      pluginsStore.fetchInstalledPlugins().then(() => {
        // 安装后推送插件列表到云端
        syncPluginListToCloud()
      })
      // 根据 isUpdate 区分安装和更新的提示
      if (payload.isUpdate) {
        toastSuccess(t('market.updateComplete'))
      } else {
        info(t('myPage.pluginInstalled'))
      }
    } else {
      toastError(t('myPage.pluginInstallFailed', { reason: resolveErrorMessage(payload, 'common.unknownError') }))
    }
  }
}

function handlePluginUninstalled(event) {
  const payload = getEventPayload(event)
  const pluginId = payload.pluginId
  if (pluginId) {
    const pinned = getPinnedList()
    const index = pinned.indexOf(pluginId)
    if (index > -1) {
      pinned.splice(index, 1)
      savePinnedList(pinned)
    }

    const nextOrder = getRecentOrder().filter((id) => id !== String(pluginId))
    saveRecentOrder(nextOrder)

    pluginsStore.fetchInstalledPlugins().then(() => {
      clampFocusedCardIndex()
      // 卸载后推送插件列表、排序、固定到云端
      if (userStore.isLoggedIn) {
        pluginsStore.pushToCloud({
          plugin_list: (pluginsStore.installedPlugins || [])
            .map((p) => getPluginId(p))
            .filter(Boolean),
          plugin_order: nextOrder,
          pinned_list: getPinnedList()
        })
      }
    })
    info(t('market.uninstallSuccess'))
  }
}

// 云同步：经插件 store 的 pushToCloud 推送（只有官方版登录后才真正推送）
async function syncPinnedToCloud() {
  if (!userStore.isLoggedIn) return

  syncing.value = true
  syncError.value = null

  try {
    await pluginsStore.pushToCloud({
      pinned_list: getPinnedList()
    })
  } catch (e) {
    syncError.value = resolveErrorMessage(e, 'common.unknownError')
    console.warn('同步固定列表失败:', e)
  } finally {
    syncing.value = false
  }
}

async function syncOrderToCloud() {
  if (!userStore.isLoggedIn) return

  syncing.value = true
  syncError.value = null

  try {
    await pluginsStore.pushToCloud({
      plugin_order: getRecentOrder()
    })
  } catch (e) {
    syncError.value = resolveErrorMessage(e, 'common.unknownError')
    console.warn('同步排序失败:', e)
  } finally {
    syncing.value = false
  }
}

/**
 * 推送当前已安装插件列表到云端
 */
async function syncPluginListToCloud() {
  if (!userStore.isLoggedIn) return

  try {
    const ids = (pluginsStore.installedPlugins || [])
      .map((p) => getPluginId(p))
      .filter(Boolean)
    await pluginsStore.pushToCloud({ plugin_list: ids })
  } catch (e) {
    console.warn('同步插件列表失败:', e)
  }
}

// Drag tip
function hideDragTip() {
  showDragTip.value = false
  if (window.ztools?.config) {
    window.ztools.config
      .set('my-page.drag-tip-shown', 'true', false, 'my_page_settings.json')
      .catch((err) => {
        console.warn('保存拖拽提示状态失败:', err)
      })
  }
}

const gridNav = useVisualGridNav({
  focusedIndex: focusedCardIndex,
  containerRef: myPageRootRef,
  focusedSelector: '.is-card-focused, .is-recent-focused',
  getTotalCount: () => navigableItems.value.length,
  getFallbackColumns: () => Math.max(1, Number(gridColumns.value) || 4),
  getGroup: (idx) => navigableItems.value[idx]?.section || '',
  getColumns: (idx) => navigableItems.value[idx]?.cols || 2,
  onFocusGrid: () => uiStore.focusGrid(),
  onReachTop: () => {
    if (typeof window !== 'undefined' && typeof window.__ztoolsFocusHomeSearch === 'function') {
      window.__ztoolsFocusHomeSearch()
      uiStore.focusSearch()
      return true
    }
    return false
  }
})

function clampFocusedCardIndex() {
  const totalLen = navigableItems.value.length
  if (totalLen <= 0) {
    focusedCardIndex.value = 0
  } else if (focusedCardIndex.value >= totalLen) {
    focusedCardIndex.value = totalLen - 1
  }
  gridNav.resetAnchor()
}

function handleNavFocus(idx) {
  gridNav.setFocusedIndex(idx)
  uiStore.focusGrid()
}

watch(
  () => installedPlugins.value.length,
  (newLen, oldLen) => {
    if (oldLen > 0 && newLen < oldLen) {
      clampFocusedCardIndex()
    }
  }
)

function openCardActionMenu(plugin) {
  if (!plugin) return
  selectedPlugin.value = plugin
  const container = myPageRootRef.value || (typeof document !== 'undefined' ? document : null)
  const navEl =
    container?.querySelector?.(`[data-nav-index="${focusedCardIndex.value}"]`) ||
    (typeof document !== 'undefined' ? document.querySelector('.is-card-focused, .is-recent-focused') : null)
  const rect = navEl?.getBoundingClientRect?.()
  const viewportW = (typeof window !== 'undefined' && window.innerWidth) || 1024
  const viewportH = (typeof window !== 'undefined' && window.innerHeight) || 768
  const hasRect = Boolean(rect && (rect.width > 0 || rect.height > 0 || rect.left !== 0 || rect.top !== 0))
  menuPosition.value = {
    x: Math.max(8, Math.min(viewportW - 200, hasRect ? Math.round(rect.left + 12) : 160)),
    y: Math.max(8, Math.min(viewportH - 220, hasRect ? Math.round(rect.bottom + 6) : 240))
  }
  showMenu.value = true
}

// 右键快捷菜单动作列表（保持与原 DOM 结构与行为完全一致，同时驱动键盘上下选择与回车执行）
const contextMenuItems = computed(() => {
  const plugin = selectedPlugin.value
  if (!plugin) return []
  const pid = getPluginId(plugin)
  if (!pid) return []

  const items = []
  if (pluginsStore.isRevoked(pid)) {
    items.push({
      key: 'revoked',
      label:
        pluginsStore.getRevokedKind(pid) === 'platform'
          ? t('myPage.menu.platformUnsupported')
          : t('myPage.menu.revoked'),
      disabled: true,
      title: pluginsStore.getRevokedReason(pid),
      style: 'opacity: 0.5; cursor: not-allowed; color: var(--rc-error);'
    })
  } else if (installedSet.value.has(pid)) {
    items.push({
      key: 'open',
      label: t('common.open'),
      disabled: false,
      action: () => {
        handleOpenPlugin(pid)
        hideMenu()
      }
    })
  } else if (downloadingSet.value.has(pid)) {
    items.push({
      key: 'downloading',
      label: t('myPage.menu.installing'),
      disabled: true,
      style: 'opacity: 0.6; cursor: not-allowed;'
    })
  } else {
    items.push({
      key: 'install',
      label: t('common.install'),
      disabled: false,
      action: () => {
        handleDownload(pid)
        hideMenu()
      }
    })
  }

  items.push({
    key: 'details',
    label: t('myPage.menu.viewDetails'),
    disabled: false,
    action: () => {
      goDetails(pid)
      hideMenu()
    }
  })

  items.push({
    key: 'favorite',
    label: pluginsStore.isFavorite(pid) ? t('common.unfavorite') : t('common.favorite'),
    disabled: false,
    action: () => {
      handleToggleFavorite(pid)
      hideMenu()
    }
  })

  if (installedSet.value.has(pid)) {
    items.push({
      key: 'pin',
      label: isPinned(pid) ? t('common.unpin') : t('myPage.menu.pinTop'),
      disabled: false,
      action: () => {
        togglePin(pid)
        hideMenu()
      }
    })
  }

  if (canUninstallPlugin(pid)) {
    const bundled = isBundledPlugin(pid)
    items.push({
      key: 'uninstall',
      label: bundled ? t('myPage.manageBundledTitle') : t('common.uninstall'),
      danger: !bundled,
      dividerBefore: true,
      disabled: false,
      action: () => {
        handleUninstallPlugin(pid, { source: 'menu' })
      }
    })
  }

  return items
})

function findFirstEnabledMenuIndex(items) {
  const idx = items.findIndex((it) => !it.disabled)
  return idx >= 0 ? idx : 0
}

function findLastEnabledMenuIndex(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i].disabled) return i
  }
  return 0
}

function moveMenuFocus(delta) {
  const items = contextMenuItems.value
  const enabledIndices = []
  for (let i = 0; i < items.length; i++) {
    if (!items[i].disabled) enabledIndices.push(i)
  }
  if (enabledIndices.length === 0) return
  const curPos = enabledIndices.indexOf(menuFocusedActionIndex.value)
  if (curPos === -1) {
    menuFocusedActionIndex.value = delta >= 0 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]
    return
  }
  const nextPos = (curPos + delta + enabledIndices.length) % enabledIndices.length
  menuFocusedActionIndex.value = enabledIndices[nextPos]
}

// 右键菜单打开时挂载模态键盘作用域（初始停用，随 showMenu && selectedPlugin 动态启停）
const contextMenuKeymap = registerKeyHandler(
  KEYMAP_SCOPES.ACTION_PANEL,
  {
    'ArrowDown': () => {
      moveMenuFocus(1)
      return true
    },
    'ArrowUp': () => {
      moveMenuFocus(-1)
      return true
    },
    'Home': () => {
      menuFocusedActionIndex.value = findFirstEnabledMenuIndex(contextMenuItems.value)
      return true
    },
    'End': () => {
      menuFocusedActionIndex.value = findLastEnabledMenuIndex(contextMenuItems.value)
      return true
    },
    'Enter': () => {
      const item = contextMenuItems.value[menuFocusedActionIndex.value]
      if (item && !item.disabled && typeof item.action === 'function') {
        item.action()
      }
      return true
    },
    'Escape': () => {
      hideMenu()
      return true
    },
    [SHELL_SHORTCUTS.ACTION_PANEL]: () => {
      hideMenu()
      return true
    }
  },
  { modal: true }
)
contextMenuKeymap.deactivate()

watch(
  () => Boolean(showMenu.value && selectedPlugin.value),
  (isOpen) => {
    uiStore.setGlobalActionPanelVisible(isOpen)
    if (isOpen) {
      menuFocusedActionIndex.value = findFirstEnabledMenuIndex(contextMenuItems.value)
      contextMenuKeymap.activate()
    } else {
      contextMenuKeymap.deactivate()
    }
  }
)

watch(selectedPlugin, () => {
  if (showMenu.value && selectedPlugin.value) {
    menuFocusedActionIndex.value = findFirstEnabledMenuIndex(contextMenuItems.value)
  }
})

watch(
  () => uiStore.actionPanelTriggerSeq,
  () => {
    if (!isPageActive.value) return
    if (showMenu.value) {
      hideMenu()
      return
    }
    const entry = navigableItems.value[focusedCardIndex.value]
    if (entry?.plugin) {
      openCardActionMenu(entry.plugin)
    }
  }
)

function isStandaloneControlOutsideNavItem(target) {
  return isInteractiveControlTarget(target, myPageRootRef.value) && !target?.closest?.('[data-nav-index]')
}

function isSubActionControlInsideNavItem(target) {
  if (!isInteractiveControlTarget(target, myPageRootRef.value)) return false
  const navItem = target?.closest?.('[data-nav-index]')
  if (!navItem) return true
  if (target === navItem) return false
  if (target?.classList?.contains?.('plugin-tile')) return false
  return true
}

function handlePageNavKey(e, key) {
  if (showMenu.value) return false
  if (isStandaloneControlOutsideNavItem(e?.target)) return false
  return gridNav.navigate(key)
}

function executeFocusedNavEntry(entry) {
  if (!entry || !entry.plugin) return false
  const pid = getPluginId(entry.plugin)
  if (entry.section === 'tiles') {
    onTileOpen(entry.plugin)
    return true
  }
  if (entry.section === 'recents') {
    handleOpenPlugin(pid)
    return true
  }
  if (entry.section === 'recommended') {
    if (installedSet.value.has(pid)) {
      openApp(pid)
    } else {
      goDetails(pid)
    }
    return true
  }
  return false
}

// 统一注册页面级键盘流 (PAGE 作用域)
useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowRight': (e) => handlePageNavKey(e, 'ArrowRight'),
  'ArrowLeft': (e) => handlePageNavKey(e, 'ArrowLeft'),
  'ArrowDown': (e) => handlePageNavKey(e, 'ArrowDown'),
  'ArrowUp': (e) => handlePageNavKey(e, 'ArrowUp'),
  'Home': (e) => handlePageNavKey(e, 'Home'),
  'End': (e) => handlePageNavKey(e, 'End'),
  'PageUp': (e) => handlePageNavKey(e, 'PageUp'),
  'PageDown': (e) => handlePageNavKey(e, 'PageDown'),
  'Enter': (e) => {
    if (showMenu.value && selectedPlugin.value) {
      handleOpenPlugin(getPluginId(selectedPlugin.value))
      hideMenu()
      return true
    }
    if (isSubActionControlInsideNavItem(e?.target)) return false
    const entry = navigableItems.value[focusedCardIndex.value]
    return executeFocusedNavEntry(entry)
  },
  [SHELL_SHORTCUTS.ACTION_PANEL]: () => {
    if (showMenu.value) {
      hideMenu()
      return true
    }
    const entry = navigableItems.value[focusedCardIndex.value]
    if (entry?.plugin) {
      openCardActionMenu(entry.plugin)
      return true
    }
    return false
  },
  [SHELL_SHORTCUTS.PIN_ITEM]: () => {
    // 仅对当前聚焦卡片且已安装的插件执行固定/取消固定
    if (showMenu.value) return false
    const entry = navigableItems.value[focusedCardIndex.value]
    if (!entry?.plugin) return false
    const pid = getPluginId(entry.plugin)
    if (!pid || !installedSet.value.has(pid)) return false
    togglePin(pid)
    return true
  },
  'Escape': () => {
    if (showMenu.value) {
      hideMenu()
      return true
    }
    return false
  }
})

// Keyboard shortcuts (兼容测试直调与全局事件分发)
function handleKeyDown(event) {
  if (!event || isComposingEvent(event) || isModalOpen()) return
  dispatchKeyEvent(event)
}

async function loadRemoteState() {
  // 拉取云端固定与排序（只有官方版且已登录时才同步；开源版为空操作）
  await cloudSync.pullHomeLayout({
    pluginsStore,
    getPluginId,
    getPinnedList,
    getRecentOrder,
    savePinnedList,
    saveRecentOrder
  })
}

async function loadDragTipState() {
  if (!window.ztools?.config) return

  try {
    const tipShown = await window.ztools.config.get(
      'my-page.drag-tip-shown',
      '',
      'my_page_settings.json'
    )
    if (tipShown === 'true' || tipShown === true) {
      showDragTip.value = false
    }
  } catch (err) {
    console.warn('读取拖拽提示状态失败:', err)
  }
}

// 固定列表与排序变化时同步到跨挂载缓存
watch(pinnedList, (list) => { homeLayoutCache.pinnedList = Array.isArray(list) ? [...list] : [] })
watch(recentOrder, (order) => { homeLayoutCache.recentOrder = Array.isArray(order) ? [...order] : [] })
watch(activeTab, (tab) => { homeLayoutCache.activeTab = tab || 'plugins' })
watch(showAllPlugins, (expanded) => { homeLayoutCache.showAllPlugins = Boolean(expanded) })
watch(focusedCardIndex, (idx) => { homeLayoutCache.focusedCardIndex = Number(idx) || 0 })

let windowListenersBound = false
function bindMyPageWindowListeners() {
  if (windowListenersBound) return
  windowListenersBound = true
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('click', hideMenu)
}
function unbindMyPageWindowListeners() {
  if (!windowListenersBound) return
  windowListenersBound = false
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('click', hideMenu)
}

onActivated(() => {
  isPageActive.value = true
  bindMyPageWindowListeners()
})

onDeactivated(() => {
  isPageActive.value = false
  hideMenu()
  contextMenuKeymap.deactivate()
  unbindMyPageWindowListeners()
})

// Lifecycle
onMounted(async () => {
  loadLaunchHotkeys()
  isUnmounted = false
  hasMounted = true
  loading.value = !homeLayoutCache.ready // 已加载过则保留上次画面，后台静默刷新

  if (typeof ResizeObserver !== 'undefined') {
    gridObserver = new ResizeObserver((entries) => {
      if (isUnmounted) return
      const entry = entries?.[0]
      const rawWidth = entry?.contentRect?.width ?? gridBodyRef.value?.clientWidth
      const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth) ? rawWidth : 0
      if (lastObservedWidth !== null && Math.abs(width - lastObservedWidth) < 0.5) {
        return
      }
      lastObservedWidth = width
      scheduleMeasureGridColumns()
    })
  }
  syncObservedGridElement(gridBodyRef.value)

  bindMyPageWindowListeners()


  if (window.ztools && window.ztools.events) {
    window.ztools.events.on('plugin_install_complete', handlePluginInstalled)
    window.ztools.events.on('plugin_uninstalled', handlePluginUninstalled)
  }

  hostPlatform.value = await getHotkeyHostPlatform()
  if (isUnmounted) return

  try {
    await pluginsStore.init()
    if (isUnmounted) return

    // 每次页面挂载时都重新获取本地插件列表，确保数据最新
    // （init 中的 fetchInstalledPlugins 可能因启动时序问题获取到空数据）
    await Promise.all([
      pluginsStore.fetchInstalledPlugins(),
      loadPinnedList().then((list) => {
        if (list) pinnedList.value = list
      }),
      loadRecentOrder().then((order) => {
        if (order) recentOrder.value = order
      }),
      loadDragTipState()
    ])
  } catch (e) {
    console.warn('[MyPage] 首屏初始化失败:', e)
  } finally {
    if (!isUnmounted) {
      const shouldRestoreSearchFocus = isHomeSearchFocused()
      homeLayoutCache.ready = true
      loading.value = false // 加载完成
      restoreHomeSearchFocusIfNeeded(shouldRestoreSearchFocus)
    }
  }

  if (isUnmounted) return

  // 推荐插件和云端同步不阻塞首屏，完成后响应式刷新页面数据
  pluginsStore.loadRecommendedPlugins(8)
  loadRemoteState()
})

onUnmounted(() => {
  isPageActive.value = false
  hasMounted = false
  isUnmounted = true
  // 先释放 ResizeObserver 与挂起的 rAF，避免后续清理抛出异常导致观察器泄漏
  cancelPendingGridMeasure()
  if (gridObserver) {
    gridObserver.disconnect()
    gridObserver = null
  }
  observedGridEl = null
  lastObservedWidth = null

  if (showMenu.value) {
    hideMenu()
    uiStore.setGlobalActionPanelVisible(false)
  }
  try {
    contextMenuKeymap?.()
  } catch (err) {
    console.warn('注销上下文菜单按键映射失败:', err)
  }

  if (reorderDebounceTimer) {
    clearTimeout(reorderDebounceTimer)
    reorderDebounceTimer = null
  }

  unbindMyPageWindowListeners()


  if (window.ztools && window.ztools.events) {
    window.ztools.events.off('plugin_install_complete', handlePluginInstalled)
    window.ztools.events.off('plugin_uninstalled', handlePluginUninstalled)
  }
})
</script>

<template>
  <div ref="myPageRootRef" class="rc-page my-page" @mousemove="gridNav.handlePointerMove">
    <!-- 加载状态 -->
    <div v-if="loading" class="loading-container">
      <RcLoading />
    </div>

    <!-- 内容区域（加载完成后显示） -->
    <template v-else>
      <!-- 新用户欢迎引导 -->
      <section v-if="isNewUser" class="welcome-section">
        <div class="welcome-card">
          <div class="welcome-icon">
            <RocketIcon style="font-size: 48px; color: var(--rc-accent)" />
          </div>
          <h2 class="welcome-title">{{ t('myPage.welcomeTitle') }}</h2>
          <p class="welcome-desc">
            {{ t('myPage.welcomeDescLine1') }}<br />
            {{ t('myPage.welcomeDescLine2') }}
          </p>
          <div class="welcome-actions">
            <Button type="primary" size="large" @click="goToMarket">
              <LayoutGridIcon /> {{ t('myPage.browseMarket') }}
            </Button>
          </div>
        </div>
      </section>

      <!-- 我的插件 + 我的收藏（标签切换，非新用户时显示） -->
      <section
        v-if="!isNewUser && (installedCount > 0 || favoritesCount > 0)"
        class="plugin-section"
      >
        <div class="section-header">
          <RcSegmented
            v-model="activeTab"
            :aria-label="t('myPage.myPluginsAria')"
            :options="[
              { label: t('myPage.tabInstalled'), value: 'plugins', count: installedCount },
              { label: t('myPage.tabFavorites'), value: 'favorites', count: favoritesCount }
            ]"
            @change="switchTab"
          />
          <Button
            v-if="hasMorePlugins"
            type="link"
            size="small"
            style="font-size: var(--rc-fs-small); color: var(--rc-text-muted);"
            @click="toggleShowAllPlugins"
          >
            {{ showAllPlugins ? t('myPage.collapse') : t('myPage.viewAll') }}
          </Button>
        </div>

        <!-- 两个标签叠放：当前标签显示真实内容，另一个只放不可见、不可操作的同尺寸占位 -->
        <div ref="gridBodyRef" class="my-plugins-body">
          <div
            v-for="tab in MY_PLUGIN_TABS"
            :key="tab"
            class="my-plugins-pane"
            :class="{ 'is-active': tab === activeTab }"
            :aria-hidden="tab === activeTab ? undefined : 'true'"
            :inert="tab === activeTab ? undefined : true"
          >
            <!-- 插件列表（统一卡片样式） -->
            <div v-if="showsRealTiles(tab)" class="plugin-tile-grid">
              <div
                v-for="(plugin, index) in displayedPlugins"
                :key="getPluginId(plugin)"
                class="draggable-card"
                :data-nav-index="index"
                data-nav-group="tiles"
                :data-nav-cols="gridColumns"
                :class="{
                  'is-draggable': activeTab === 'plugins',
                  'is-card-focused': !uiStore.isSearchInputActive && focusedCardIndex === index,
                  'is-drag-over':
                    activeTab === 'plugins' &&
                    dragOverIndex === index &&
                    draggingPlugin &&
                    getPluginId(draggingPlugin) !== getPluginId(plugin),
                  'is-dragging':
                    activeTab === 'plugins' &&
                    draggingPlugin &&
                    getPluginId(draggingPlugin) === getPluginId(plugin)
                }"
                :draggable="activeTab === 'plugins'"
                @click="handleNavFocus(index)"
                @focusin="handleNavFocus(index)"
                @dragstart="handleDragStart(plugin, index)"
                @dragover.prevent="handleDragOver(index)"
                @dragenter.prevent="handleDragOver(index)"
                @drop.prevent="handleDrop(index)"
                @dragend="handleDragEnd"
              >
                <PluginTile
                  :plugin="plugin"
                  :focused="!uiStore.isSearchInputActive && focusedCardIndex === index"
                  :pinned="isPinned(getPluginId(plugin))"
                  :revoked="pluginsStore.isRevoked(getPluginId(plugin))"
                  :revokedText="pluginsStore.getRevokedKind(getPluginId(plugin)) === 'platform' ? t('market.card.platformUnsupported') : t('market.card.revoked')"
                  :hasUpdate="hasUsableUpdate(getPluginId(plugin))"
                  :hotkey="launchHotkeys[getPluginId(plugin)] || ''"
                  :installed="installedSet.has(getPluginId(plugin))"
                  @open="onTileOpen"
                  @menu="showPluginMenu"
                />
              </div>
            </div>

            <!-- 空状态 -->
            <RcEmpty
              v-else-if="placeholderTileCount(tab) === 0"
              class="my-plugins-empty"
              :icon="tab === 'plugins' ? LayoutGridIcon : StarIcon"
              :title="tab === 'plugins' ? t('myPage.emptyInstalled') : t('myPage.emptyFavorites')"
            >
              <template #action>
                <RcButton variant="secondary" size="md" @click="goToMarket">{{ t('myPage.browseMarket') }}</RcButton>
              </template>
            </RcEmpty>

            <!-- 占位：另一个标签的预留高度，或收藏详情加载中 -->
            <div
              v-else
              class="plugin-tile-grid"
              :aria-busy="tab === activeTab ? 'true' : undefined"
            >
              <PluginTileSkeleton v-for="i in placeholderTileCount(tab)" :key="i" />
            </div>
          </div>
        </div>
      </section>

      <!-- 最近使用：紧凑列表 -->
      <section v-if="!isNewUser && recentPlugins.length > 0" class="plugin-section">
        <div class="section-header">
          <h2 class="section-title">{{ t('myPage.recentTitle') }}</h2>
        </div>
        <div class="recent-list">
          <button
            v-for="(plugin, rIdx) in recentPlugins"
            :key="getPluginId(plugin)"
            type="button"
            class="recent-row"
            :class="{ 'is-recent-focused': !uiStore.isSearchInputActive && focusedCardIndex === recentNavIndex(rIdx) }"
            :data-nav-index="recentNavIndex(rIdx)"
            data-nav-group="recents"
            :data-nav-cols="1"
            @focusin="handleNavFocus(recentNavIndex(rIdx))"
            @click="handleNavFocus(recentNavIndex(rIdx)); handleOpenPlugin(getPluginId(plugin))"
            @contextmenu.prevent="showPluginMenu(plugin, $event)"
          >
            <RcSquircle
              :glyph="resolvePluginGlyph(plugin)"
              :fallback-glyph="resolveKeywordGlyph(getLocalizedPluginName(plugin))"
              :src="plugin.localIconPath || (String(plugin.icon || '').startsWith('http') ? plugin.icon : '')"
              :size="30"
            />
            <span class="recent-text">
              <span class="recent-name">{{ getLocalizedPluginName(plugin) || getPluginId(plugin) }}</span>
              <span class="recent-desc">{{ getLocalizedPluginDescription(plugin) || t('common.noDescription') }}</span>
            </span>
            <span class="recent-cat">{{ (plugin.categoryId || plugin.category) ? getLocalizedCategoryName(plugin.categoryId || plugin.category) : '' }}</span>
            <span class="recent-time">{{ recentTimeLabel(plugin) }}</span>
            <span class="recent-open">{{ t('common.open') }} <ShortcutKeys combo="Enter" /></span>
          </button>
        </div>
      </section>

      <!-- 热门推荐：只在拿到推荐数据时显示，避免空状态占位 -->
      <section v-if="recommendedPlugins.length > 0" class="plugin-section">
        <h2 class="section-title">{{ t('myPage.recommendedTitle') }}</h2>
        <div class="plugin-grid-3d">
          <div
            v-for="(plugin, recIdx) in recommendedPlugins"
            :key="getPluginId(plugin)"
            class="recommended-card-wrap"
            :class="{ 'is-card-focused': !uiStore.isSearchInputActive && focusedCardIndex === recommendedNavIndex(recIdx) }"
            :data-nav-index="recommendedNavIndex(recIdx)"
            data-nav-group="recommended"
            :data-nav-cols="2"
            @click="handleNavFocus(recommendedNavIndex(recIdx))"
            @focusin="handleNavFocus(recommendedNavIndex(recIdx))"
          >
            <PluginCard3D
              :plugin="plugin"
              :showFavorite="true"
              :isFavorite="pluginsStore.isFavorite(getPluginId(plugin))"
              :isInstalled="installedSet.has(getPluginId(plugin))"
              :downloading="downloadingSet.has(getPluginId(plugin))"
              :installFailed="installFailedSet.has(getPluginId(plugin))"
              :updateInfo="updateMap[getPluginId(plugin)]"
              @toggle-favorite="handleToggleFavorite"
              @open="goDetails"
              @open-app="openApp"
              @download="handleDownload"
              @plugin-updated="onPluginUpdated"
            />
          </div>
        </div>
      </section>

      <!-- 再拼一块：去插件市场 -->
      <RcBannerLink
        v-if="!isNewUser"
        class="market-banner"
        :title="t('myPage.marketBannerTitle')"
        :description="t('myPage.marketBannerDesc')"
        :link-text="t('myPage.marketBannerLink')"
        @click="goToMarket"
      />

      <!-- 右键菜单 -->
      <div
        v-if="showMenu && selectedPlugin"
        class="context-menu"
        role="menu"
        :style="{ top: menuPosition.y + 'px', left: menuPosition.x + 'px' }"
        @click.stop
      >
        <template v-for="(item, idx) in contextMenuItems" :key="item.key">
          <div v-if="item.dividerBefore" class="menu-divider"></div>
          <div
            class="menu-item"
            :class="{
              disabled: item.disabled,
              danger: item.danger,
              'is-selected': !item.disabled && menuFocusedActionIndex === idx
            }"
            :style="item.style"
            :title="item.title"
            role="menuitem"
            :aria-disabled="item.disabled ? 'true' : undefined"
            @mouseenter="!item.disabled && (menuFocusedActionIndex = idx)"
            @click="!item.disabled && item.action?.()"
          >
            {{ item.label }}
          </div>
        </template>
      </div>

      <!-- 同步状态 -->
      <div v-if="syncing" class="sync-indicator">
        <SpinnerIcon aria-hidden="true" />
        <span>{{ t('myPage.syncing') }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 加载状态 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}


/* 欢迎引导卡片 */
.welcome-section {
  margin-bottom: 40px;
}

.welcome-card {
  background: linear-gradient(
    135deg,
    var(--rc-surface) 0%,
    var(--rc-canvas) 100%
  );
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-xl);
  padding: 32px 24px;
  text-align: center;
}

.welcome-icon {
  margin-bottom: 20px;
}

.welcome-title {
  font-size: var(--rc-fs-title);
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--rc-text-primary);
}

.welcome-desc {
  font-size: var(--rc-fs-emph);
  color: var(--rc-text-secondary);
  margin-bottom: 24px;
  line-height: 1.6;
}

.welcome-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
}

/* 区块样式 */
.plugin-section {
  margin-bottom: 32px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: var(--rc-fs-body);
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--rc-text-primary);
}

/* 我的插件：两个标签叠放在同一格，高度只跟随当前标签的实际内容 */
.my-plugins-body {
  display: grid;
}

.my-plugins-pane {
  grid-area: 1 / 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 非当前标签不占高度：只保留宽度供列数测量，避免另一个标签（如收藏空状态）把已安装两行撑出大片空白 */
.my-plugins-pane:not(.is-active) {
  visibility: hidden;
  pointer-events: none;
  height: 0;
  overflow: hidden;
}

/* 卡片按内容区宽度排列；极窄窗口仍能收缩到单列。 */
.plugin-tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 8px;
}

/* 最近使用：带分隔线的紧凑行 */
.recent-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--rc-border);
}

.recent-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  border-bottom: 1px solid var(--rc-border);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--rc-dur) ease;
}

.recent-row:hover {
  background: var(--rc-surface-hover);
}

.recent-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent-name {
  font-size: var(--rc-fs-body);
  font-weight: 500;
  color: var(--rc-text-primary);
}

.recent-desc {
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-cat {
  min-width: 72px;
  max-width: 110px;
  flex-shrink: 0;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-time {
  min-width: 64px;
  flex-shrink: 0;
  text-align: right;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-faint);
  white-space: nowrap;
}

.recent-open {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--rc-fs-small);
  color: var(--rc-text-faint);
  opacity: 0;
  transition: opacity var(--rc-dur) ease;
}

/* 「打开 Enter」跟随键盘聚焦行展示，避免与顶栏搜索框或悬停态同时双亮 */
.recent-row.is-recent-focused .recent-open {
  opacity: 1;
}

.recent-row:focus-visible {
  outline: none;
}

.recent-row.is-recent-focused {
  outline: none;
  background: var(--rc-surface-active);
}







/* 推荐卡片网格 */
.plugin-grid-3d {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 8px;
}

.draggable-card {
  min-width: 0;
  transition:
    transform var(--rc-dur) ease,
    opacity var(--rc-dur) ease;
}

.draggable-card.is-draggable {
  cursor: grab;
}

.draggable-card.is-draggable:active {
  cursor: grabbing;
}

.draggable-card.is-drag-over {
  outline: 1.5px dashed var(--rc-accent);
  outline-offset: 3px;
  border-radius: var(--rc-radius-lg);
}

.draggable-card.is-dragging {
  opacity: 0.55;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .plugin-grid-3d {
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }

  .welcome-card {
    padding: 32px 20px;
  }

  .welcome-title {
    font-size: var(--rc-fs-title-md);
  }
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  background: var(--rc-surface);
  border: 1px solid var(--rc-border-highlight);
  border-radius: var(--rc-radius-md);
  box-shadow: var(--rc-shadow-lg);
  z-index: 1000;
  min-width: 168px;
  padding: 4px;
}

.menu-item {
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-radius: var(--rc-radius-sm);
  cursor: pointer;
  color: var(--rc-text-primary);
  transition: background-color var(--rc-dur) ease;
  font-size: var(--rc-fs-body);
}

.menu-item:hover,
.menu-item.is-selected {
  background-color: var(--rc-surface-hover);
}

.menu-item.is-selected {
  background-color: var(--rc-surface-active);
}

.menu-item.danger {
  color: var(--rc-error);
}

.menu-item.danger:hover,
.menu-item.danger.is-selected {
  background-color: var(--rc-error-subtle);
}

.menu-divider {
  height: 1px;
  background-color: var(--rc-border);
  margin: 4px 0;
}

/* 同步状态指示器 */
.sync-indicator {
  position: fixed;
  bottom: 20px;
  right: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--rc-surface);
  border-radius: var(--rc-radius-md);
  box-shadow: var(--rc-shadow-md);
  font-size: var(--rc-fs-emph);
  color: var(--rc-text-secondary);
}

.is-card-focused {
  border-radius: var(--rc-radius-lg);
}

.plugin-grid-3d .is-card-focused,
.is-card-focused:not(.draggable-card) {
  border-radius: var(--rc-radius-lg);
  box-shadow: var(--rc-focus-ring);
}

.is-card-focused :deep(.card-compact) {
  border-color: transparent;
}
</style>
