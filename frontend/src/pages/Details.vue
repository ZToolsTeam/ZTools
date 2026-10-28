<script setup>
import { ArrowLeftOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons-vue'
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'

import PluginDetailHeader from './details-components/PluginDetailHeader.vue'
import PluginScreenshots from './details-components/PluginScreenshots.vue'
import PluginDescription from './details-components/PluginDescription.vue'

import { useNavStore } from '@/stores/nav'
import { usePluginsStore } from '@/stores/plugins'
import {
  openPlugin as apiOpenPlugin,
  getDownloadSign,
  installPluginNative,
  uninstallPluginNative,
  getPluginDetails,
  createShortcut as apiCreateShortcut,
  checkPluginUpdate,
  downloadPluginUpdate,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from '@/api/apiserver'
import { useToast } from '@/composables/useToast'
import { usePluginInstall } from '@/composables/usePluginInstall'
import { useVersionCompat } from '@/composables/useVersionCompat'
import { ROUTES, routeUtils } from '@/router/routes'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import { isPluginSupportedOnCurrentPlatform, isWindows } from '@/utils/platform'
import { pluginDetailTabs, auth, onAuthRequired, track } from '@edition'
import { getOfficialPlugin, isClientProvidedPlugin } from '@/utils/officialPlugins'
import { getBundledPluginEntry, isBundledPlugin } from '@/utils/bundledPlugins'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'

const route = useRoute()
const router = useRouter()
const nav = useNavStore()
const pluginsStore = usePluginsStore()
const { installWithFeedback } = usePluginInstall()

const plugin = ref({})
const loading = ref(true)
const routePluginId = computed(() => String(route.params.pluginId || ''))

const pluginId = computed(() =>
  String(routePluginId.value || plugin.value?.pluginId || '')
)
const error = ref('')
const { toastSuccess, toastError, toastWarning } = useToast()
const { checkPluginCompat } = useVersionCompat()

// 留言数（由官方版的留言 Tab 加载后回报；开源版没有留言）
const loadedCommentsCount = ref(0)

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

// 使用 Store 中的安装状态（随客户端提供的插件始终视为已安装，避免异步同步前按钮从“安装”跳变到“打开”；
// 插件市场分发的官方插件以实际安装状态为准）
const isInstalled = computed(() =>
  pluginsStore.installedSet.has(pluginId.value) ||
  isClientProvidedPlugin(pluginId.value)
)

// 随客户端提供的插件没有安装目录，不能卸载，也生成不了桌面快捷方式（主进程会报插件不存在），这里不给入口
const canUninstall = computed(() => !isClientProvidedPlugin(pluginId.value))
// 桌面快捷方式只有 Windows 支持
const canCreateShortcut = computed(() => isWindows() && canUninstall.value)

// 详情页会缓存“有更新/快捷键”等仅对已安装插件有效的本地状态；
// 当前插件被卸载后需要立即清空，避免页面残留“有更新”标记。
watch(isInstalled, (installed) => {
  if (!installed) {
    hasUpdate.value = false
    updateInfo.value = null
    hotkeyText.value = ''
  }
})

// 「详情」之后的 Tab 由版本提供（官方版：留言、评分、版本记录；开源版没有）
const tabs = ['detail', ...pluginDetailTabs.map((tab) => tab.key)]
const tabNames = {
  detail: '详情',
  ...Object.fromEntries(pluginDetailTabs.map((tab) => [tab.key, tab.label]))
}
const hasCommentsTab = pluginDetailTabs.some((tab) => tab.key === 'comments')
const activeTab = ref('detail')
const tabContainerRef = ref(null)
let loadRequestId = 0
// 点击「查看留言」后等留言加载完再校正一次滚动位置
let scrollToCommentsPending = false
// 每次切到某个 Tab（包括再次点击当前 Tab）都会变化；附加 Tab 据此重新加载数据（如留言每次点开都重新拉取）
const tabActivationToken = ref(0)

const tabContext = computed(() => ({
  pluginId: pluginId.value,
  plugin: plugin.value,
  isInstalled: isInstalled.value,
  activationToken: tabActivationToken.value
}))

const commentsCount = computed(() => {
  if (!hasCommentsTab) return null
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
  loadedCommentsCount.value = 0
  scrollToCommentsPending = false
}

const load = async () => {
  const pid = routePluginId.value
  const requestId = ++loadRequestId
  resetDetailsState()

  if (!pid) {
    loading.value = false
    error.value = '插件标识符不存在'
    return
  }

  // 官方内置应用与随包内置插件（bundledPlugins）直接在首帧同步就绪，无需骨架屏闪烁或远程 API 请求
  const localBuiltin = getOfficialPlugin(pid) || getBundledPluginEntry(pid)
  if (localBuiltin) {
    plugin.value = {
      ...localBuiltin,
      features: Array.isArray(localBuiltin.features) ? localBuiltin.features : [],
      comments: [],
      screenshots: [],
      rating: 5,
      downloads: '内置'
    }
    isFavorite.value = pluginsStore.isFavorite(pid)
    loading.value = false

    // 后台静默预热内置声明式插件脚本，使随后点击“打开”进入具体插件页时零延迟直出
    if (isBundledPlugin(pid)) {
      loadInstalledDeclarativePlugin(pid).catch((prewarmErr) => {
        console.debug('[Details] 预热内置声明式插件未命中:', prewarmErr)
      })
    }
    if (pluginsStore.installedSet.size === 0) {
      pluginsStore.fetchInstalledPlugins().catch((fetchErr) => {
        console.warn('[Details] 同步本地已安装插件列表失败:', fetchErr)
      })
    }
    return
  }

  loading.value = true

  try {
    // 确保 Store 中有最新的本地插件列表
    // 只在首次访问时加载（installedSet 为空）
    // 从列表页跳转或安装完成后，信任 eventsStore 维护的 installedSet 状态
    if (pluginsStore.installedSet.size === 0) {
      await pluginsStore.fetchInstalledPlugins()
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
    track('detail_view', pid)

    // 4. 如果插件已安装，查询快捷键绑定
    if (pluginsStore.installedSet.has(pid)) {
      try {
        await fetchPluginHotkey(pid)
      } catch (e) {
        console.warn('[Details] 查询插件快捷键失败，跳过:', e)
      }
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

// 处理标签切换（各 Tab 组件自己加载数据）
const handleTabChange = (tab) => {
  if (!tabs.includes(tab)) return
  activeTab.value = tab
  tabActivationToken.value += 1
}

// 留言 Tab 的回报：count 为已加载留言数，loaded 表示一次加载结束
const commentsTabListeners = {
  count: (count) => {
    loadedCommentsCount.value = Number.isFinite(count) && count >= 0 ? count : 0
  },
  loaded: async () => {
    if (!scrollToCommentsPending) return
    scrollToCommentsPending = false
    await nextTick()
    scrollCommentsToTop()
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
  if (!hasCommentsTab) return
  // 切到留言 Tab 会重新加载留言，等加载回报后再校正一次位置
  scrollToCommentsPending = true
  handleTabChange('comments')

  // 先对 loading 状态滚动，立即响应点击；留言加载完成后再校正最终位置（见 commentsTabListeners.loaded）
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
    if (!onAuthRequired(e)) {
      toastError('操作失败: ' + (e.message || e))
    }
  }
}

const downloadPlugin = () => installWithFeedback(pluginId.value, async () => {
  if (!(await auth.ensureCanInstall())) return false
  track('plugin_clickinstall', pluginId.value)
  return true
})

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
  if (!canUninstall.value) {
    toastError('内置插件随客户端提供，不能卸载')
    return
  }
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
      track('shortcut_create', pluginId.value)
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
    if (!pluginsStore.acceptsInstallEvent(payload)) return
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
        <ArrowLeftOutlined  />
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
        <WarningOutlined  />
      </div>
      <h3 class="error-title">加载失败</h3>
      <p class="error-message">{{ error }}</p>
      <button class="retry-btn" @click="load">
        <ReloadOutlined  />
        重试
      </button>
    </div>

    <!-- 正常内容 -->
    <div v-else>
      <PluginDetailHeader
        :plugin="plugin"
        :subtitle="subtitle"
        :isInstalled="isInstalled"
        :canUninstall="canUninstall"
        :canCreateShortcut="canCreateShortcut"
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

          <template v-for="tab in pluginDetailTabs" :key="tab.key">
            <component
              :is="tab.component"
              v-if="activeTab === tab.key"
              v-bind="tab.props(tabContext)"
              v-on="tab.key === 'comments' ? commentsTabListeners : {}"
            />
          </template>
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
  background: linear-gradient(90deg, var(--rc-surface-subtle) 25%, var(--rc-surface-active) 50%, var(--rc-surface-subtle) 75%);
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
  background: linear-gradient(90deg, var(--rc-surface-subtle) 25%, var(--rc-surface-active) 50%, var(--rc-surface-subtle) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-subtitle {
  width: 60%;
  height: 16px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--rc-surface-subtle) 25%, var(--rc-surface-active) 50%, var(--rc-surface-subtle) 75%);
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
  background: linear-gradient(90deg, var(--rc-surface-subtle) 25%, var(--rc-surface-active) 50%, var(--rc-surface-subtle) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

.skeleton-content {
  height: 300px;
  border-radius: 16px;
  background: linear-gradient(90deg, var(--rc-surface-subtle) 25%, var(--rc-surface-active) 50%, var(--rc-surface-subtle) 75%);
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
  background: var(--rc-error-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: var(--rc-error);
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
  height: 34px;
  padding: 0 16px;
  background: var(--rc-accent);
  border: none;
  border-radius: var(--rc-radius-md);
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-accent-contrast);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.retry-btn:hover {
  background: var(--rc-accent-hover);
}

/* Tab 容器 */
.tab-container {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  overflow: hidden;
}

/* 标签页：底部 2px 橙色指示条，选中态不做整块填充 */
.tab-header {
  display: flex;
  gap: 4px;
  padding: 0 12px;
  border-bottom: 1px solid var(--rc-border);
}

.tab-btn {
  position: relative;
  height: 42px;
  padding: 0 12px;
  background: transparent;
  border: none;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-muted);
  cursor: pointer;
  transition: color 0.15s ease;
}

.tab-btn:hover {
  color: var(--rc-text-primary);
}

.tab-btn.active {
  color: var(--rc-text-primary);
}

.tab-btn.active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--rc-accent);
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
