import { app, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'

export async function loadApplicationIcon(): Promise<NativeImage> {
  // Packaged executables embed LOGO.ico; development runs use electron.exe.
  const icon = app.isPackaged
    ? await app.getFileIcon(app.getPath('exe'), { size: 'large' })
    : nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'app', 'LOGO.ico'))
  if (icon.isEmpty()) throw new Error('无法加载 ZTools 应用图标')
  return icon
}
