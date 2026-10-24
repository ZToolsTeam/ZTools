import type { CallerIdentity } from '../contracts/capabilities.js'
import type { AnalyticsReportParams, UserSetTokenParams } from '../contracts/method-params.js'
import type { LaunchIntent } from './runtime/launch-intent.js'
import type { JsonFileStore } from './services/json-file-store.js'
import type { LibraryMetadataSource } from './services/library-integrity-pins.js'
import type { UpdateSource } from './services/update-service.js'

/**
 * 主进程的版本接口（与界面层的 @edition 对应）。
 *
 * 公共代码只通过这里的接口使用与版本相关的能力：账号、统计、更新来源与公共库元数据。
 * - 开源版实现在 `edition-oss/`：不联网、始终未登录、没有凭据、没有更新来源、公共库只用内置完整性锚点；
 * - 其他版本的实现由 `edition.ts` 在运行时按需加载，接口与开源版完全一致。
 */

export interface UserInfoOptions {
  /**
   * 是否在结果里带上登录凭据（token / refresh_token）。
   * 默认不带：只有宿主自身（主窗口且未归属到任何插件）才应传 true，插件调用一律拿不到凭据。
   */
  readonly includeCredentials?: boolean
}

/** 账号服务：对应 IPC 方法 user_get_info / user_set_token / user_logout */
export interface AccountService {
  /** 当前账号信息；未登录时为 `{ success: true, logged_in: false }` */
  getInfo(options?: UserInfoOptions): Promise<Record<string, unknown>>
  /** 保存登录结果；返回是否真正保存（没有账号能力的版本返回 false，且不写任何文件） */
  setToken(params: UserSetTokenParams): Promise<boolean>
  /** 退出登录 */
  logout(): Promise<void>
}

/** 宿主统计：所有方法都不能向调用方抛错，失败只记录日志 */
export interface HostAnalytics {
  /** 界面层 / 插件经 analytics_report 上报；插件身份以主进程校验后的调用方为准 */
  report(params: AnalyticsReportParams, caller: CallerIdentity): void
  /** 宿主自身的事件（插件安装、更新、卸载等） */
  reportHost(event: string, pluginId: string, data?: unknown): void
  /** 插件打开成功 */
  reportPluginOpened(pluginId: string, data?: unknown): void
  /** 收到启动意图（安装器拉起、命令行来源等） */
  reportLaunch(intent: LaunchIntent): void
  /** 应用完成冷启动（调用方保证每个进程只调用一次） */
  reportStartup(): void
  /** 停止：取消进行中的上报，之后的上报一律丢弃 */
  stop(): void
}

export interface MainEditionContext {
  readonly appVersion: string
  readonly webVersion: string
  readonly dataRoot: string
  /** 已按 `MainEdition.storeFiles` 放行对应文件的 JSON 存储 */
  readonly store: JsonFileStore
}

export interface MainEditionServices {
  readonly user: AccountService
  readonly analytics: HostAnalytics
  /** 更新来源；null 表示没有更新来源（检查更新直接返回没有更新，不发网络请求） */
  readonly updateSource: UpdateSource | null
  /** 公共库元数据来源（插件安装依赖库时使用） */
  readonly libraryMetadata: LibraryMetadataSource
}

export interface MainEdition {
  readonly id: 'commercial' | 'oss'
  /** 本版本额外需要放行的 JSON 存储文件（只允许数据目录下的 `*.json` 文件名） */
  readonly storeFiles: readonly string[]
  createServices(context: MainEditionContext): MainEditionServices
}
