import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { MacUpdateInstaller } from '../../services/update-service.js'

const execute = promisify(execFile)
const TOOL_TIMEOUT_MS = 5 * 60 * 1000

function expectedBundleVersions(version: string): { shortVersion: string; buildVersion: string } {
  const parts = version.split('.')
  const patch = Number(parts[2])
  const build = Number(parts[3])
  const merged = patch * 1000 + build
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]*)$/.test(part) || !Number.isSafeInteger(Number(part))) ||
      build > 999 || !Number.isSafeInteger(merged)) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'macOS 更新发布版本号无效')
  }
  // 与发行包一致：X.Y.Z.W 对应显示版本 X.Y.Z、构建号 X.Y.(Z×1000+W)。
  return { shortVersion: parts.slice(0, 3).join('.'), buildVersion: `${parts.slice(0, 2).join('.')}.${merged}` }
}

/** 原生边界由启动层注入，服务测试无需加载 Electron。 */
export type MacAutoUpdater = Pick<Electron.AutoUpdater, 'on' | 'removeListener' | 'setFeedURL' | 'checkForUpdates' | 'quitAndInstall'>
export type MacUpdateCommand = (file: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>

const runCommand: MacUpdateCommand = (file, args, signal) => execute(file, args, {
  encoding: 'utf8', timeout: args[0] === 'detach' ? 5000 : TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
  ...(signal ? { signal } : {})
})

/**
 * 复用已发布的 DMG，仅把其中的签名应用转为 Squirrel 所需的 ZIP。
 * 当前应用全程不被写入；替换、失败恢复和重启由 Electron 内置的 ShipIt 执行。
 */
interface MacAppUpdaterOptions {
  appPath: string
  isPackaged: boolean
  stagingRoot: string
  autoUpdater: MacAutoUpdater
  requestQuit: () => void
  reportRestartError: (error: Error) => void
  runCommand?: MacUpdateCommand
  nativeTimeoutMs?: number
}

export class MacAppUpdater implements MacUpdateInstaller {
  readonly #options: MacAppUpdaterOptions
  readonly #run: MacUpdateCommand
  #ready = false
  #busy = false
  #restarting = false
  #nativePending = false
  #finishNative: ((error?: Error) => void) | undefined
  readonly #onNativeError = (error: Error): void => {
    this.#nativePending = false
    if (this.#finishNative) this.#finishNative(error)
    else if (this.#restarting) this.#options.reportRestartError(error)
    else console.warn('macOS 原生更新器错误', error)
  }
  readonly #onNativeDownloaded = (): void => {
    this.#nativePending = false
    this.#ready = true
    this.#finishNative?.()
  }
  readonly #onNativeMissing = (): void => this.#onNativeError(new Error('原生更新器未接受更新包'))
  #restartTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: MacAppUpdaterOptions) {
    this.#options = options
    this.#run = options.runCommand ?? runCommand
    // 原生任务没有取消 API；超时后仍接收终态，避免迟到的 error 成为未处理异常。
    options.autoUpdater.on('error', this.#onNativeError)
    options.autoUpdater.on('update-downloaded', this.#onNativeDownloaded)
    options.autoUpdater.on('update-not-available', this.#onNativeMissing)
  }

  assertSupported(): void {
    const { isPackaged, appPath } = this.#options
    if (!isPackaged || !path.isAbsolute(appPath) || !appPath.endsWith('.app')) {
      throw new ZToolsError(errorCodes.notSupported, '请在正式安装的 ZTools 中更新，开发环境不支持替换应用')
    }
    if (appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) {
      throw new ZToolsError(errorCodes.notSupported, '请先将 ZTools 拖入“应用程序”并从那里打开，再进行更新')
    }
  }

  async #verifyApplication(candidate: string, version: string, signal: AbortSignal): Promise<void> {
    const current = this.#options.appPath
    const expected = expectedBundleVersions(version)
    const infoValue = async (appPath: string, key: string): Promise<string> => {
      const result = await this.#run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], signal)
      return result.stdout.trim()
    }
    const currentId = await infoValue(current, 'CFBundleIdentifier')
    if (await infoValue(candidate, 'CFBundleIdentifier') !== currentId ||
        await infoValue(candidate, 'CFBundleShortVersionString') !== expected.shortVersion ||
        await infoValue(candidate, 'CFBundleVersion') !== expected.buildVersion) {
      throw new ZToolsError(errorCodes.dataCorrupt, '更新包中的应用标识或版本与发布信息不一致')
    }
    await this.#run('/usr/bin/codesign', ['--verify', '--deep', '--strict', current], signal)
    const signature = await this.#run('/usr/bin/codesign', ['--display', '--verbose=2', '-r-', current], signal)
    const details = signature.stdout + '\n' + signature.stderr
    const requirement = details.match(/^designated => (.+)$/m)?.[1]
    if (!requirement || !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(details)) {
      throw new ZToolsError(errorCodes.notSupported, '当前应用没有有效的开发者签名，无法自动更新')
    }
    // 同时验证嵌套代码与当前应用的 designated requirement，拒绝换签/换产品的包。
    await this.#run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=' + requirement, candidate], signal)
  }

  async #createArchive(dmgPath: string, version: string, root: string, signal: AbortSignal): Promise<string> {
    const mountpoint = path.join(root, 'volume')
    await fs.mkdir(mountpoint)
    try {
      await this.#run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, dmgPath], signal)
      const apps = (await fs.readdir(mountpoint, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
      if (apps.length !== 1) throw new ZToolsError(errorCodes.dataCorrupt, '更新磁盘映像必须包含一个应用')
      const candidate = path.join(mountpoint, apps[0]!.name)
      await this.#verifyApplication(candidate, version, signal)
      const archive = path.join(root, 'update.zip')
      await this.#run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', '--zlibCompressionLevel', '1', candidate, archive], signal)
      return archive
    } finally {
      // attach 中途被取消也可能已挂载；卸载不使用已取消的 signal。
      try {
        await this.#run('/usr/bin/hdiutil', ['detach', mountpoint])
      } catch (error) {
        // 未挂载时目录仍在根卷；避免误卸载其他卷，也不递归删除未卸载的挂载点。
        const [parent, mounted] = await Promise.all([fs.stat(root), fs.stat(mountpoint)])
        if (parent.dev !== mounted.dev) {
          await this.#run('/usr/bin/hdiutil', ['detach', '-force', mountpoint])
        }
        console.warn('更新映像常规卸载失败，已检查挂载状态或强制卸载', error)
      }
    }
  }

  async prepare(dmgPath: string, version: string, signal: AbortSignal): Promise<void> {
    this.assertSupported()
    if (this.#busy || this.#ready || this.#nativePending) throw new ZToolsError(errorCodes.invalidRequest, '已有 macOS 更新正在安装')
    this.#busy = true
    let root: string | undefined
    try {
      signal.throwIfAborted()
      try {
        await fs.access(this.#options.appPath, fs.constants.W_OK)
        await fs.access(path.dirname(this.#options.appPath), fs.constants.W_OK)
      } catch {
        throw new ZToolsError(errorCodes.permissionDenied, '当前账户无法替换此应用，请将 ZTools 安装到有写入权限的位置后重试')
      }
      await fs.mkdir(this.#options.stagingRoot, { recursive: true })
      root = await fs.mkdtemp(path.join(this.#options.stagingRoot, 'update-'))
      await fs.chmod(root, 0o700)
      const archive = await this.#createArchive(dmgPath, version, root, signal)
      signal.throwIfAborted()
      // 此后由原生更新器接管，不再提供取消：Squirrel 已验证的更新会在退出时安装。
      await this.#stageNativeUpdate(archive, version, signal)
      this.#ready = true
    } finally {
      this.#busy = false
      if (root) {
        // 不递归删除 volume：卸载失败时保留现场，防止越过挂载边界。
        await fs.rm(path.join(root, 'update.zip'), { force: true }).catch(error => console.warn('清理更新归档失败', error))
        await fs.rmdir(path.join(root, 'volume')).catch(error => console.warn('清理更新挂载点失败', error))
        await fs.rmdir(root).catch(error => console.warn('清理更新临时目录失败', error))
      }
    }
  }

  async #stageNativeUpdate(archive: string, version: string, signal: AbortSignal): Promise<void> {
    const updater = this.#options.autoUpdater
    const token = randomUUID()
    const feedPath = `/${token}/feed`
    const zipPath = `/${token}/update.zip`
    const size = (await fs.stat(archive)).size
    let origin = ''
    let fail: (error: Error) => void = () => undefined
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.method !== 'GET' || request.headers.host !== origin.slice('http://'.length)) {
        response.writeHead(403).end()
      } else if (request.url === feedPath) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ url: origin + zipPath, name: version }))
      } else if (request.url === zipPath) {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size })
        void pipeline(createReadStream(archive), response).catch(error => fail(error as Error))
      } else response.writeHead(404).end()
    })
    server.requestTimeout = TOOL_TIMEOUT_MS
    const handleError = (error: Error): void => fail(error)
    server.on('error', handleError)
    try {
      await new Promise<void>((resolve, reject) => {
        fail = reject
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动本机更新服务')
      origin = `http://127.0.0.1:${address.port}`
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          this.#finishNative = undefined
          if (error) reject(error)
          else resolve()
        }
        const onAbort = (): void => finish(new ZToolsError(errorCodes.appStopping, '应用退出，更新准备已中断'))
        const timer = setTimeout(() => finish(new Error('原生更新器准备超时，请重新打开 ZTools 后重试')), this.#options.nativeTimeoutMs ?? TOOL_TIMEOUT_MS)
        fail = finish
        this.#finishNative = finish
        this.#nativePending = true
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          updater.setFeedURL({ url: origin + feedPath })
          updater.checkForUpdates()
        } catch (error) { this.#onNativeError(error instanceof Error ? error : new Error(String(error))) }
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      server.removeListener('error', handleError)
    }
  }

  /** 原生事件监听和应用同寿命；退出后不再启动新任务。 */
  dispose(): void {
    clearTimeout(this.#restartTimer)
    this.#options.autoUpdater.removeListener('error', this.#onNativeError)
    this.#options.autoUpdater.removeListener('update-downloaded', this.#onNativeDownloaded)
    this.#options.autoUpdater.removeListener('update-not-available', this.#onNativeMissing)
  }

  requestRestart(): void {
    if (!this.#ready || this.#restartTimer) return
    // 让安装 IPC 的成功响应先返回；退出前由启动层释放数据库、锁与所有窗口。
    this.#restartTimer = setTimeout(() => this.#options.requestQuit(), 150)
  }

  /** 只在应用清理完毕后调用，避免 close-to-tray 拦住 Squirrel 的重启。 */
  quitAndInstall(): boolean {
    if (!this.#ready || this.#restarting) return false
    this.#restarting = true
    clearTimeout(this.#restartTimer)
    this.#options.autoUpdater.quitAndInstall()
    return true
  }
}
