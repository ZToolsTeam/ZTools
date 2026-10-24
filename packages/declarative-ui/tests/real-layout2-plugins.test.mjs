import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as multiDownload from '../dist/examples/multi-download/logic.js'
import * as videoDownloader from '../dist/examples/video-downloader/logic.js'
import * as mover from '../dist/examples/mover/logic.js'
import * as dataRecovery from '../dist/examples/data-recovery/logic.js'
import * as shredder from '../dist/examples/shredder/logic.js'
import * as systemBackup from '../dist/examples/system-backup/logic.js'
import * as sqlitePlugin from '../dist/examples/sqlite-plugin/logic.js'
import * as wechatCleaner from '../dist/examples/wechat-cleaner/logic.js'
import * as qqCleaner from '../dist/examples/qq-cleaner/logic.js'
import * as boost from '../dist/examples/boost/logic.js'
import * as softwareManager from '../dist/examples/software-manager/logic.js'
import * as diskAnalyzer from '../dist/examples/disk-analyzer/logic.js'
import * as cleaner from '../dist/examples/cleaner/logic.js'
import * as batchRename from '../dist/examples/batch-rename/logic.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 构造真实宿主传输桩：兼容 callHostTransport 的 hostOverride[method] 与 hostOverride.transport.call
 */
function createRealHostStub(handlers = {}) {
  const calls = []
  const dispatch = async (method, params) => {
    calls.push({ channel: method, payload: params })
    if (typeof handlers[method] === 'function') {
      return await handlers[method](params)
    }
    if (method in handlers) {
      return handlers[method]
    }
    throw new Error(`CHANNEL_NOT_IMPLEMENTED: ${method}`)
  }

  const stub = {
    __isRealHost: true,
    calls,
    transport: {
      call: dispatch
    }
  }

  for (const key of Object.keys(handlers)) {
    stub[key] = (params) => dispatch(key, params)
  }

  return stub
}

test('P12 multi-download: 真实宿主传输层下载、磁盘空间探测、目录 {files} 兼容与异常边界验证', async () => {
  const host = createRealHostStub({
    system_get_path: () => 'C:\\Users\\RealUser\\Downloads',
    system_search_files: () => ({
      files: [
        {
          name: 'ubuntu-24.04.iso',
          path: 'C:\\Users\\RealUser\\Downloads\\ubuntu-24.04.iso',
          is_dir: false,
          size: 4096000,
          mtime: 1710000000
        }
      ],
      total_matches: 1,
      total_bytes: 4096000
    }),
    system_get_disk_usage: () => ({
      total: 500 * 1024 ** 3,
      used: 377 * 1024 ** 3,
      available: 123 * 1024 ** 3,
      percent: 75
    }),
    network_http_download: (payload) => ({
      destPath: payload.destPath,
      bytesDownloaded: 4096000
    }),
    shell_trash_item: () => ({ ok: true })
  })

  const snap = await multiDownload.fetchMultiDownloadSnapshot(host)
  assert.equal(snap.downloadDir, 'C:\\Users\\RealUser\\Downloads')
  assert.equal(snap.driveFreeBytes, 123 * 1024 ** 3)
  assert.equal(snap.files.length, 1)
  assert.equal(snap.files[0].name, 'ubuntu-24.04.iso')

  // 真实 HTTP 下载成功链路
  const dlOk = await multiDownload.startMultiThreadDownloadTask(
    'https://releases.ubuntu.com/24.04/ubuntu-24.04.iso',
    snap.downloadDir,
    multiDownload.THREAD_SPLIT_PRESETS[0],
    host
  )
  assert.equal(dlOk.ok, true)
  assert.ok(host.calls.some(c => c.channel === 'network_http_download'))

  // 真实回收站清理与释放体积计算
  const trashRes = await multiDownload.deleteDownloadedFiles(
    ['C:\\Users\\RealUser\\Downloads\\ubuntu-24.04.iso'],
    snap.files,
    host
  )
  assert.equal(trashRes.deletedCount, 1)
  assert.equal(trashRes.freedBytes, 4096000)

  // 异常边界：非法 URL 与下载失败严禁伪装成功
  const badUrlRes = await multiDownload.startMultiThreadDownloadTask(
    'invalid-protocol://bad',
    snap.downloadDir,
    multiDownload.THREAD_SPLIT_PRESETS[0],
    host
  )
  assert.equal(badUrlRes.ok, false)

  const failHost = createRealHostStub({
    network_http_download: () => {
      throw new Error('HTTP 502 Bad Gateway')
    }
  })
  const dlFail = await multiDownload.startMultiThreadDownloadTask(
    'https://example.com/file.zip',
    'C:\\Users\\RealUser\\Downloads',
    multiDownload.THREAD_SPLIT_PRESETS[0],
    failHost
  )
  assert.equal(dlFail.ok, false)
  assert.match(dlFail.error || dlFail.message, /502|失败/)
})

