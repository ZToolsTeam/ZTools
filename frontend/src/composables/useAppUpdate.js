import { useUpdateStore } from '@/stores/update'
import { compareAppVersions } from '@/utils/version'

// 防止 web 静默更新重复触发
let _webUpdateInProgress = false

export function useAppUpdate() {
  const updateStore = useUpdateStore()

  /**
   * 检查应用版本
   * 更新编排由 Delphi 端统一管理，前端只负责发起检查请求
   * Delphi 端通过 IPC 事件推送检查结果，前端在 main.js 的 update_handler 中处理展示
   * @returns {Promise<Object>} 版本检查结果
   */
  async function checkVersion(source = 'manual') {
    try {
      const result = await window.ztools.update.check(source)
      // Delphi 端会通过 update.checkResult 事件推送结果
      // 前端在 main.js 的 update_handler 中统一处理展示
      return result
    } catch (error) {
      updateStore.setError(error.message)
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

      // 发送下载请求（Delphi 端弹出原生进度窗体，异步执行）
      const result = await window.ztools.update.downloadAndInstall({
        version: updateStore.versionInfo.version,
        downloadUrl: updateStore.versionInfo.downloadUrl,
        checksum: updateStore.versionInfo.checksum,
        fileSize: updateStore.versionInfo.fileSize
      })

      return result
    } catch (error) {
      updateStore.setError(error.message)
      throw error
    }
  }

  /**
   * 取消更新
   */
  function cancelUpdate() {
    const cancel = window.ztools?.update?.cancel
    if (typeof cancel === 'function') {
      Promise.resolve(cancel()).catch((error) => {
        console.warn('[update] 取消更新失败:', error)
      })
    }
    updateStore.reset()
  }

  return {
    checkVersion,
    downloadAndInstall,
    cancelUpdate,
    silentWebUpdate
  }
}
