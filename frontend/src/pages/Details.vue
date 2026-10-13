<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'

import PluginDetailHeader from './details-components/PluginDetailHeader.vue'
import PluginScreenshots from './details-components/PluginScreenshots.vue'
import PluginDescription from './details-components/PluginDescription.vue'
import PluginComments from './details-components/PluginComments.vue'
import PluginRating from './details-components/PluginRating.vue'
import PluginVersions from './details-components/PluginVersions.vue'

import { useNavStore } from '@/stores/nav'
import { useUIStore } from '@/stores/ui'
import { usePluginsStore } from '@/stores/plugins'
import {
  openPlugin as apiOpenPlugin,
  getDownloadSign,
  installPluginNative,
  uninstallPluginNative,
  getPluginDetails,
  isAuthenticated,
  getPluginComments,
  postPluginComment,
  createShortcut as apiCreateShortcut,
  checkPluginUpdate,
  downloadPluginUpdate,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from '@/api/apiserver'
import { useToast } from '@/composables/useToast'
import { useVersionCompat } from '@/composables/useVersionCompat'
import { ROUTES, routeUtils } from '@/router/routes'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import { isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { isOnline } from '@/config/runtime-mode'
import { getOfficialPlugin, isOfficialPlugin } from '@/utils/officialPlugins'

const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const uiStore = useUIStore()
const pluginsStore = usePluginsStore()

const plugin = ref({})
const loading = ref(true)
const routePluginId = computed(() => String(route.params.pluginId || ''))

const pluginId = computed(() =>
  String(routePluginId.value || plugin.value?.pluginId || '')
)
const error = ref('')
const { toastSuccess, toastError, toastWarning } = useToast()
const { checkPluginCompat } = useVersionCompat()

// 留言相关
const comments = ref([])
const commentsLoading = ref(false)
const commentContent = ref('')
const submittingComment = ref(false)
const replyTo = ref(null)

const isFavorite = ref(false)
const hasUpdate = ref(false)
const updateInfo = ref(null)
const creatingShortcut = ref(false)
const downloading = computed(() =>
  pluginsStore.downloadingSet.has(pluginId.value)
)
const installFailed = computed(() =>
  pluginsStore.installFailedSet.has(pluginId.value)
)
const isRevoked = computed(() =>
  Boolean(plugin.value?.revoked || pluginsStore.isRevoked(pluginId.value))
)
const revokedReason = computed(() =>
  plugin.value?.revoked_reason || plugin.value?.revokedReason || pluginsStore.getRevokedReason(pluginId.value) || ''
)
const installError = computed(() =>
  pluginsStore.getInstallError(pluginId.value)
)
const downloadProgress = ref(0)
const downloadPhase = ref('')     // '' = 插件下载, 'library' = 依赖库安装
const libIndex = ref(0)           // 当前第几个依赖库
const libTotal = ref(0)           // 依赖库总数
// 当前插件绑定的快捷键文本
const hotkeyText = ref('')
const subtitle = computed(() => {
  const p = plugin.value || {}
  if (!p.version && !p.category && !p.size) return ''
  return `v${p.version || ''} · ${p.category || ''} · ${p.size || '未知'}`
})

// 使用 Store 中的安装状态
const isInstalled = computed(() =>
  pluginsStore.installedSet.has(pluginId.value)
)

// 详情页会缓存“有更新/快捷键”等仅对已安装插件有效的本地状态；
// 当前插件被卸载后需要立即清空，避免页面残留“有更新”标记。
watch(isInstalled, (installed) => {
  if (!installed) {
    hasUpdate.value = false
    updateInfo.value = null
    hotkeyText.value = ''
  }
})

const tabs = isOnline ? ['detail', 'comments', 'rating', 'version'] : ['detail']
const tabNames = {
  detail: '详情',
  comments: '留言',
  rating: '评分',
  version: '版本记录'
}
const activeTab = ref('detail')
const tabContainerRef = ref(null)
let loadRequestId = 0
let commentsRequestId = 0

const loadedCommentsCount = computed(() => {
  const countComment = (comment) =>
    1 +
    (comment.children || []).reduce(
      (sum, child) => sum + countComment(child),
      0
    )
  return comments.value.reduce((sum, comment) => sum + countComment(comment), 0)
})

const commentsCount = computed(() => {
  const fields = [
    plugin.value?.commentsCount,
    plugin.value?.comments_count,
    plugin.value?.commentCount,
    plugin.value?.comment_count
  ]
  const count = fields.find((value) => value !== undefined && value !== null)
  if (count === undefined) return loadedCommentsCount.value

  const normalized = Number(count)
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : loadedCommentsCount.value
})

function resetDetailsState() {
  plugin.value = {}
  error.value = ''
  isFavorite.value = false
  hasUpdate.value = false
  updateInfo.value = null
  downloadProgress.value = 0
  downloadPhase.value = ''
  libIndex.value = 0
  libTotal.value = 0
  hotkeyText.value = ''
  comments.value = []
  commentsLoading.value = false
  commentContent.value = ''
  submittingComment.value = false
  replyTo.value = null
}

const load = async () => {
  const pid = routePluginId.value
  const requestId = ++loadRequestId
  resetDetailsState()
  loading.value = true

  if (!pid) {
    loading.value = false
    error.value = '插件标识符不存在'
    return
  }

  try {
    // 确保 Store 中有最新的本地插件列表
    // 只在首次访问时加载（installedSet 为空）
    // 从列表页跳转或安装完成后，信任 eventsStore 维护的 installedSet 状态
    if (pluginsStore.installedSet.size === 0) {
      await pluginsStore.fetchInstalledPlugins()
    }

    // 官方内置标杆应用无需请求远程市场 API
    if (isOfficialPlugin(pid)) {
      const official = getOfficialPlugin(pid)
      plugin.value = {
        ...official,
        features: [],
        comments: [],
        screenshots: [],
        rating: 5,
        downloads: '内置'
      }
      isFavorite.value = pluginsStore.isFavorite(pid)
      loading.value = false
      return
    }

    // 并行请求：详情
    const results = await Promise.allSettled([getPluginDetails(pid)])
    if (requestId !== loadRequestId) return

    // 1. 插件详情
    if (results[0].status === 'fulfilled') {
      plugin.value = results[0].value
      if (!isPluginSupportedOnCurrentPlatform(plugin.value)) {
        error.value = '该插件不支持当前操作系统平台'
        loading.value = false
        return
      }
    } else {
      throw results[0].reason
    }

    // 2. 从 Store 获取收藏状态
    isFavorite.value = pluginsStore.isFavorite(pid)

    // 3. 如果插件已安装，检查是否有更新
    if (pluginsStore.installedSet.has(pid)) {
      // 优先使用 Store 中已有的更新信息（列表页批量检查的结果）
      const cachedUpdate = pluginsStore.updateMap[pid]
      if (cachedUpdate && cachedUpdate.hasUpdate) {
        if (cachedUpdate.incompatible) {
          // 不兼容：显示"需升级"而非"更新"
          hasUpdate.value = false
          updateInfo.value = cachedUpdate
        } else {
          hasUpdate.value = true
          updateInfo.value = cachedUpdate
        }
      } else {
        // Store 中没有，单独向后端查询
        try {
          const localPlugin = pluginsStore.installedPlugins.find(
            (p) => String(p.pluginId) === pid
          )
          const localVersion =
            localPlugin?.version || localPlugin?.currentVersion || ''

          // 安装完成事件会先更新 installedSet，完整本地信息稍后才刷新。
          // 此时不能用猜测版本检查更新，否则刚安装的最新版会被误判为需更新。
          if (localVersion) {
            const updateResult = await checkPluginUpdate(pid, {
              current_version: localVersion
            })
            if (updateResult && updateResult.hasUpdate) {
              // 检查兼容性
              const compat = await checkPluginCompat(updateResult)
              if (compat.compatible) {
                hasUpdate.value = true
                updateInfo.value = updateResult
              } else {
                hasUpdate.value = false
                updateInfo.value = {
                  ...updateResult,
                  incompatible: true,
                  incompatReason: compat.reason
                }
              }
            } else {
              hasUpdate.value = false
              updateInfo.value = null
            }
          }
        } catch (e) {
          console.warn('[Details] 更新检测失败，跳过:', e)
        }
      }
    } else {
      hasUpdate.value = false
      updateInfo.value = null
    }

    // 埋点：详情页访问
    window.ztools?.analytics?.report('detail_view', pid)

    // 4. 如果插件已安装，查询快捷键绑定
    if (pluginsStore.installedSet.has(pid)) {
      try {
        await fetchPluginHotkey(pid)
      } catch (e) {
        console.warn('[Details] 查询插件快捷键失败，跳过:', e)
      }
    }

    // 5. 加载留言（如果当前是留言 Tab）
    if (activeTab.value === 'comments') {
      await fetchComments(pid)
    }
  } catch (e) {
    if (requestId !== loadRequestId) return
    error.value = e.message || String(e)
    toastError('加载插件详情失败: ' + (e.message || e))
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
    }
  }
}

// 查询插件快捷键绑定
const fetchPluginHotkey = async (pid) => {
  hotkeyText.value = ''
  if (!window.ztools?.trigger) return
  try {
    const result = await window.ztools.trigger.list(pid)
    const triggers = result?.data || result || []
    if (Array.isArray(triggers)) {
      // 查找 hotkey 类型、window 动作模式的触发器
      // Delphi 端返回的结构：action: { mode, target, params }
      const hotkeyTrigger = triggers.find(
        (t) =>
          !getPluginFeatureHotkeyItemByTrigger(t) &&
          t.type === 'hotkey' &&
          (t.action?.mode === 'window' || t.actionMode === 'window')
      )
      if (hotkeyTrigger?.config?.key) {
        hotkeyText.value = hotkeyTrigger.config.key
      }
    }
  } catch (e) {
    console.warn('[Details] 查询插件快捷键失败:', e)
  }
}

// 获取留言
const fetchComments = async (pid = pluginId.value) => {
  const requestId = ++commentsRequestId
  commentsLoading.value = true
  comments.value = []
  try {
    const res = await getPluginComments(pid)
    if (requestId !== commentsRequestId || pid !== pluginId.value) return
    comments.value = res.data || []
  } catch (e) {
    if (requestId !== commentsRequestId) return
    console.error('获取留言失败:', e)
  } finally {
    if (requestId === commentsRequestId) {
      commentsLoading.value = false
    }
  }
}

// 提交留言
const submitComment = async () => {
  if (!commentContent.value.trim()) {
    toastError('请输入留言内容')
    return
  }

  // 检查是否安装
  if (!isInstalled.value) {
    toastError('请先安装该插件后再留言')
    return
  }

  // 检查是否登录
  if (!(await isAuthenticated())) {
    uiStore.openLoginModal()
    return
  }

  submittingComment.value = true
  try {
    await postPluginComment(pluginId.value, {
      content: commentContent.value,
      parent_id: replyTo.value?.id
    })
    toastSuccess('留言成功，请等待管理员审核')
    // 埋点：提交评论
    window.ztools?.analytics?.report('detail_comment', pluginId.value)
    commentContent.value = ''
    replyTo.value = null
    // 重新加载留言
    fetchComments()
  } catch (e) {
    toastError('提交失败: ' + (e.message || e))
  } finally {
    submittingComment.value = false
  }
}

// 处理标签切换
const handleTabChange = (tab) => {
  activeTab.value = tab
  if (tab === 'comments') {
    return fetchComments()
  }
}

const scrollCommentsToTop = () => {
  const tabContainer = tabContainerRef.value
  const scrollContainer = tabContainer?.closest('main')
  if (!tabContainer || !scrollContainer) return

  const tabRect = tabContainer.getBoundingClientRect()
  const scrollRect = scrollContainer.getBoundingClientRect()
  scrollContainer.scrollTo({
    top: Math.max(
      0,
      scrollContainer.scrollTop + tabRect.top - scrollRect.top
    ),
    behavior: 'smooth'
  })
}

const showComments = async () => {
  const commentsRequest = handleTabChange('comments')

  // 先对 loading 状态滚动，立即响应点击；留言渲染完成后再校正最终位置。
  await nextTick()
  scrollCommentsToTop()
  await commentsRequest
  await nextTick()
  scrollCommentsToTop()
}

const goBack = () => {
  // 优先使用浏览器历史返回，保留来源页面的状态（如 MyPage 的标签页）
  if (window.history.length > 1) {
    router.back()
  } else {
    // 无历史记录时回退到列表页
    router.push(routeUtils.toListCategory(nav.currentCategory || ''))
  }
}

const open = async () => {
  const pid = pluginId.value
  if (!pid) return

  if (isRevoked.value) {
    toastError('无法启动：' + (revokedReason.value || '该插件已被官方下架禁用'))
    return
  }

  try {
    const result = await pluginsStore.openPlugin(pid)
    if (result?.isDeclarative) {
      return
    }

    // 检查是否需要导航到详情页（插件已卸载的情况）
    if (result?.action === 'navigate_to_detail') {
      toastWarning(result.error || '插件未安装，请重新安装')
      // 如果当前不在详情页，则跳转到详情页
      if (
        route.name !== 'details' ||
        route.params.pluginId !== result.pluginId
      ) {
        router.push({
          ...ROUTES.DETAILS,
          params: { pluginId: result.pluginId }
        })
      }
      return
    }

    if (result?.success) {
      toastSuccess('已启动插件')
    } else {
      toastError('启动失败: ' + (result?.error || '未知错误'))
    }
  } catch (e) {
    toastError('启动失败: ' + (e.message || e))
  }
}

const toggleFavorite = async () => {
  try {
    // 收藏功能必须登录
    const pid = pluginId.value
    if (!pid) {
      toastError('插件标识符不存在')
      return
    }

    await pluginsStore.toggleFavorite(pid)
    // 从 Store 更新收藏状态
    isFavorite.value = pluginsStore.isFavorite(pid)
    toastSuccess(isFavorite.value ? '已加入收藏' : '已取消收藏')
  } catch (e) {
    if (e.status === 401 || e.need_login) {
      toastWarning(e.message || '请先登录后继续')
      uiStore.openLoginModal()
    } else {
      toastError('操作失败: ' + (e.message || e))
    }
  }
}

const downloadPlugin = async () => {
  const pid = pluginId.value
  if (!pid) return

  // 官方下架拦截
  if (isRevoked.value) {
    toastError('无法安装：' + (revokedReason.value || '该插件已被官方下架禁用'))
    return
  }

  // 防止重复并发安装
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

    // 一键静默安装，底层复用 plugin-install-service，装完直接进入内嵌声明式舞台
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

const updatePlugin = async () => {
  Modal.confirm({
    title: '确定要更新该插件吗？',
    content: '更新过程中可能会暂时中断服务。',
    okText: '更新',
    cancelText: '取消',
    onOk: async () => {
      const pid = pluginId.value

      if (!updateInfo.value) {
        toastError('无更新信息')
        return
      }

      try {
        // 标记为下载中
        pluginsStore.startDownload(pid)

        // 使用更新流程（走 plugin_update IPC，Delphi 会先停止旧插件→备份→原子替换）
        await downloadPluginUpdate(pid, updateInfo.value)

        toastSuccess('开始更新插件，请稍候...')
        // 注意：不在这里清除 hasUpdate / updateInfo
        // 下载完成后由 handleInstallComplete 回调清除，避免按钮提前变成"打开"
      } catch (e) {
        // 出错时清除下载状态
        pluginsStore.endDownload(pid)
        toastError('更新失败: ' + (e.message || e))
      }
    }
  })
}

const uninstall = async () => {
  Modal.confirm({
    title: '确定要卸载该插件吗？',
    content: '卸载后插件文件将被删除。',
    okText: '卸载',
    cancelText: '取消',
    okType: 'danger',
    onOk: async () => {
      const pid = pluginId.value
      try {
        const res = await uninstallPluginNative(pid)
        if (res && res.success) {
          toastSuccess('插件已卸载')
          // Store will be updated by event, but we can optimistically update here if needed
          // Actually event loop is fast enough.

          if (window.ztools?.events) {
            await window.ztools.events
              .emit('plugin_uninstalled', { pluginId: pid })
              .catch(() => {})
          }
        } else {
          toastError('卸载失败: ' + (res?.error || '未知错误'))
        }
      } catch (e) {
        toastError('卸载失败: ' + (e.message || e))
      }
    }
  })
}

const createShortcut = async () => {
  if (!isInstalled.value) {
    toastError('请先安装该插件后再创建快捷方式')
    return
  }
  if (creatingShortcut.value) return

  creatingShortcut.value = true
  try {
    const res = await apiCreateShortcut(pluginId.value)
    if (res && res.success) {
      toastSuccess('桌面快捷方式已生成')
      // 埋点：创建桌面快捷方式
      window.ztools?.analytics?.report('shortcut_create', pluginId.value)
    } else {
      toastError('生成失败: ' + (res?.error || '未知错误'))
    }
  } catch (e) {
    toastError('生成失败: ' + (e.message || e))
  } finally {
    creatingShortcut.value = false
  }
}

// 导航到高级设置页面并自动打开插件快捷键弹窗
const setHotkey = () => {
  router.push({
    ...ROUTES.ADVANCED_SETTINGS,
    query: { openPluginHotkey: 'true' }
  })
}

// 事件处理函数
const handleDownloadProgress = (envelope) => {
  try {
    const payload = envelope?.payload || {}
    const pid = payload.pluginId
    if (String(pid) === pluginId.value) {
      downloadProgress.value = payload.percent || 0
      // 处理依赖库安装阶段
      if (payload.phase === 'library') {
        downloadPhase.value = 'library'
        libIndex.value = payload.libIndex || 0
        libTotal.value = payload.libTotal || 0
      }
    }
  } catch (e) {
    console.error('处理下载进度事件失败:', e)
  }
}

const handleInstallComplete = async (envelope) => {
  try {
    const payload = envelope?.payload || {}
    const pid = payload.pluginId

    if (String(pid) === pluginId.value) {
      downloadProgress.value = 0
      downloadPhase.value = ''
      libIndex.value = 0
      libTotal.value = 0

      if (payload.success) {
        // 如果是更新完成，清除更新状态，让按钮从"更新"变为"打开"
        if (payload.isUpdate) {
          hasUpdate.value = false
          updateInfo.value = null
        }
        toastSuccess(payload.isUpdate ? '插件更新成功' : '插件安装成功')
        // eventsStore 已经通过 onInstallComplete 更新了 installedSet 和 downloadingSet
        // 无需再次调用 fetchInstalledPlugins，避免竞态条件
        // isInstalled 和 downloading 计算属性会自动响应状态变化
      } else {
        toastError((payload.isUpdate ? '更新失败: ' : '安装失败: ') + (payload.error || '未知错误'))
      }
    }
  } catch (e) {
    console.error('处理安装完成事件失败:', e)
  }
}

onMounted(async () => {
  try {
    if (window.ztools && window.ztools.events) {
      // 仍然需要订阅下载进度，因为目前 eventsStore 没有分发这个高频事件
      window.ztools.events.subscribe('plugin_download_progress').catch(() => {})
      window.ztools.events.on(
        'plugin_download_progress',
        handleDownloadProgress
      )

      // 其他事件由 eventsStore 统一订阅，但我们这里需要处理页面特定的逻辑（如关闭下载状态）
      // 我们可以监听 eventsStore 的状态，或者简单地继续监听全局事件（因为 on 是多播的）
      // 为了减少重复订阅开销，subscribe 只需要做一次（eventsStore 做了），但 on 需要每个组件自己做
      window.ztools.events.on('plugin_install_complete', handleInstallComplete)
    }
  } catch (e) {
    console.error('订阅插件事件失败:', e)
  }
})

watch(
  () => route.params.pluginId,
  () => {
    load()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  try {
    if (window.ztools && window.ztools.events) {
      window.ztools.events.off(
        'plugin_download_progress',
        handleDownloadProgress
      )
      window.ztools.events.off('plugin_install_complete', handleInstallComplete)
    }
  } catch (e) {
    console.error('取消订阅插件事件失败:', e)
  }
})
</script>

<template>
  <div class="details-page">
    <!-- 返回按钮 -->
    <div class="back-nav">
      <button class="back-btn" @click="goBack">
        <i class="fa fa-arrow-left"></i>
        <span>返回</span>
      </button>
    </div>

    <!-- 加载中骨架屏 -->
    <div v-if="loading" class="skeleton-container">
      <div class="skeleton-header">
        <div class="skeleton-icon"></div>
        <div class="skeleton-info">
          <div class="skeleton-title"></div>
          <div class="skeleton-subtitle"></div>
        </div>
      </div>
      <div class="skeleton-stats">
        <div v-for="i in 5" :key="i" class="skeleton-stat"></div>
      </div>
      <div class="skeleton-content"></div>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="error" class="error-container">
      <div class="error-icon">
        <i class="fa fa-exclamation-triangle"></i>
      </div>
      <h3 class="error-title">加载失败</h3>
      <p class="error-message">{{ error }}</p>
      <button class="retry-btn" @click="load">
        <i class="fa fa-refresh"></i>
        重试
      </button>
    </div>

    <!-- 正常内容 -->
    <div v-else>
      <PluginDetailHeader
        :plugin="plugin"
        :subtitle="subtitle"
        :isInstalled="isInstalled"
        :hasUpdate="hasUpdate"
        :downloading="downloading"
        :installFailed="installFailed"
        :installError="installError"
        :isRevoked="isRevoked"
        :revokedReason="revokedReason"
        :isFavorite="isFavorite"
        :downloadProgress="downloadProgress"
        :downloadPhase="downloadPhase"
        :libIndex="libIndex"
        :libTotal="libTotal"
        :updateInfo="updateInfo"
        :hotkeyText="hotkeyText"
        :creatingShortcut="creatingShortcut"
        :commentsCount="commentsCount"
        @open="open"
        @update="updatePlugin"
        @uninstall="uninstall"
        @download="downloadPlugin"
        @toggle-favorite="toggleFavorite"
        @create-shortcut="createShortcut"
        @set-hotkey="setHotkey"
        @show-comments="showComments"
      />

      <PluginScreenshots :screenshots="plugin.screenshots" />

      <!-- Tab分页 -->
      <div ref="tabContainerRef" class="tab-container">
        <div class="tab-header">
          <button
            v-for="tab in tabs"
            :key="tab"
            class="tab-btn"
            :class="{ active: activeTab === tab }"
            @click="handleTabChange(tab)"
          >
            <span>{{ tabNames[tab] }}</span>
          </button>
        </div>

        <div class="tab-content">
          <PluginDescription
            v-if="activeTab === 'detail'"
            :description="plugin.description"
          />

          <PluginComments
            v-else-if="activeTab === 'comments'"
            :comments="comments"
            :loading="commentsLoading"
            :isInstalled="isInstalled"
            :submitting="submittingComment"
            v-model:modelValue="commentContent"
            v-model:replyTo="replyTo"
            @submit="submitComment"
          />

          <PluginRating v-else-if="activeTab === 'rating'" />

          <PluginVersions
            v-else-if="activeTab === 'version'"
            :changelogs="plugin.changelogs"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.details-page {
  color: var(--zt-text);
}

/* 返回导航 */
.back-nav {
  margin-bottom: 8px;
}

.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: var(--color-gray-100);
  border: none;
  border-radius: 6px;
  font-size: 12px;
  color: var(--zt-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-btn:hover {
  background: var(--color-gray-200);
  color: var(--zt-text);
}

/* 骨架屏 */
.skeleton-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
}

.skeleton-icon {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton-title {
  width: 40%;
  height: 24px;
  border-radius: 6px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-subtitle {
  width: 60%;
  height: 16px;
  border-radius: 4px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  padding: 0 24px;
}

.skeleton-stat {
  height: 60px;
  border-radius: 10px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-content {
  height: 300px;
  border-radius: 16px;
  background: linear-gradient(90deg, #f0f0f0 25%, #e8e8e8 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

/* 错误状态 */
.error-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  text-align: center;
}

.error-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: white;
  margin-bottom: 20px;
}

.error-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--zt-text);
  margin: 0 0 8px;
}

.error-message {
  font-size: 14px;
  color: var(--zt-text-secondary);
  margin: 0 0 20px;
}

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  color: white;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 12px rgba(45, 113, 255, 0.3);
}

.retry-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(45, 113, 255, 0.4);
}

/* Tab 容器 */
.tab-container {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  overflow: hidden;
}

.tab-header {
  display: flex;
  gap: 4px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-gray-50);
}

