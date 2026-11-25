<script setup>
import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, ExternalLinkIcon, SearchIcon } from '@lucide/vue'
import { ref, computed, onActivated, onDeactivated, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import PluginCard3D from '@/components/PluginCard3D.vue'
import SkeletonCard from '@/components/SkeletonCard.vue'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import { RcBannerLink, RcButton, RcEmpty, RcSegmented } from '@/components/base'

import { useNavStore } from '@/stores/nav'
import { usePluginsStore } from '@/stores/plugins'
import { useCategoriesStore } from '@/stores/categories'
import { auth, onAuthRequired, pluginRatings, track } from '@edition'
import { useToast } from '@/composables/useToast'
import { usePluginInstall } from '@/composables/usePluginInstall'
import { useVersionCompat } from '@/composables/useVersionCompat'
import { useUIStore } from '@/stores/ui'
import { useVisualGridNav } from '@/composables/useVisualGridNav'
import { routeUtils, ROUTES } from '@/router/routes'
import { isBundledPlugin } from '@/utils/bundledPlugins'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { useKeymap, KEYMAP_SCOPES, isInteractiveControlTarget } from '@/utils/keymap'
import { matchesShellShortcut } from '@/utils/shellShortcuts'
import { useAppI18n } from '@/i18n'
import { getLocalizedCategoryName, getLocalizedPluginName } from '@/utils/pluginI18n'
import {
  FAVORITES_CATEGORY_ID,
  getCategoryIcon,
  normalizeCategoryRouteParam,
  resolveCategoryKey
} from '@/utils/pluginCategories'
import { resolveErrorMessage } from '@/utils/errorMessage'

const { t } = useAppI18n()
const nav = useNavStore()
const uiStore = useUIStore()
const pluginsStore = usePluginsStore()
const { installWithFeedback } = usePluginInstall()
const categoriesStore = useCategoriesStore()
const route = useRoute()
const router = useRouter()
const { toastError, toastSuccess, toastWarning } = useToast()
const { checkPluginCompat } = useVersionCompat()

const CATEGORY_PREVIEW_LIMIT = 8
// 每页固定 20 条，不提供每页条数切换
const PAGE_SIZE = 20

const items = ref([])
const previewGroups = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(PAGE_SIZE)
const category = ref(normalizeCategoryRouteParam(route.params.category || ''))
const loading = ref(false)
const isFetching = ref(false)
const loadingLocalPlugins = ref(false)
const error = ref('')
const isPageActive = ref(true)
let loadRequestId = 0
let needsReloadOnActivate = false

// 是否为"全部"分类视图（需要分组展示）
const isAllCategory = computed(() => !category.value || category.value === '')
const searchKeyword = ref(String(route.query.q || '').trim())

// 页面内分类筛选：与侧栏 selectCategory 行为一致（切换分类时清空搜索词）
function selectMarketCategory(categoryIdOrName) {
  const next = normalizeCategoryRouteParam(categoryIdOrName)
  nav.setCategory(next)
  router.push({ ...ROUTES.LIST, params: { category: next } })
}
const selectedSourceType = computed(() => pluginsStore.sourceFilter || 'all')
const isCategoryOverview = computed(
  () => isAllCategory.value && searchKeyword.value === '' && selectedSourceType.value === 'all'
)

// 三个来源各自的插件数（按当前分类 / 搜索词 / 收藏统计），显示在来源切换上。
// null：正在统计（占位，避免数字出现时把按钮挤开）；undefined：统计失败，不显示数字（不编造）
const SOURCE_TYPES = ['all', 'official', 'community']
const sourceCounts = ref({ all: null, official: null, community: null })
let sourceCountsKey = ''
let sourceCountsRequest = 0

async function refreshSourceCounts({ requestCategory, requestKeyword, isFav }) {
  const favIds = isFav ? Array.from(pluginsStore.favorites) : null
  const key = `${requestCategory}|${requestKeyword}|${favIds ? favIds.join(',') : ''}`
  // 只切换来源时数量不变，不重新统计，也不闪烁
  if (key === sourceCountsKey) return
  sourceCountsKey = key
  const requestId = ++sourceCountsRequest
  sourceCounts.value = { all: null, official: null, community: null }
  if (favIds && favIds.length === 0) {
    sourceCounts.value = { all: 0, official: 0, community: 0 }
    return
  }
  const base = favIds ? { ids: favIds } : { category: requestCategory, keyword: requestKeyword }
  let counts = null
  try {
    counts = await pluginsStore.countPluginsBySource(base)
  } catch (error) {
    console.warn('[List] 统计各来源插件数失败，来源切换上不显示数量:', error)
  }
  if (requestId !== sourceCountsRequest) return
  // 统计失败时不记住这组条件，下次加载（如网络恢复后重试）重新统计
  if (!counts) sourceCountsKey = ''
  const next = {}
  for (const type of SOURCE_TYPES) {
    const total = Number(counts?.[type])
    next[type] = Number.isFinite(total) && total >= 0 ? total : undefined
  }
  sourceCounts.value = next
}

const switchSourceType = async (type) => {
  page.value = 1
  resetListFocus()
  await pluginsStore.setSourceFilter(type)
  await load()
}

const categoriesReady = computed(() => categoriesStore.loaded || categoriesStore.error)
// 当前系统上一个插件都没有的分类不显示（正在查看的分类保留，免得页面没有选中项）
const visibleMarketCategories = computed(() =>
  (categoriesStore.sidebarCategories || []).filter((c) => pluginsStore.isCategoryVisible(resolveCategoryKey(c), category.value))
)
const isInitialLoading = computed(
  () => loading.value || categoriesStore.loading || (!categoriesStore.loaded && !categoriesStore.error)
)

// 使用 Store 的状态
const installedSet = computed(() => pluginsStore.installedSet)
const updateMap = computed(() => pluginsStore.updateMap)
const downloadingSet = computed(() => pluginsStore.downloadingSet)
const installFailedSet = computed(() => pluginsStore.installFailedSet)

const getPluginId = (pluginOrId) => {
  if (pluginOrId === null || pluginOrId === undefined) return ''
  if (typeof pluginOrId === 'object') {
    // 只使用 pluginId(业务标识符),不使用 id(数据库主键)
    return String(pluginOrId.pluginId || '').trim()
  }
  return String(pluginOrId).trim()
}

// 插件卡片参数（分类预览与平铺列表共用）；评分汇总由版本提供，开源版没有评分，始终为 null
const cardProps = (p, index) => {
  const pid = getPluginId(p)
  return {
    plugin: p,
    tabindex: index === focusedCardIndex.value ? 0 : -1,
    actionTabindex: index === focusedCardIndex.value ? 0 : -1,
    role: 'group',
    'aria-label': getLocalizedPluginName(p),
    showFavorite: true,
    isFavorite: pluginsStore.isFavorite(pid),
    isInstalled: installedSet.value.has(pid),
    downloading: downloadingSet.value.has(pid),
    installFailed: installFailedSet.value.has(pid),
    updateInfo: updateMap.value[pid],
    ratingSummary: pluginRatings.enabled ? pluginRatings.summaries[pid] || null : null
  }
}

const buildPreviewGroups = (categories) =>
  categories.map((item) => {
    const key = resolveCategoryKey(item)
    return {
      ...item,
      id: key || item.id,
      icon: getCategoryIcon(key || item.name)
    }
  })

const fetchCategoryOverview = async (categoriesPromise, requestId) => {
  const nextGroups = []
  let catalogTotal = 0

  if (typeof pluginsStore.loadCategoryOverview === 'function') {
    const categories = await categoriesPromise
    if (requestId !== loadRequestId) return null

    const groups = buildPreviewGroups(categories)
    const overview = await pluginsStore.loadCategoryOverview(groups, CATEGORY_PREVIEW_LIMIT)
    if (requestId !== loadRequestId) return null

    let runningStartIndex = 0
    if (Array.isArray(overview?.groups)) {
      for (const rawGroup of overview.groups) {
        const key = resolveCategoryKey(rawGroup)
        const rawPlugins = Array.isArray(rawGroup?.plugins)
          ? rawGroup.plugins
          : Array.isArray(rawGroup?.list)
            ? rawGroup.list
            : []
        const plugins = rawPlugins.filter(isPluginSupportedOnCurrentPlatform)
        const groupTotal = Number(rawGroup?.total ?? rawGroup?.pluginsCount ?? plugins.length)
        if (groupTotal > 0 || plugins.length > 0) {
          nextGroups.push({
            ...rawGroup,
            id: key || rawGroup.id,
            icon: rawGroup.icon || getCategoryIcon(key || rawGroup.name),
            plugins,
            total: groupTotal,
            startIndex: runningStartIndex
          })
          runningStartIndex += plugins.length
        }
      }
    } else {
      const byCategory = overview?.byCategory || overview?.groups || {}
      for (const group of groups) {
        const entry = byCategory instanceof Map
          ? (byCategory.get(group.id) || byCategory.get(group.name))
          : (byCategory[group.id] || byCategory[group.name])
        const rawPlugins = Array.isArray(entry?.list)
          ? entry.list
          : Array.isArray(entry?.plugins)
            ? entry.plugins
            : []
        const plugins = rawPlugins.filter(isPluginSupportedOnCurrentPlatform)
        const groupTotal = Number(entry?.total ?? plugins.length)
        if (groupTotal > 0 || plugins.length > 0) {
          nextGroups.push({
            ...group,
            plugins,
            total: groupTotal,
            startIndex: runningStartIndex
          })
          runningStartIndex += plugins.length
        }
      }
    }
    catalogTotal = Number(overview?.total ?? 0)
    return { nextGroups, catalogTotal }
  }

  const [categories, catalogResult] = await Promise.all([
    categoriesPromise,
    pluginsStore.loadWithCache({ sourceType: 'all', page: 1, per_page: 1 })
  ])
  if (requestId !== loadRequestId) return null

  const groups = buildPreviewGroups(categories)
  const results = await Promise.allSettled(
    groups.map((group) =>
      pluginsStore.loadWithCache({
        category: group.id || group.name,
        page: 1,
        per_page: CATEGORY_PREVIEW_LIMIT
      })
    )
  )
  if (requestId !== loadRequestId) return null

  let failedCount = 0
  let runningStartIndex = 0
  for (let index = 0; index < groups.length; index += 1) {
    const result = results[index]
    if (result.status === 'rejected') {
      failedCount += 1
      console.warn(`[List] 分类“${groups[index].name}”预览加载失败:`, result.reason)
      continue
    }

    const plugins = (Array.isArray(result.value?.list)
      ? result.value.list
      : []).filter(isPluginSupportedOnCurrentPlatform)
    const groupTotal = Number(
      result.value?.total ?? groups[index].pluginsCount ?? plugins.length
    )
    if (groupTotal > 0 || plugins.length > 0) {
      nextGroups.push({
        ...groups[index],
        plugins,
        total: groupTotal,
        startIndex: runningStartIndex
      })
      runningStartIndex += plugins.length
    }
  }

  if (failedCount === groups.length && groups.length > 0) {
    throw new Error(t('market.categoryPreviewFailed'))
  }
  if (failedCount > 0) {
    toastWarning(t('market.partialCategoryFailed', { count: failedCount }, failedCount))
  }
  catalogTotal = catalogResult.total
  return { nextGroups, catalogTotal }
}

const load = async () => {
  const requestId = ++loadRequestId
  const requestCategory = category.value || ''
  const requestPage = page.value
  const requestPageSize = pageSize.value
  const requestKeyword = searchKeyword.value
  const requestIsCategoryOverview =
    requestCategory === '' && requestKeyword === '' && selectedSourceType.value === 'all'
  const hasWarmCache =
    Boolean(pluginsStore.hasFreshCatalog?.()) &&
    (categoriesStore.loaded || Boolean(categoriesStore.error))
  if (!hasWarmCache) {
    loading.value = true
  }
  isFetching.value = true
  error.value = ''
  try {
    const isFav = requestCategory === FAVORITES_CATEGORY_ID
    void refreshSourceCounts({ requestCategory: isFav ? '' : requestCategory, requestKeyword, isFav })
    const categoriesPromise = categoriesStore.fetchCategories()

    // 批量检查更新的公共函数（后台执行，不阻塞列表渲染）
    const doBatchCheck = () => {
      pluginsStore
        .checkInstalledUpdates()
        .catch((e) => console.warn('批量检查更新失败:', e))
    }

    // 首次加载时获取本地插件列表，完成后再批量检查
    if (pluginsStore.installedSet.size === 0) {
      loadingLocalPlugins.value = true
      pluginsStore
        .fetchInstalledPlugins()
        .then(() => {
          doBatchCheck()
        })
        .catch((e) => {
          console.warn('获取本地插件列表失败:', e)
        })
        .finally(() => {
          loadingLocalPlugins.value = false
        })
    } else {
      // 非首次加载，直接用已有的 installedPlugins 批量检查
      doBatchCheck()
    }

    if (requestIsCategoryOverview) {
      const overviewResult = await fetchCategoryOverview(categoriesPromise, requestId)
      if (!overviewResult || requestId !== loadRequestId) return

      previewGroups.value = overviewResult.nextGroups
      items.value = []
      // 一个插件可以属于多个分类；总数取当前系统目录的去重结果，不累加分类或预览数量。
      total.value = overviewResult.catalogTotal
    } else if (isFav) {
      // 收藏页：通过 IDs 批量获取，支持分页
      const favIds = Array.from(pluginsStore.favorites)
      if (!favIds || favIds.length === 0) {
        if (requestId !== loadRequestId) return
        previewGroups.value = []
        items.value = []
        total.value = 0
        return
      }

      const result = await pluginsStore.loadWithCache({
        ids: favIds,
        page: requestPage,
        per_page: requestPageSize,
        keyword: requestKeyword
      })

      if (requestId !== loadRequestId) return
      previewGroups.value = []
      items.value = result.list
      total.value = result.total
    } else {
      // 普通列表（走内存缓存，3分钟内不重复请求）
      const result = await pluginsStore.loadWithCache({
        category: requestCategory,
        sourceType: selectedSourceType.value,
        page: requestPage,
        per_page: requestPageSize,
        keyword: requestKeyword
      })
      if (requestId !== loadRequestId) return
      previewGroups.value = []
      items.value = result.list
      total.value = result.total
    }
  } catch (e) {
    if (requestId !== loadRequestId) return
    error.value = resolveErrorMessage(e, 'common.unknownError')
    toastError(t('market.loadListFailed', { reason: error.value }))
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
      isFetching.value = false
    }
  }
}

