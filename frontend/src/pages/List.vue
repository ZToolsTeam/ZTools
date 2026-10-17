<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import PluginCard3D from '@/components/PluginCard3D.vue'
import SkeletonCard from '@/components/SkeletonCard.vue'

import { useNavStore } from '@/stores/nav'
import { usePluginsStore } from '@/stores/plugins'
import { useCategoriesStore } from '@/stores/categories'
import {
  openPlugin as apiOpenPlugin,
  batchCheckPlugins,
  getDownloadSign,
  installPluginNative,
  isAuthenticated,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from '@/api/apiserver'
import { useToast } from '@/composables/useToast'
import { useVersionCompat } from '@/composables/useVersionCompat'
import { useUIStore } from '@/stores/ui'
import { routeUtils, ROUTES } from '@/router/routes'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { isOfficialPlugin } from '@/utils/officialPlugins'
import { useKeymap, KEYMAP_SCOPES } from '@/utils/keymap'

const nav = useNavStore()
const uiStore = useUIStore()
const pluginsStore = usePluginsStore()
const categoriesStore = useCategoriesStore()
const route = useRoute()
const router = useRouter()
const { toastError, toastSuccess, toastWarning } = useToast()
const { checkPluginCompat } = useVersionCompat()

const CATEGORY_PREVIEW_LIMIT = 8
const PAGE_SIZE_OPTIONS = ['10', '20', '50']
const DEFAULT_PAGE_SIZE = 20
const PAGE_SIZE_STORAGE_KEY = 'ztools_market_page_size'

const normalizePageSize = (value, fallback = DEFAULT_PAGE_SIZE) => {
  const normalized = Number(value)
  return PAGE_SIZE_OPTIONS.includes(String(normalized))
    ? normalized
    : fallback
}

const loadPersistedPageSize = () => {
  try {
    return normalizePageSize(window.localStorage?.getItem(PAGE_SIZE_STORAGE_KEY))
  } catch (e) {
    console.warn('[List] 读取分页容量设置失败:', e)
    return DEFAULT_PAGE_SIZE
  }
}

const persistPageSize = (value) => {
  try {
    window.localStorage?.setItem(PAGE_SIZE_STORAGE_KEY, String(value))
  } catch (e) {
    console.warn('[List] 保存分页容量设置失败:', e)
  }
}

const items = ref([])
const previewGroups = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(loadPersistedPageSize())
const category = ref(route.params.category || '')
const loading = ref(false)
const loadingLocalPlugins = ref(false)
const error = ref('')
let loadRequestId = 0

// 是否为"全部"分类视图（需要分组展示）
const isAllCategory = computed(() => !category.value || category.value === '')
const searchKeyword = computed(() => String(route.query.q || '').trim())

// 页面内分类筛选：与侧栏 selectCategory 行为一致（切换分类时清空搜索词）
function selectMarketCategory(name) {
  const next = name === '全部' ? '' : name
  nav.setCategory(next)
  router.push({ ...ROUTES.LIST, params: { category: next } })
}
const selectedSourceType = computed(() => pluginsStore.sourceFilter || 'all')
const isCategoryOverview = computed(
  () => isAllCategory.value && searchKeyword.value === '' && selectedSourceType.value === 'all'
)

const switchSourceType = async (type) => {
  page.value = 1
  await pluginsStore.setSourceFilter(type)
  await load()
}

// 分类名称 → 图标映射（前端本地维护）
const CATEGORY_ICON_MAP = {
  '系统工具': 'fa-wrench',
  '办公效率': 'fa-briefcase',
  '媒体处理': 'fa-file-image-o',
  '安全工具': 'fa-shield'
}

const categoriesReady = computed(() => categoriesStore.loaded || categoriesStore.error)
// 当前系统上一个插件都没有的分类不显示（正在查看的分类保留，免得页面没有选中项）
const visibleMarketCategories = computed(() =>
  (categoriesStore.sidebarCategories || []).filter((c) => pluginsStore.isCategoryVisible(c.name, category.value))
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

const load = async () => {
  const requestId = ++loadRequestId
  const requestCategory = category.value || ''
  const requestPage = page.value
  const requestPageSize = pageSize.value
  const requestKeyword = searchKeyword.value
  const requestIsCategoryOverview =
    requestCategory === '' && requestKeyword === '' && selectedSourceType.value === 'all'
  loading.value = true
  error.value = ''
  try {
    const isFav = requestCategory === 'favorites'
    const categoriesPromise = categoriesStore.fetchCategories()

    // 批量检查更新的公共函数（后台执行，不阻塞列表渲染）
    const doBatchCheck = () => {
      // 节流：5 分钟内不重复请求
      if (!pluginsStore.shouldCheckUpdate()) return
      const locals = pluginsStore.installedPlugins
      if (locals.length === 0) return
      batchCheckPlugins({
        plugins: locals.map((p) => ({
          id: p.pluginId,
          version: p.version || '1.0.0'
        }))
      })
        .then(async (updates) => {
          await pluginsStore.setUpdateInfo(updates)
        })
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
      const categories = await categoriesPromise
      if (requestId !== loadRequestId) return

      const groups = categories.map((item) => ({
        ...item,
        icon: CATEGORY_ICON_MAP[item.name] || 'fa-cube'
      }))
      const results = await Promise.allSettled(
        groups.map((group) =>
          pluginsStore.loadWithCache({
            category: group.name,
            page: 1,
            per_page: CATEGORY_PREVIEW_LIMIT
          })
        )
      )
      if (requestId !== loadRequestId) return

      const nextGroups = []
      let failedCount = 0
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
            total: groupTotal
          })
        }
      }

      if (failedCount === groups.length && groups.length > 0) {
        throw new Error('分类预览加载失败')
      }
      if (failedCount > 0) {
        toastWarning(`有 ${failedCount} 个分类加载失败，请稍后重试`)
      }

      previewGroups.value = nextGroups
      items.value = []
      total.value = nextGroups.reduce((sum, group) => sum + group.total, 0)
    } else if (isFav) {
      previewGroups.value = []
      // 收藏页：通过 IDs 批量获取，支持分页
      const favIds = Array.from(pluginsStore.favorites)
      if (!favIds || favIds.length === 0) {
        if (requestId !== loadRequestId) return
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
      items.value = result.list
      total.value = result.total
    } else {
      previewGroups.value = []
      // 普通列表（走内存缓存，3分钟内不重复请求）
      const result = await pluginsStore.loadWithCache({
        category: requestCategory,
        sourceType: selectedSourceType.value,
        page: requestPage,
        per_page: requestPageSize,
        keyword: requestKeyword
      })
      if (requestId !== loadRequestId) return
      items.value = result.list
      total.value = result.total
    }
  } catch (e) {
    if (requestId !== loadRequestId) return
    error.value = e.message || String(e)
    toastError('加载列表失败: ' + error.value)
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
    }
  }
}

