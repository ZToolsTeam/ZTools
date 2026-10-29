import { app, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'

export interface ApplicationIconDependencies {
  readonly platform?: NodeJS.Platform
  readonly isPackaged?: boolean
  readonly getAppPath?: () => string
  readonly getExePath?: () => string
  readonly resourcesPath?: string
  readonly getFileIcon?: (filePath: string, options: { size: 'large' }) => Promise<NativeImage>
  readonly createFromPath?: (filePath: string) => NativeImage
  readonly setDockIcon?: (icon: NativeImage) => void
}

/**
 * 开发态图标文件：Windows 的 nativeImage 可直接读取多尺寸 ICO；
 * macOS / Linux 的 nativeImage 不支持 ICO，必须使用 PNG，否则启动即失败。
 */
export function developmentIconFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'LOGO.ico' : 'app-icon.png'
}

export function resolveApplicationIconCandidates(options: {
  readonly platform: NodeJS.Platform
  readonly appPath: string
  readonly resourcesPath: string
}): readonly string[] {
  const { platform, appPath, resourcesPath } = options
  const primaryFile = developmentIconFile(platform)
  const candidates: string[] = [
    path.join(appPath, 'resources', 'app', primaryFile),
    path.join(resourcesPath, 'app', primaryFile),
    path.join(resourcesPath, primaryFile)
  ]
  if (platform === 'win32') {
    candidates.push(
      path.join(appPath, 'resources', 'app', 'app-icon.png'),
      path.join(resourcesPath, 'app', 'app-icon.png'),
      path.join(resourcesPath, 'app-icon.png')
    )
  } else if (platform === 'darwin') {
    candidates.push(
      path.join(resourcesPath, 'ZTools.icns'),
      path.join(resourcesPath, 'electron.icns'),
      path.join(appPath, 'resources', 'app', 'ZTools.icns')
    )
  }
  return [...new Set(candidates)]
}

export async function loadApplicationIcon(
  dependencies: ApplicationIconDependencies = {}
): Promise<NativeImage> {
  const platform = dependencies.platform ?? process.platform
  const isPackaged = dependencies.isPackaged ?? app.isPackaged
  const appPath = dependencies.getAppPath ? dependencies.getAppPath() : app.getAppPath()
  const exePath = dependencies.getExePath ? dependencies.getExePath() : app.getPath('exe')
  const resourcesPath =
    dependencies.resourcesPath ??
    (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? process.resourcesPath
      : path.dirname(appPath))
  const getFileIcon =
    dependencies.getFileIcon ?? ((target, opts) => app.getFileIcon(target, opts))
  const createFromPath =
    dependencies.createFromPath ?? ((target) => nativeImage.createFromPath(target))
  const setDockIcon =
    dependencies.setDockIcon ?? ((icon) => { app.dock?.setIcon(icon) })

  let icon: NativeImage | undefined

  // 打包后的 Windows 可执行文件内嵌 LOGO.ico，优先提取可执行文件图标
  if (isPackaged && platform === 'win32') {
    try {
      const exeIcon = await getFileIcon(exePath, { size: 'large' })
      if (exeIcon && !exeIcon.isEmpty()) {
        icon = exeIcon
      }
    } catch {
      // 回退到候选文件列表
    }
  }

  if (!icon || icon.isEmpty()) {
    const candidates = resolveApplicationIconCandidates({
      platform,
      appPath,
      resourcesPath
    })
    for (const candidate of candidates) {
      try {
        const loaded = createFromPath(candidate)
        if (loaded && !loaded.isEmpty()) {
          icon = loaded
          break
        }
      } catch {
        // 尝试下一个候选路径
      }
    }
  }

  if ((!icon || icon.isEmpty()) && !(isPackaged && platform === 'win32')) {
    try {
      const fileIcon = await getFileIcon(exePath, { size: 'large' })
      if (fileIcon && !fileIcon.isEmpty()) {
        icon = fileIcon
      }
    } catch {
      // 忽略异常，统一在下方抛出明确错误
    }
  }

  if (!icon || icon.isEmpty()) {
    throw new Error('无法加载 ZTools 应用图标')
  }

  // 开发态 macOS 的 Dock 默认显示 Electron 图标，这里换成 ZTools 品牌图标。
  if (platform === 'darwin' && !isPackaged) {
    setDockIcon(icon)
  }
  return icon
}

export interface TrayIconDependencies {
  readonly platform?: NodeJS.Platform
  readonly getAppPath?: () => string
  readonly createFromPath?: (filePath: string) => NativeImage
}

/**
 * 托盘图标文件（构建时由 scripts/build.mjs 复制到 out/assets/tray，随安装包分发）：
 * - macOS 菜单栏用单色模板图（trayTemplate.png 及 @2x/@3x），系统按浅色 / 深色菜单栏自动着色；
 * - Windows 通知区域用多尺寸 ICO，系统按缩放比例挑 16 / 24 / 32 像素图层，避免把 32px 应用图标缩小后发糊。
 */
export function trayIconFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'trayTemplate.png' : 'tray.ico'
}

export function resolveTrayIconCandidates(options: {
  readonly platform: NodeJS.Platform
  readonly appPath: string
}): readonly string[] {
  const file = trayIconFile(options.platform)
  return [
    path.join(options.appPath, 'out', 'assets', 'tray', file),
    path.join(options.appPath, 'resources', 'app', options.platform === 'darwin' ? path.join('tray', file) : 'LOGO.ico')
  ]
}

/** 加载托盘图标；专用文件都缺失时返回 fallback（应用图标），不让托盘因为少一个文件而无法显示 */
export function loadTrayIcon(
  fallback: NativeImage,
  dependencies: TrayIconDependencies = {}
): NativeImage {
  const platform = dependencies.platform ?? process.platform
  const appPath = dependencies.getAppPath ? dependencies.getAppPath() : app.getAppPath()
  const createFromPath =
    dependencies.createFromPath ?? ((target) => nativeImage.createFromPath(target))
  for (const candidate of resolveTrayIconCandidates({ platform, appPath })) {
    try {
      const icon = createFromPath(candidate)
      if (icon && !icon.isEmpty()) {
        if (platform === 'darwin') icon.setTemplateImage(true)
        return icon
      }
    } catch {
      // 尝试下一个候选路径
    }
  }
  return fallback
}
