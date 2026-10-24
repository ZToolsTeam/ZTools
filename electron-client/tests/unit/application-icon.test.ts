import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { NativeImage } from 'electron'
import {
  developmentIconFile,
  loadApplicationIcon,
  resolveApplicationIconCandidates
} from '../../src/main/windows/application-icon.js'

function mockImage(empty: boolean, tag = 'icon'): NativeImage {
  return {
    isEmpty: () => empty,
    tag
  } as unknown as NativeImage
}

test('developmentIconFile returns LOGO.ico on win32 and app-icon.png on darwin/linux', () => {
  assert.equal(developmentIconFile('win32'), 'LOGO.ico')
  assert.equal(developmentIconFile('darwin'), 'app-icon.png')
  assert.equal(developmentIconFile('linux'), 'app-icon.png')
})

test('resolveApplicationIconCandidates includes app.asar, resources, and macOS icns fallbacks', () => {
  const candidates = resolveApplicationIconCandidates({
    platform: 'darwin',
    appPath: '/Applications/ZTools.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/ZTools.app/Contents/Resources'
  })
  assert.ok(candidates.includes(path.join('/Applications/ZTools.app/Contents/Resources/app.asar', 'resources', 'app', 'app-icon.png')))
  assert.ok(candidates.includes(path.join('/Applications/ZTools.app/Contents/Resources', 'app-icon.png')))
  assert.ok(candidates.includes(path.join('/Applications/ZTools.app/Contents/Resources', 'ZTools.icns')))
  assert.ok(candidates.includes(path.join('/Applications/ZTools.app/Contents/Resources', 'electron.icns')))
})

test('loadApplicationIcon loads app-icon.png and sets dock icon in macOS development mode', async () => {
  const dockIcons: NativeImage[] = []
  const expected = mockImage(false, 'mac-dev-png')
  const icon = await loadApplicationIcon({
    platform: 'darwin',
    isPackaged: false,
    getAppPath: () => '/workspace/electron-client',
    getExePath: () => '/workspace/electron-client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    resourcesPath: '/workspace/electron-client/resources',
    createFromPath: (target) =>
      target.endsWith(path.join('resources', 'app', 'app-icon.png')) ? expected : mockImage(true),
    getFileIcon: async () => mockImage(true),
    setDockIcon: (img) => dockIcons.push(img)
  })
  assert.equal(icon, expected)
  assert.equal(dockIcons.length, 1)
  assert.equal(dockIcons[0], expected)
})

test('loadApplicationIcon falls back to packaged electron.icns when app.asar/resources/app/app-icon.png is missing on macOS', async () => {
  const dockIcons: NativeImage[] = []
  const expectedIcns = mockImage(false, 'mac-packaged-icns')
  const triedPaths: string[] = []
  const icon = await loadApplicationIcon({
    platform: 'darwin',
    isPackaged: true,
    getAppPath: () => '/Applications/ZTools.app/Contents/Resources/app.asar',
    getExePath: () => '/Applications/ZTools.app/Contents/MacOS/ZTools',
    resourcesPath: '/Applications/ZTools.app/Contents/Resources',
    createFromPath: (target) => {
      triedPaths.push(target)
      if (target === path.join('/Applications/ZTools.app/Contents/Resources', 'electron.icns')) {
        return expectedIcns
      }
      return mockImage(true)
    },
    getFileIcon: async () => mockImage(true),
    setDockIcon: (img) => dockIcons.push(img)
  })
  assert.equal(icon, expectedIcns)
  assert.equal(dockIcons.length, 0)
  assert.ok(triedPaths[0]?.endsWith(path.join('resources', 'app', 'app-icon.png')))
})

test('loadApplicationIcon falls back to getFileIcon on macOS when all static icon files are unavailable', async () => {
  const fileIcon = mockImage(false, 'mac-exe-file-icon')
  const icon = await loadApplicationIcon({
    platform: 'darwin',
    isPackaged: true,
    getAppPath: () => '/Applications/ZTools.app/Contents/Resources/app.asar',
    getExePath: () => '/Applications/ZTools.app/Contents/MacOS/ZTools',
    resourcesPath: '/Applications/ZTools.app/Contents/Resources',
    createFromPath: () => {
      throw new Error('disk read failure')
    },
    getFileIcon: async () => fileIcon,
    setDockIcon: () => {}
  })
  assert.equal(icon, fileIcon)
})

test('loadApplicationIcon on packaged win32 falls back to LOGO.ico when getFileIcon rejects', async () => {
  const fallbackIco = mockImage(false, 'win32-fallback-ico')
  const icon = await loadApplicationIcon({
    platform: 'win32',
    isPackaged: true,
    getAppPath: () => 'C:\\Program Files\\ZTools\\resources\\app.asar',
    getExePath: () => 'C:\\Program Files\\ZTools\\ZTools.exe',
    resourcesPath: 'C:\\Program Files\\ZTools\\resources',
    getFileIcon: async () => {
      throw new Error('shell icon extraction failed')
    },
    createFromPath: (target) =>
      target.endsWith(path.join('resources', 'app', 'LOGO.ico')) ? fallbackIco : mockImage(true)
  })
  assert.equal(icon, fallbackIco)
})

test('loadApplicationIcon throws explicit error when all icon sources are empty or fail', async () => {
  await assert.rejects(
    loadApplicationIcon({
      platform: 'darwin',
      isPackaged: true,
      getAppPath: () => '/Applications/ZTools.app/Contents/Resources/app.asar',
      getExePath: () => '/Applications/ZTools.app/Contents/MacOS/ZTools',
      resourcesPath: '/Applications/ZTools.app/Contents/Resources',
      createFromPath: () => mockImage(true),
      getFileIcon: async () => mockImage(true),
      setDockIcon: () => {}
    }),
    /无法加载 ZTools 应用图标/
  )
})