test('P13 video-downloader: 真实磁盘空间、直链下载、无 yt-dlp 时如实复制命令及异常边界验证', async () => {
  let clipboardContent = ''
  const host = createRealHostStub({
    system_get_path: () => 'C:\\Users\\RealUser\\Videos',
    system_search_files: () => ({
      files: [
        {
          name: 'demo.mp4',
          path: 'C:\\Users\\RealUser\\Videos\\demo.mp4',
          is_dir: false,
          size: 8192000,
          mtime: 1710000000
        }
      ],
      total_matches: 1,
      total_bytes: 8192000
    }),
    system_get_disk_usage: () => ({
      total: 500 * 1024 ** 3,
      used: 412 * 1024 ** 3,
      available: 88 * 1024 ** 3,
      percent: 82
    }),
    clipboard_copy_text: (payload) => {
      clipboardContent = payload.text
      return { ok: true }
    },
    shell_trash_item: () => ({ ok: true })
  })

  const snap = await videoDownloader.fetchVideoDownloaderSnapshot(host)
  assert.equal(snap.driveFreeBytes, 88 * 1024 ** 3)
  assert.ok(snap.videos.length >= 1)
  assert.equal(snap.videos[0].name, 'demo.mp4')

  // 无 yt-dlp 插件时如实告知复制命令到剪贴板，不谎称已启动后台下载
  const res = await videoDownloader.parseAndDownloadStreamVideo(
    'https://www.bilibili.com/video/BV1xx411c7mD',
    snap.saveDir,
    videoDownloader.VIDEO_QUALITY_PRESETS[0],
    host
  )
  assert.equal(res.ok, true)
  assert.match(res.message, /已生成并复制 yt-dlp 命令到剪贴板/)
  assert.match(clipboardContent, /yt-dlp/)

  // 直链下载失败时在真实宿主下必须返回 ok: false
  const failHost = createRealHostStub({
    network_http_download: () => {
      throw new Error('Connection reset by peer')
    }
  })
  const directFail = await videoDownloader.parseAndDownloadStreamVideo(
    'https://cdn.example.com/media/sample.mp4',
    'C:\\Users\\RealUser\\Videos',
    videoDownloader.VIDEO_QUALITY_PRESETS[0],
    failHost
  )
  assert.equal(directFail.ok, false)

  // 真实删除视频统计 freedBytes
  const delRes = await videoDownloader.trashLocalVideoFiles(
    ['C:\\Users\\RealUser\\Videos\\demo.mp4'],
    snap.videos,
    host
  )
  assert.equal(delRes.deletedCount, 1)
  assert.equal(delRes.freedBytes, 8192000)
})

test('P14 mover: 消除 7.5GB 虚增体积、真实扫描目录与迁移失败如实报错验证', async () => {
  const host = createRealHostStub({
    system_get_path: (p) => `C:\\Users\\RealUser\\${p.name}`,
    system_get_disk_usage: (p) => {
      if (String(p.drive).startsWith('C:')) {
        return { total: 256 * 1024 ** 3, used: 216 * 1024 ** 3, available: 40 * 1024 ** 3, percent: 84 }
      }
      if (String(p.drive).startsWith('D:')) {
        return { total: 1024 * 1024 ** 3, used: 424 * 1024 ** 3, available: 600 * 1024 ** 3, percent: 41 }
      }
      return { total: 0, used: 0, available: 0, percent: 0 }
    },
    system_search_files: (payload) => {
      if (String(payload.query).includes('downloads')) {
        return {
          files: [
            {
              name: 'archive.zip',
              path: 'C:\\Users\\RealUser\\downloads\\archive.zip',
              is_dir: false,
              size: 10485760,
              mtime: 1710000000
            }
          ],
          total_matches: 1,
          total_bytes: 10485760
        }
      }
      return { files: [], total_matches: 0, total_bytes: 0 }
    }
  })

  const snap = await mover.fetchMoverSnapshot(host)
  const dlFolder = snap.folders.find(f => f.sourcePath.toLowerCase().includes('downloads'))
  assert.ok(dlFolder)
  // 真实体积必须严格等于扫描出的 10MB，绝不叠加 7.5GB 静态假体积
  assert.equal(dlFolder.sizeBytes, 10485760)
  // 空目录在真实宿主下不应混入可迁移列表
  const nonLocked = snap.folders.filter(f => !f.isSystemLocked)
  assert.equal(nonLocked.length, 1)

  // 异常边界：系统锁定目录拦截与真实宿主未挂载迁移服务时返回 ok: false
  const lockedFolder = snap.folders.find(f => f.isSystemLocked)
  const lockedRes = await mover.executeDirectoryMove([lockedFolder], 'D:', host)
  assert.equal(lockedRes.ok, false)

  const moveFailRes = await mover.executeDirectoryMove([dlFolder], 'D:', host)
  assert.equal(moveFailRes.ok, false)
})

