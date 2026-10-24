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
