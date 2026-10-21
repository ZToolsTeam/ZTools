/**
 * 35 款本地原生声明式插件全集 —— 三大标准布局范式、零彩色 Emoji 规范与 Beyond Happy Path 集成测试套件
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderDeclarativeRoot,
  ProcessMonitorCommand,
  FlowGuardCommand,
  ClipboardHistoryCommand,
  HardwareInfoCommand,
  NetworkAdapterCommand,
  NetworkRescueCommand,
  ContextMenuCommand,
  WindowManagementCommand,
  WechatMultiCommand,
  SystemCommand,
  LanShareCommand,
  DiskAnalyzerCommand,
  CleanerCommand,
  WechatCleanerCommand,
  QQCleanerCommand,
  SoftwareManagerCommand,
  BoostCommand,
  MoverCommand,
  DataRecoveryCommand,
  ShredderCommand,
  SystemBackupCommand,
  MultiDownloadCommand,
  VideoDownloaderCommand,
  SqlitePluginCommand,
  BatchRenameCommand,
  BatchVideoCommand,
  BatchAudioCommand,
  PdfCommand,
  AiImageCommand,
  AiVideoCommand,
  OcrCommand,
  RecordCommand,
  ScreenshotsCommand,
  ColorPickerCommand,
  fetchNetworkAdapters,
  filterNetworkAdapters,
  runNetworkRescueDiagnostics,
  executeNetworkRepair,
  batchExecuteNetworkRepairs,
  fetchContextMenuEntries,
  fetchWechatInstances,
  fetchLanShareSnapshot,
  generateQrCodeSvgDataUri,
  fetchMoverSnapshot,
  executeDirectoryMove,
  fetchRecoverableFiles,
  restoreSelectedFiles,
  fetchShredCandidates,
  executeSecureShred,
  fetchSystemBackupSnapshot,
  createBackupArchive,
  fetchSqliteWorkspace,
  executeSqliteQuery,
  fetchAiImageWorkspace,
  runAiImageBatch,
  fetchAiVideoWorkspace,
  runAiVideoBatch,
  fetchOcrWorkspace,
  executeBatchOcr,
  fetchRecordWorkspace
} from '../dist/index.js';

const COLORFUL_EMOJI_RE = /[\u{1F300}-\u{1FAFF}]/u

test.describe('35 款本地原生插件全集 —— 三大标准布局范式与 Beyond Happy Path 集成验收套件', () => {
  test('1. 【布局一：Search & Preview List】全部 11 款插件符合单栏宽列表 / 右侧真实内容预览规范且零彩色 Emoji', async () => {
    const layout1Specs = [
      { id: '01-process-monitor', fn: ProcessMonitorCommand, expectDetail: false },
      { id: '02-flow-guard', fn: FlowGuardCommand, expectDetail: false },
      { id: '03-clipboard-manager', fn: ClipboardHistoryCommand, expectDetail: true },
      { id: '04-hardware-info', fn: HardwareInfoCommand, expectDetail: true },
      { id: '05-network-adapter', fn: NetworkAdapterCommand, expectDetail: false },
      { id: '06-network-rescue', fn: NetworkRescueCommand, expectDetail: false },
      { id: '07-context-menu', fn: ContextMenuCommand, expectDetail: false },
      { id: '08-window-manager', fn: WindowManagementCommand, expectDetail: false },
      { id: '09-wechat-multi', fn: WechatMultiCommand, expectDetail: false },
      { id: '10-system-tools', fn: SystemCommand, expectDetail: false },
      { id: '11-lan-share', fn: LanShareCommand, expectDetail: true }
    ]

    for (const spec of layout1Specs) {
      const root = renderDeclarativeRoot(spec.fn)
      const rendered = root.getLatest()
      const fb = rendered.props?.filterBar?.props || rendered.props?.filterBar

      assert.equal(rendered.type, 'List', `${spec.id} 根节点应为 List`)
      assert.equal(
        Boolean(rendered.props?.isShowingDetail),
        spec.expectDetail,
        `${spec.id} isShowingDetail 应为 ${spec.expectDetail}`
      )
      assert.ok(rendered.props?.searchBarAccessory, `${spec.id} 应挂载 searchBarAccessory (List.Dropdown)`)
      assert.ok(
        fb?.summaryText && fb.summaryText.length > 0,
        `${spec.id} 应提供单行 filterBar.summaryText`
      )
      assert.equal(
        COLORFUL_EMOJI_RE.test(fb.summaryText),
        false,
        `${spec.id} summaryText 严禁包含彩色 Emoji`
      )
    }
  })

  test('2. 【布局二：Master-SubList Cleaner】全部 14 款插件符合左 32% 导航树 + 右 68% 可勾选 subList 规范', async () => {
    const layout2Specs = [
      { id: '12-disk-analyzer', fn: DiskAnalyzerCommand },
      { id: '13-cleaner', fn: CleanerCommand },
      { id: '14-wechat-cleaner', fn: WechatCleanerCommand },
      { id: '15-qq-cleaner', fn: QQCleanerCommand },
      { id: '16-software-manager', fn: SoftwareManagerCommand },
      { id: '17-boost', fn: BoostCommand },
      { id: '18-mover', fn: MoverCommand },
      { id: '19-data-recovery', fn: DataRecoveryCommand },
      { id: '20-shredder', fn: ShredderCommand },
      { id: '21-system-backup', fn: SystemBackupCommand },
      { id: '22-multi-download', fn: MultiDownloadCommand },
      { id: '23-video-downloader', fn: VideoDownloaderCommand },
      { id: '24-sqlite-plugin', fn: SqlitePluginCommand },
      { id: '25-batch-rename', fn: BatchRenameCommand }
    ]

    for (const spec of layout2Specs) {
      const root = renderDeclarativeRoot(spec.fn)
      const rendered = root.getLatest()
      const fb = rendered.props?.filterBar?.props || rendered.props?.filterBar
      const subList = rendered.props?.subList?.props || rendered.props?.subList

      assert.equal(rendered.type, 'List', `${spec.id} 根节点应为 List`)
      assert.ok(subList, `${spec.id} 必须包含右栏 subList 描述符`)
      assert.ok(Array.isArray(subList.items), `${spec.id} subList.items 必须为数组`)
      assert.ok(subList.items.length > 0, `${spec.id} subList.items 首屏应有明细数据`)
      assert.ok(
        fb?.summaryText && fb.summaryText.length > 0,
        `${spec.id} 必须包含单行 filterBar.summaryText`
      )
      assert.equal(
        COLORFUL_EMOJI_RE.test(fb.summaryText),
        false,
        `${spec.id} summaryText 严禁包含彩色 Emoji`
      )
    }
  })

  test('3. 【布局三：Parameter & Queue Workbench】全部 9 款插件符合左 34% workbenchPanel + 右 66% subList 规范', async () => {
    const layout3Specs = [
      { id: '26-batch-video', fn: BatchVideoCommand },
      { id: '27-batch-audio', fn: BatchAudioCommand },
      { id: '28-pdf', fn: PdfCommand },
      { id: '29-ai-image', fn: AiImageCommand },
      { id: '30-ai-video', fn: AiVideoCommand },
      { id: '31-ocr', fn: OcrCommand },
      { id: '32-record', fn: RecordCommand },
      { id: '33-screenshot', fn: ScreenshotsCommand },
      { id: '34-screen-color-picker', fn: ColorPickerCommand }
      // 文本对比（file-compare）已由客户端内置插件提供，这里不再保留重复实现
    ]

    for (const spec of layout3Specs) {
      const root = renderDeclarativeRoot(spec.fn)
      const rendered = root.getLatest()
      const fb = rendered.props?.filterBar?.props || rendered.props?.filterBar
      const wb = rendered.props?.workbenchPanel?.props || rendered.props?.workbenchPanel
      const subList = rendered.props?.subList?.props || rendered.props?.subList

      assert.equal(rendered.type, 'List', `${spec.id} 根节点应为 List`)
      assert.ok(wb, `${spec.id} 必须包含左栏 workbenchPanel 描述符`)
      assert.ok(
        Array.isArray(wb.fields) && wb.fields.length >= 4,
        `${spec.id} workbenchPanel.fields 应包含至少 4 个参数配置项`
      )
      assert.ok(wb.previewCard, `${spec.id} workbenchPanel 应包含 previewCard 预估摘要卡`)
      assert.ok(subList, `${spec.id} 必须包含右栏 subList 任务队列描述符`)
      assert.ok(
        Array.isArray(subList.items) && subList.items.length > 0,
        `${spec.id} subList.items 应包含待处理任务项`
      )
      assert.equal(
        COLORFUL_EMOJI_RE.test(fb?.summaryText || ''),
        false,
        `${spec.id} summaryText 严禁包含彩色 Emoji`
      )
    }
  })

  test('4. [Beyond Happy Path] 15 款新增插件底层逻辑与异常/安全边界校验', async () => {
    // 4.1 NetworkAdapter & NetworkRescue
    const netSnap = await fetchNetworkAdapters()
    assert.ok(netSnap.adapters.length > 0)
    assert.equal(filterNetworkAdapters(netSnap.adapters, 'non-existent-xyz-999', 'all').length, 0)

    const rescueSnap = await runNetworkRescueDiagnostics()
    assert.ok(rescueSnap.items.length >= 6)
    const unknownRepair = await executeNetworkRepair('non-existent-repair-id')
    assert.equal(unknownRepair.ok, false)
    const unknownBatch = await batchExecuteNetworkRepairs(['non-existent-repair-id'])
    assert.equal(unknownBatch.repairedCount, 0)

    // 4.2 ContextMenu & WechatMulti & LanShare
    const ctxSnap = await fetchContextMenuEntries()
    assert.ok(ctxSnap.entries.length > 0)
    const wxSnap = await fetchWechatInstances()
    assert.ok(wxSnap.items.length > 0)
    const lanSnap = await fetchLanShareSnapshot()
    assert.ok(lanSnap.items.length > 0)
    const svgUri = generateQrCodeSvgDataUri('http://192.168.1.100:18580/share/test')
    assert.ok(svgUri.startsWith('data:image/svg+xml;utf8,'))

    // 4.3 Mover: 拦截 C:\Windows 系统目录搬迁 & 空目录列表拦截
    const moverSnap = await fetchMoverSnapshot()
    assert.ok(moverSnap.folders.length > 0)
    const protectedMove = await executeDirectoryMove(
      [{ id: 'sys', name: 'System32', sourcePath: 'C:\\Windows\\System32', sizeBytes: 1024, isSystemLocked: true }],
      'D:\\ZToolsMoved'
    )
    assert.equal(protectedMove.ok, false, '系统核心目录必须拒绝搬迁')
    const emptyMove = await executeDirectoryMove([], 'D:\\ZToolsMoved')
    assert.equal(emptyMove.ok, false, '空列表搬迁应返回失败提示')

    // 4.4 Shredder: 拦截系统核心文件粉碎
    const shredSnap = await fetchShredCandidates()
    assert.ok(shredSnap.candidates.length > 0)
    const protectedShred = await executeSecureShred(
      [{ id: 'ntos', name: 'ntoskrnl.exe', path: 'C:\\Windows\\System32\\ntoskrnl.exe', sizeBytes: 1024, isSystemLocked: true }],
      'dod_3pass'
    )
    assert.equal(protectedShred.ok, false, '系统内核文件必须拒绝粉碎')

    // 4.5 DataRecovery & SystemBackup & SqlitePlugin
    const recSnap = await fetchRecoverableFiles()
    assert.ok(recSnap.items.length > 0)
    const emptyRestore = await restoreSelectedFiles([], 'C:\\Users\\Default\\Desktop\\ZToolsRecovered')
    assert.equal(emptyRestore.restoredCount, 0)

    const backupSnap = await fetchSystemBackupSnapshot()
    assert.ok(backupSnap.items.length > 0)
    const emptyBackup = await createBackupArchive([], 'full_bundle', 'C:\\Users\\Default\\Documents\\ZToolsBackups')
    assert.equal(emptyBackup.ok, false)

    const sqliteWs = await fetchSqliteWorkspace()
    assert.ok(sqliteWs.tables.length > 0)
    const unsafeSql = await executeSqliteQuery('main.db', 'DROP DATABASE main;')
    assert.equal(unsafeSql.ok, false, '破坏性 DROP DATABASE SQL 必须被安全沙箱拦截')

    // 4.6 AI Image / AI Video / OCR / Record / File Compare 空队列与正常队列边界
    const aiImgWs = await fetchAiImageWorkspace()
    assert.ok(aiImgWs.files.length > 0)
    const emptyAiImg = await runAiImageBatch([], 'realesrgan_x4', '2x', 'png')
    assert.equal(emptyAiImg.processedCount, 0)

    const aiVidWs = await fetchAiVideoWorkspace()
    assert.ok(aiVidWs.files.length > 0)
    const emptyAiVid = await runAiVideoBatch([], 'rife_v46', '60fps', '4k_2160p')
    assert.equal(emptyAiVid.processedCount, 0)

    const ocrWs = await fetchOcrWorkspace()
    assert.ok(ocrWs.items.length > 0)
    const emptyOcr = await executeBatchOcr([], { languageModelId: 'zh_en_mix', layoutStrategy: 'natural_paragraph', postAction: 'copy_clipboard', filterStampNoise: true })
    assert.equal(emptyOcr.recognizedCount, 0)
    assert.equal(emptyOcr.ok, false)

    const recWs = await fetchRecordWorkspace()
    assert.ok(recWs.recordings.length > 0)

  })
})
