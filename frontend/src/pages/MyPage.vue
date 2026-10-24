<script>
// 跨次挂载保留的首页状态：从插件返回时先按上次的样子直接画出来，
// 不再先闪「加载中」、也不会先按默认列数 / 默认顺序排一遍再跳到正确位置
const homeLayoutCache = { ready: false, gridColumns: 5, pinnedList: [], recentOrder: [] }

/** 仅供测试：清空跨挂载缓存，模拟应用刚启动 */
export function resetHomeLayoutCache() {
  Object.assign(homeLayoutCache, { ready: false, gridColumns: 5, pinnedList: [], recentOrder: [] })
}
</script>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { usePluginsStore } from '@/stores/plugins'
import { useUserStore, cloudSync, onAuthRequired } from '@edition'
import { useRouter } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { useUIStore } from '@/stores/ui'
import PluginCard3D from '@/components/PluginCard3D.vue'
import PluginTile from '@/components/PluginTile.vue'
import BrandMark from '@/components/BrandMark.vue'
import { RcSegmented, RcSquircle } from '@/components/base'
import { resolvePluginGlyph } from '@/utils/brandIcons'
import { formatRelativeTime } from '@/utils/relativeTime'
import { buildLaunchHotkeyMap } from '@/utils/launchHotkeyTargets'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import { Empty, Button, Modal, Spin } from 'ant-design-vue'
import { RocketOutlined, AppstoreOutlined } from '@ant-design/icons-vue'
import {
  openPlugin as apiOpenPlugin,
  getDownloadSign,
  installPluginNative,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from '@/api/apiserver'
import { routeUtils } from '@/router/routes'
import { getHotkeyHostPlatform } from '@/utils/hotkeyRecorder'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { isBundledPlugin } from '@/utils/bundledPlugins'
import { useKeymap, KEYMAP_SCOPES, dispatchKeyEvent, isModalOpen } from '@/utils/keymap'

// Stores
const pluginsStore = usePluginsStore()
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
const showAllPlugins = ref(false) // 控制"我的插件"折叠/展开
const activeTab = ref('plugins') // 'plugins' | 'favorites' - 标签切换
const pinnedList = ref([...homeLayoutCache.pinnedList]) // 响应式固定列表
const focusedCardIndex = ref(0) // 键盘流当前聚焦的卡片索引

// Constants
const MAX_PINNED_COUNT = 8
const DEFAULT_ROWS = 2 // 「常用」默认显示行数
const RECENT_LIMIT = 5 // 「最近使用」最多显示条数

// 网格实际列数：auto-fill 会随窗口宽度变化，键盘上下移动与默认显示数量都以真实列数为准
const gridColumns = ref(homeLayoutCache.gridColumns)
let gridObserver = null
function measureGridColumns(el) {
  if (!el) return
  const template = getComputedStyle(el).gridTemplateColumns || ''
  const count = template.split(' ').filter((part) => part && part !== 'none').length
  if (count > 0) {
    gridColumns.value = count
    homeLayoutCache.gridColumns = count
  }
}
function bindGridEl(el) {
  if (gridObserver) {
    gridObserver.disconnect()
    gridObserver = null
  }
  if (!el || typeof ResizeObserver === 'undefined') {
    measureGridColumns(el)
    return
  }
  gridObserver = new ResizeObserver(() => measureGridColumns(el))
  gridObserver.observe(el)
  measureGridColumns(el)
}
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

// Computed - 插件数量
const installedCount = computed(() => installedPlugins.value.length)
const favoritesCount = computed(() => favoritePlugins.value.length)

// 切换标签时重置展开状态
function switchTab(tab) {
  activeTab.value = tab
  showAllPlugins.value = false
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
    error('保存固定列表失败: ' + e.message)
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
    error('保存排序失败: ' + e.message)
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
    warning(`最多只能固定 ${MAX_PINNED_COUNT} 个插件`)
    return
  }

  const pinned = getPinnedList()
  if (!pinned.includes(pluginId)) {
    pinned.push(pluginId)
    await savePinnedList(pinned)
    // 固定后立即持久化当前排序，防止重启后丢失
    await persistCurrentOrder()
    success('已固定')

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
    success('已取消固定')

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
    success('排序已保存')

    if (userStore.isLoggedIn) {
      syncOrderToCloud()
    }
    reorderDebounceTimer = null
  }, DEBOUNCE_DELAY)
}