.tab-btn {
  padding: 6px 16px;
  background: transparent;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--zt-text-secondary);
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
    background 0.15s ease,
    box-shadow 0.2s ease;
  position: relative;
  overflow: hidden;
}

.tab-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
  opacity: 0;
  transform: scale(0.85);
  transition:
    opacity 0.2s ease,
    transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
  border-radius: 10px;
  z-index: 0;
}

.tab-btn span {
  position: relative;
  z-index: 1;
}

.tab-btn:hover {
  transform: translateY(-1px);
  background: var(--color-gray-200);
}

.tab-btn:active {
  transform: scale(0.96);
}

.tab-btn.active {
  color: white;
  box-shadow: 0 4px 12px rgba(74, 140, 255, 0.25);
  transform: translateY(-1px);
}

.tab-btn.active::before {
  opacity: 1;
  transform: scale(1);
}

.tab-btn.active:hover {
  background: transparent;
  box-shadow: 0 6px 16px rgba(74, 140, 255, 0.35);
}

.tab-content {
  padding: 16px;
}

/* 响应式 */
@media (max-width: 600px) {
  .skeleton-stats {
    grid-template-columns: repeat(2, 1fr);
  }

  .tab-header {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .tab-btn {
    white-space: nowrap;
  }
}
</style>
