import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DownloadsManagerCommand,
  scanDownloadsDirectory,
  filterDownloadEntries,
  cleanRedundantInstallers,
  cleanExpiredDownloads,
  trashDownloadItem,
  copyDownloadFileEntity,
  addCustomDownloadDirectory,
  removeCustomDownloadDirectory,
  clearCustomDownloadDirectories,
  validateCustomDownloadDirPath,
  isDownloadTemporaryOrHiddenFile
} from '../packages/declarative-ui/dist/index.js'

import {
  BuiltinPluginHostService
} from '../electron-client/out/main/services/builtin-plugin-host-service.js'

test('1. [Integration] BuiltinPluginHostService DownloadsManagerPlugin 真实文件系统扫描、临时文件过滤与自定义目录校验', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-dl-host-'))
  try {
    const customNetdiskDir = path.join(tmpRoot, 'QuarkDownload')
    const customImDir = path.join(tmpRoot, 'WeChat_2026-10')
    await fs.mkdir(customNetdiskDir, { recursive: true })
    await fs.mkdir(customImDir, { recursive: true })

    // 写入真实文件与未完成临时文件
    const installerPath = path.join(customNetdiskDir, 'ZTools-Setup-2.1.0.exe')
    const docPath = path.join(customImDir, '2026Q4产品架构评审.pdf')
    const tempCrDownload = path.join(customNetdiskDir, 'incomplete-video.mp4.crdownload')
    const tempThunder = path.join(customNetdiskDir, 'movie.mkv.xltd')
    const desktopIni = path.join(customImDir, 'desktop.ini')

    await fs.writeFile(installerPath, Buffer.alloc(4096, 0x4d))
    await fs.writeFile(docPath, Buffer.alloc(2048, 0x25))
    await fs.writeFile(tempCrDownload, Buffer.alloc(1024, 0x00))
    await fs.writeFile(tempThunder, Buffer.alloc(1024, 0x00))
    await fs.writeFile(desktopIni, '[.ShellClassInfo]')

    const now = Date.now()
    await fs.utimes(installerPath, new Date(now - 60_000), new Date(now - 60_000))
    await fs.utimes(docPath, new Date(now - 10_000), new Date(now - 10_000))

    const hostService = new BuiltinPluginHostService()
    assert.equal(hostService.isSupportedPlugin('downloads-manager'), true)

    // 校验合法自定义目录
    const validRes = await hostService.handlePluginCall('downloads-manager', 'validateCustomDir', {
      dirPath: customNetdiskDir
    })
    assert.equal(validRes.ok, true)
    assert.equal(validRes.path, path.resolve(customNetdiskDir))

    // 扫描汇总（传入两个临时目录作为 customDirs）
    const scanRes = await hostService.handlePluginCall('downloads-manager', 'scanAll', {
      customDirs: [customNetdiskDir, customImDir],
      maxFilesPerSource: 50
    })
    assert.equal(scanRes.ok, true)
    assert.ok(Array.isArray(scanRes.items))

    const scannedFromTmp = scanRes.items.filter(
      (item) => item.dirPath === customNetdiskDir || item.dirPath === customImDir
    )
    assert.equal(scannedFromTmp.length, 2, '应只包含 2 个真实完成文件，自动过滤 .crdownload/.xltd/desktop.ini')
    assert.equal(scannedFromTmp[0].name, '2026Q4产品架构评审.pdf', '应按修改时间降序排列，最新文件排第一')
    assert.equal(scannedFromTmp[0].category, 'document')
    assert.equal(scannedFromTmp[1].name, 'ZTools-Setup-2.1.0.exe')
    assert.equal(scannedFromTmp[1].category, 'installer')
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
})