function syncRouteFilterAndReload(rawCategory, rawQuery) {
  const nextCategory = normalizeCategoryRouteParam(rawCategory || '')
  const nextKeyword = String(rawQuery || '').trim()
  if (nextCategory === category.value && nextKeyword === searchKeyword.value) return false
  const previousCategory = category.value
  category.value = nextCategory
  searchKeyword.value = nextKeyword

  page.value = 1
  resetListFocus()
  if (nextCategory !== previousCategory) {
    // 埋点：市场分类筛选
    track('market_filter', '', { category: nextCategory || 'all' })
  }
  needsReloadOnActivate = false
  load()
  return true
}

watch(
  [() => route.name, () => route.params.category, () => route.query.q],
  ([name, v, q]) => {
    if (!isPageActive.value) return
    if (name && name !== ROUTES.LIST.name) return
    syncRouteFilterAndReload(v, q)
  }
)

const toggleFavorite = async (pluginId) => {
  try {
    const id = getPluginId(pluginId)
    const wasFavorite = pluginsStore.isFavorite(id)
    await pluginsStore.toggleFavorite(id)
    toastSuccess(wasFavorite ? t('market.favoriteRemoved') : t('market.favoriteAdded'))
    if (category.value === 'favorites') await load()
  } catch (e) {
    if (!onAuthRequired(e)) {
      console.error('toggleFavorite error:', e)
      toastError(t('market.operationFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
    }
  }
}

const goDetails = (id) => {
  router.push(routeUtils.toPluginDetails(id))
}

const goCategory = (categoryIdOrName) => {
  router.push(routeUtils.toListCategory(normalizeCategoryRouteParam(categoryIdOrName)))
}

const handlePaginationChange = async (nextPage) => {
  page.value = Math.max(1, Number(nextPage) || 1)
  resetListFocus()
  await load()
}

const openApp = async (id) => {
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
      toastWarning(resolveErrorMessage(res, 'market.notInstalledReinstall'))
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

const openExtensionsRepo = () => {
  const url = 'https://github.com/ZToolsTeam/ZTools-extensions'
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

function clearSearchAndBrowse() {
  pluginsStore.setSourceFilter('all')
  router.replace({ ...ROUTES.LIST, params: { category: '' }, query: {} })
}

const openDevGuide = () => {
  const url = 'https://github.com/ZToolsTeam/ZTools-extensions#5-%E5%88%86%E9%92%9F%E8%B4%A1%E7%8C%AE%E4%BD%A0%E7%9A%84%E9%A6%96%E6%AC%BE%E6%8F%92%E4%BB%B6'
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

const listContainerRef = ref(null)
const focusedCardIndex = ref(0)
const actionPanelVisible = ref(false)

// 分类概览模式下键盘焦点按页面上实际展示的顺序（各分类前 8 个）移动
const isPreviewVisible = computed(() => isCategoryOverview.value && previewGroups.value.length > 0)

const currentDisplayList = computed(() => {
  if (isPreviewVisible.value) {
    const list = []
    for (const g of previewGroups.value) {
      if (Array.isArray(g.plugins)) list.push(...g.plugins)
    }
    return list
  }
  return items.value || []
})

function previewFlatIndex(groupIndex, index) {
  const group = previewGroups.value[groupIndex]
  if (typeof group?.startIndex === 'number') {
    return group.startIndex + index
  }
  let offset = 0
  for (let i = 0; i < groupIndex; i++) {
    offset += Array.isArray(previewGroups.value[i]?.plugins) ? previewGroups.value[i].plugins.length : 0
  }
  return offset + index
}

function getListNavGroup(idx) {
  if (!isPreviewVisible.value) return 'flat'
  let cursor = 0
  for (const g of previewGroups.value) {
    const len = Array.isArray(g?.plugins) ? g.plugins.length : 0
    if (idx < cursor + len) return g.name || ''
    cursor += len
  }
  return ''
}

const gridNav = useVisualGridNav({
  focusedIndex: focusedCardIndex,
  containerRef: listContainerRef,
  focusedSelector: '.is-list-card-focused',
  getTotalCount: () => currentDisplayList.value.length,
  fallbackColumns: 2,
  getGroup: getListNavGroup,
  onFocusGrid: () => {
    uiStore.focusGrid()
    focusCurrentCard()
  },
  onReachTop: () => {
    if (typeof window !== 'undefined' && typeof window.__ztoolsFocusHomeSearch === 'function') {
      window.__ztoolsFocusHomeSearch()
      uiStore.focusSearch()
      return true
    }
    return false
  }
})

function resetListFocus() {
  focusedCardIndex.value = 0
  gridNav.resetAnchor()
  actionPanelVisible.value = false
}

function focusCurrentCard() {
  listContainerRef.value?.querySelector(`[data-nav-index="${focusedCardIndex.value}"]`)?.focus({ preventScroll: true })
}

watch(() => uiStore.isGridFocused, (focused) => {
  if (focused && isPageActive.value && document.activeElement === document.body) focusCurrentCard()
})

function handleCardFocus(idx) {
  if (idx !== focusedCardIndex.value) gridNav.setFocusedIndex(idx)
  uiStore.focusGrid()
}

// 列表因筛选或取消收藏而变短时钳制焦点索引（不拦截测试手动赋越界值）
watch(
  () => currentDisplayList.value.length,
  (newLen, oldLen) => {
    if (oldLen > 0 && newLen > 0 && newLen < oldLen && focusedCardIndex.value >= newLen) {
      focusedCardIndex.value = newLen - 1
    }
  }
)

const focusedPlugin = computed(() => currentDisplayList.value[focusedCardIndex.value] || null)

const hasCardActions = computed(() => !isInitialLoading.value && !error.value && !!focusedPlugin.value)
const emptySearch = computed(() => !!searchKeyword.value && !isInitialLoading.value && !isFetching.value && !error.value && !currentDisplayList.value.length)
defineExpose({ hasCardActions })

const activePluginActions = computed(() => {
  const p = focusedPlugin.value
  if (!p) return []
  const pid = getPluginId(p)
  if (!pid) return []

  const isRevoked = Boolean(p.revoked || pluginsStore.isRevoked(pid))
  const isInstalled = installedSet.value.has(pid)
  const isFav = pluginsStore.isFavorite(pid)
  const actions = []

  if (!isRevoked) {
    if (isInstalled) {
      actions.push({
        type: 'Action',
        props: {
          title: t('market.actionOpenPlugin'),
          icon: 'arrow-right-circle',
          onAction: () => openApp(pid)
        }
      })
    } else {
      actions.push({
        type: 'Action',
        props: {
          title: isBundledPlugin(pid) ? t('common.restore') : t('market.actionInstallPlugin'),
          icon: 'download',
          onAction: () => handleDownload(pid)
        }
      })
    }
  }

  actions.push({
    type: 'Action',
    props: {
      title: t('market.actionViewDetails'),
      icon: 'eye',
      onAction: () => goDetails(pid)
    }
  })

  actions.push({
    type: 'Action',
    props: {
      title: isFav ? t('common.unfavorite') : t('market.card.addFavorite'),
      icon: isFav ? 'star-disabled' : 'star',
      onAction: () => toggleFavorite(pid)
    }
  })

  if (isRevoked && isInstalled && isBundledPlugin(pid)) {
    actions.push({
      type: 'Action',
      props: {
        title: t('myPage.manageBundledTitle'),
        icon: 'gear',
        onAction: () => router.push({ ...ROUTES.ADVANCED_SETTINGS, query: { manageBundled: pid } })
      }
    })
  } else if (isRevoked && isInstalled) {
    actions.push({
      type: 'Action',
      props: {
        title: t('market.actionUninstallPlugin'),
        icon: 'trash',
        style: 'destructive',
        onAction: async () => {
          try {
            const res = await pluginsStore.uninstallPlugin(pid)
            if (res?.success === false) {
              toastError(t('market.uninstallFailed', { reason: resolveErrorMessage(res, 'common.unknownError') }))
            } else {
              toastSuccess(t('market.uninstallSuccess'))
            }
          } catch (err) {
            toastError(t('market.uninstallFailed', { reason: resolveErrorMessage(err, 'common.unknownError') }))
          }
        }
      }
    })
  }

  return actions
})

watch(actionPanelVisible, (visible) => {
  uiStore.setGlobalActionPanelVisible(visible)
})

watch(
  () => uiStore.actionPanelTriggerSeq,
  () => {
    if (!isPageActive.value) return
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
    } else if (hasCardActions.value) {
      actionPanelVisible.value = true
    }
  }
)

function isStandaloneControlTarget(target) {
  return isInteractiveControlTarget(target, listContainerRef.value) && !target?.closest?.('[data-nav-index]')
}

function isStandaloneOrInnerActionControl(target) {
  if (!isInteractiveControlTarget(target, listContainerRef.value)) return false
  const cardRoot = target?.closest?.('[data-nav-index]')
  if (!cardRoot) return true
  return target !== cardRoot
}

function handleGridDirectionKey(e, key) {
  if (actionPanelVisible.value) return false
  if (isStandaloneControlTarget(e?.target)) return false
  return hasCardActions.value && gridNav.navigate(key)
}

useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowRight': (e) => handleGridDirectionKey(e, 'ArrowRight'),
  'ArrowLeft': (e) => handleGridDirectionKey(e, 'ArrowLeft'),
  'ArrowDown': (e) => handleGridDirectionKey(e, 'ArrowDown'),
  'ArrowUp': (e) => handleGridDirectionKey(e, 'ArrowUp'),
  'Home': (e) => handleGridDirectionKey(e, 'Home'),
  'End': (e) => handleGridDirectionKey(e, 'End'),
  'PageUp': (e) => handleGridDirectionKey(e, 'PageUp'),
  'PageDown': (e) => handleGridDirectionKey(e, 'PageDown'),
  'Enter': (e) => {
    if (actionPanelVisible.value || !hasCardActions.value) return false
    if (isStandaloneOrInnerActionControl(e?.target)) return false
    const p = currentDisplayList.value[focusedCardIndex.value]
    if (p) {
      const pid = getPluginId(p)
      if (installedSet.value.has(pid)) {
        openApp(pid)
      } else {
        goDetails(pid)
      }
      return true
    }
    return false
  },
  'Escape': () => {
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
      return true
    }
    return false
  },
  onKeyDown: (_event, { combo }) => {
    if (!matchesShellShortcut(combo, 'ACTION_PANEL')) return false
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
      return true
    }
    if (hasCardActions.value) {
      actionPanelVisible.value = true
      return true
    }
    return false
  }
})

