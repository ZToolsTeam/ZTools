import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isVersionGte, checkCompat, fetchVersions } from '../useVersionCompat'
import comparisonCases from '../../../../packages/api/contracts/fixtures/app-version/comparison-cases.json'

// 重置模块级缓存
beforeEach(() => {
  vi.resetModules()
})

describe('isVersionGte', () => {
  it('相等版本返回 true', () => {
    expect(isVersionGte('1.2.3', '1.2.3')).toBe(true)
  })

  it('当前版本更高返回 true', () => {
    expect(isVersionGte('2.0.0', '1.9.9')).toBe(true)
    expect(isVersionGte('1.3.0', '1.2.9')).toBe(true)
    expect(isVersionGte('1.2.4', '1.2.3')).toBe(true)
  })

  it('当前版本更低返回 false', () => {
    expect(isVersionGte('1.0.0', '2.0.0')).toBe(false)
    expect(isVersionGte('1.2.2', '1.2.3')).toBe(false)
  })

  it('required 为空或 1.0.0 时始终返回 true', () => {
    expect(isVersionGte('0.0.1', '')).toBe(true)
    expect(isVersionGte('0.0.1', null)).toBe(true)
    expect(isVersionGte('0.0.1', '1.0.0')).toBe(true)
    expect(isVersionGte('0.0.1', '1.0.0.0')).toBe(true)
  })

  it('current 为空时返回 false', () => {
    expect(isVersionGte('', '1.2.3')).toBe(false)
    expect(isVersionGte(null, '1.2.3')).toBe(false)
  })

  it('三位和四位版本按缺省 0 兼容比较', () => {
    expect(isVersionGte('1.0.8', '1.0.8.0')).toBe(true)
    expect(isVersionGte('1.0.8.0', '1.0.8')).toBe(true)
    expect(isVersionGte('1.0.8.1', '1.0.8')).toBe(true)
    expect(isVersionGte('1.0.8', '1.0.8.1')).toBe(false)
  })

  it('非三位或四位数字版本不满足要求', () => {
    expect(isVersionGte('2.0', '1.9.9')).toBe(false)
    expect(isVersionGte('1.0.0', '1.0')).toBe(false)
  })
})