test('P15 data-recovery: 真实宿主下彻底移除 5 个虚构恢复文件并校验恢复结果', async () => {
  const host = createRealHostStub({
    system_get_path: () => 'C:\\Users\\RealUser\\AppData\\Local\\Temp',
    system_search_files: () => ({
      files: [
        {
          name: 'real_temp_doc.docx',
          path: 'C:\\Users\\RealUser\\AppData\\Local\\Temp\\real_temp_doc.docx',
          is_dir: false,
          size: 51200,
          mtime: Math.floor(Date.now() / 1000)
        }
      ],
      total_matches: 1,
      total_bytes: 51200
    })
  })

  const snap = await dataRecovery.fetchRecoverableFiles('all', host)
  assert.equal(snap.items.length, 1)
  assert.equal(snap.items[0].name, 'real_temp_doc.docx')
  // 严禁出现虚构的财务预测模型假文件
  assert.equal(snap.items.some(f => f.name.includes('季度财务预测模型')), false)

  // 异常边界：当底层恢复与复制均失败时，严禁返回伪成功
  const restoreFail = await dataRecovery.restoreSelectedFiles(snap.items, 'D:\\Recovered', host)
  assert.equal(restoreFail.ok, false)
  assert.equal(restoreFail.restoredCount, 0)
})

test('P16 shredder: 真实宿主下移除虚构机密文件并在粉碎失败时返回真实错误', async () => {
  const host = createRealHostStub({
    system_get_path: () => 'C:\\Users\\RealUser\\AppData\\Local\\Temp',
    system_search_files: (payload) => {
      if (String(payload.query).includes('Temp')) {
        return {
          files: [
            {
              name: 'real_trace.log',
              path: 'C:\\Users\\RealUser\\AppData\\Local\\Temp\\real_trace.log',
              is_dir: false,
              size: 2048,
              mtime: Math.floor(Date.now() / 1000)
            }
          ],
          total_matches: 1,
          total_bytes: 2048
        }
      }
      return { files: [], total_matches: 0, total_bytes: 0 }
    }
  })

  const snap = await shredder.fetchShredCandidates(host)
  assert.equal(snap.candidates.some(f => f.name === 'decrypted_token_session_dump.tmp'), false)
  assert.equal(snap.candidates.some(f => f.name === 'real_trace.log'), true)

  // 异常边界：系统核心目录拦截与底层擦除失败时返回 ok: false
  const sysRes = await shredder.executeSecureShred(
    [
      {
        id: 'sys_locked',
        name: 'ntoskrnl.exe',
        path: 'C:\\Windows\\System32\\ntoskrnl.exe',
        category: 'system_locked',
        categoryName: '系统保护锁定',
        sizeBytes: 1024,
        isSystemLocked: true
      }
    ],
    'dod_3pass',
    host
  )
  assert.equal(sysRes.ok, false)

  const realTarget = snap.candidates.find(f => f.name === 'real_trace.log')
  const failShred = await shredder.executeSecureShred([realTarget], 'dod_3pass', host)
  assert.equal(failShred.ok, false)
  assert.equal(failShred.shreddedCount, 0)
})