// Menu handling
function showPluginMenu(plugin, event) {
  event.preventDefault()
  selectedPlugin.value = plugin
  menuPosition.value = { x: event.clientX, y: event.clientY }
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
    const reason = pluginsStore.getRevokedReason(id) || '该插件已被官方下架禁用'
    toastError('无法启动：' + reason)
    return
  }
  try {
    await pluginsStore.openPlugin(id)
  } catch (e) {
    toastError('启动失败: ' + (e.message || e))
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
    const reason = pluginsStore.getRevokedReason(pluginId) || '该插件已被官方下架禁用'
    toastError('无法启动：' + reason)
    return
  }

  if (isBundledPlugin(pluginId) || isOfficialPlugin(pluginId)) {
    try {
      await pluginsStore.openPlugin(pluginId)
    } catch (e) {
      toastError('启动失败: ' + (e.message || e))
    }
    return
  }
  try {
    const res = await apiOpenPlugin(id)

    // 检查是否需要导航到详情页（插件已卸载的情况）
    if (res?.action === 'navigate_to_detail') {
      toastWarning(res.error || '插件未安装，请重新安装')
      router.push(routeUtils.toPluginDetails(res.pluginId || id))
      return
    }

    if (res?.success) {
      toastSuccess('已打开插件')
    } else {
      toastError('打开失败')
    }
  } catch (e) {
    toastError('打开失败: ' + (e.message || e))
  }
}

// 一键静默安装插件（支持并发互斥与自动进舞台）
async function handleDownload(id) {
  const pid = getPluginId(id)
  if (!pid) return

  if (pluginsStore.isRevoked(pid)) {
    const reason = pluginsStore.getRevokedReason(pid) || '该插件已被官方下架禁用'
    toastError('无法安装：' + reason)
    return
  }

  // 防止重复下载
  if (pluginsStore.isInstalling(pid)) {
    toastWarning('该插件正在安装中，请稍候...')
    return
  }

  try {
    toastSuccess('正在安装插件，请稍候...')
    await pluginsStore.installPlugin(pid, { autoOpen: true })
    toastSuccess('插件安装完成')
  } catch (e) {
    if (isPluginVersionIncompatibleError(e)) {
      toastWarning(getPluginVersionIncompatibleMessage(e))
    } else if (!onAuthRequired(e, { level: 'error' })) {
      toastError('安装失败: ' + (e.message || e))
    }
  }
}

// 插件更新完成回调（保留兼容性，实际由 handlePluginInstalled 处理）
function onPluginUpdated(pluginId) {
}

async function handleToggleFavorite(pluginId) {
  try {
    const id = getPluginId(pluginId)
    if (!id) {
      toastError('插件标识符不存在')
      return
    }
    const wasFavorite = pluginsStore.isFavorite(id)
    await pluginsStore.toggleFavorite(id)
    toastSuccess(wasFavorite ? '已取消收藏' : '已加入收藏')
  } catch (e) {
    if (!onAuthRequired(e)) {
      console.error('toggleFavorite error:', e)
      toastError('操作失败: ' + (e.message || e))
    }
  }
}

