import fs from 'node:fs'
import path from 'node:path'

export interface MacosUserDataPathApp {
  isReady(): boolean
  getPath(name: string): string
  setPath(name: string, value: string): void
}

export type CreateUserDataDirectory = (targetPath: string) => void

/** Keep Electron's private cache/config root stable across dev and packaged app names. */
export function configureMacosUserDataPath(
  app: MacosUserDataPathApp,
  createDirectory: CreateUserDataDirectory = (targetPath) => {
    fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 })
  }
): string {
  if (app.isReady()) throw new Error('macOS userData path must be configured before Electron is ready')

  const appDataPath = app.getPath('appData')
  if (!path.isAbsolute(appDataPath)) throw new Error('macOS appData path must be absolute')

  const userDataPath = path.join(appDataPath, 'ZTools')
  createDirectory(userDataPath)
  app.setPath('userData', userDataPath)
  return userDataPath
}
