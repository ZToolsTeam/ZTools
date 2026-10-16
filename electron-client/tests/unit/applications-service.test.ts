import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApplicationsService,
  type ApplicationRegistryScanner,
  type ApplicationUninstaller,
  type InstalledApplicationRecord
} from '../../src/main/services/applications-service.js'

test('ApplicationsService: 注册表扫描与拼音检索测试', async () => {
  const mockScanner: ApplicationRegistryScanner = {
    scan: async () => [
      {
        id: 'app-wechat',
        name: '微信 (WeChat)',
        version: '3.9.12.17',
        publisher: 'Tencent Technology',
        installLocation: 'C:\\Program Files\\Tencent\\WeChat',
        uninstallString: '"C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe"',
        quietUninstallString: '"C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe" /S',
        estimatedSizeKb: 450000,
        estimatedSize: 450000 * 1024,
        installDate: '20260401',
        isSystemComponent: false,
        pinyin: 'weixin',
        pinyinInitials: 'wx'
      },
      {
        id: 'app-vscode',
        name: 'Visual Studio Code',
        version: '1.93.0',
        publisher: 'Microsoft Corporation',
        installLocation: 'C:\\Program Files\\Microsoft VS Code',
        uninstallString: '"C:\\Program Files\\Microsoft VS Code\\unins000.exe"',
        estimatedSizeKb: 360000,
        estimatedSize: 360000 * 1024,
        installDate: '20260301',
        isSystemComponent: false,
        pinyin: 'visualstudiocode',
        pinyinInitials: 'vsc'
      },
      {
        id: 'app-runtime',
        name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)',
        version: '14.38.33135',
        publisher: 'Microsoft Corporation',
        installLocation: '',
        uninstallString: 'MsiExec.exe /X{B2509927}',
        estimatedSizeKb: 24000,
        estimatedSize: 24000 * 1024,
        installDate: '20260101',
        isSystemComponent: true,
        pinyin: 'microsoftvisualc',
        pinyinInitials: 'mvc'
      }
    ]
  }

  let uninstalledCmd = ''
  const mockUninstaller: ApplicationUninstaller = {
    uninstall: async (cmd: string) => {
      uninstalledCmd = cmd
      return { success: true }
    }
  }

  const service = new ApplicationsService({
    scanner: mockScanner,
    uninstaller: mockUninstaller
  })

  // 1. 全量扫描与默认过滤
  const allApps = await service.searchApplications()
  assert.equal(allApps.length, 2, '默认不包含系统运行库组件')

  // 包含系统组件
  const withSystem = await service.searchApplications('', { includeSystemComponents: true })
  assert.equal(withSystem.length, 3, '包含系统组件时应为 3 款')

  // 2. 拼音与首字母搜索
  const wxResults = await service.searchApplications('wx')
  assert.equal(wxResults.length, 1)
  assert.equal(wxResults[0]?.name, '微信 (WeChat)')

  const pinyinResults = await service.searchApplications('weixin')
  assert.equal(pinyinResults.length, 1)
  assert.equal(pinyinResults[0]?.name, '微信 (WeChat)')

  // 3. 卸载流程
  const uninstallRes = await service.launchUninstall('app-wechat', true)
  assert.equal(uninstallRes.success, true)
  assert.equal(uninstalledCmd, '"C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe" /S', '静默卸载应优先采用 quietUninstallString')

  // 4. 异常处理：不存在的软件
  await assert.rejects(
    async () => service.launchUninstall('non-existent-app'),
    /未找到应用程序/
  )

  // 5. 缓存与 forceRefresh 机制
  let scanCount = 0
  const countingScanner: ApplicationRegistryScanner = {
    scan: async () => {
      scanCount++
      return []
    }
  }
  const cachedService = new ApplicationsService({ scanner: countingScanner })
  await cachedService.searchApplications()
  await cachedService.searchApplications()
  assert.equal(scanCount, 1, '60秒 TTL 内连续查询应命中缓存')

  await cachedService.searchApplications('', { forceRefresh: true })
  assert.equal(scanCount, 2, '指定 forceRefresh=true 时应绕过缓存重新扫描')
})

test('WindowsRegistryScanner: 真实注册表扫描与 UTF-8 解码验证', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 环境下验证注册表真实扫描')
    return
  }

  const { WindowsRegistryScanner } = await import('../../src/main/services/applications-service.js')
  const scanner = new WindowsRegistryScanner()
  const apps = await scanner.scan()

  assert.ok(Array.isArray(apps), '应返回数组')
  assert.ok(apps.length > 10, `真实机器上应至少扫描出 10+ 款软件，实际发现 ${apps.length} 款`)

  // 验证不含 UTF-8 乱码字符 (如  或 \\ufffd)
  for (const app of apps) {
    assert.ok(!app.name.includes('\ufffd'), `软件名称不得包含 UTF-8 乱码字符: ${app.name}`)
    assert.ok(app.uninstallString.length > 0, `应用应包含有效卸载字符串: ${app.name}`)
  }
})
