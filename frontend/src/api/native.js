// Native API Implementation
// Encapsulates interactions with the Electron host via window.ztools

import { isOfficialPlugin } from '@/utils/officialPlugins'
import { normalizeCategoryNames } from '@/utils/pluginCategories'

/**
 * Check if the native bridge is available
 */
function hasNativeBridge() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.ztools &&
      typeof window.ztools === 'object'
    )
  } catch (err) {
    console.warn('[native] 检测原生桥接失败:', err)
    return false
  }
}

export const isNative = hasNativeBridge()

/**
 * Get a native module from window.ztools
 * @param {string} moduleName
 */
function getNativeModule(moduleName) {
  if (!window.ztools) {
    throw new Error('ZTools API 未初始化')
  }
  if (moduleName === 'win' || moduleName === 'window') {
    const winModule = window.ztools.window || window.ztools.win
    if (!winModule) {
      throw new Error('ZTools window API 不可用')
    }
    return winModule
  }
  const module = window.ztools[moduleName]
  if (!module) {
    throw new Error(`ZTools ${moduleName} API 不可用`)
  }
  return module
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout(promise, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Request timeout')), ms)
    promise
      .then((v) => {
        clearTimeout(t)
        resolve(v)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1'
  }
  return false
}

const native = {
  // ==========================================
  // 1. 插件管理 (Plugin Management)
  // ==========================================
  async openPlugin(pluginId, payload) {
    if (isOfficialPlugin(pluginId)) {
      return { success: true, isDeclarative: true, pluginId }
    }
    try {
      const plugin = getNativeModule('plugin')
      if (typeof plugin.open !== 'function') throw new Error('API missing')
      const res = await plugin.open(pluginId, payload)
      const resData =
        res?.data && typeof res.data === 'object'
          ? res.data
          : res

      // 检查是否需要导航到详情页
      if (resData?.action === 'navigate_to_detail') {
        return {
          success: false,
          error: resData.error || '插件未安装',
          action: 'navigate_to_detail',
          pluginId: resData.pluginId || pluginId
        }
      }

      if (resData?.success === false) {
        return {
          success: false,
          error: resData.error || '打开失败',
          pluginId: resData.pluginId || pluginId
        }
      }

      const success = res === true || res?.success === true || resData?.success === true
      return {
        ...(resData && typeof resData === 'object' ? resData : {}),
        success
      }
    } catch (e) {
      console.error('openPlugin error:', e)
      return { success: false, error: e.message }
    }
  },

  async getLocalPlugins() {
    try {
      const plugin = getNativeModule('plugin')
      const result = await plugin.getList()
      return result && result.data && Array.isArray(result.data)
        ? result.data.map((item) => ({
          ...item,
          category: normalizeCategoryNames(item.category).join(' / ')
        }))
        : []
    } catch (e) {
      console.error('getLocalPlugins error:', e)
      return []
    }
  },

  async installPluginNative(pluginId, downloadInfo) {
    try {
      const plugin = getNativeModule('plugin')
      const rawInfo =
        typeof downloadInfo === 'string'
          ? { downloadUrl: downloadInfo }
          : downloadInfo || {}
      const info = {
        ...rawInfo,
        checksum: rawInfo.checksum || rawInfo.sha256 || '',
        sha256: rawInfo.sha256 || rawInfo.checksum || '',
        fileSize: Number(rawInfo.fileSize ?? rawInfo.file_size ?? rawInfo.size ?? 0) || 0
      }
      return await plugin.install(pluginId, info.downloadUrl || '', info)
    } catch (e) {
      return { success: false, error: e.message }
    }
  },

  async uninstallPluginNative(pluginId) {
    try {
      const plugin = getNativeModule('plugin')
      return await plugin.uninstall(pluginId)
    } catch (e) {
      return { success: false, error: e.message }
    }
  },

  async createShortcut(pluginId) {
    try {
      const plugin = getNativeModule('plugin')
      return await plugin.createShortcut(pluginId)
    } catch (e) {
      return { success: false, error: e.message }
    }
  },

  async refreshPluginIcon(pluginId, iconUrl) {
    try {
      const plugin = getNativeModule('plugin')
      return await plugin.refreshIcon(pluginId, iconUrl)
    } catch (e) {
      return { success: false, error: e.message }
    }
  },

  // ==========================================
  // 2. 配置与收藏 (Config & Favorites)
  // ==========================================
  async getFavorites() {
    try {
      const config = getNativeModule('config')
      const data = await config.get('plugins.favorites', '[]')
      return JSON.parse(data)
    } catch (e) {
      console.warn('[native] getFavorites 失败:', e)
      return []
    }
  },

  async setFavorites(ids) {
    try {
      const config = getNativeModule('config')
      const data = JSON.stringify(Array.from(new Set(ids)))
      await config.set('plugins.favorites', data, true)
      return true
    } catch (e) {
      console.warn('[native] setFavorites 失败:', e)
      return false
    }
  },

  async getAutostart() {
    const isElectronHost = typeof window.ztools?.isElectron === 'function'
      ? window.ztools.isElectron()
      : Boolean(window.__ztoolsElectron)
    if (isElectronHost) {
      const sys = getNativeModule('sys')
      if (typeof sys.getAutostart === 'function') {
        const result = await withTimeout(sys.getAutostart())
        if (result?.success !== true || typeof result.enabled !== 'boolean') {
          throw new Error('获取开机启动状态失败')
        }
        return result.enabled
      }
    }
    const config = getNativeModule('config')
    const raw = await withTimeout(config.get('system.autostart', 'false'))
    return normalizeBoolean(raw)
  },

  async setAutostart(enabled) {
    try {
      const sys = window.ztools?.sys
      if (typeof sys?.setAutostart === 'function') {
        const result = await withTimeout(sys.setAutostart(!!enabled))
        return result?.success === true && normalizeBoolean(result.enabled) === !!enabled
      }
      console.warn('[native] 当前宿主不支持 sys.setAutostart，无法设置开机自启')
      return false
    } catch (err) {
      console.warn('[native] setAutostart 失败:', err)
      return false
    }
  },

  async getHotkey() {
    try {
      return (await getNativeModule('config').get('hotkey.global', '')) || ''
    } catch (err) {
      console.warn('[native] getHotkey 失败:', err)
      return ''
    }
  },
  async setHotkey(val) {
    try {
      await getNativeModule('config').set('hotkey.global', val || '', true)
      return true
    } catch (err) {
      console.warn('[native] setHotkey 失败:', err)
      return false
    }
  },
  async getMinimizeToTray() {
    try {
      const raw = await getNativeModule('config').get(
        'system.minimizeToTray',
        'true'
      )
      return normalizeBoolean(raw)
    } catch (err) {
      console.warn('[native] getMinimizeToTray 失败:', err)
      return true
    }
  },
  async setMinimizeToTray(val) {
    try {
      await getNativeModule('config').set(
        'system.minimizeToTray',
        String(!!val),
        true
      )
      return true
    } catch (err) {
      console.warn('[native] setMinimizeToTray 失败:', err)
      return false
    }
  },
  async getCloseConfirm() {
    try {
      const raw = await getNativeModule('config').get(
        'system.closeConfirm',
        'true'
      )
      return normalizeBoolean(raw)
    } catch (err) {
      console.warn('[native] getCloseConfirm 失败:', err)
      return true
    }
  },
  async setCloseConfirm(val) {
    try {
      await getNativeModule('config').set(
        'system.closeConfirm',
        String(!!val),
        true
      )
      return true
    } catch (err) {
      console.warn('[native] setCloseConfirm 失败:', err)
      return false
    }
  },

  // ==========================================
  // 3. 窗口控制 (Window Control)
  // ==========================================
  win: {
    async open(url) {
      return await getNativeModule('win').open(url)
    },
    async minimize() {
      return await getNativeModule('win').minimize()
    },
    async maximize() {
      return await getNativeModule('win').maximize()
    },
    async restore() {
      return await getNativeModule('win').show()
    },
    async close() {
      return await getNativeModule('win').close()
    },
    async setAlwaysOnTop(flag) {
      return await getNativeModule('win').setAlwaysOnTop(flag)
    },
    async setOpacity(alpha) {
      return await getNativeModule('win').setOpacity(alpha)
    },
    async showOpenDialog(options) {
      return await getNativeModule('win').showOpenDialog(options)
    },
    async showSaveDialog(options) {
      return await getNativeModule('win').showSaveDialog(options)
    },
    async toggleDevTools() {
      return await getNativeModule('win').toggleDevTools()
    },
    async setSize(width, height) {
      return await getNativeModule('win').setSize(width, height)
    },
    async getBounds() {
      return await getNativeModule('win').getBounds()
    }
  },

  // ==========================================
  // 4. 系统控制与监控 (System & Monitor)
  // ==========================================
  sys: {
    async getInfo() {
      return await getNativeModule('sys').getInfo()
    },
    async getNativeId() {
      return await getNativeModule('sys').getNativeId()
    },
    async notify(title, msg) {
      return await getNativeModule('sys').notify(title, msg)
    },
    async openExternal(url) {
      return await getNativeModule('shell').openExternal(url)
    },
    async lock() {
      return await getNativeModule('sys').lock()
    },
    async sleep() {
      return await getNativeModule('sys').sleep()
    },
    async getCPUUsage() {
      return await getNativeModule('sys').getCPUUsage()
    },
    async getMemoryUsage() {
      return await getNativeModule('sys').getMemoryUsage()
    },
    async checkUpdate() {
      return await getNativeModule('sys').checkUpdate()
    },
    async getPath(name) {
      return await getNativeModule('sys').getPath(name)
    },
    async searchFiles(query, limit = 50) {
      if (window.__ztoolsLauncher?.searchFiles) {
        return await window.__ztoolsLauncher.searchFiles(query, limit)
      }
      if (typeof window.ztools?.system?.searchFiles === 'function') {
        return await window.ztools.system.searchFiles(query, limit)
      }
      if (typeof window.ztools?.sys?.searchFiles === 'function') {
        return await window.ztools.sys.searchFiles(query, limit)
      }
      return await getNativeModule('sys').searchFiles(query, limit)
    }
  },

  // ==========================================
  // 5. 文件系统 (Filesystem)
  // ==========================================
  fs: {
    async readFile(path) {
      return await getNativeModule('fs').readFile(path)
    },
    async writeFile(path, content, options = {}) {
      return await getNativeModule('fs').writeFile(path, content, options)
    },
    async deleteFile(path) {
      return await getNativeModule('fs').deleteFile(path)
    },
    async exists(path) {
      return await getNativeModule('fs').fileExists(path)
    },
    async fileExists(path) {
      return await getNativeModule('fs').fileExists(path)
    },
    async directoryExists(path) {
      return await getNativeModule('fs').directoryExists(path)
    },
    async getCurrentDirectory() {
      return await getNativeModule('fs').getCurrentDirectory()
    },
    async getDirectoryContents(path) {
      return await getNativeModule('fs').getDirectoryContents(path)
    },
    async createDirectory(path) {
      return await getNativeModule('fs').createDirectory(path)
    }
  },

  // ==========================================
  // 6. 数据库 (Database - Extended)
  // ==========================================
  db: {
    async get(pluginId, key) {
      return await getNativeModule('db').get(pluginId, key)
    },
    async set(pluginId, key, value) {
      return await getNativeModule('db').set(pluginId, key, value)
    },
    async delete(pluginId, key) {
      return await getNativeModule('db').delete(pluginId, key)
    },
    async allDocs(pluginId) {
      return await getNativeModule('db').allDocs(pluginId)
    },
    async putSecure(pluginId, key, value) {
      return await getNativeModule('db').putSecure(pluginId, key, value)
    },
    async getSecure(pluginId, key) {
      return await getNativeModule('db').getSecure(pluginId, key)
    }
  },

  // ==========================================
  // 7. 特权服务 (Privileged Service) - NEW
  // ==========================================
  privileged: {
    async regWrite(path, name, value, view = 64) {
      return await getNativeModule('privileged').regWrite(
        path,
        name,
        value,
        view
      )
    },
    async regDelete(path, name, view = 64) {
      return await getNativeModule('privileged').regDelete(path, name, view)
    },
    async fileWrite(path, content) {
      return await getNativeModule('privileged').fileWrite(path, content)
    },
    async restartExplorer() {
      return await getNativeModule('privileged').restartExplorer()
    },
    async execute(cmd, options) {
      return await getNativeModule('privileged').execute(cmd, options)
    }
  },

  // ==========================================
  // 8. 触发器与热键 (Trigger & Hotkey) - NEW
  // ==========================================
  trigger: {
    async register(config) {
      return await getNativeModule('trigger').register(config)
    },
    async unregister(id) {
      return await getNativeModule('trigger').unregister(id)
    },
    async list() {
      return await getNativeModule('trigger').list()
    },
    async checkConflict(key, pluginId = '') {
      return await getNativeModule('trigger').checkConflict(key, pluginId)
    }
  },

  // ==========================================
  // 9. 协议处理 (Protocol) - NEW
  // ==========================================
  protocol: {
    async getUrl(path) {
      return `ztools://file/${path.replace(/\\/g, '/')}`
    },
    async readText(url) {
      return await (await fetch(url)).text()
    },
    async readJson(url) {
      return await (await fetch(url)).json()
    },
    async readBlob(url) {
      return await (await fetch(url)).blob()
    }
  },

  // ==========================================
  // 其他模块 (Network, Process, Screen, Simulate)
  // ==========================================
  network: {
    async httpRequest(options) {
      return await getNativeModule('network').httpRequest(options)
    },
    async download(url, targetPath) {
      return await getNativeModule('network').download(url, targetPath)
    }
  },
  process: {
    async getList() {
      return await getNativeModule('process').list()
    },
    async kill(pid) {
      return await getNativeModule('process').kill(pid)
    },
    async isRunning(name) {
      return await getNativeModule('process').exists(name)
    }
  },
  screen: {
    async capture(options) {
      return await getNativeModule('screen').capture(options)
    },
    async getCursorPos() {
      return await getNativeModule('screen').getCursorPos()
    },
    async getAllDisplays() {
      return await getNativeModule('screen').getAllDisplays()
    }
  },
  simulate: {
    async keyPress(key) {
      return await getNativeModule('sys').simulateKeyPress(key)
    },
    async text(text) {
      return await getNativeModule('sys').simulateText(text)
    }
  },

  // ==========================================
  // Legacy / Direct Exports
  // ==========================================
  async downloadAppUpdate(info) {
    return await getNativeModule('update').downloadApp(info)
  },
  async downloadPluginUpdate(id, info) {
    return await getNativeModule('update').downloadPlugin(id, info)
  },
  async getDllPluginList() {
    return await getNativeModule('dllplugin').getList()
  },
  async callDllPlugin(plugin, func, params) {
    return await getNativeModule('dllplugin').call(plugin, func, params)
  },
  async storageGet(pid, k) {
    return await native.db.get(pid, k)
  },
  async storageSet(pid, k, v) {
    return await native.db.set(pid, k, v)
  },
  async storageDelete(pid, k) {
    return await native.db.delete(pid, k)
  },
  async systemNotify(t, m) {
    return await native.sys.notify(t, m)
  }
}

// Exports
export const getLocalPlugins = native.getLocalPlugins
export const openPlugin = native.openPlugin
export const getFavorites = native.getFavorites
export const setFavorites = native.setFavorites
export const getAutostart = native.getAutostart
export const setAutostart = native.setAutostart
export const getHotkey = native.getHotkey
export const setHotkey = native.setHotkey
export const getMinimizeToTray = native.getMinimizeToTray
export const setMinimizeToTray = native.setMinimizeToTray
export const getCloseConfirm = native.getCloseConfirm
export const setCloseConfirm = native.setCloseConfirm
export const downloadAppUpdate = native.downloadAppUpdate
export const downloadPluginUpdate = native.downloadPluginUpdate
export const getDllPluginList = native.getDllPluginList
export const callDllPlugin = native.callDllPlugin
export const installPluginNative = native.installPluginNative
export const uninstallPluginNative = native.uninstallPluginNative
export const createShortcut = native.createShortcut
export const storageGet = native.storageGet
export const storageSet = native.storageSet
export const storageDelete = native.storageDelete
export const systemNotify = native.systemNotify
export const searchFiles = native.sys.searchFiles

native.window = native.win

export const win = native.win
export { win as window }
export const sys = native.sys
export const fs = native.fs
export const db = native.db
export const privileged = native.privileged
export const trigger = native.trigger
export const protocol = native.protocol
export const network = native.network
export const process = native.process
export const screen = native.screen
export const simulate = native.simulate

export default native