test('P17 system-backup: 真实探测备份文件与归档创建/还原失败拦截验证', async () => {
  const host = createRealHostStub({
    system_get_path: (p) => `C:\\Users\\RealUser\\${p.name}`,
    filesystem_get_file_size: () => 16384,
    system_search_files: () => ({
      files: [
        {
          name: 'ZTools_Backup_Real.zip',
          path: 'C:\\Users\\RealUser\\documents\\ZToolsBackups\\ZTools_Backup_Real.zip',
          is_dir: false,
          size: 65536,
          mtime: Math.floor(Date.now() / 1000)
        }
      ],
      total_matches: 1,
      total_bytes: 65536
    })
  })

  const snap = await systemBackup.fetchSystemBackupSnapshot(host)
  assert.equal(snap.items.some(i => i.name === 'ZTools_SystemBackup_20261018_Full.zip'), false)
  assert.equal(snap.items.some(i => i.name === 'ZTools_Backup_Real.zip'), true)

  // 异常边界：未挂载备份服务时创建归档与还原必须返回 ok: false，绝不返回写死 19.6MB 假成功
  const createFail = await systemBackup.createBackupArchive(
    snap.items.filter(i => i.category !== 'snapshot_archives'),
    'full',
    'C:\\Users\\RealUser\\documents\\ZToolsBackups',
    host
  )
  assert.equal(createFail.ok, false)
  assert.equal(createFail.sizeBytes || 0, 0)

  const archiveItem = snap.items.find(i => i.name === 'ZTools_Backup_Real.zip')
  const restoreFail = await systemBackup.restoreBackupSnapshot(archiveItem, host)
  assert.equal(restoreFail.ok, false)
})

test('P18 sqlite-plugin: 真实宿主下连接与执行 SQL 校验及危险 SQL 拦截验证', async () => {
  const host = createRealHostStub({
    system_get_path: () => 'C:\\Users\\RealUser\\AppData\\Roaming',
    system_search_files: () => ({ files: [], total_matches: 0, total_bytes: 0 })
  })

  // 未挂载 sqlite 原生服务时在真实宿主下返回空表结构而非假表
  const ws = await sqlitePlugin.fetchSqliteWorkspace(undefined, host)
  assert.equal(ws.tables.length, 0)

  // 危险 SQL 拦截
  const dropRes = await sqlitePlugin.executeSqliteQuery('C:\\test.db', 'DROP TABLE kv_storage;', host)
  assert.equal(dropRes.ok, false)

  // 未挂载 sqlite.execute 时真实宿主下返回 ok: false，绝不伪造 SELECT 结果行
  const selectFail = await sqlitePlugin.executeSqliteQuery('C:\\test.db', 'SELECT * FROM kv_storage LIMIT 5;', host)
  assert.equal(selectFail.ok, false)
  assert.equal(selectFail.rows.length, 0)

  // 挂载 sqlite.execute (dllplugin_call) 时返回真实行数据
  const okHost = createRealHostStub({
    dllplugin_call: (payload) => {
      assert.equal(payload.plugin, 'SqlitePlugin')
      assert.equal(payload.func, 'executeQuery')
      return {
        rows: [{ key: 'theme', value: 'dark' }],
        affectedRows: 0,
        message: '查询成功 (1 行)'
      }
    }
  })
  const selectOk = await sqlitePlugin.executeSqliteQuery('C:\\test.db', 'SELECT * FROM kv_storage;', okHost)
  assert.equal(selectOk.ok, true)
  assert.equal(selectOk.rows.length, 1)
  assert.equal(selectOk.rows[0].key, 'theme')
})

test('P19 & P20 wechat-cleaner & qq-cleaner: 彻底消除 D:\\Local\\Roaming\\Tencent 私人硬编码路径与真实传输验证', async () => {
  const wechatSrc = fs.readFileSync(
    path.join(__dirname, '../src/examples/wechat-cleaner/logic.ts'),
    'utf-8'
  )
  const qqSrc = fs.readFileSync(
    path.join(__dirname, '../src/examples/qq-cleaner/logic.ts'),
    'utf-8'
  )
  assert.equal(wechatSrc.includes('D:\\Local\\Roaming\\Tencent'), false)
  assert.equal(wechatSrc.includes('D:\\\\Local\\\\Roaming\\\\Tencent'), false)
  assert.equal(qqSrc.includes('D:\\Local\\Roaming\\Tencent'), false)
  assert.equal(qqSrc.includes('D:\\\\Local\\\\Roaming\\\\Tencent'), false)

  const failHost = createRealHostStub({})
  const wxRes = await wechatCleaner.invokeNativeCapability('ScanWeChatStorage', { mode: 'fast' }, failHost)
  assert.equal(wxRes.ok, false)
  assert.equal(wxRes.data?.simulated, undefined)

  const qqRes = await qqCleaner.invokeNativeCapability('ScanQQStorage', { mode: 'fast' }, failHost)
  assert.equal(qqRes.ok, false)
  assert.equal(qqRes.data?.simulated, undefined)

  // 参数校验与聊天数据库保护异常测试
  await assert.rejects(
    () => wechatCleaner.invokeNativeCapability('', {}, failHost),
    /INVALID_METHOD/
  )
  await assert.rejects(
    () => qqCleaner.invokeNativeCapability('CleanStorage', { path: 'C:\\Tencent Files\\10001\\Msg3.0.db' }, failHost),
    /SECURITY_INTERCEPTED/
  )
})