test('2. [Integration] 插件服务层多渠道聚合（IM / 网盘 / 浏览器）、渠道与类型筛选及声明式 UI 树渲染', async () => {
  clearCustomDownloadDirectories()
  const now = Date.now()
  const mockHost = {
    async plugin_invoke({ action }) {
      if (action === 'discoverSources') {
        return {
          success: true,
          data: {
            ok: true,
            sources: [
              {
                id: 'browser-default',
                label: '浏览器与系统下载',
                channel: 'browser',
                appName: '系统下载',
                path: 'C:\\Users\\Geek\\Downloads'
              },
              {
                id: 'netdisk-baidu',
                label: '百度网盘下载',
                channel: 'netdisk',
                appName: '百度网盘',
                path: 'D:\\BaiduNetdiskDownload'
              },
              {
                id: 'im-wechat-2026-10',
                label: '微信接收 (2026-10)',
                channel: 'im',
                appName: '微信',
                path: 'C:\\Users\\Geek\\Documents\\WeChat Files\\wxid_real\\FileStorage\\File\\2026-10'
              }
            ]
          }
        }
      }
      return { success: true, data: { ok: true } }
    },
    async system_search_files({ query }) {
      if (query === 'dir:C:\\Users\\Geek\\Downloads') {
        return {
          success: true,
          data: {
            files: [
              {
                name: 'NodeJS-v22.11.0-x64.msi',
                path: 'C:\\Users\\Geek\\Downloads\\NodeJS-v22.11.0-x64.msi',
                is_dir: false,
                size: 32 * 1024 * 1024,
                mtime: now - 3600_000
              },
              {
                name: 'unfinished.zip.crdownload',
                path: 'C:\\Users\\Geek\\Downloads\\unfinished.zip.crdownload',
                is_dir: false,
                size: 1024,
                mtime: now
              }
            ]
          }
        }
      }
      if (query === 'dir:D:\\BaiduNetdiskDownload') {
        return {
          success: true,
          data: {
            files: [
              {
                name: 'Ubuntu-24.04-Desktop-amd64.iso',
                path: 'D:\\BaiduNetdiskDownload\\Ubuntu-24.04-Desktop-amd64.iso',
                is_dir: false,
                size: 4800 * 1024 * 1024,
                mtime: now - 40 * 86_400_000
              }
            ]
          }
        }
      }
      if (query.includes('WeChat Files')) {
        return {
          success: true,
          data: {
            files: [
              {
                name: '客户合同终版_盖章.pdf',
                path: 'C:\\Users\\Geek\\Documents\\WeChat Files\\wxid_real\\FileStorage\\File\\2026-10\\客户合同终版_盖章.pdf',
                is_dir: false,
                size: 5 * 1024 * 1024,
                mtime: now - 120_000
              }
            ]
          }
        }
      }
      return { success: true, data: { files: [] } }
    }
  }

  const summary = await scanDownloadsDirectory({}, mockHost)
  assert.equal(summary.totalCount, 3, '应聚合 3 个渠道的有效文件并排除 .crdownload')
  assert.equal(summary.installerCount, 1, '应识别出 1 个 .msi 安装包')
  assert.equal(summary.entries[0].name, '客户合同终版_盖章.pdf', '微信最新接收的合同应排在第一位')
  assert.equal(summary.entries[0].channel, 'im')

  // 按渠道筛选：仅看办公 IM
  const imOnly = filterDownloadEntries(summary.entries, { filterValue: 'im' })
  assert.equal(imOnly.length, 1)
  assert.equal(imOnly[0].appName, '微信')

  // 按渠道筛选：仅看网盘
  const netdiskOnly = filterDownloadEntries(summary.entries, { filterValue: 'netdisk' })
  assert.equal(netdiskOnly.length, 1)
  assert.equal(netdiskOnly[0].appName, '百度网盘')

  // 按文件类型筛选：仅看安装包
  const installersOnly = filterDownloadEntries(summary.entries, { filterValue: 'type:installer' })
  assert.equal(installersOnly.length, 1)
  assert.equal(installersOnly[0].name, 'NodeJS-v22.11.0-x64.msi')

  // 验证声明式组件树遵循布局一红线（无详情侧栏、无 MetricGrid、无 DistributionBar）
  const tree = DownloadsManagerCommand({ launchContext: { featureCode: 'downloads-im' } })
  assert.equal(tree.type, 'List')
  assert.equal(tree.props.isShowingDetail, false)
  assert.equal(tree.props.metricGrid, undefined)
  assert.equal(tree.props.distributionBar, undefined)
  assert.ok(tree.props.searchBarAccessory, '必须包含右上角 List.Dropdown 渠道与类型筛选器')
})

test('3. [Exception] 参数与路径穿越防御：拒绝空路径、相对路径、空字节与 ../ 越权目录', async () => {
  assert.equal(validateCustomDownloadDirPath('').ok, false)
  assert.equal(validateCustomDownloadDirPath('   ').ok, false)
  assert.equal(validateCustomDownloadDirPath('./relative/downloads').ok, false)
  assert.equal(validateCustomDownloadDirPath('C:\\Users\\Geek\\Downloads\\..\\..\\Windows\\System32').ok, false)
  assert.equal(validateCustomDownloadDirPath('/Users/geek/Downloads/../../../etc').ok, false)
  assert.equal(validateCustomDownloadDirPath('C:\\Downloads\0evil').ok, false)

  const addTraversalRes = await addCustomDownloadDirectory('C:\\Downloads\\..\\Windows')
  assert.equal(addTraversalRes.ok, false)
  assert.match(String(addTraversalRes.error), /PATH_TRAVERSAL_REJECTED/)

  const hostService = new BuiltinPluginHostService()
  const hostTraversalRes = await hostService.handlePluginCall('downloads-manager', 'validateCustomDir', {
    dirPath: 'C:\\Users\\..\\Windows\\System32'
  })
  assert.equal(hostTraversalRes.ok, false)
  assert.match(String(hostTraversalRes.error), /PATH_TRAVERSAL_REJECTED/)
})

