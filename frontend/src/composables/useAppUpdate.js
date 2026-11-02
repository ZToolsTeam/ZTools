import { useUpdateStore } from '@/stores/update'
import { compareAppVersions } from '@/utils/version'

// 防止 web 静默更新重复触发
let _webUpdateInProgress = false

const TRUSTED_CLIENT_RELEASE_ORIGIN = 'https://cdn.ztools.cn'
const TRUSTED_CLIENT_RELEASE_BASE_PATH = '/client-v2'
const SAFE_ARTIFACT_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FOUR_PART_VERSION_PATTERN = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$/

/**
 * 校验 macOS 手动更新 DMG 下载地址位于受信任官方 CDN 版本目录下且扩展名为 .dmg。
 * 具体文件名以后台返回为准，不在前端硬编码锁死文件名模板。
 * @param {unknown} rawUrl
 * @param {unknown} version
 * @returns {boolean}
 */
export function isTrustedMacManualUpdateUrl(rawUrl, version) {
  if (typeof rawUrl !== 'string' || typeof version !== 'string' || !FOUR_PART_VERSION_PATTERN.test(version)) {
    return false
  }
  if (!version.split('.').every((part) => Number.isSafeInteger(Number(part)))) {
    return false
  }
  const expectedExtension = '.dmg'
  const expectedPrefix = `${TRUSTED_CLIENT_RELEASE_ORIGIN}${TRUSTED_CLIENT_RELEASE_BASE_PATH}/${version}/`
  if (!rawUrl.startsWith(expectedPrefix)) return false
  const fileName = rawUrl.slice(expectedPrefix.length)
  if (
    fileName.length <= expectedExtension.length ||
    !fileName.endsWith(expectedExtension) ||
    !SAFE_ARTIFACT_FILENAME_PATTERN.test(fileName) ||
    fileName.includes('..')
  ) {
    return false
  }
  try {
    const parsed = new URL(rawUrl)
    return (
      parsed.href === rawUrl &&
      parsed.origin === TRUSTED_CLIENT_RELEASE_ORIGIN &&
      parsed.pathname === `${TRUSTED_CLIENT_RELEASE_BASE_PATH}/${version}/${fileName}` &&
      parsed.search === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

/**
 * 当前平台是否不支持更新操作（主进程以 NOT_SUPPORTED 明确声明）。
 * 这是能力边界而不是故障：启动检查应静默跳过，手动检查应提示用户去官网下载。
 * @param {unknown} error
 */
export function isUpdateUnsupported(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'NOT_SUPPORTED'
}

export function useAppUpdate() {
  const updateStore = useUpdateStore()

  /**
   * 检查应用版本
   * 主进程按宿主平台选择正式安装包，前端负责展示检查结果。
   * @returns {Promise<Object>} 版本检查结果
   */
  async function checkVersion(source = 'manual') {
    try {
      const result = await window.ztools.update.check(source)
      return result
    } catch (error) {
      // 平台不支持不是错误，不写入更新错误状态
      if (!isUpdateUnsupported(error)) updateStore.setError(error.message)
      throw error
    }
  }

  /**
   * Web 静默更新：校验最低 exe 版本后直接执行，不弹通知
   * @param {Object} data - web 更新数据（含 version, url/downloadUrl, minAppVersion 等）
   * @returns {Promise<boolean>} 是否成功发起更新
   */
  async function silentWebUpdate(data) {
    if (_webUpdateInProgress) {
      console.log('[update] Web 静默更新已在进行中，跳过')
      return false
    }

    _webUpdateInProgress = true
    try {
      // 获取当前 exe 版本，校验最低版本要求
      const configuredMinAppVersion = data.minAppVersion
      const minAppVersion = configuredMinAppVersion === null ||
        configuredMinAppVersion === undefined ||
        configuredMinAppVersion === ''
        ? '1.0.0'
        : configuredMinAppVersion
      let currentAppVersion = '1.0.0'
      try {
        currentAppVersion = await window.ztools.sys.getAppVersion()
      } catch (e) {
        console.warn('[update] 获取 exe 版本失败，无法执行 web 静默更新:', e)
        throw e
      }

      const versionCompareResult = compareAppVersions(currentAppVersion, minAppVersion)
      if (versionCompareResult === null || versionCompareResult < 0) {
        console.warn(
          `[update] exe 版本 ${currentAppVersion} 低于 web 更新要求的最低版本 ${minAppVersion}，跳过 web 静默更新`
        )
        return false
      }

      const version = data.version
      const downloadUrl = data.downloadUrl || data.url
      const checksum = data.checksum
      if (typeof version !== 'string' || typeof downloadUrl !== 'string' || typeof checksum !== 'string' || checksum.length === 0) {
        console.warn('[update] Web 更新缺少版本、下载地址或完整性校验值，已跳过')
        return false
      }
      const result = await window.ztools.sys.performUpdate('web', {
        version,
        downloadUrl,
        checksum,
        fileSize: Number.isSafeInteger(data.fileSize) ? data.fileSize : 0,
        ...(typeof data.minAppVersion === 'string' ? { minAppVersion: data.minAppVersion } : {})
      })
      return result === true || result?.success === true
    } catch (err) {
      console.error('[update] Web 静默更新失败:', err)
      throw err
    } finally {
      _webUpdateInProgress = false
    }
  }

  /**
   * 下载并安装应用
   * 通过 IPC 下载并交给外部安装器，进度由 update_download_progress 事件提供
   * @returns {Promise<Object>} 下载启动结果
   */
  async function downloadAndInstall() {
    try {
      updateStore.setError(null)

      // 发送下载请求（宿主端异步执行下载并启动安装器）
      const result = await window.ztools.update.downloadAndInstall({
        version: updateStore.versionInfo.version,
        downloadUrl: updateStore.versionInfo.downloadUrl,
        checksum: updateStore.versionInfo.checksum,
        fileSize: updateStore.versionInfo.fileSize
      })

      if (result?.success !== true) throw new Error(result?.message || '安装器未启动，请重试')
      return result
    } catch (error) {
      updateStore.setError(error.message)
      throw error
    }
  }

  /** macOS 由浏览器下载已发布 DMG，打开下载不等于完成安装。 */
  async function openManualUpdate(info) {
    if (info?.manualUpdate !== true || !isTrustedMacManualUpdateUrl(info?.downloadUrl, info?.version)) {
      throw new Error('macOS 安装包信息无效，请重新检查更新')
    }
    const opened = await window.ztools?.shell?.openExternal(info.downloadUrl)
    if (opened !== true) throw new Error('无法打开安装包下载，请稍后重试')
    return true
  }

  /**
   * 取消更新
   */
  function cancelUpdate() {
    const update = window.ztools?.update
    if (typeof update?.cancel === 'function') {
      Promise.resolve().then(() => update.cancel()).catch((error) => {
        console.warn('[update] 取消更新失败:', error)
      })
    }
    updateStore.reset()
  }

  return {
    checkVersion,
    downloadAndInstall,
    openManualUpdate,
    cancelUpdate,
    silentWebUpdate
  }
}