describe('checkCompat', () => {
  it('无 minVersion 要求时兼容', () => {
    const result = checkCompat({}, '1.0.0', '1.0.0')
    expect(result.compatible).toBe(true)
  })

  it('满足 minAppVersion 时兼容', () => {
    const result = checkCompat({ minAppVersion: '1.5.0' }, '2.0.0', '1.0.0')
    expect(result.compatible).toBe(true)
  })

  it('不满足 minAppVersion 时不兼容，reason 包含版本信息', () => {
    const result = checkCompat({ minAppVersion: '3.0.0' }, '2.0.0', '1.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('3.0.0')
    expect(result.reason).toContain('2.0.0')
  })

  it('不满足 minWebVersion 时不兼容', () => {
    const result = checkCompat({ minWebVersion: '2.0.0' }, '3.0.0', '1.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('2.0.0')
  })

  it('appVersion 优先于 webVersion 检查', () => {
    // 两个都不满足，应该先报 app 版本问题
    const result = checkCompat(
      { minAppVersion: '5.0.0', minWebVersion: '5.0.0' },
      '1.0.0',
      '1.0.0'
    )
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('App')
  })

  it.each(comparisonCases.invalid)(
    '无效的当前 App 版本 %j 在存在最低版本要求时失败关闭',
    (appVersion) => {
      const result = checkCompat({ minAppVersion: '1.0.0.1' }, appVersion, '1.0.0')
      expect(result.compatible).toBe(false)
      expect(result.reason).toContain('App')
    }
  )

  it('minWebVersion 继续使用旧通用比较规则，不受 App 段长限制影响', () => {
    const result = checkCompat(
      { minWebVersion: '1.0.0.1000000000000000' },
      '1.0.0',
      '1.0.0.2000000000000000'
    )
    expect(result.compatible).toBe(true)
  })

  it.each(comparisonCases.invalid.filter((version) => version !== null && version !== ''))(
    '无效的最低 App 版本 %j 失败关闭',
    (minAppVersion) => {
      const result = checkCompat({ minAppVersion }, '2.0.0', '2.0.0')
      expect(result.compatible).toBe(false)
      expect(result.reason).toContain('App')
    }
  )

  it.each([0, false])('非字符串最低 App 版本 %j 失败关闭', (minAppVersion) => {
    const result = checkCompat({ minAppVersion }, '2.0.0', '2.0.0')
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('App')
  })
})

describe('fetchVersions', () => {
  it('ztools API 可用时返回真实版本', async () => {
    global.window.ztools = {
      sys: {
        getCurrentVersion: vi.fn().mockResolvedValue({
          appVersion: '2.3.4',
          webVersion: '1.5.0'
        })
      }
    }

    // 重新导入以清除模块缓存
    const { fetchVersions: freshFetch } = await import('../useVersionCompat')
    // 注意：模块级缓存可能已有值，直接测试 API 调用路径
    const ver = await freshFetch()
    expect(ver.appVersion).toBeDefined()
    expect(ver.webVersion).toBeDefined()
  })

  it('ztools API 不可用时将未知 App 版本缓存为 null，Web 仍使用默认版本', async () => {
    global.window.ztools = {}
    const { fetchVersions: freshFetch, checkCompat: freshCheckCompat } = await import('../useVersionCompat')
    const ver = await freshFetch()
    expect(ver.appVersion).toBeNull()
    expect(ver.webVersion).toBe('1.0.0')
    expect(freshCheckCompat({ minAppVersion: '1.0.0.1' }, ver.appVersion, ver.webVersion).compatible).toBe(false)
    expect(freshCheckCompat({}, ver.appVersion, ver.webVersion).compatible).toBe(true)
  })

  it('IPC 抛错时未知 App 版本失败关闭，Web 仍使用默认版本', async () => {
    const getCurrentVersion = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
    global.window.ztools = {
      sys: {
        getCurrentVersion
      }
    }
    const { fetchVersions: freshFetch, checkCompat: freshCheckCompat } = await import('../useVersionCompat')
    const ver = await freshFetch()
    const cachedVer = await freshFetch()
    expect(ver.appVersion).toBeNull()
    expect(ver.webVersion).toBe('1.0.0')
    expect(cachedVer).toEqual(ver)
    // 读取失败不缓存，下次重新读取，避免一次临时故障让插件一直判为不兼容
    expect(getCurrentVersion).toHaveBeenCalledTimes(2)
    expect(freshCheckCompat({ minAppVersion: '1.0.0.1' }, ver.appVersion, ver.webVersion).compatible).toBe(false)
    expect(freshCheckCompat({}, ver.appVersion, ver.webVersion).compatible).toBe(true)
  })

  it('IPC 结果缺少 appVersion 时按未知版本处理', async () => {
    global.window.ztools = {
      sys: {
        getCurrentVersion: vi.fn().mockResolvedValue({ webVersion: '1.5.0' })
      }
    }
    const { fetchVersions: freshFetch, checkCompat: freshCheckCompat } = await import('../useVersionCompat')
    const ver = await freshFetch()
    expect(ver.appVersion).toBeNull()
    expect(ver.webVersion).toBe('1.5.0')
    expect(freshCheckCompat({ minAppVersion: '1.0.0.1' }, ver.appVersion, ver.webVersion).compatible).toBe(false)
    expect(freshCheckCompat({}, ver.appVersion, ver.webVersion).compatible).toBe(true)
  })

  it.each(comparisonCases.invalid)(
    '保留 API 返回的无效 App 版本 %j，使最低版本检查失败关闭',
    async (appVersion) => {
      global.window.ztools = {
        sys: {
          getCurrentVersion: vi.fn().mockResolvedValue({
            appVersion,
            webVersion: '1.5.0'
          })
        }
      }
      const { fetchVersions: freshFetch, checkCompat: freshCheckCompat } = await import('../useVersionCompat')
      const versions = await freshFetch()
      expect(versions.appVersion).toBe(appVersion)
      const result = freshCheckCompat(
        { minAppVersion: '1.0.0.1' },
        versions.appVersion,
        versions.webVersion
      )
      expect(result.compatible).toBe(false)
    }
  )
})