function handleUninstallPlugin(pluginId) {
  Modal.confirm({
    title: '确认卸载',
    content: '确定要卸载此插件吗？',
    okText: '卸载',
    cancelText: '取消',
    onOk() {
      pluginsStore.uninstallPlugin(pluginId)
      hideMenu()
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
  const pluginId = payload.pluginId
  if (pluginId) {
    if (payload.success) {
      pluginsStore.fetchInstalledPlugins().then(() => {
        // 安装后推送插件列表到云端
        syncPluginListToCloud()
      })
      // 根据 isUpdate 区分安装和更新的提示
      if (payload.isUpdate) {
        toastSuccess('插件更新完成')
      } else {
        info('插件已安装')
      }
    } else {
      toastError('插件安装失败: ' + (payload.error || '未知错误'))
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
    info('插件已卸载')
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
    syncError.value = e.message
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
    syncError.value = e.message
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
      .catch(() => {})
  }
}

function openCardActionMenu(plugin) {
  if (!plugin) return
  selectedPlugin.value = plugin
  // 动作面板贴着当前聚焦的磁贴弹出
  const rect = document.querySelector('.is-card-focused')?.getBoundingClientRect?.()
  menuPosition.value = {
    x: Math.min(window.innerWidth - 200, rect ? rect.left + 12 : 160),
    y: Math.min(window.innerHeight - 200, rect ? rect.bottom + 6 : 240)
  }
  showMenu.value = true
}

function scrollFocusedCardIntoView() {
  nextTick(() => {
    const el = document.querySelector('.is-card-focused')
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  })
}

// 统一注册页面级键盘流 (PAGE 作用域)
useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowRight': () => {
    if (displayedPlugins.value.length === 0) return false
    focusedCardIndex.value = Math.min(focusedCardIndex.value + 1, displayedPlugins.value.length - 1)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowLeft': () => {
    if (displayedPlugins.value.length === 0) return false
    focusedCardIndex.value = Math.max(focusedCardIndex.value - 1, 0)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowDown': () => {
    if (displayedPlugins.value.length === 0) return false
    focusedCardIndex.value = Math.min(focusedCardIndex.value + gridColumns.value, displayedPlugins.value.length - 1)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowUp': () => {
    if (displayedPlugins.value.length === 0) return false
    focusedCardIndex.value = Math.max(focusedCardIndex.value - gridColumns.value, 0)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'Enter': () => {
    if (showMenu.value && selectedPlugin.value) {
      handleOpenPlugin(getPluginId(selectedPlugin.value))
      hideMenu()
      return true
    }
    const cur = displayedPlugins.value[focusedCardIndex.value]
    if (cur) {
      handleOpenPlugin(getPluginId(cur))
      return true
    }
    return false
  },
  'Ctrl+K': () => {
    const cur = displayedPlugins.value[focusedCardIndex.value]
    if (cur) {
      openCardActionMenu(cur)
      return true
    }
    return false
  },
  'Escape': () => {
    if (showMenu.value) {
      hideMenu()
      return true
    }
    return false
  },
  'Delete': () => {
    const p = selectedPlugin.value || displayedPlugins.value[focusedCardIndex.value]
    if (p) {
      handleUninstallPlugin(getPluginId(p))
      return true
    }
    return false
  }
})

// Keyboard shortcuts (兼容测试直调与全局事件分发)
function handleKeyDown(event) {
  // 对话框（如卸载确认）打开时，回车 / Delete 只作用于对话框，不再打开或卸载列表里的插件
  if (isModalOpen()) return
  if (dispatchKeyEvent(event)) return

  if (!selectedPlugin.value) return

  const searchModifier =
    hostPlatform.value === 'macos'
      ? event.metaKey && !event.ctrlKey
      : hostPlatform.value === 'windows' && event.ctrlKey && !event.metaKey
  if (searchModifier && event.key && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    togglePin(getPluginId(selectedPlugin.value))
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    handleOpenPlugin(getPluginId(selectedPlugin.value))
  }

  if (event.key === 'Delete') {
    event.preventDefault()
    handleUninstallPlugin(getPluginId(selectedPlugin.value))
  }
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
  } catch {
    // 忽略
  }
}

// 固定列表与排序变化时同步到跨挂载缓存
watch(pinnedList, (list) => { homeLayoutCache.pinnedList = Array.isArray(list) ? [...list] : [] })
watch(recentOrder, (order) => { homeLayoutCache.recentOrder = Array.isArray(order) ? [...order] : [] })

// Lifecycle
onMounted(async () => {
  loadLaunchHotkeys()
  isUnmounted = false
  loading.value = !homeLayoutCache.ready // 已加载过则保留上次画面，后台静默刷新

  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('click', hideMenu)

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
  if (gridObserver) {
    gridObserver.disconnect()
    gridObserver = null
  }
  isUnmounted = true

  if (reorderDebounceTimer) {
    clearTimeout(reorderDebounceTimer)
    reorderDebounceTimer = null
  }

  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('click', hideMenu)

  if (window.ztools && window.ztools.events) {
    window.ztools.events.off('plugin_install_complete', handlePluginInstalled)
    window.ztools.events.off('plugin_uninstalled', handlePluginUninstalled)
  }
})
</script>

<template>
  <div class="my-page">
    <!-- 加载状态 -->
    <div v-if="loading" class="loading-container">
      <Spin size="large" tip="加载中..." />
    </div>

    <!-- 内容区域（加载完成后显示） -->
    <template v-else>
      <!-- 新用户欢迎引导 -->
      <section v-if="isNewUser" class="welcome-section">
        <div class="welcome-card">
          <div class="welcome-icon">
            <RocketOutlined style="font-size: 48px; color: var(--zt-primary)" />
          </div>
          <h2 class="welcome-title">欢迎使用 ZTools</h2>
          <p class="welcome-desc">
            ZTools 是一个强大的插件化工具平台，帮助你提升工作效率。<br />
            快来探索丰富的插件生态吧！
          </p>
          <div class="welcome-actions">
            <Button type="primary" size="large" @click="goToMarket">
              <AppstoreOutlined /> 浏览插件市场
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
            :options="[
              { label: '已安装', value: 'plugins', count: installedCount },
              { label: '收藏', value: 'favorites', count: favoritesCount }
            ]"
            @change="switchTab"
          />
          <Button
            v-if="hasMorePlugins"
            type="link"
            size="small"
            style="font-size: 12px; color: var(--rc-text-muted);"
            @click="showAllPlugins = !showAllPlugins"
          >
            {{ showAllPlugins ? '收起' : `查看全部` }}
          </Button>
        </div>

        <!-- 空状态 -->
        <Empty
          v-if="displayedPlugins.length === 0"
          :image="Empty.PRESENTED_IMAGE_SIMPLE"
          :description="activeTab === 'plugins' ? '暂无已安装插件' : '暂无收藏'"
          style="margin: 40px 0"
        >
          <template #extra>
            <Button type="primary" @click="goToMarket">浏览插件市场</Button>
          </template>
        </Empty>

        <!-- 插件列表（统一卡片样式） -->
        <div v-else :ref="bindGridEl" class="plugin-tile-grid">
          <div
            v-for="(plugin, index) in displayedPlugins"
            :key="getPluginId(plugin)"
            class="draggable-card"
            :class="{
              'is-draggable': activeTab === 'plugins',
              'is-card-focused': focusedCardIndex === index,
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
            @click="focusedCardIndex = index; uiStore.focusGrid()"
            @dragstart="handleDragStart(plugin, index)"
            @dragover.prevent="handleDragOver(index)"
            @dragenter.prevent="handleDragOver(index)"
            @drop.prevent="handleDrop(index)"
            @dragend="handleDragEnd"
          >
            <PluginTile
              :plugin="plugin"
              :focused="focusedCardIndex === index"
              :pinned="isPinned(getPluginId(plugin))"
              :revoked="pluginsStore.isRevoked(getPluginId(plugin))"
              :hasUpdate="hasUsableUpdate(getPluginId(plugin))"
              :hotkey="launchHotkeys[getPluginId(plugin)] || ''"
              :installed="installedSet.has(getPluginId(plugin))"
              @open="onTileOpen"
              @menu="showPluginMenu"
            />
          </div>
        </div>
      </section>

      <!-- 最近使用：紧凑列表 -->
      <section v-if="!isNewUser && recentPlugins.length > 0" class="plugin-section">
        <div class="section-header">
          <h2 class="section-title">最近使用</h2>
        </div>
        <div class="recent-list">
          <button
            v-for="plugin in recentPlugins"
            :key="getPluginId(plugin)"
            type="button"
            class="recent-row"
            @click="handleOpenPlugin(getPluginId(plugin))"
            @contextmenu.prevent="showPluginMenu(plugin, $event)"
          >
            <RcSquircle
              :glyph="resolvePluginGlyph(plugin)"
              :src="plugin.localIconPath || (String(plugin.icon || '').startsWith('http') ? plugin.icon : '')"
              icon="fa-cube"
              :size="30"
            />
            <span class="recent-text">
              <span class="recent-name">{{ plugin.name || getPluginId(plugin) }}</span>
              <span class="recent-desc">{{ plugin.description || '暂无描述' }}</span>
            </span>
            <span class="recent-cat">{{ plugin.category || '' }}</span>
            <span class="recent-time">{{ recentTimeLabel(plugin) }}</span>
            <span class="recent-open">打开 <ShortcutKeys combo="Enter" /></span>
          </button>
        </div>
      </section>

      <!-- 热门推荐：只在拿到推荐数据时显示，避免空状态占位 -->
      <section v-if="recommendedPlugins.length > 0" class="plugin-section">
        <h2 class="section-title">热门推荐</h2>
        <div class="plugin-grid-3d">
          <PluginCard3D
            v-for="plugin in recommendedPlugins"
            :key="getPluginId(plugin)"
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
      </section>

      <!-- 再拼一块：去插件市场 -->
      <button v-if="!isNewUser" type="button" class="market-banner" @click="goToMarket">
        <BrandMark :size="26" />
        <span class="market-banner-text">
          <span class="market-banner-title">再拼一块</span>
          <span class="market-banner-desc">插件市场里的插件都经过官方审核，源码公开，免费安装</span>
        </span>
        <span class="market-banner-link">去插件市场 →</span>
      </button>

      <!-- 右键菜单 -->
      <div
        v-if="showMenu && selectedPlugin"
        class="context-menu"
        :style="{ top: menuPosition.y + 'px', left: menuPosition.x + 'px' }"
      >
        <div
          v-if="pluginsStore.isRevoked(getPluginId(selectedPlugin))"
          class="menu-item disabled"
          style="opacity: 0.5; cursor: not-allowed; color: var(--rc-error);"
          :title="pluginsStore.getRevokedReason(getPluginId(selectedPlugin))"
        >
          已下架（禁止启动）
        </div>
        <div
          v-else
          class="menu-item"
          @click="handleOpenPlugin(getPluginId(selectedPlugin))"
        >
          打开
        </div>
        <div class="menu-item" @click="goDetails(getPluginId(selectedPlugin)); hideMenu()">
          查看详情
        </div>
        <div
          class="menu-item"
          @click="handleToggleFavorite(getPluginId(selectedPlugin))"
        >
          {{
            pluginsStore.isFavorite(getPluginId(selectedPlugin))
              ? '取消收藏'
              : '收藏'
          }}
        </div>
        <div class="menu-item" @click="togglePin(getPluginId(selectedPlugin))">
          {{
            isPinned(getPluginId(selectedPlugin))
              ? '取消固定'
              : '固定到最前'
          }}
        </div>
        <div class="menu-divider"></div>
        <div
          class="menu-item danger"
          @click="handleUninstallPlugin(getPluginId(selectedPlugin))"
        >
          卸载
        </div>
      </div>

      <!-- 同步状态 -->
      <div v-if="syncing" class="sync-indicator">
        <Spin size="small" />
        <span>同步中...</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.my-page {
  padding: 18px 22px 32px;
  max-width: 1040px;
  margin: 0 auto;
}

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
    var(--zt-bg-elevated) 0%,
    var(--zt-bg-secondary) 100%
  );
  border: 1px solid var(--zt-border);
  border-radius: 16px;
  padding: 32px 24px;
  text-align: center;
}

