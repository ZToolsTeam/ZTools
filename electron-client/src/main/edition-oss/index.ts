import type {
  AccountService,
  HostAnalytics,
  MainEdition,
  MainEditionServices
} from '../edition-types.js'
import { pinnedLibraryMetadataSource } from '../services/library-integrity-pins.js'

/**
 * 主进程开源版实现（edition.ts 找不到其他版本入口时使用）。
 * 不连接任何后台、不发网络请求、不读写账号文件：
 * - 账号：始终未登录，没有凭据，保存登录结果一律拒绝；
 * - 统计：全部丢弃；
 * - 更新：没有更新来源（新版本请到 GitHub Releases 下载）；
 * - 公共库：只用随版本发布的内置完整性锚点（CDN 地址 + SHA-256）。
 */

const LOGGED_OUT = Object.freeze({ success: true, logged_in: false })

const loggedOutAccount: AccountService = Object.freeze({
  async getInfo(): Promise<Record<string, unknown>> {
    return { ...LOGGED_OUT }
  },
  async setToken(): Promise<boolean> {
    return false
  },
  async logout(): Promise<void> {}
})

const noopAnalytics: HostAnalytics = Object.freeze({
  report() {},
  reportHost() {},
  reportPluginOpened() {},
  reportLaunch() {},
  reportStartup() {},
  stop() {}
})

export const ossEdition: MainEdition = Object.freeze({
  id: 'oss' as const,
  storeFiles: Object.freeze([]),
  createServices(): MainEditionServices {
    return {
      user: loggedOutAccount,
      analytics: noopAnalytics,
      updateSource: null,
      libraryMetadata: pinnedLibraryMetadataSource
    }
  }
})
