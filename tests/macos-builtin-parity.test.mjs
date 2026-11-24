/**
 * ZTools Electron 主进程 macOS 原生服务层集成与异常防御测试套件
 *
 * 覆盖范围：
 * - Gate-2：Electron 主进程 macOS 原生服务层（file-indexer, navigation, applications, script-commands, dictionary）集成与异常防御
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTempDirTracker } from './helpers/temp-dir.mjs'

const tmpTracker = createTempDirTracker()
test.after(() => {
  tmpTracker.cleanupAll()
})

test('Gate-2: Electron 主进程 macOS 原生服务层（file-indexer, navigation, applications, script-commands, dictionary）集成与异常防御', async () => {
  const { searchFilesOnMacos, scanDirectoryForSearch } = await import(
    '../electron-client/out-test/src/main/platform/macos/file-indexer.js'
  )
  const { NavigationService } = await import(
    '../electron-client/out-test/src/main/services/navigation-service.js'
  )
  const { ScriptCommandsService } = await import(
    '../electron-client/out-test/src/main/services/script-commands-service.js'
  )
  const { DictionaryService } = await import(
    '../electron-client/out-test/src/main/services/dictionary-service.js'
  )

  // 1. file-indexer: searchFilesOnMacos & scanDirectoryForSearch (including non-existent dir fallback)
  // limit 取 1：预设记录已填满结果，不会再去查本机 Spotlight，结果不受本机文件影响
  const fallbackSearch = await searchFilesOnMacos('ZTools', 1, [
    {
      name: 'ZTools-Mac.dmg',
      path: '/Users/mac/Downloads/ZTools-Mac.dmg',
      is_dir: false,
      size: 1024,
      mtime: Date.now(),
      acronym: 'ztm',
      pinyin: 'ztools-mac.dmg'
    }
  ])
  assert.equal(fallbackSearch.files.length, 1)
  assert.equal(fallbackSearch.files[0].name, 'ZTools-Mac.dmg')

  const badDirScan = await scanDirectoryForSearch('/non-existent-macos-directory-xyz-999', 20, [])
  assert.equal(badDirScan.files.length, 0)
  assert.equal(badDirScan.subdirs.length, 0)

  // 2. NavigationService: searchMenuItems & clickMenuItem
  // 注入 darwin 平台与假执行器：验证会以正确参数调用 osascript，但绝不真实点击本机前台应用的菜单
  const navExecCalls = []
  let navExecFail = null
  const navService = new NavigationService({
    platform: 'darwin',
    execFile: async (file, args) => {
      navExecCalls.push({ file, args: [...args] })
      if (navExecFail) throw navExecFail
      return { stdout: 'ok' }
    }
  })
  navService.setMockMenuItems([
    {
      id: 'menu-xcode-build',
      title: 'Build',
      label: 'Build',
      appName: 'Xcode',
      path: ['Product', 'Build'],
      shortcut: '⌘B',
      enabled: true
    }
  ])
  const menuHits = await navService.searchMenuItems('build')
  assert.equal(menuHits.length, 1)
  assert.equal(menuHits[0].appName, 'Xcode')
  // 菜单路径不足两级（缺少菜单项名称）必须拒绝，各平台一致
  const badClick = await navService.clickMenuItem({ path: ['Product'] })
  assert.equal(badClick.success, false)
  assert.match(badClick.error, /无效的菜单路径/)
  assert.equal(navExecCalls.length, 0, '路径不合法时不应执行任何命令')
  // 按 id 找到预设菜单项，解析出「顶级菜单 > 菜单项」并交给 osascript（假执行器）
  const clickMenuRes = await navService.clickMenuItem({ id: 'menu-xcode-build' })
  assert.equal(clickMenuRes.success, true)
  assert.equal(clickMenuRes.clicked, 'Product > Build')
  assert.equal(navExecCalls.length, 1)
  assert.equal(navExecCalls[0].file, '/usr/bin/osascript')
  assert.deepEqual(navExecCalls[0].args.slice(-3), ['Xcode', 'Product', 'Build'])
  // 脚本失败（如未授予自动化权限）如实返回失败
  navExecFail = new Error('Not authorized to send Apple events to System Events. (-1743)')
  const deniedClick = await navService.clickMenuItem({ id: 'menu-xcode-build' })
  assert.equal(deniedClick.success, false)
  assert.match(deniedClick.error, /-1743/)
  // 非 macOS 平台没有实现菜单点击，返回 unsupported 而不是假成功
  const winNav = new NavigationService({
    platform: 'win32',
    execFile: async () => {
      throw new Error('不应执行任何命令')
    }
  })
  winNav.setMockMenuItems([{ id: 'menu-xcode-build', title: 'Build', label: 'Build', appName: 'Xcode', path: ['Product', 'Build'], shortcut: '', enabled: true }])
  const winClick = await winNav.clickMenuItem({ id: 'menu-xcode-build' })
  assert.equal(winClick.success, false)
  assert.match(winClick.error, /unsupported/)

  // 3. ScriptCommandsService: scanScripts & commands Map（使用独立临时目录，避免在系统临时根目录下遗留 scripts 目录）
  const scriptDataRoot = tmpTracker.mkdtemp('ztools-macos-scripts-')
  try {
    const scriptSvc = new ScriptCommandsService({ dataRoot: scriptDataRoot })
    await scriptSvc.scanScripts()
    assert.ok(scriptSvc.commands instanceof Map)
  } finally {
    tmpTracker.remove(scriptDataRoot)
  }

  // 4. DictionaryService: speakWord rejects empty input
  const dictSvc = new DictionaryService()
  await assert.rejects(() => dictSvc.speakWord('   '))
})