.welcome-icon {
  margin-bottom: 20px;
}

.welcome-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--zt-text);
}

.welcome-desc {
  font-size: 15px;
  color: var(--zt-text-secondary);
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
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--rc-text-primary);
}

/* 标签切换 */
.tab-switcher {
  display: flex;
  gap: 2px;
  background: var(--rc-surface-subtle);
  padding: 2px;
  border-radius: var(--rc-radius-md, 8px);
  border: 1px solid var(--rc-border);
}

.tab-btn {
  padding: 4px 12px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--rc-text-secondary);
  transition: all 0.15s ease;
  user-select: none;
}

.tab-btn:hover {
  color: var(--rc-text-primary);
}

.tab-btn.active {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  font-weight: 600;
  box-shadow: var(--rc-shadow-sm);
}

/* 「常用」紧凑磁贴网格（设计稿：minmax(170px, 1fr)，间距 8px） */
.plugin-tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
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
  transition: background-color 0.15s ease;
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
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
}

.recent-desc {
  font-size: 12px;
  color: var(--rc-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-cat {
  width: 72px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--rc-text-muted);
}

.recent-time {
  width: 64px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  color: var(--rc-text-faint);
}

.recent-open {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rc-text-faint);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.recent-row:hover .recent-open,
.recent-row:focus-visible .recent-open {
  opacity: 1;
}

.market-banner {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.market-banner:hover {
  border-color: var(--rc-accent);
}

.market-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.market-banner-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
}

.market-banner-desc {
  font-size: 12px;
  color: var(--rc-text-muted);
}

.market-banner-link {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--rc-accent-text);
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
    transform 0.15s ease,
    opacity 0.15s ease;
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

  .my-page {
    padding: 12px;
  }

  .welcome-card {
    padding: 32px 20px;
  }

  .welcome-title {
    font-size: 20px;
  }
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  background: var(--rc-surface);
  border: 1px solid var(--rc-border-highlight);
  border-radius: 10px;
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
  border-radius: 6px;
  cursor: pointer;
  color: var(--rc-text-primary);
  transition: background-color 0.15s ease;
  font-size: 13px;
}

.menu-item:hover {
  background-color: var(--zt-bg-hover);
}

.menu-item.danger {
  color: var(--rc-error);
}

.menu-item.danger:hover {
  background-color: var(--rc-error-subtle);
}

.menu-divider {
  height: 1px;
  background-color: var(--zt-border);
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
  background: var(--zt-bg-elevated);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  font-size: 14px;
  color: var(--zt-text-secondary);
}

.is-card-focused {
  border-radius: var(--rc-radius-lg, 12px);
  box-shadow: var(--rc-focus-ring);
}

.is-card-focused :deep(.card-compact) {
  border-color: transparent;
}
</style>
