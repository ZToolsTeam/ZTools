import { createApp } from 'vue'
import { createPinia } from 'pinia'

import router, { preloadCoreRoutes } from './router'
import App from './App.vue'
import '@/assets/css/index.css'

// FontAwesome
import 'font-awesome/css/font-awesome.min.css'

// Ant Design Vue
import 'ant-design-vue/dist/reset.css'

// Stores
import { useThemeStore } from './stores/theme'
import { useUserStore } from './stores/user'
import { usePluginsStore } from './stores/plugins'
import { useNavStore } from './stores/nav'

// Toast 系统
import { useToast } from '@/composables/useToast'
import { syncGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { openSettings, openDevTools } from '@/utils/internalPlugins'

// 创建应用
const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.mount('#app')

// 全局暴露 router 供宿主控制与 CDP 联调
window.__router = router

// 首屏空闲时预热核心路由组件
preloadCoreRoutes()

// ===== 初始化主题 =====
const themeStore = useThemeStore(pinia)
themeStore.init()

// ===== 初始化用户状态 =====
const userStore = useUserStore(pinia)
userStore.initEventListeners()

// ===== 初始化插件状态 =====
const pluginsStore = usePluginsStore(pinia)
pluginsStore.init()

// ===== 注册全局 Toast 函数（供 CEF-IPC SDK 使用）=====
const { toast } = useToast()
window.__ztoolsToast = toast

// ===== 注册全局导航方法（供宿主端或托盘调用）=====
window.__navigateTo = async (path, options) => {
  const nav = useNavStore(pinia)
  const pageName = path.replace(/^\//, '')

  // 优先通过内置插件门面打开设置面板
  if (pageName === 'advanced-settings' || pageName === 'settings') {
    const res = await openSettings({ ...options, router })
    if (res?.fallback && res?.type === 'route') {
      nav.setPage('advanced-settings')
      if (options?.scrollToSuperPanelSettings) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('ztools-scroll-to-super-panel-settings'))
        }, 80)
      }
    }
    return
  }

  // 优先通过内置插件门面打开开发者工具
  if (pageName === 'devtools') {
    const res = await openDevTools({ ...options, router })
    if (res?.fallback && res?.type === 'route') {
      nav.setPage('devtools')
    }
    return
  }

  if (pageName) nav.setPage(pageName)
  if (options?.openShortcutSettings) {
    window.__openShortcutSettings = true
  }
  if (options?.scrollToSuperPanelSettings) {
    window.__scrollToSuperPanelSettings = true
  }

  router.push({ name: pageName || 'my' })
    .catch(() => {})
    .then(() => {
      if (options?.scrollToSuperPanelSettings) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('ztools-scroll-to-super-panel-settings'))
        }, 80)
      }
    })
}

// ===== 启动时同步全局唤醒快捷键 =====
const syncGlobalWakeHotkeyOnStartup = async () => {
  const maxAttempts = 5

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await syncGlobalWakeHotkey({ useDefaultWhenEmpty: true })
      if (result.success) {
        return
      }
    } catch (error) {
      console.error('Failed to sync global wake hotkey on startup:', error)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.warn('Global wake hotkey sync skipped: trigger is unavailable')
}

syncGlobalWakeHotkeyOnStartup()

// ===== 阻止浏览器默认的文件拖放行为 =====
document.addEventListener(
  'dragover',
  (e) => {
    e.preventDefault()
    e.stopPropagation()
  },
  true
)

document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    e.stopPropagation()
  },
  true
)

// ===== 更新检查回调 =====
// 更新编排由 Delphi 端统一管理，前端只负责展示通知
function update_handler(msgType, msgData) {
  // console.log('[update]', msgType, JSON.stringify(msgData))

  if (msgType === 'update.checkResult') {
    // Delphi 端已处理优先级编排，前端做防御性检查
    // App 优先于 Web：App 有更新时只展示 App（安装包含 Web 资源）
    if (msgData.app) {
      // console.log(`[update] 发现 App 更新: ${msgData.app.version}`)
      window.__showUpdateNotification?.('app', msgData.app)
    } else if (msgData.web) {
      // console.log(`[update] 发现 Web 更新: ${msgData.web.version}，静默执行`)
      window.__silentWebUpdate?.(msgData.web)
    }
  } else if (msgType === 'update.checkError') {
    console.error('[update] 检查更新失败:', msgData.error)
  } else if (msgType === 'navigation.open') {
    // 悬浮条请求工作台跳到指定页面；只接受站内已注册的 hash 路由
    const route = msgData?.route
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return
    if (router.resolve(route).matched.length === 0) return
    router.push(route).catch(() => {})
  } else if (msgType === 'update.complete') {
    // console.log('[update] 更新完成:', msgData)
    window.__updateComplete?.(msgData.type, msgData.success, msgData.message)
  }
}
if (typeof window !== 'undefined' && window.ztools?.events?.transport?.setMessageCallback) {
  window.ztools.events.transport.setMessageCallback(update_handler)
}