const handleDownload = (id) => {
  const pid = getPluginId(id)
  return installWithFeedback(pid, async () => {
    if (!(await auth.ensureCanInstall())) return false
    track('plugin_clickinstall', pid)
    return true
  })
}

const onPluginUpdated = async (pluginId) => {
  // 保留兼容性，实际更新完成由 handleInstallComplete 处理
  await load()
}

// 处理收藏变化事件
const handleFavoriteChanged = async (envelope) => {
  try {
    // 如果当前在收藏页面，重新加载列表
    if (category.value === 'favorites') {
      if (!isPageActive.value) {
        needsReloadOnActivate = true
        return
      }
      console.debug('[List] 收藏状态变化，重新加载列表')
      await load()
    }
  } catch (e) {
    console.error('[List] 处理收藏变化事件失败:', e)
  }
}

// 处理插件安装完成事件
const handleInstallComplete = async (envelope) => {
  try {
    const payload = envelope?.payload || {}
    if (!pluginsStore.acceptsInstallEvent(payload)) return
    const pid = payload.pluginId

    if (!isPageActive.value) {
      if (payload.success && payload.isUpdate) {
        needsReloadOnActivate = true
      }
      return
    }

    if (payload.success) {
      console.debug('[List] 插件安装完成:', pid)
      // 根据 isUpdate 区分安装和更新
      if (payload.isUpdate) {
        toastSuccess(t('market.updateComplete'))
        await load()
      }
    } else if (pid) {
      toastError(t('market.installFailed', { reason: resolveErrorMessage(payload, 'common.unknownError') }))
    }
  } catch (e) {
    console.error('[List] 处理安装完成事件失败:', e)
  }
}

