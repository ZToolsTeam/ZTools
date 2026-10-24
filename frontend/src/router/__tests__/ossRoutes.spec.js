/**
 * 开源版路由：只有公共页面，没有登录、个人中心与端内反馈页；访问这些地址回到首页
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@edition', () => import('@/edition-oss/index.js'))

const PUBLIC_ROUTE_NAMES = [
  'about', 'advanced-settings', 'declarative', 'details', 'devtools', 'diagnostics',
  'events', 'launcher', 'list', 'my', 'popout', 'welcome'
]

// 首次导入路由会冷编译全部页面组件，整套测试并行时可能超过默认 5 秒，单独放宽导入时限
const ROUTER_IMPORT_TIMEOUT_MS = 30000

describe('开源版路由', () => {
  let router

  beforeAll(async () => {
    router = (await import('@/router')).default
  }, ROUTER_IMPORT_TIMEOUT_MS)

  it('[集成] 路由表只有公共页面', () => {
    const names = router.getRoutes().map((r) => r.name).filter(Boolean).sort()
    expect(names).toEqual(PUBLIC_ROUTE_NAMES)
  })

  it('[故障] 直接访问旧的登录、个人中心、反馈建议地址时落到兜底路由，不报错', () => {
    for (const path of ['/login', '/profile', '/wish-wall']) {
      const resolved = router.resolve(path)
      expect(resolved.name, path).toBeUndefined()
      expect(resolved.matched.at(-1)?.path, path).toBe('/:pathMatch(.*)*')
    }
  })
})