test('4. [Exception] 单渠道目录无权限 (EACCES) 或不存在 (ENOENT) 时优雅隔离，不阻断其他正常渠道', async () => {
  const now = Date.now()
  const partiallyFailingHost = {
    async plugin_invoke({ action }) {
      if (action === 'discoverSources') {
        return {
          success: true,
          data: {
            ok: true,
            sources: [
              {
                id: 'locked-im',
                label: '受限企业微信目录',
                channel: 'im',
                appName: '企业微信',
                path: 'C:\\Restricted\\WXWork'
              },
              {
                id: 'healthy-browser',
                label: '浏览器与系统下载',
                channel: 'browser',
                appName: '系统下载',
                path: 'C:\\Users\\Geek\\Downloads'
              }
            ]
          }
        }
      }
      return { success: true, data: { ok: true } }
    },
    async system_search_files({ query }) {
      if (query.includes('Restricted')) {
        throw new Error('EACCES: permission denied, scandir C:\\Restricted\\WXWork')
      }
      return {
        success: true,
        data: {
          files: [
            {
              name: 'healthy-report.xlsx',
              path: 'C:\\Users\\Geek\\Downloads\\healthy-report.xlsx',
              is_dir: false,
              size: 102400,
              mtime: now
            }
          ]
        }
      }
    }
  }

  const summary = await scanDownloadsDirectory({}, partiallyFailingHost)
  assert.equal(summary.totalCount, 1, '单个受限目录报错不得导致全盘扫描崩溃')
  assert.equal(summary.entries[0].name, 'healthy-report.xlsx')
})

test('5. [Exception] 回收站删除失败 (EBUSY 文件占用) 与剪贴板失败时保持状态回滚不误删列表项', async () => {
  const sampleEntries = [
    {
      id: 'dl-locked-installer',
      name: 'running-installer.exe',
      path: 'C:\\Users\\Geek\\Downloads\\running-installer.exe',
      dirPath: 'C:\\Users\\Geek\\Downloads',
      ext: '.exe',
      category: 'installer',
      sizeBytes: 50 * 1024 * 1024,
      sizeFormatted: '50.0 MB',
      modifiedAt: '2026-10-24 18:00',
      mtimeMs: Date.now(),
      ageDays: 45,
      isPinned: false,
      channel: 'browser',
      sourceId: 'browser-default',
      sourceLabel: '浏览器与系统下载',
      appName: '系统下载'
    }
  ]

  const failingTrashHost = {
    async shell_trash_item() {
      return {
        success: false,
        error: { code: 'EBUSY', message: 'EBUSY: resource busy or locked' }
      }
    },
    async clipboard_copy_file() {
      return {
        success: false,
        error: { code: 'ENOENT', message: 'ENOENT: target file missing' }
      }
    }
  }

  // 单条移入回收站失败：不能从列表中移除
  const singleRes = await trashDownloadItem(sampleEntries, 'dl-locked-installer', failingTrashHost)
  assert.equal(singleRes.ok, false)
  assert.match(String(singleRes.error), /EBUSY/)
  assert.equal(singleRes.remainingEntries.length, 1, '删除失败时必须保留原条目，严禁假成功移除')

  // 批量清理安装包失败：cleanedCount 必须为 0 且保留原条目
  const batchRes = await cleanRedundantInstallers(sampleEntries, failingTrashHost)
  assert.equal(batchRes.cleanedCount, 0)
  assert.equal(batchRes.freedBytes, 0)
  assert.equal(batchRes.remainingEntries.length, 1)

  // 复制文件实体失败：返回明确错误
  const copyRes = await copyDownloadFileEntity('C:\\Users\\Geek\\Downloads\\missing.pdf', failingTrashHost)
  assert.equal(copyRes.ok, false)
  assert.match(String(copyRes.error), /ENOENT/)

  // 临时文件识别校验
  assert.equal(isDownloadTemporaryOrHiddenFile('video.mp4.crdownload'), true)
  assert.equal(isDownloadTemporaryOrHiddenFile('archive.7z.baiduyun.p.downloading'), true)
  assert.equal(isDownloadTemporaryOrHiddenFile('setup.exe.xltd'), true)
  assert.equal(isDownloadTemporaryOrHiddenFile('normal-file.pdf'), false)
})