// 处理插件卸载完成事件
const handleUninstallComplete = async (envelope) => {
  try {
    const payload = envelope?.payload || {}
    const pid = payload.pluginId

    console.debug('[List] 插件卸载完成:', pid)
    // eventsStore 已经通过 onUninstallComplete 更新了 installedSet
    // 无需再次调用 fetchInstalledPlugins，避免竞态条件
  } catch (e) {
    console.error('[List] 处理卸载完成事件失败:', e)
  }
}

onMounted(() => {
  const initialCategory = normalizeCategoryRouteParam(route.params.category || '')
  nav.setCategory(initialCategory)
  // 埋点：市场页面访问
  track('market_view', '', { category: initialCategory || 'all' })
  load()
  // 插件卡片上的评分：官方版一次拉全量汇总并缓存几分钟，不阻塞列表；开源版没有评分，为空操作
  if (pluginRatings.enabled) {
    Promise.resolve(pluginRatings.loadAll()).catch(() => {})
  }

  // 订阅事件
  try {
    if (window.ztools && window.ztools.events) {
      window.ztools.events.on('favorite_changed', handleFavoriteChanged)
      window.ztools.events.on('plugin_install_complete', handleInstallComplete)
      window.ztools.events.on('plugin_uninstalled', handleUninstallComplete)
    }
  } catch (e) {
    console.error('[List] 订阅事件失败:', e)
  }
})

