/**
 * 插件版本兼容性检查
 * 根据插件的 minAppVersion / minWebVersion 判断当前环境是否满足要求
 */
import { computed, ref, unref } from 'vue'
import { i18n, t } from '@/i18n'
import { formatVersionForDisplay } from '@/utils/versionDisplay'
import { compareAppVersions, isNumericVersionGte } from '@/utils/version'

// 模块级缓存，避免重复 IPC 调用
let _cachedAppVersion = null
let _cachedWebVersion = null
let _versionsCached = false
let _versionPromise = null

/**
 * 版本号比较：v1 >= v2 返回 true
 */
function isVersionGte(current, required) {
  // 保留旧版“未配置最低版本/最低版本为初始版本即不设门槛”的语义。
  if (
    required === null ||
    required === undefined ||
    required === '' ||
    required === '1.0.0' ||
    required === '1.0.0.0'
  ) {
    return true
  }

  const result = compareAppVersions(current, required)
  return result !== null && result >= 0
}

/**
 * 获取当前 App 和 Web 版本（带缓存）
 */
async function fetchVersions() {
  if (_versionsCached) {
    return { appVersion: _cachedAppVersion, webVersion: _cachedWebVersion }
  }
  // 防止并发重复调用
  if (_versionPromise) return _versionPromise

  _versionPromise = (async () => {
    try {
      if (window.ztools?.sys?.getCurrentVersion) {
        const ver = await window.ztools.sys.getCurrentVersion()
        const hasAppVersion = ver !== null &&
          typeof ver === 'object' &&
          Object.prototype.hasOwnProperty.call(ver, 'appVersion')
        _cachedAppVersion = hasAppVersion ? ver.appVersion : null
        _cachedWebVersion = ver?.webVersion || '1.0.0'
      } else {
        _cachedAppVersion = null
        _cachedWebVersion = '1.0.0'
      }
      _versionsCached = true
    } catch (e) {
      console.warn('[VersionCompat] 获取版本失败:', e)
      _cachedAppVersion = null
      _cachedWebVersion = '1.0.0'
      _versionsCached = false
    }
    return { appVersion: _cachedAppVersion, webVersion: _cachedWebVersion }
  })()

  const result = await _versionPromise
  _versionPromise = null
  return result
}

function createCompatResult(compatible, reasonResolver) {
  const result = { compatible }
  Object.defineProperty(result, 'reason', {
    enumerable: true,
    configurable: true,
    get() {
      return typeof reasonResolver === 'function' ? reasonResolver() : ''
    }
  })
  return result
}

/**
 * 检查插件是否与当前环境兼容
 * 返回对象的 `reason` 为可枚举动态 getter，热切换语言后自动按当前 locale 重新求值。
 * @param {Object} info - 包含 minAppVersion / minWebVersion 的对象
 * @returns {{ compatible: boolean, reason: string }}
 */
function checkCompat(info, appVersion, webVersion) {
  const configuredMinAppVersion = info?.minAppVersion
  const minApp = configuredMinAppVersion === null ||
    configuredMinAppVersion === undefined ||
    configuredMinAppVersion === ''
    ? '1.0.0'
    : configuredMinAppVersion
  const minWeb = info?.minWebVersion || '1.0.0'

  if (!isVersionGte(appVersion, minApp)) {
    return createCompatResult(false, () =>
      t('versionCompat.appTooLow', {
        min: minApp,
        current: formatVersionForDisplay(appVersion, appVersion || '')
      })
    )
  }
  if (!isNumericVersionGte(webVersion, minWeb)) {
    return createCompatResult(false, () =>
      t('versionCompat.webTooLow', {
        min: minWeb,
        current: formatVersionForDisplay(webVersion, webVersion || '')
      })
    )
  }
  return { compatible: true, reason: '' }
}

/**
 * 版本兼容性 composable
 */
export function useVersionCompat() {
  const appVersion = ref(_cachedAppVersion || '')
  const webVersion = ref(_cachedWebVersion || '')

  /**
   * 初始化版本信息（建议在 App.vue 或 store init 时调用一次）
   */
  async function initVersions() {
    const ver = await fetchVersions()
    appVersion.value = ver.appVersion
    webVersion.value = ver.webVersion
    return ver
  }

  /**
   * 检查插件兼容性（异步，自动获取版本）
   * @param {Object} info - { minAppVersion, minWebVersion }
   * @returns {Promise<{ compatible: boolean, reason: string }>}
   */
  async function checkPluginCompat(info) {
    const ver = await fetchVersions()
    return checkCompat(info, ver.appVersion, ver.webVersion)
  }

  /**
   * 同步检查（需要先调用过 initVersions）
   */
  function checkPluginCompatSync(info) {
    void i18n.global.locale.value
    return checkCompat(info, appVersion.value, webVersion.value)
  }

  /**
   * 创建响应当前 locale 与版本变化的兼容性计算属性（热切换语言自动更新 reason）
   * @param {Object | import('vue').Ref<Object> | (() => Object)} infoSource
   */
  function createPluginCompatComputed(infoSource) {
    return computed(() => {
      void i18n.global.locale.value
      const info = typeof infoSource === 'function' ? infoSource() : unref(infoSource)
      return checkCompat(info, appVersion.value, webVersion.value)
    })
  }

  return {
    appVersion,
    webVersion,
    initVersions,
    checkPluginCompat,
    checkPluginCompatSync,
    createPluginCompatComputed,
    isVersionGte
  }
}

// 导出静态方法供非组件场景使用
export { fetchVersions, checkCompat, isVersionGte }