watch(
  [() => route.params.category, () => route.query.q],
  ([v], [previousCategory]) => {
    category.value = v || ''
    page.value = 1
    if (v !== previousCategory) {
      // 埋点：市场分类筛选
      window.ztools?.analytics?.report('market_filter', '', { category: v || 'all' })
    }
    load()
  }
)

const toggleFavorite = async (pluginId) => {
  try {
    // 收藏功能必须登录
    const id = getPluginId(pluginId)
    const wasFavorite = pluginsStore.isFavorite(id)
    await pluginsStore.toggleFavorite(id)
    toastSuccess(wasFavorite ? '已取消收藏' : '已加入收藏')
    if (category.value === 'favorites') await load()
  } catch (e) {
    if (e.status === 401 || e.need_login) {
      toastWarning(e.message || '请先登录后继续')
      uiStore.openLoginModal()
    } else {
      console.error('toggleFavorite error:', e)
      toastError('操作失败: ' + (e.message || e))
    }
  }
}

const goDetails = (id) => {
  router.push(routeUtils.toPluginDetails(id))
}

const goCategory = (categoryName) => {
  router.push(routeUtils.toListCategory(categoryName))
}

const handlePaginationChange = async (nextPage, nextPageSize) => {
  const resolvedPageSize = normalizePageSize(nextPageSize, pageSize.value)
  const sizeChanged = resolvedPageSize !== pageSize.value

  pageSize.value = resolvedPageSize
  page.value = sizeChanged ? 1 : Math.max(1, Number(nextPage) || 1)
  if (sizeChanged) {
    persistPageSize(resolvedPageSize)
  }
  await load()
}

