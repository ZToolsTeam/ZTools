import { app, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'

/**
 * 开发态图标文件：Windows 的 nativeImage 可直接读取多尺寸 ICO；
 * macOS / Linux 的 nativeImage 不支持 ICO，必须使用 PNG，否则启动即失败。
 */
export function developmentIconFile(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'LOGO.ico' : 'app-icon.png'
}

export async function loadApplicationIcon(): Promise<NativeImage> {
  // 打包后的 Windows 可执行文件内嵌 LOGO.ico；开发态直接读取 resources/app 下的源图标。
  const icon = app.isPackaged && process.platform === 'win32'
    ? await app.getFileIcon(app.getPath('exe'), { size: 'large' })
    : nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'app', developmentIconFile()))
  if (icon.isEmpty()) throw new Error('无法加载 ZTools 应用图标')
  // 开发态 macOS 的 Dock 默认显示 Electron 图标，这里换成 ZTools 品牌图标。
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
  return icon
}