onActivated(() => {
  isPageActive.value = true
  if (route.name && route.name !== ROUTES.LIST.name) return
  const synced = syncRouteFilterAndReload(route.params.category, route.query.q)
  if (!synced && needsReloadOnActivate) {
    needsReloadOnActivate = false
    load()
  }
})

onDeactivated(() => {
  isPageActive.value = false
  if (actionPanelVisible.value) {
    actionPanelVisible.value = false
  }
})

onBeforeUnmount(() => {
  isPageActive.value = false
  if (actionPanelVisible.value) {
    actionPanelVisible.value = false
    uiStore.setGlobalActionPanelVisible(false)
  }
  // 取消事件订阅
  try {
    if (window.ztools && window.ztools.events) {
      window.ztools.events.off('favorite_changed', handleFavoriteChanged)
      window.ztools.events.off('plugin_install_complete', handleInstallComplete)
      window.ztools.events.off('plugin_uninstalled', handleUninstallComplete)
    }
  } catch (e) {
    console.error('[List] 取消订阅失败:', e)
  }
})
</script>

<template>
  <div
    ref="listContainerRef"
    class="rc-page market-page"
    @mousemove="gridNav.handlePointerMove"
  >
    <!-- 页头：插件市场 / 当前分类 / 搜索词 -->
    <header class="page-header has-action">
      <div class="market-head-text">
        <h1 class="page-title">{{ category ? getLocalizedCategoryName(category) : (searchKeyword ? t('market.searchTitle', { keyword: searchKeyword }) : t('market.title')) }}</h1>
        <p class="page-subtitle">{{ t('market.subtitle') }}</p>
      </div>
      <!-- 页面级动作：中性次按钮（橙色克制，本页不放实心/淡橙按钮）；外链图标表示会在浏览器打开 GitHub -->
      <RcButton
        variant="secondary"
        size="md"
        :icon="ExternalLinkIcon"
        v-if="!emptySearch"
        class="market-submit"
        :title="t('market.submitTooltip')"
        @click="openExtensionsRepo"
      >
        {{ t('market.submitPlugin') }}
      </RcButton>
    </header>
    <!-- 加载骨架屏：等分类和插件列表都就绪后再渲染 -->
    <div
      v-if="isInitialLoading"
      style="
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
      "
    >
      <SkeletonCard v-for="i in 8" :key="i" />
    </div>

    <!-- 全部插件：分类概览，每个分类固定展示前 8 个 -->
    <template
      v-else-if="
        categoriesReady &&
        isCategoryOverview &&
        previewGroups.length > 0
      "
    >
      <div
        v-for="group in previewGroups"
        :key="group.id || group.name"
        style="margin-bottom: 16px"
      >
        <!-- 分类标题：Raycast 纯粹极客 Section 风格 -->
        <div
          class="flex items-center justify-between"
          style="margin-bottom: 8px; margin-top: 10px;"
        >
          <div class="flex items-center gap-2">
            <span class="text-[length:var(--rc-fs-small)] font-semibold text-[var(--rc-text-primary)] tracking-wide">
              {{ getLocalizedCategoryName(group.id || group.name) }}
            </span>
            <span class="text-[length:var(--rc-fs-caption)] font-mono text-[var(--rc-text-muted)]">
              {{ group.total }}
            </span>
          </div>
          <button
            type="button"
            class="category-view-all-btn text-[length:var(--rc-fs-caption)] text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 transition-colors whitespace-nowrap"
            @click="goCategory(group.id || group.name)"
          >
            <span>{{ t('market.viewAll') }}</span>
            <ChevronRightIcon class="text-[length:var(--rc-fs-caption)]" />
          </button>
        </div>
        <!-- 该分类下的插件网格 -->
        <div
          style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 12px;
          "
        >
          <PluginCard3D
            v-for="(p, index) in group.plugins"
            :key="getPluginId(p)"
            class="transition-all rounded-[var(--rc-radius-lg)]"
            :class="{ 'is-list-card-focused': !uiStore.isSearchInputActive && focusedCardIndex === group.startIndex + index }"
            :data-nav-index="group.startIndex + index"
            :data-nav-group="group.id || group.name"
            v-bind="cardProps(p, group.startIndex + index)"
            @click="handleCardFocus(group.startIndex + index)"
            @focusin="handleCardFocus(group.startIndex + index)"
            @toggle-favorite="toggleFavorite"
            @open="goDetails"
            @open-app="openApp"
            @download="handleDownload"
            @plugin-updated="onPluginUpdated"
          />
        </div>
      </div>
    </template>

    <!-- 空结果提供直接返回完整目录的入口 -->
    <RcEmpty
      v-else-if="categoriesReady && !loading && !isFetching && !error && items.length === 0"
      :icon="SearchIcon"
      :title="route.query.q ? t('market.emptySearchTitle', { keyword: route.query.q }) : t('market.emptyTitle')"
      :description="route.query.q ? t('market.emptySearchDesc') : t('market.emptyDesc')"
    >
      <template v-if="emptySearch" #action>
        <div class="flex flex-col items-center gap-2">
          <RcButton variant="primary" size="md" @click="clearSearchAndBrowse">{{ t('market.clearSearchAndBrowse') }}</RcButton>
          <RcButton variant="ghost" size="sm" @click="openDevGuide">{{ t('market.devGuide') }}</RcButton>
        </div>
      </template>
    </RcEmpty>

    <!-- 搜索结果 / 具体分类 / 收藏：平铺展示 -->
    <div
      v-else-if="categoriesReady && !loading"
      style="
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
      "
    >
      <PluginCard3D
        v-for="(p, index) in items"
        :key="getPluginId(p)"
        class="transition-all rounded-[var(--rc-radius-lg)]"
        :class="{ 'is-list-card-focused': !uiStore.isSearchInputActive && focusedCardIndex === index }"
        :data-nav-index="index"
        data-nav-group="flat"
        @click="handleCardFocus(index)"
        @focusin="handleCardFocus(index)"
        v-bind="cardProps(p, index)"
        @toggle-favorite="toggleFavorite"
        @open="goDetails"
        @open-app="openApp"
        @download="handleDownload"
        @plugin-updated="onPluginUpdated"
      />
    </div>
    <div
      v-if="error"
      style="font-size: var(--rc-fs-small); color: var(--rc-error)"
    >
      {{ error }}
    </div>
    <div
      v-if="!isCategoryOverview && total > 0"
      class="flex items-center justify-center"
      style="padding-top: var(--spacing-lg)"
    >
      <a-pagination
        show-less-items
        size="small"
        :current="page"
        :page-size="pageSize"
        :total="total"
        @change="handlePaginationChange"
      >
        <!-- 上一页 / 下一页换成 Lucide 图标，其余页码沿用默认渲染 -->
        <template #itemRender="{ type, originalElement }">
          <button v-if="type === 'prev'" type="button" class="ant-pagination-item-link" :aria-label="t('market.prevPage')"><ChevronLeftIcon aria-hidden="true" /></button>
          <button v-else-if="type === 'next'" type="button" class="ant-pagination-item-link" :aria-label="t('market.nextPage')"><ChevronRightIcon aria-hidden="true" /></button>
          <a v-else-if="type === 'jump-prev' || type === 'jump-next'" class="ant-pagination-item-link" :aria-label="type === 'jump-prev' ? t('market.jumpPrev5') : t('market.jumpNext5')">
            <div class="ant-pagination-item-container">
              <component :is="type === 'jump-prev' ? ChevronsLeftIcon : ChevronsRightIcon" class="ant-pagination-item-link-icon" aria-hidden="true" />
              <span class="ant-pagination-item-ellipsis">•••</span>
            </div>
          </a>
          <component :is="originalElement" v-else />
        </template>
      </a-pagination>
    </div>

    <!-- 底部：开源插件大仓直达 -->
    <RcBannerLink
      v-if="!emptySearch"
      class="market-repo-banner"
      :title="t('market.repoBannerTitle')"
      :description="t('market.repoBannerDesc')"
      :link-text="t('market.repoBannerLink')"
      @click="openExtensionsRepo"
    />

    <!-- 当前聚焦插件快捷动作面板 -->
    <ActionPanelModal
      :visible="actionPanelVisible"
      :actions="activePluginActions"
      :target-title="focusedPlugin ? getLocalizedPluginName(focusedPlugin) : ''"
      placement="corner"
      @close="actionPanelVisible = false"
      @trigger="(act) => act?.props?.onAction?.()"
    />
  </div>
</template>

<style scoped>
.market-page {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

/* 外框（.rc-page）与页头（.page-header/.page-title/.page-subtitle）用全局样式；
   页头在 flex 列里，下边距 12 + 列间距 8 = 与其它页一致的 20px */
.market-page > .page-header {
  margin-bottom: 12px;
}

.market-head-text {
  min-width: 0;
}

.market-submit {
  flex-shrink: 0;
}

.market-repo-banner {
  margin: 28px 0 12px;
}

.is-list-card-focused {
  border-radius: var(--rc-radius-lg);
  box-shadow: var(--rc-focus-ring);
}

.is-list-card-focused:focus-visible {
  outline: none;
}

.is-list-card-focused:has(:focus-visible) {
  box-shadow: none;
}

.is-list-card-focused :deep(.card-compact) {
  border-color: transparent;
}
</style>
