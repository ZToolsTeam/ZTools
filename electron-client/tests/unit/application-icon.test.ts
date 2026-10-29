import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { NativeImage } from 'electron'
import {
  developmentIconFile,
  loadApplicationIcon,
  loadTrayIcon,
  resolveApplicationIconCandidates,
  resolveTrayIconCandidates
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

function mockTemplateImage(empty: boolean, tag: string): NativeImage & { templateFlags: boolean[] } {
  const templateFlags: boolean[] = []
  return {
    isEmpty: () => empty,
    setTemplateImage: (flag: boolean) => { templateFlags.push(flag) },
    templateFlags,
    tag
  } as unknown as NativeImage & { templateFlags: boolean[] }
}

test('resolveTrayIconCandidates: macOS 用 out/assets/tray 下的模板图，Windows 用多尺寸 ICO，源码目录作开发兜底', () => {
  assert.deepEqual(resolveTrayIconCandidates({ platform: 'darwin', appPath: '/app' }), [
    path.join('/app', 'out', 'assets', 'tray', 'trayTemplate.png'),
    path.join('/app', 'resources', 'app', 'tray', 'trayTemplate.png')
  ])
  assert.deepEqual(resolveTrayIconCandidates({ platform: 'win32', appPath: 'C:/app' }), [
    path.join('C:/app', 'out', 'assets', 'tray', 'tray.ico'),
    path.join('C:/app', 'resources', 'app', 'LOGO.ico')
  ])
})

test('loadTrayIcon: macOS 取到模板图后标记为模板，菜单栏按深浅色自动着色', () => {
  const template = mockTemplateImage(false, 'tray-template')
  const icon = loadTrayIcon(mockImage(false, 'app'), {
    platform: 'darwin',
    getAppPath: () => '/app',
    createFromPath: () => template
  })
  assert.equal(icon, template)
  assert.deepEqual(template.templateFlags, [true])
})

test('loadTrayIcon: Windows 打包产物缺失时退回源码目录的 LOGO.ico，且不设置模板标记', () => {
  const requested: string[] = []
  const ico = mockTemplateImage(false, 'ico')
  const icon = loadTrayIcon(mockImage(false, 'app'), {
    platform: 'win32',
    getAppPath: () => 'C:/app',
    createFromPath: (target) => {
      requested.push(target)
      if (target.endsWith('tray.ico')) throw new Error('ENOENT')
      return ico
    }
  })
  assert.equal(icon, ico)
  assert.equal(requested.length, 2)
  assert.deepEqual(ico.templateFlags, [])
})

test('loadTrayIcon: 专用图标全部为空或读取失败时返回应用图标，托盘仍能显示', () => {
  const fallback = mockImage(false, 'app')
  let calls = 0
  const icon = loadTrayIcon(fallback, {
    platform: 'darwin',
    getAppPath: () => '/app',
    createFromPath: () => {
      calls += 1
      if (calls === 1) return mockImage(true, 'empty')
      throw new Error('broken png')
    }
  })
  assert.equal(icon, fallback)
  assert.equal(calls, 2)
})