test('P21 ~ P25 boost, software-manager, disk-analyzer, cleaner, batch-rename: 真实传输层与异常边界验证', async () => {
  const failHost = createRealHostStub({})

  // P21 boost: 真实宿主下 invokeNativeCapability 不返回 simulated: true，terminateBoostProcess 拦截系统进程
  const boostCapFail = await boost.invokeNativeCapability('OptimizeMemory', { level: 1 }, failHost)
  assert.equal(boostCapFail.ok, false)
  assert.equal(boostCapFail.data?.simulated, undefined)

  const sysKill = await boost.terminateBoostProcess(4, 'System', failHost)
  assert.equal(sysKill.ok, false)

  const dllKillHost = createRealHostStub({
    dllplugin_call: (payload) => {
      assert.equal(payload.plugin, 'ProcessMonitorPlugin')
      assert.equal(payload.func, 'TerminateProcessByPID')
      return { success: true }
    }
  })
  const procKillOk = await boost.terminateBoostProcess(8888, 'chrome.exe', dllKillHost)
  assert.equal(procKillOk.ok, true)

  // P22 software-manager: 真实宿主下卸载失败绝不落入 resolveMockData 伪成功
  const swCapFail = await softwareManager.invokeNativeCapability('GetAllSoftware', {}, failHost)
  assert.equal(swCapFail.ok, false)

  const uninstallFail = await softwareManager.uninstallSoftware(
    {
      id: 'app-1',
      name: 'DemoApp',
      publisher: 'Demo',
      version: '1.0',
      installDate: '2026-01-01',
      estimatedSize: 1024,
      installLocation: 'C:\\Program Files\\DemoApp',
      uninstallString: 'C:\\Program Files\\DemoApp\\uninstall.exe',
      category: 'desktop'
    },
    false,
    failHost
  )
  assert.equal(uninstallFail.ok, false)

  // P23 disk-analyzer: 真实宿主下 invokeNativeCapability 走 dllplugin_call，失败返回 ok: false
  const diskCapFail = await diskAnalyzer.invokeNativeCapability('StartScan', { rootPath: 'C:\\' }, failHost)
  assert.equal(diskCapFail.ok, false)
  assert.equal(diskCapFail.data?.simulated, undefined)

  // P24 cleaner: 真实宿主下 invokeNativeCapability 走 dllplugin_call，失败返回 ok: false
  const cleanerCapFail = await cleaner.invokeNativeCapability('ScanSystemJunk', { deep: true }, failHost)
  assert.equal(cleanerCapFail.ok, false)
  assert.equal(cleanerCapFail.data?.simulated, undefined)

  // P25 batch-rename: 真实宿主下 invokeNativeCapability 走 dllplugin_call，失败返回 ok: false
  const renameCapFail = await batchRename.invokeNativeCapability('BatchRenameByRule', { type: 'number' }, failHost)
  assert.equal(renameCapFail.ok, false)
  assert.equal(renameCapFail.data?.simulated, undefined)

  const dllOkHost = createRealHostStub({
    dllplugin_call: (payload) => ({
      executed: true,
      plugin: payload.plugin,
      func: payload.func
    })
  })
  const renameCapOk = await batchRename.invokeNativeCapability('BatchRenameByRule', { type: 'number' }, dllOkHost)
  assert.equal(renameCapOk.ok, true)
  assert.equal(renameCapOk.fromFallback, false)
  assert.equal(renameCapOk.data.plugin, 'BatchRenamePlugin')
})
