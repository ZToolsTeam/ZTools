import { createRouter, createWebHashHistory } from 'vue-router'

import MainLayout from '../layouts/MainLayout.vue'
import MyPage from '../pages/MyPage.vue'
import Details from '../pages/Details.vue'
import DeclarativePage from '../pages/DeclarativePage.vue'
import { rootRoutes, layoutRoutes, preloadRouteLoaders, track } from '@edition'

// 标记是否为首次进入应用（仅首次导航时判断跳转）
let isFirstVisit = true

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 版本附加的顶层页面（官方版的登录页等，开源版没有）
    ...rootRoutes,
    {
      path: '/launcher',
      name: 'launcher',
      component: () => import('../components/LauncherBar.vue')
    },
    {
      path: '/popout/:pluginId',
      name: 'popout',
      component: DeclarativePage,
      props: (route) => ({
        pluginId: route.params.pluginId,
        isPopout: true
      })
    },
    {
      path: '/',
      component: MainLayout,
      children: [
        {
          path: '',
          name: 'my',
          component: MyPage,
          beforeEnter: (to, from, next) => {
            // 仅首次进入应用时判断，后续导航不再拦截
            if (!isFirstVisit) return next()
            isFirstVisit = false

            next()

            // 首屏先渲染，再后台判断是否需要跳转，避免 router-view 长时间空白
            Promise.resolve().then(async () => {
              try {
                const { usePluginsStore } = await import('../stores/plugins')
                const pluginsStore = usePluginsStore()
                // 等待插件初始化完成（防重入，多次调用返回同一 Promise）
                await pluginsStore.init()

                if (
                  router.currentRoute.value.name === 'my' &&
                  pluginsStore.installedPlugins.length === 0
                ) {
                  // 没有安装任何插件，跳转到全部页
                  router.replace({ name: 'list' }).catch(() => {})
                }
              } catch (err) {
                console.warn('[router] 初始化插件状态失败，默认进入我的页:', err)
              }
            })
          }
        },
        {
          path: 'list/:category?',
          name: 'list',
          component: () => import('../pages/List.vue'),
          props: true
        },
        {
          path: 'details/:pluginId',
          name: 'details',
          component: Details,
          props: true
        },
        {
          path: 'events',
          name: 'events',
          component: () => import('../pages/EventMonitor.vue')
        },
        {
          path: 'diagnostics',
          name: 'diagnostics',
          component: () => import('../pages/Diagnostics.vue')
        },
        {
          path: 'advanced-settings',
          name: 'advanced-settings',
          component: () => import('../pages/AdvancedSettings.vue')
        },
        // 版本附加的主布局页面（官方版的反馈建议、个人中心等，开源版没有）
        ...layoutRoutes,
        {
          path: 'about',
          name: 'about',
          component: () => import('../pages/About.vue')
        },
        {
          path: 'devtools',
          name: 'devtools',
          component: () => import('../pages/DevTools.vue')
        },
        {
          path: 'declarative/:pluginId',
          name: 'declarative',
          component: DeclarativePage,
          props: true
        },
        {
          path: 'welcome',
          name: 'welcome',
          redirect: '/'
        }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

// 极客悬浮窗模式嗅探：优先直接进入 /launcher
router.beforeEach((to, from, next) => {
  if (typeof window !== 'undefined') {
    const isLauncherMode =
      window.__ztoolsWindowMode === 'launcher' ||
      window.location.search.includes('mode=launcher') ||
      window.location.hash.includes('launcher')
    if (isLauncherMode && to.path !== '/launcher') {
      return next('/launcher')
    }
  }
  next()
})

// 埋点：页面访问（只有官方版上报；开源版为空操作）
router.afterEach((to) => {
  track('page_view', '', { page: to.name || to.path })
})

/**
 * 静默空闲预加载高频核心路由组件
 * 利用浏览器空闲时段预加载关键页面 chunk，彻底消除首次点击时的动态加载等待
 */
export function preloadCoreRoutes() {
  const preload = () => {
    const loaders = [
      () => import('../pages/About.vue'),
      () => import('../pages/AdvancedSettings.vue'),
      ...preloadRouteLoaders,
      () => import('../pages/List.vue')
    ]
    loaders.forEach((load) => {
      try {
        load().catch((err) => {
          console.warn('[router] 静默预加载路由失败:', err)
        })
      } catch (err) {
        console.warn('[router] 触发静默预加载异常:', err)
      }
    })
  }

  if (typeof window !== 'undefined') {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => preload(), { timeout: 2500 })
    } else {
      setTimeout(preload, 1200)
    }
  }
}

export default router