const openApp = async (id) => {
  const pluginId = getPluginId(id)
  if (!pluginId) return

  if (pluginsStore.isRevoked(pluginId)) {
    const reason = pluginsStore.getRevokedReason(pluginId) || '该插件已被官方下架禁用'
    toastError('无法启动：' + reason)
    return
  }

  if (isOfficialPlugin(pluginId)) {
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
      toastWarning(res.error || '插件未安装，请重新下载')
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

const openExtensionsRepo = () => {
  const url = 'https://github.com/codingmuse/ZTools-extensions'
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

const openDevGuide = () => {
  const url = 'https://github.com/codingmuse/ZTools-extensions#5-%E5%88%86%E9%92%9F%E8%B4%A1%E7%8C%AE%E4%BD%A0%E7%9A%84%E9%A6%96%E6%AC%BE%E6%8F%92%E4%BB%B6'
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

const focusedCardIndex = ref(0)

const currentDisplayList = computed(() => {
  if (isOverviewMode.value) {
    const list = []
    for (const g of groupedPlugins.value) {
      if (Array.isArray(g.plugins)) list.push(...g.plugins)
    }
    return list
  }
  return items.value || []
})

function scrollFocusedCardIntoView() {
  if (typeof document !== 'undefined') {
    const el = document.querySelector('.is-list-card-focused')
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }
}

useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowRight': () => {
    if (currentDisplayList.value.length === 0) return false
    focusedCardIndex.value = Math.min(focusedCardIndex.value + 1, currentDisplayList.value.length - 1)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowLeft': () => {
    if (currentDisplayList.value.length === 0) return false
    focusedCardIndex.value = Math.max(focusedCardIndex.value - 1, 0)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowDown': () => {
    if (currentDisplayList.value.length === 0) return false
    focusedCardIndex.value = Math.min(focusedCardIndex.value + 3, currentDisplayList.value.length - 1)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'ArrowUp': () => {
    if (currentDisplayList.value.length === 0) return false
    focusedCardIndex.value = Math.max(focusedCardIndex.value - 3, 0)
    uiStore.focusGrid()
    scrollFocusedCardIntoView()
    return true
  },
  'Enter': () => {
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
  'Ctrl+K': () => {
    const p = currentDisplayList.value[focusedCardIndex.value]
    if (p) {
      toggleFavorite(getPluginId(p))
      return true
    }
    return false
  }
})

const handleDownload = async (id) => {
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
    const loggedIn = await isAuthenticated()
    if (!loggedIn) {
      toastError('请先登录后下载插件')
      uiStore.openLoginModal()
      return
    }

    window.ztools?.analytics?.report('plugin_clickinstall', pid)
    toastSuccess('正在安装插件，请稍候...')
    await pluginsStore.installPlugin(pid, { autoOpen: true })
    toastSuccess('插件安装完成')
  } catch (e) {
    if (typeof isPluginVersionIncompatibleError === 'function' && isPluginVersionIncompatibleError(e)) {
      toastWarning(typeof getPluginVersionIncompatibleMessage === 'function' ? getPluginVersionIncompatibleMessage(e) : '插件版本不兼容')
    } else if (e.status === 401 || e.need_login) {
      toastError(e.message || '请先登录后下载插件')
      uiStore.openLoginModal()
    } else {
      toastError('安装失败: ' + (e.message || e))
    }
  }
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
    const pid = payload.pluginId

    if (payload.success) {
      console.debug('[List] 插件安装完成:', pid)
      // 根据 isUpdate 区分安装和更新
      if (payload.isUpdate) {
        toastSuccess('插件更新完成')
        await load()
      }
    } else if (pid) {
      toastError('安装失败: ' + (payload.error || '未知错误'))
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
  nav.setCategory(route.params.category || '')
  // 埋点：市场页面访问
  window.ztools?.analytics?.report('market_view', '', { category: route.params.category || 'all' })
  load()

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

onBeforeUnmount(() => {
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
    style="
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      color: var(--color-text);
    "
  >
    <!-- 页头：插件市场 / 当前分类 / 搜索词 -->
    <header class="market-head">
      <div class="market-head-text">
        <h1 class="market-title">{{ category || (searchKeyword ? `搜索「${searchKeyword}」` : '插件市场') }}</h1>
        <p class="market-subtitle">每个插件都经过官方审核，源码公开，免费安装。</p>
      </div>
      <button type="button" class="market-submit" title="插件投稿即向开源插件大仓提交 PR，官方审核后上架" @click="openExtensionsRepo">
        提交插件
      </button>
    </header>

    <!-- 页面内筛选：分类（与侧栏同一导航）+ 来源 -->
    <div class="market-filters">
      <div class="market-chips" role="group" aria-label="分类">
        <button
          v-for="c in visibleMarketCategories"
          :key="c.name"
          type="button"
          class="market-chip"
          :class="{ 'is-on': c.name === '全部' ? !category : category === c.name }"
          :aria-pressed="c.name === '全部' ? !category : category === c.name"
          @click="selectMarketCategory(c.name)"
        >
          <span class="market-chip-marker" aria-hidden="true"></span>{{ c.name }}
        </button>
      </div>
      <div class="market-filters-side">
        <div class="market-seg" role="group" aria-label="来源">
            <button
              type="button"
              class="market-seg-btn"
              :class="{ 'is-on': selectedSourceType === 'all' }"
              :aria-pressed="selectedSourceType === 'all'"
              @click="switchSourceType('all')"
            >
              全部
            </button>
            <button
              type="button"
              class="market-seg-btn"
              :class="{ 'is-on': selectedSourceType === 'official' }"
              :aria-pressed="selectedSourceType === 'official'"
              @click="switchSourceType('official')"
            >
              官方自营
            </button>
            <button
              type="button"
              class="market-seg-btn"
              :class="{ 'is-on': selectedSourceType === 'community' }"
              :aria-pressed="selectedSourceType === 'community'"
              @click="switchSourceType('community')"
            >
              社区精选
            </button>
        </div>
        <span class="market-total">共 {{ total }} 个</span>
      </div>
    </div>
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
        :key="group.name"
        style="margin-bottom: 16px"
      >
        <!-- 分类标题：Raycast 纯粹极客 Section 风格 -->
        <div
          class="flex items-center justify-between"
          style="margin-bottom: 8px; margin-top: 10px;"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-[var(--rc-text-primary)] tracking-wide">
              {{ group.name }}
            </span>
            <span class="text-[11px] font-mono text-[var(--rc-text-muted)]">
              {{ group.total }}
            </span>
          </div>
          <button
            type="button"
            class="category-view-all-btn text-[11px] text-[var(--rc-text-secondary)] hover:text-[var(--rc-text-primary)] flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 transition-colors"
            @click="goCategory(group.name)"
          >
            <span>全部</span>
            <i class="fa fa-angle-right text-[10px]"></i>
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
            v-for="p in group.plugins"
            :key="getPluginId(p)"
            :plugin="p"
            :showFavorite="true"
            :isFavorite="pluginsStore.isFavorite(getPluginId(p))"
            :isInstalled="installedSet.has(getPluginId(p))"
            :downloading="downloadingSet.has(getPluginId(p))"
            :installFailed="installFailedSet.has(getPluginId(p))"
            :updateInfo="updateMap[getPluginId(p)]"
            @toggle-favorite="toggleFavorite"
            @open="goDetails"
            @open-app="openApp"
            @download="handleDownload"
            @plugin-updated="onPluginUpdated"
          />
        </div>
      </div>
    </template>

    <!-- 空状态提示：智能开发者转化引导 -->
    <div
      v-else-if="categoriesReady && !loading && items.length === 0"
      style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 50px 20px;
        color: var(--color-text-secondary);
      "
    >
      <i
        class="fa fa-search"
        style="font-size: 36px; opacity: 0.3; margin-bottom: 12px"
      ></i>
      <p style="font-size: var(--font-size-body-l); font-weight: 500; margin: 0 0 4px">
        {{ route.query.q ? `未找到与 "${route.query.q}" 相关的插件` : '暂无插件' }}
      </p>
      <p style="font-size: var(--font-size-body-s); opacity: 0.6; margin: 0 0 16px">
        {{ route.query.q ? '试试其他关键词，或者亲手打造它：' : '稍后再来看看' }}
      </p>

      <!-- 杀手级开发者号召卡片 -->
      <div
        v-if="route.query.q"
        class="flex flex-col items-center max-w-md p-4 rounded-xl border border-[var(--rc-border)] bg-[var(--rc-bg-secondary,rgba(255,255,255,0.03))] shadow-sm"
      >
        <div class="text-sm font-medium mb-1 text-[var(--rc-text-primary)]">
          🚀 想要「{{ route.query.q }}」功能？
        </div>
        <div class="text-xs text-[var(--rc-text-muted)] mb-3 text-center leading-relaxed">
          ZTools 全面拥抱开源生态！基于统一声明式 UI 标准，5 分钟为你需要的工具写一个插件，投稿即 PR，官方审核后全网一键分发。
        </div>
        <div class="flex items-center gap-2">
          <a-button type="primary" size="small" @click="openExtensionsRepo">
            <template #icon><i class="fa fa-github mr-1"></i></template>
            访问 ZTools-extensions 大仓
          </a-button>
          <a-button size="small" @click="openDevGuide">
            查看 5 分钟上手指南
          </a-button>
        </div>
      </div>
    </div>

    <!-- 搜索结果 / 具体分类 / 收藏：平铺展示 -->
    <div
      v-else-if="categoriesReady && !loading"
      style="
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
      "
    >
      <div
        v-for="(p, index) in items"
        :key="getPluginId(p)"
        class="transition-all rounded-xl"
        :class="{ 'is-list-card-focused': focusedCardIndex === index }"
        @click="focusedCardIndex = index; uiStore.focusGrid()"
      >
        <PluginCard3D
          :plugin="p"
          :showFavorite="true"
          :isFavorite="pluginsStore.isFavorite(getPluginId(p))"
          :isInstalled="installedSet.has(getPluginId(p))"
          :downloading="downloadingSet.has(getPluginId(p))"
          :installFailed="installFailedSet.has(getPluginId(p))"
          :updateInfo="updateMap[getPluginId(p)]"
          @toggle-favorite="toggleFavorite"
          @open="goDetails"
          @open-app="openApp"
          @download="handleDownload"
          @plugin-updated="onPluginUpdated"
        />
      </div>
    </div>
    <div
      v-if="error"
      style="font-size: var(--font-size-body-s); color: var(--color-error)"
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
        show-size-changer
        size="small"
        :current="page"
        :page-size="pageSize"
        :page-size-options="PAGE_SIZE_OPTIONS"
        :total="total"
        @change="handlePaginationChange"
      />
    </div>

    <!-- 底部：开源插件大仓直达 -->
    <button type="button" class="market-repo-banner" @click="openExtensionsRepo">
      <span class="market-repo-text">
        <span class="market-repo-title">没找到想要的工具？</span>
        <span class="market-repo-desc">插件源码全部开源，投稿即提交 PR，5 分钟就能写一个自己的插件</span>
      </span>
      <span class="market-repo-link">访问 ZTools-extensions →</span>
    </button>
  </div>
</template>

<style scoped>
.market-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.market-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--rc-text-primary);
}

.market-subtitle {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--rc-text-muted);
}

.market-submit {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--rc-radius-md);
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.market-submit:hover {
  background: var(--rc-surface-hover);
}

.market-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--rc-border);
}

.market-chips {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
}

.market-chip {
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 8px;
  border: none;
  border-radius: var(--rc-radius-md);
  background: transparent;
  color: var(--rc-text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.market-chip:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.market-chip.is-on {
  background: var(--rc-surface-active);
  color: var(--rc-text-primary);
  font-weight: 600;
}

.market-chip-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  background: transparent;
}

.market-chip.is-on .market-chip-marker {
  background: var(--rc-accent);
  box-shadow: var(--rc-marker-glow);
}

.market-filters-side {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.market-seg {
  display: flex;
  padding: 2px;
  border-radius: var(--rc-radius-md);
  background: var(--rc-kbd-bg);
}

.market-seg-btn {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--rc-text-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.market-seg-btn:hover {
  color: var(--rc-text-primary);
}

.market-seg-btn.is-on {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  box-shadow: var(--rc-shadow-sm);
}

.market-total {
  font-size: 12px;
  color: var(--rc-text-muted);
  white-space: nowrap;
}

.market-repo-banner {
  width: 100%;
  margin: 28px 0 12px;
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

.market-repo-banner:hover {
  border-color: var(--rc-accent);
}

.market-repo-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.market-repo-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
}

.market-repo-desc {
  font-size: 12px;
  color: var(--rc-text-muted);
}

.market-repo-link {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--rc-accent-text);
}

.is-list-card-focused {
  border-radius: var(--rc-radius-lg, 12px);
  box-shadow: var(--rc-focus-ring);
}

.is-list-card-focused :deep(.card-compact) {
  border-color: transparent;
}
</style>
