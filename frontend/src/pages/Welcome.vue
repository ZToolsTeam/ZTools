<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'

import PluginCard from '@/components/PluginCard.vue'
import SkeletonCard from '@/components/SkeletonCard.vue'

import { usePluginsStore } from '@/stores/plugins'
import {
  getMarketPlugins,
  openPlugin as apiOpenPlugin,
  batchCheckPlugins,
  getDownloadSign,
  installPluginNative,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from '@/api/apiserver'
import { useToast } from '@/composables/useToast'
import { onAuthRequired } from '@edition'
import { routeUtils } from '@/router/routes'

const router = useRouter()
const pluginsStore = usePluginsStore()
const { toastSuccess, toastError, toastWarning } = useToast()

const items = ref([])
const category = ref('')
const loading = ref(false)
const error = ref('')
const updateMap = ref({})

// 使用 Store 的状态，避免重复维护
const installedSet = computed(() => pluginsStore.installedSet)
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
  loading.value = true
  error.value = ''
  try {
    // 只在首次加载时获取本地已安装列表（避免覆盖事件系统维护的状态）
    if (pluginsStore.installedSet.size === 0) {
      pluginsStore
        .fetchInstalledPlugins()
        .then((locals) => {
          const localPlugins = Array.isArray(locals) ? locals : []

          // 批量检查更新（后台执行）
          if (localPlugins.length > 0) {
            batchCheckPlugins({
              plugins: localPlugins.map((p) => ({
                id: p.pluginId,
                version: p.version || '1.0.0'
              }))
            })
              .then((updates) => {
                updateMap.value = updates || {}
              })
              .catch((e) => console.warn('批量检查更新失败:', e))
          }
        })
        .catch((e) => {
          console.warn('获取本地插件列表失败:', e)
        })
    }

    const { list } = await pluginsStore.loadWithCache({
      category: category.value,
      per_page: 12
    })
    items.value = list
  } catch (e) {
    error.value = e.message || String(e)
    toastError('加载推荐插件失败: ' + error.value)
  } finally {
    loading.value = false
  }
}

const toggleFavorite = async (pluginId) => {
  try {
    const id = getPluginId(pluginId)
    await pluginsStore.toggleFavorite(id)
    const isFav = pluginsStore.isFavorite(id)
    toastSuccess(isFav ? '已加入收藏' : '已取消收藏')
  } catch (e) {
    if (!onAuthRequired(e)) {
      toastError('操作失败: ' + (e.message || e))
    }
  }
}
const goDetails = (id) => {
  router.push(routeUtils.toPluginDetails(id))
}
const openApp = async (id) => {
  try {
    const res = await apiOpenPlugin(id)

    // 检查是否需要导航到详情页（插件已卸载的情况）
    if (res?.action === 'navigate_to_detail') {
      toastWarning(res.error || '插件未安装，请重新下载')
      router.push(routeUtils.toPluginDetails(res.pluginId || id))
      return
    }

    if (res?.success) toastSuccess('已启动插件')
    else toastError('启动失败')
  } catch (e) {
    toastError('启动失败: ' + (e.message || e))
  }
}

const handleDownload = async (id) => {
  // 防止重复下载
  if (pluginsStore.downloadingSet.has(String(id))) {
    toastError('该插件正在下载中，请稍候')
    return
  }

  try {
    // 标记为下载中
    pluginsStore.startDownload(id)
    toastSuccess('插件安装中...')

    // 1. 获取下载签名 (Backend)
    const downloadInfo = await getDownloadSign(id)
    const downloadUrl = downloadInfo?.downloadUrl

    if (!downloadUrl) throw new Error('无法获取下载地址')

    // 2. 开始下载 (Native)
    const result = await installPluginNative(id, downloadInfo)

    if (!result || !result.success) {
      throw new Error(result?.error || '启动下载失败')
    }
  } catch (e) {
    // 出错时清除下载状态
    pluginsStore.endDownload(id)

    if (isPluginVersionIncompatibleError(e)) {
      toastWarning(getPluginVersionIncompatibleMessage(e))
    } else if (onAuthRequired(e, { level: 'error' })) {
      // 需要登录：已提示并打开登录框（只有官方版）
    } else {
      // 非登录问题：标记为安装失败，按钮显示"重试"
      const nextFailed = new Set(pluginsStore.installFailedSet)
      nextFailed.add(String(id))
      pluginsStore.installFailedSet = nextFailed
      toastError('下载失败: ' + (e.message || e))
    }
  }
}

// Welcome 页面不需要处理安装完成事件
// 因为已经使用 store 的 installedSet，eventsStore 会自动更新

// 处理插件卸载事件（保留用于清除 updateMap）
const handlePluginUninstalled = async (envelope) => {
  try {
    const payload = envelope?.payload || {}
    const pluginId = payload.pluginId
    if (pluginId) {
      // 清除更新信息
      if (updateMap.value[pluginId]) {
        delete updateMap.value[pluginId]
      }
    }
  } catch (e) {
    console.error('处理卸载事件失败:', e)
  }
}

onMounted(async () => {
  // console.log('Welcome component mounted')
  await load()

  // 订阅插件卸载事件（只用于清除 updateMap）
  try {
    if (window.ztools && window.ztools.events) {
      window.ztools.events.on('plugin_uninstalled', handlePluginUninstalled)
    }
  } catch (e) {
    console.error('订阅插件事件失败:', e)
  }
})

onBeforeUnmount(() => {
  // 取消事件订阅
  try {
    if (window.ztools && window.ztools.events) {
      window.ztools.events.off('plugin_uninstalled', handlePluginUninstalled)
    }
  } catch (e) {
    console.error('取消订阅失败:', e)
  }
})
</script>

<template>
  <div class="space-y-4" style="color: var(--zt-text)">
    <h2 class="text-lg font-semibold">推荐插件</h2>
    <div v-if="loading" class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <SkeletonCard v-for="i in 12" :key="i" />
    </div>
    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <PluginCard
        v-for="p in items"
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
      />
    </div>
    <div v-if="error" class="text-sm" style="color: var(--zt-error)">
      {{ error }}
    </div>
  </div>
</template>
