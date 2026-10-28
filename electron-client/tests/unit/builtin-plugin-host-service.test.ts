import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { PNG } from 'pngjs'
import {
  BuiltinPluginHostService,
  isSupportedPlugin,
  normalizePluginName
} from '../../src/main/services/builtin-plugin-host-service.js'
import { buildMultiPagePdfFromStreams, fileUrlToLocalPath, isFullyQualifiedPath, PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
import { MediaOcrHostPluginHandler, type MediaOcrHostDeps } from '../../src/main/services/host-plugins/media-ocr-host.js'

/** 插件不能再传 __simulate* 参数伪造“没有 ffmpeg / 抓屏失败”；改由构造参数注入替身，生产代码不保留测试开关 */
const mediaCtx = { clipboard: null, processService: null, windowControl: null, authorizeExistingPath: async (p: string) => p, authorizeOutputPath: async (p: string) => p } as HostPluginContext
function mediaHandlerWithoutFfmpeg(extra: Partial<MediaOcrHostDeps> = {}) {
  const calls: string[] = []
  const handler = new MediaOcrHostPluginHandler(mediaCtx, {
    runCommand: async (command, args) => {
      calls.push([command, ...args].join(' '))
      return command === 'ffmpeg' ? { stdout: '', stderr: 'command not found: ffmpeg', exitCode: 127 } : { stdout: '', stderr: `未预设命令: ${command}`, exitCode: 1 }
    },
    runPowerShell: async () => { throw new PowerShellError(1, '未预设 PowerShell') },
    captureScreenToPng: async () => false,
    ...extra
  })
  return { handler, calls }
}

test('BuiltinPluginHostService recognizes all 18 original and 13 newly added builtin plugin aliases ([P-3])', () => {
  const host = new BuiltinPluginHostService()
  const expectedPlugins = [
    'LanSharePlugin',
    'lan-share',
    'NetworkAdapterPlugin',
    'network-adapter',
    'NetworkRescuePlugin',
    'network-rescue',
    'MoverPlugin',
    'mover',
    'DataRecoveryPlugin',
    'data-recovery',
    'ShredderPlugin',
    'shredder',
    'SystemBackupPlugin',
    'system-backup',
    'SqlitePlugin',
    'sqlite-plugin',
    'FileComparePlugin',
    'file-compare',
    'OcrPlugin',
    'ocr',
    'ColorPickerPlugin',
    'screen-color-picker',
    'RecordPlugin',
    'record',
    'ContextMenuPlugin',
    'context-menu',
    'WeChatMultiPlugin',
    'wechat-multi',
    'FlowGuardPlugin',
    'flow-guard',
    'BoostPlugin',
    'boost',
    'AiImagePlugin',
    'ai-image',
    'BatchVideoPlugin',
    'batch-video',
    'BatchAudioPlugin',
    'batch-audio',
    'AiVideoPlugin',
    'ai-video',
    'PdfPlugin',
    'pdf',
    'ScreenshotsPlugin',
    'screenshots',
    'screenshot',
    'CleanerPlugin',
    'cleaner',
    'AnalyzerPlugin',
    'disk-analyzer',
    'WechatCleanerPlugin',
    'wechat-cleaner',
    'QQCleanerPlugin',
    'qq-cleaner',
    'BatchRenamePlugin',
    'batch-rename',
    'SoftwareManagerPlugin',
    'software-manager',
    'HardwareInfoPlugin',
    'hardware-info',
    'SystemActionsPlugin',
    'system',
    'system-tools',
    'MultiDownloadPlugin',
    'multi-download',
    'VideoDownloaderPlugin',
    'video-downloader',
    'WindowManagementPlugin',
    'window-management',
    'window-manager',
    'ClipboardHistoryPlugin',
    'clipboard-history',
    'clipboard-manager'
  ]

  for (const name of expectedPlugins) {
    assert.equal(host.supportsPlugin(name), true, `Expected ${name} to be supported`)
    assert.equal(host.isSupportedPlugin(name), true, `Expected isSupportedPlugin(${name}) to be true`)
    assert.equal(isSupportedPlugin(name), true)
    assert.ok(normalizePluginName(name), `Expected normalizePluginName(${name}) to return canonical name`)
  }
  assert.equal(host.supportsPlugin('NonExistentPlugin'), false)
  assert.equal(normalizePluginName('NonExistentPlugin'), null)
})

test('LanSharePlugin starts real local HTTP server, serves shared file list, and stops cleanly', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-lanshare-test-'))
  const sampleFile = path.join(tempDir, 'hello.txt')
  await fs.writeFile(sampleFile, 'Hello ZTools LAN Share!', 'utf8')

  try {
    const startRes = (await host.handlePluginCall('LanSharePlugin', 'addSharedFile', {
      paths: [sampleFile],
      port: 0
    })) as {
      ok: boolean
      running: boolean
      port: number
      sharedFiles: Array<{ id: string; name: string; size: number }>
    }

    assert.equal(startRes.ok, true)
    assert.equal(startRes.running, true)
    assert.ok(startRes.port > 0)
    assert.equal(startRes.sharedFiles.length, 1)
    assert.equal(startRes.sharedFiles[0]?.name, 'hello.txt')

    const apiResponse = await fetch(`http://127.0.0.1:${startRes.port}/api/files`)
    assert.equal(apiResponse.status, 200)
    const apiJson = (await apiResponse.json()) as { ok: boolean; files: Array<{ name: string }> }
    assert.equal(apiJson.ok, true)
    assert.equal(apiJson.files[0]?.name, 'hello.txt')

    const stopRes = (await host.handlePluginCall('LanSharePlugin', 'stopServer', {})) as {
      ok: boolean
      running: boolean
    }
    assert.equal(stopRes.ok, true)
    assert.equal(stopRes.running, false)
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('FileComparePlugin computes real SHA-256, line diffs, and compareBatch pairs ([P-3])', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-compare-test-'))
  const fileA = path.join(tempDir, 'a.txt')
  const fileB = path.join(tempDir, 'b.txt')
  const fileC = path.join(tempDir, 'c.txt')
  await fs.writeFile(fileA, 'line1\nline2-old\nline3', 'utf8')
  await fs.writeFile(fileB, 'line1\nline2-new\nline3\nline4', 'utf8')
  await fs.writeFile(fileC, 'line1\nline2-old\nline3', 'utf8')

  try {
    const res = (await host.handlePluginCall('FileComparePlugin', 'compareFiles', {
      leftPath: fileA,
      rightPath: fileB
    })) as {
      ok: boolean
      identical: boolean
      leftSha256: string
      rightSha256: string
      summary: { equalCount: number; modifiedCount: number; insertedCount: number }
    }

    assert.equal(res.ok, true)
    assert.equal(res.identical, false)
    assert.notEqual(res.leftSha256, res.rightSha256)
    assert.equal(res.summary.equalCount, 2)
    assert.equal(res.summary.modifiedCount, 1)
    assert.equal(res.summary.insertedCount, 1)

    const batchRes = (await host.handlePluginCall('FileComparePlugin', 'compareBatch', {
      pairs: [
        { id: 'pair-diff', leftPath: fileA, rightPath: fileB },
        { id: 'pair-same', leftPath: fileA, rightPath: fileC },
        { id: 'pair-missing', leftPath: fileA, rightPath: path.join(tempDir, 'non-existent.txt') }
      ]
    })) as {
      ok: boolean
      comparedCount: number
      results: Array<{
        id: string
        ok: boolean
        identical?: boolean
        status: string
        leftSha256?: string
        rightSha256?: string
      }>
    }

    assert.equal(batchRes.ok, true)
    assert.equal(batchRes.comparedCount, 3)
    assert.equal(batchRes.results[0]?.id, 'pair-diff')
    assert.equal(batchRes.results[0]?.identical, false)
    assert.equal(batchRes.results[0]?.status, 'modified')
    assert.equal(batchRes.results[1]?.id, 'pair-same')
    assert.equal(batchRes.results[1]?.identical, true)
    assert.equal(batchRes.results[1]?.status, 'identical')
    assert.equal(batchRes.results[1]?.leftSha256, batchRes.results[1]?.rightSha256)
    assert.equal(batchRes.results[2]?.id, 'pair-missing')
    assert.equal(batchRes.results[2]?.ok, false)
    assert.equal(batchRes.results[2]?.status, 'missing')
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('SqlitePlugin creates, queries, and persists real SQLite tables via sql.js', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-sqlite-test-'))
  const dbPath = path.join(tempDir, 'test.sqlite')
  await fs.writeFile(dbPath, Buffer.alloc(0))

  try {
    await host.handlePluginCall('SqlitePlugin', 'execute', {
      dbPath,
      sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ("Ada"), ("Linus");'
    })

    const tablesRes = (await host.handlePluginCall('SqlitePlugin', 'getTables', { dbPath })) as {
      ok: boolean
      tables: Array<{ name: string; rowCount: number }>
    }
    assert.equal(tablesRes.ok, true)
    assert.equal(tablesRes.tables.length, 1)
    assert.equal(tablesRes.tables[0]?.name, 'users')
    assert.equal(tablesRes.tables[0]?.rowCount, 2)

    const queryRes = (await host.handlePluginCall('SqlitePlugin', 'query', {
      dbPath,
      sql: 'SELECT id, name FROM users ORDER BY id'
    })) as {
      ok: boolean
      rows: Array<{ id: number; name: string }>
    }
    assert.equal(queryRes.ok, true)
    assert.deepEqual(queryRes.rows, [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Linus' }
    ])
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('SystemBackupPlugin creates real ZIP archive and restores files accurately', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-backup-test-'))
  const sourceDir = path.join(tempDir, 'src')
  const backupDir = path.join(tempDir, 'backups')
  const restoreDir = path.join(tempDir, 'restored')
  await fs.mkdir(sourceDir, { recursive: true })
  const configFile = path.join(sourceDir, 'settings.json')
  await fs.writeFile(configFile, JSON.stringify({ theme: 'dark', version: 2 }), 'utf8')

  try {
    const createRes = (await host.handlePluginCall('SystemBackupPlugin', 'createBackup', {
      sourcePaths: [configFile],
      backupDir,
      backupName: 'unit-test-backup.zip'
    })) as {
      ok: boolean
      backupPath: string
      sizeBytes: number
    }
    assert.equal(createRes.ok, true)
    assert.ok(createRes.sizeBytes > 0)

    const restoreRes = (await host.handlePluginCall('SystemBackupPlugin', 'restoreBackup', {
      backupPath: createRes.backupPath,
      targetDir: restoreDir
    })) as {
      ok: boolean
      extractedCount: number
    }
    assert.equal(restoreRes.ok, true)
    assert.equal(restoreRes.extractedCount, 1)

    const restoredContent = await fs.readFile(path.join(restoreDir, 'settings.json'), 'utf8')
    assert.deepEqual(JSON.parse(restoredContent), { theme: 'dark', version: 2 })
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('ShredderPlugin overwrites and permanently unlinks target file while blocking system paths', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-shred-test-'))
  const secretFile = path.join(tempDir, 'secret.txt')
  await fs.writeFile(secretFile, 'Sensitive token 123456', 'utf8')

  try {
    const res = (await host.handlePluginCall('ShredderPlugin', 'shredFiles', {
      paths: [secretFile],
      passes: 3
    })) as {
      ok: boolean
      shreddedCount: number
    }
    assert.equal(res.ok, true)
    assert.equal(res.shreddedCount, 1)

    await assert.rejects(fs.stat(secretFile))

    const sysRes = (await host.handlePluginCall('ShredderPlugin', 'shredFiles', {
      paths: ['C:\\Windows\\System32'],
      passes: 1
    })) as {
      ok: boolean
      shreddedCount: number
      errors: Array<{ path: string; error: string }>
    }
    assert.equal(sysRes.ok, false)
    assert.equal(sysRes.shreddedCount, 0)
    assert.equal(sysRes.errors.length, 1)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('PdfPlugin preserves multi-page PDF content on compress/merge and never overwrites with 1-page dummy title PDF ([P-2])', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-pdf-test-'))
  const multiPagePdfPath = path.join(tempDir, 'multi-page-source.pdf')
  const secondPdfPath = path.join(tempDir, 'second-source.pdf')
  const compressedPdfPath = path.join(tempDir, 'compressed-out.pdf')
  const mergedPdfPath = path.join(tempDir, 'merged-out.pdf')
  const txtOutPath = path.join(tempDir, 'extracted.txt')
  const invalidPdfPath = path.join(tempDir, 'corrupted.pdf')

  const multiPageBuf = buildMultiPagePdfFromStreams([
    'BT\n/F1 11 Tf\n48 760 Td\n(Original Page 1 Alpha Content) Tj\nET',
    'BT\n/F1 11 Tf\n48 760 Td\n(Original Page 2 Beta Content) Tj\nET'
  ])
  const secondPdfBuf = buildMultiPagePdfFromStreams([
    'BT\n/F1 11 Tf\n48 760 Td\n(Second PDF Page 3 Gamma Content) Tj\nET'
  ])
  await fs.writeFile(multiPagePdfPath, multiPageBuf)
  await fs.writeFile(secondPdfPath, secondPdfBuf)
  await fs.writeFile(invalidPdfPath, 'NOT_A_VALID_PDF_FILE', 'utf8')

  try {
    // 1. Compress existing 2-page PDF: must preserve all 2 pages and original content
    const compressRes = (await host.handlePluginCall('PdfPlugin', 'compressPdf', {
      filePath: multiPagePdfPath,
      outputPath: compressedPdfPath
    })) as {
      ok: boolean
      outputPath: string
      pageCount: number
      sizeBytes: number
    }
    assert.equal(compressRes.ok, true)
    assert.equal(compressRes.pageCount, 2)
    const compressedRaw = await fs.readFile(compressedPdfPath, 'latin1')
    assert.ok(compressedRaw.includes('Original Page 1 Alpha Content'))
    assert.ok(compressedRaw.includes('Original Page 2 Beta Content'))
    assert.equal(compressedRaw.includes('ZTools PDF Output:'), false)

    // 2. Inspect compressed PDF: must report 2 pages
    const inspectRes = (await host.handlePluginCall('PdfPlugin', 'inspectPdf', {
      filePath: compressedPdfPath
    })) as {
      ok: boolean
      isPdf: boolean
      pageCount: number
    }
    assert.equal(inspectRes.ok, true)
    assert.equal(inspectRes.isPdf, true)
    assert.equal(inspectRes.pageCount, 2)

    // 3. Merge 2-page PDF + 1-page PDF: must produce 3-page PDF containing all 3 pages' streams
    const mergeRes = (await host.handlePluginCall('PdfPlugin', 'mergePdf', {
      files: [multiPagePdfPath, secondPdfPath],
      outputPath: mergedPdfPath
    })) as {
      ok: boolean
      outputPath: string
      pageCount: number
    }
    assert.equal(mergeRes.ok, true)
    assert.equal(mergeRes.pageCount, 3)
    const mergedRaw = await fs.readFile(mergedPdfPath, 'latin1')
    assert.ok(mergedRaw.includes('Original Page 1 Alpha Content'))
    assert.ok(mergedRaw.includes('Original Page 2 Beta Content'))
    assert.ok(mergedRaw.includes('Second PDF Page 3 Gamma Content'))

    // 4. Extract text from merged 3-page PDF
    const txtRes = (await host.handlePluginCall('PdfPlugin', 'pdfToTxt', {
      filePath: mergedPdfPath,
      outputPath: txtOutPath
    })) as {
      ok: boolean
      text: string
    }
    assert.equal(txtRes.ok, true)
    assert.ok(txtRes.text.includes('Original Page 1 Alpha Content'))
    assert.ok(txtRes.text.includes('Second PDF Page 3 Gamma Content'))

    // 5. Non-happy path: invalid PDF file must be rejected with { ok: false, error }
    const badRes = (await host.handlePluginCall('PdfPlugin', 'compressPdf', {
      filePath: invalidPdfPath,
      outputPath: path.join(tempDir, 'should-not-exist.pdf')
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(badRes.ok, false)
    assert.match(String(badRes.error), /PDF/)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('RecordPlugin returns { ok: false, error } when recording/capture produces no output file and never creates 320x180 gray fake PNG ([S-1])', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-record-test-'))
  const missingOutputPath = path.join(tempDir, 'failed-capture.png')
  const { handler: host, calls } = mediaHandlerWithoutFfmpeg()

  try {
    // PNG 单帧模式在开始阶段就抓帧：注入的抓屏替身返回 false 时直接失败，不进入录制状态（以前这里会先报 recording:true 成功）
    const startRes = (await host.handleRecord('startRecording', {
      type: 'video',
      outputPath: missingOutputPath
    })) as {
      ok: boolean
      success: boolean
      recording: boolean
      sessionId?: string
      error?: string
    }
    assert.equal(startRes.ok, false)
    assert.equal(startRes.success, false)
    assert.equal(startRes.recording, false)
    assert.equal(startRes.sessionId, undefined)
    assert.match(String(startRes.error), /屏幕录制或抓图失败/)
    assert.equal(fsSync.existsSync(missingOutputPath), false, 'Must not write fake 320x180 gray PNG on startRecording')
    assert.deepEqual(fsSync.readdirSync(tempDir), [], '抓帧失败不能留下临时文件')
    // PNG 抓帧不依赖 ffmpeg
    assert.deepEqual(calls, [])

    const statusRes = (await host.handleRecord('status', {})) as { recording: boolean; sessions: unknown[] }
    assert.equal(statusRes.recording, false)
    assert.deepEqual(statusRes.sessions, [])

    // 没有会话时停止录制如实失败，不能把任何文件报成录制结果
    const stopRes = (await host.handleRecord('stopRecording', {})) as {
      ok: boolean
      success: boolean
      error?: string
    }
    assert.equal(stopRes.ok, false)
    assert.equal(stopRes.success, false)
    assert.match(String(stopRes.error), /没有正在进行的录制/)
    assert.equal(fsSync.existsSync(missingOutputPath), false, 'Must not write fake 320x180 gray PNG on stopRecording')

    // 抓屏成功：开始时帧已写出，停止时返回同一文件
    const okOutputPath = path.join(tempDir, 'captured.png')
    const { handler: okHost } = mediaHandlerWithoutFfmpeg({
      captureScreenToPng: async (p) => {
        await fs.writeFile(p, 'REAL_PNG_FRAME')
        return true
      }
    })
    const okStart = (await okHost.handleRecord('startRecording', { type: 'video', outputPath: okOutputPath })) as {
      ok: boolean
      recording: boolean
      sessionId: string
    }
    assert.equal(okStart.ok, true)
    assert.equal(okStart.recording, true)
    assert.equal(fsSync.readFileSync(okOutputPath, 'utf8'), 'REAL_PNG_FRAME')
    const okStop = (await okHost.handleRecord('stopRecording', { sessionId: okStart.sessionId })) as {
      ok: boolean
      outputPath: string
      sizeBytes: number
    }
    assert.equal(okStop.ok, true)
    assert.equal(okStop.outputPath, okOutputPath)
    assert.equal(okStop.sizeBytes, 'REAL_PNG_FRAME'.length)
    assert.deepEqual(fsSync.readdirSync(tempDir), ['captured.png'])
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('BatchVideoPlugin / BatchAudioPlugin / AiVideoPlugin fail honestly when ffmpeg is missing or transcode fails without copying source ([P-1])', async () => {
  const { handler } = mediaHandlerWithoutFfmpeg()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-batchmedia-test-'))
  const srcVideo = path.join(tempDir, 'input.mov')
  const outMp4 = path.join(tempDir, 'output.mp4')
  const copyOutMov = path.join(tempDir, 'copied.mov')
  await fs.writeFile(srcVideo, 'FAKE_MOV_CONTENT_NOT_TRANSCODED', 'utf8')

  try {
    // 1. Transcoding without ffmpeg must return { ok: false, error } and NOT copy input.mov to output.mp4
    const failRes = (await handler.handleBatchMedia('BatchVideoPlugin', 'transcode', {
      files: [srcVideo],
      format: 'mp4',
      outputPath: outMp4
    })) as {
      ok: boolean
      success: boolean
      processedCount: number
      error?: string
    }
    assert.equal(failRes.ok, false)
    assert.equal(failRes.success, false)
    assert.equal(failRes.processedCount, 0)
    assert.match(String(failRes.error), /ffmpeg/)
    assert.equal(fsSync.existsSync(outMp4), false, 'Must not copy un-transcoded source file to output path')

    // 2. Explicit same-format lossless copy (mode: 'copy' + same extension) is allowed
    const copyRes = (await handler.handleBatchMedia('BatchVideoPlugin', 'copyStream', {
      files: [srcVideo],
      format: 'mov',
      mode: 'copy',
      outputPath: copyOutMov
    })) as {
      ok: boolean
      success: boolean
      processedCount: number
    }
    assert.equal(copyRes.ok, true)
    assert.equal(copyRes.processedCount, 1)
    assert.equal(fsSync.existsSync(copyOutMov), true)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('AiImagePlugin upscales PNG image dimensions', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-test-'))
  const srcPngPath = path.join(tempDir, 'small.png')
  const outPngPath = path.join(tempDir, 'upscaled.png')

  const png = new PNG({ width: 4, height: 4 })
  png.data.fill(180)
  await fs.writeFile(srcPngPath, PNG.sync.write(png))

  try {
    const imgRes = (await host.handlePluginCall('AiImagePlugin', 'upscale', {
      files: [srcPngPath],
      outputPath: outPngPath,
      mode: 'upscale',
      scale: 2
    })) as {
      ok: boolean
      results: Array<{ width: number; height: number; outputBytes: number }>
    }
    assert.equal(imgRes.ok, true)
    assert.equal(imgRes.results[0]?.width, 8)
    assert.equal(imgRes.results[0]?.height, 8)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('BatchRenamePlugin, CleanerPlugin, and HardwareInfoPlugin execute real host operations ([P-3])', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-newplugins-test-'))
  const origFile = path.join(tempDir, 'draft.txt')
  const renamedFile = path.join(tempDir, 'final.txt')
  await fs.writeFile(origFile, 'rename and clean test', 'utf8')

  try {
    // 1. BatchRenamePlugin renames file on disk
    const renameRes = (await host.handlePluginCall('BatchRenamePlugin', 'ExecuteBatchRename', {
      items: [{ oldPath: origFile, newPath: renamedFile }]
    })) as {
      ok: boolean
      renamedCount: number
    }
    assert.equal(renameRes.ok, true)
    assert.equal(renameRes.renamedCount, 1)
    assert.equal(fsSync.existsSync(origFile), false)
    assert.equal(fsSync.existsSync(renamedFile), true)

    // 2. CleanerPlugin scans and cleans target file
    const scanRes = (await host.handlePluginCall('CleanerPlugin', 'StartScanAsync', {
      path: tempDir
    })) as {
      ok: boolean
      fileCount: number
    }
    assert.equal(scanRes.ok, true)
    assert.equal(scanRes.fileCount, 1)

    const cleanRes = (await host.handlePluginCall('CleanerPlugin', 'CleanFiles', {
      paths: [renamedFile]
    })) as {
      ok: boolean
      deletedCount: number
    }
    assert.equal(cleanRes.ok, true)
    assert.equal(cleanRes.deletedCount, 1)
    assert.equal(fsSync.existsSync(renamedFile), false)

    // 3. HardwareInfoPlugin 旧接口已停用：不再返回拼凑的 CPU / 磁盘数据，提示更新插件改走通用系统接口
    const hwRes = (await host.handlePluginCall('HardwareInfoPlugin', 'GetHardwareInfo', {})) as {
      ok: boolean
      success: boolean
      errorCode?: string
      error?: string
      cpu?: unknown
      disks?: unknown
    }
    assert.equal(hwRes.ok, false)
    assert.equal(hwRes.success, false)
    assert.equal(hwRes.errorCode, 'UNSUPPORTED_ACTION')
    assert.match(String(hwRes.error), /请更新硬件信息插件/)
    assert.equal(hwRes.cpu, undefined)
    assert.equal(hwRes.disks, undefined)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('NetworkAdapterPlugin, NetworkRescuePlugin, and BoostPlugin return real system telemetry and reject unknown methods', async () => {
  const host = new BuiltinPluginHostService()

  const adaptersRes = (await host.handlePluginCall('NetworkAdapterPlugin', 'getAdapters', {})) as {
    ok: boolean
    adapters: Array<{ name: string; dnsServers: string[]; speedMbps: number }>
  }
  assert.equal(adaptersRes.ok, true)
  assert.ok(Array.isArray(adaptersRes.adapters))
  assert.ok(adaptersRes.adapters.length >= 1)
  assert.ok(Array.isArray(adaptersRes.adapters[0]?.dnsServers))
  assert.equal(typeof adaptersRes.adapters[0]?.speedMbps, 'number')

  const rescueDiag = (await host.handlePluginCall('NetworkRescuePlugin', 'diagnose', {})) as {
    ok: boolean
    checks: Array<{ id: string; status: string; latencyMs: number }>
  }
  assert.equal(rescueDiag.ok, true)
  const checkIds = new Set(rescueDiag.checks.map((c) => c.id))
  for (const expectedId of [
    'flush-dns',
    'clear-proxy',
    'reset-winsock',
    'check-hosts',
    'renew-dhcp',
    'ping-gateway-dns',
    'reset-firewall',
    'restart-nla'
  ]) {
    assert.equal(checkIds.has(expectedId), true, `Expected diagnose checks to include ${expectedId}`)
  }

  const hostsRepair = (await host.handlePluginCall('NetworkRescuePlugin', 'repair', {
    checkId: 'check-hosts'
  })) as {
    ok: boolean
    checkId: string
    activeRulesCount?: number
  }
  assert.equal(hostsRepair.ok, true)
  assert.equal(hostsRepair.checkId, 'check-hosts')
  assert.equal(typeof hostsRepair.activeRulesCount, 'number')

  const badRepair = (await host.handlePluginCall('NetworkRescuePlugin', 'repair', {
    checkId: 'non-existent-repair-id'
  })) as {
    ok: boolean
    error?: string
  }
  assert.equal(badRepair.ok, false)
  assert.ok(badRepair.error)

  const unknownRescueFn = (await host.handlePluginCall('NetworkRescuePlugin', 'unknownFunction', {})) as {
    ok: boolean
    error?: string
  }
  assert.equal(unknownRescueFn.ok, false)
  assert.match(String(unknownRescueFn.error), /Unsupported NetworkRescuePlugin function/)

  const boostRes = (await host.handlePluginCall('BoostPlugin', 'getStatus', {})) as {
    ok: boolean
    totalMemoryBytes: number
    cpuCount: number
  }
  assert.equal(boostRes.ok, true)
  assert.ok(boostRes.totalMemoryBytes > 0)
  assert.ok(boostRes.cpuCount > 0)

  // 开机启动项统一由 StartupManagerPlugin 处理，BoostPlugin 不再提供另一份实现
  const startupRes = (await host.handlePluginCall('BoostPlugin', 'getStartupItems', {})) as { ok: boolean; error?: string }
  assert.equal(startupRes.ok, false)
  assert.match(String(startupRes.error), /Unsupported BoostPlugin function/)

  const unknownBoostFn = (await host.handlePluginCall('BoostPlugin', 'unknownBoostMethod', {})) as {
    ok: boolean
    error?: string
  }
  assert.equal(unknownBoostFn.ok, false)
  assert.match(String(unknownBoostFn.error), /Unsupported BoostPlugin function/)
})

test('LanSharePlugin supports syncShareFiles, toggleFileShare, /dl/ route, 403 on disabled share, and rejects unknown methods', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-lanshare-contract-'))
  const fileA = path.join(tempDir, 'alpha.txt')
  await fs.writeFile(fileA, 'Alpha LAN Content', 'utf8')

  try {
    const statusBefore = (await host.handlePluginCall('LanSharePlugin', 'getLanShareStatus', {})) as {
      ok: boolean
      running: boolean
      lanIp: string
      primaryIp: string
      files: unknown[]
      totalClientRequests: number
    }
    assert.equal(statusBefore.ok, true)
    assert.equal(statusBefore.running, false)
    assert.equal(statusBefore.lanIp, statusBefore.primaryIp)
    assert.equal(typeof statusBefore.totalClientRequests, 'number')

    const syncRes = (await host.handlePluginCall('LanSharePlugin', 'syncShareFiles', {
      files: [{ id: 'custom-alpha', name: 'alpha.txt', path: fileA, shared: true }]
    })) as {
      ok: boolean
      files: Array<{ id: string; shared: boolean }>
    }
    assert.equal(syncRes.ok, true)
    assert.equal(syncRes.files.length, 1)
    assert.equal(syncRes.files[0]?.id, 'custom-alpha')
    assert.equal(syncRes.files[0]?.shared, true)

    const startRes = (await host.handlePluginCall('LanSharePlugin', 'startShareServer', { port: 0 })) as {
      ok: boolean
      running: boolean
      port: number
    }
    assert.equal(startRes.ok, true)
    assert.equal(startRes.running, true)

    // /dl/0/alpha.txt should return 200 when shared === true
    const dlOk = await fetch(`http://127.0.0.1:${startRes.port}/dl/0/alpha.txt`)
    assert.equal(dlOk.status, 200)
    assert.equal(await dlOk.text(), 'Alpha LAN Content')

    // Toggle shared to false -> /dl/ and /download/ must return 403 Forbidden
    const toggleOff = (await host.handlePluginCall('LanSharePlugin', 'toggleFileShare', {
      id: 'custom-alpha',
      shared: false
    })) as {
      ok: boolean
      files: Array<{ id: string; shared: boolean }>
    }
    assert.equal(toggleOff.ok, true)
    assert.equal(toggleOff.files[0]?.shared, false)

    const dlForbidden = await fetch(`http://127.0.0.1:${startRes.port}/dl/0/alpha.txt`)
    assert.equal(dlForbidden.status, 403)
    await dlForbidden.text()

    const downloadForbidden = await fetch(`http://127.0.0.1:${startRes.port}/download/custom-alpha/alpha.txt`)
    assert.equal(downloadForbidden.status, 403)
    await downloadForbidden.text()

    // Non-existent file toggle must return { ok: false, error }
    const toggleMissing = (await host.handlePluginCall('LanSharePlugin', 'toggleFileShare', {
      id: 'non-existent-id',
      shared: true
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(toggleMissing.ok, false)
    assert.ok(toggleMissing.error)

    // Unknown function must return { ok: false, error }
    const unknownFn = (await host.handlePluginCall('LanSharePlugin', 'nonExistentMethod', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(unknownFn.ok, false)
    assert.match(String(unknownFn.error), /Unsupported LanSharePlugin function/)
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('SystemRegistryHost plugins enforce strict method contracts, real WMI thermal or null, and residual cleaning', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-sysreg-contract-'))
  const residualFile = path.join(tempDir, 'leftover.log')
  await fs.writeFile(residualFile, 'residual data 1234567890', 'utf8')

  try {
    // 1. ContextMenuPlugin scanEntries returns items and entries with normalized scope
    const ctxRes = (await host.handlePluginCall('ContextMenuPlugin', 'scanEntries', {})) as {
      ok: boolean
      items: Array<{ scope: string; scopeLabel: string }>
      entries: Array<{ scope: string; scopeLabel: string }>
    }
    assert.equal(ctxRes.ok, true)
    assert.ok(Array.isArray(ctxRes.items))
    assert.ok(Array.isArray(ctxRes.entries))
    for (const entry of ctxRes.entries) {
      assert.ok(['file', 'directory', 'background'].includes(entry.scope))
    }

    const badCtxFn = (await host.handlePluginCall('ContextMenuPlugin', 'unknownAction', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(badCtxFn.ok, false)

    // 2. WeChatMultiPlugin scanInstances returns wechatPath & installPath and rejects unknown fn
    const wxRes = (await host.handlePluginCall('WeChatMultiPlugin', 'scanInstances', {})) as {
      ok: boolean
      wechatPath: string
      installPath: string
      instances: unknown[]
    }
    assert.equal(wxRes.ok, true)
    assert.equal(wxRes.wechatPath, wxRes.installPath)
    assert.ok(Array.isArray(wxRes.instances))

    const badWxFn = (await host.handlePluginCall('WeChatMultiPlugin', 'unknownWxAction', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(badWxFn.ok, false)

    // 3. HardwareInfoPlugin getTemperature 不再把 ACPI 热区温度当 CPU 温度返回，也不返回任何温度数值
    const tempRes = (await host.handlePluginCall('HardwareInfoPlugin', 'getTemperature', {})) as {
      ok: boolean
      errorCode?: string
      cpuTempCelsius?: unknown
    }
    assert.equal(tempRes.ok, false)
    assert.equal(tempRes.errorCode, 'UNSUPPORTED_ACTION')
    assert.equal(tempRes.cpuTempCelsius, undefined)

    // 4. SoftwareManagerPlugin cleanResiduals deletes residual files and blocks unknown fn
    const cleanRes = (await host.handlePluginCall('SoftwareManagerPlugin', 'cleanResiduals', {
      paths: [residualFile]
    })) as {
      ok: boolean
      freedBytes: number
      cleanedCount: number
    }
    assert.equal(cleanRes.ok, true)
    assert.equal(cleanRes.cleanedCount, 1)
    assert.ok(cleanRes.freedBytes > 0)
    assert.equal(fsSync.existsSync(residualFile), false)

    const badSwFn = (await host.handlePluginCall('SoftwareManagerPlugin', 'unknownSwMethod', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(badSwFn.ok, false)

    // 5. SystemActionsPlugin & WindowManagementPlugin reject invalid actions
    const badSysAction = (await host.handlePluginCall('SystemActionsPlugin', 'nonExistentSystemAction', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(badSysAction.ok, false)

    const badWinAction = (await host.handlePluginCall('WindowManagementPlugin', 'nonExistentWinAction', {})) as {
      ok: boolean
      error?: string
    }
    assert.equal(badWinAction.ok, false)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('StorageHost plugins support DataRecovery, SystemBackup no-empty-ZIP guard, Sqlite VACUUM/inspectWorkspace, and Cleaner summary', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-storage-contract-'))
  const cachedFile = path.join(tempDir, 'deleted_doc.txt')
  const restoredTargetFile = path.join(tempDir, 'restored_exact.txt')
  await fs.writeFile(cachedFile, 'Recoverable document content', 'utf8')

  try {
    // 1. DataRecoveryPlugin scanDeletedFiles & restoreFile with sourceCachePath + targetPath
    const scanRec = (await host.handlePluginCall('DataRecoveryPlugin', 'scanDeletedFiles', {
      scanPath: tempDir
    })) as {
      ok: boolean
      items: Array<{ cachePath: string; originalPath: string; deletedAtMs: number; sizeBytes: number }>
      files: Array<{ cachePath: string }>
    }
    assert.equal(scanRec.ok, true)
    assert.ok(scanRec.items.length >= 1)
    assert.equal(scanRec.items.length, scanRec.files.length)
    assert.ok(scanRec.items[0]?.cachePath)
    assert.ok(scanRec.items[0]?.originalPath)
    assert.equal(typeof scanRec.items[0]?.deletedAtMs, 'number')

    const restoreRec = (await host.handlePluginCall('DataRecoveryPlugin', 'restoreFile', {
      sourceCachePath: cachedFile,
      targetPath: restoredTargetFile
    })) as {
      ok: boolean
      targetPath: string
    }
    assert.equal(restoreRec.ok, true)
    assert.equal(fsSync.existsSync(restoredTargetFile), true)
    assert.equal(await fs.readFile(restoredTargetFile, 'utf8'), 'Recoverable document content')

    // 2. SystemBackupPlugin rejects empty/missing sources instead of creating fake manifest ZIP
    const emptyBackup = (await host.handlePluginCall('SystemBackupPlugin', 'createSnapshotArchive', {
      paths: [path.join(tempDir, 'does_not_exist_12345.txt')],
      vaultDir: path.join(tempDir, 'vault')
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(emptyBackup.ok, false)
    assert.match(String(emptyBackup.error), /未找到任何有效的待备份源文件/)

    // Valid snapshot create + default targetDir restore
    const validSnap = (await host.handlePluginCall('SystemBackupPlugin', 'createSnapshotArchive', {
      paths: [cachedFile],
      vaultDir: path.join(tempDir, 'vault'),
      backupName: 'snap-test.zip'
    })) as {
      ok: boolean
      backupPath: string
      archivePath: string
      fileCount: number
    }
    assert.equal(validSnap.ok, true)
    assert.equal(validSnap.backupPath, validSnap.archivePath)
    assert.equal(validSnap.fileCount, 1)

    const restoreSnap = (await host.handlePluginCall('SystemBackupPlugin', 'restoreSnapshotArchive', {
      archivePath: validSnap.archivePath
    })) as {
      ok: boolean
      targetDir: string
      extractedCount: number
    }
    assert.equal(restoreSnap.ok, true)
    assert.equal(restoreSnap.extractedCount, 1)
    assert.ok(restoreSnap.targetDir.endsWith('snap-test_restored'))

    // 3. SqlitePlugin inspectWorkspace without dbPath + VACUUM via execute
    const wsRes = (await host.handlePluginCall('SqlitePlugin', 'inspectWorkspace', {
      scanAppData: true
    })) as {
      ok: boolean
      dbPath: string
      tables: unknown[]
      rows: unknown[]
    }
    assert.equal(wsRes.ok, true)
    assert.ok(wsRes.dbPath)
    assert.ok(Array.isArray(wsRes.tables))
    assert.ok(Array.isArray(wsRes.rows))

    const vacuumRes = (await host.handlePluginCall('SqlitePlugin', 'execute', {
      dbPath: wsRes.dbPath,
      sql: 'VACUUM;'
    })) as {
      ok: boolean
    }
    assert.equal(vacuumRes.ok, true)

    // 4. CleanerPlugin GetScanSummary & StartCleanWithSelection
    const summaryRes = (await host.handlePluginCall('CleanerPlugin', 'GetScanSummary', {
      path: tempDir
    })) as {
      ok: boolean
      totalBytes: number
      categories: unknown[]
    }
    assert.equal(summaryRes.ok, true)
    assert.ok(summaryRes.totalBytes > 0)
    assert.ok(Array.isArray(summaryRes.categories))

    const selClean = (await host.handlePluginCall('CleanerPlugin', 'StartCleanWithSelection', {
      selectedPaths: [restoredTargetFile]
    })) as {
      ok: boolean
      freedBytes: number
      deletedCount: number
    }
    assert.equal(selClean.ok, true)
    assert.equal(selClean.deletedCount, 1)
    assert.ok(selClean.freedBytes > 0)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('MediaOcrHost plugins enforce no-fake-fallback on ColorPicker, Record, BatchAudio format normalization, and Pdf pageRangeMode', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-contract-'))

  try {
    const { handler: media } = mediaHandlerWithoutFfmpeg()
    // 1. ColorPickerPlugin fails honestly when sampling fails (never returns #3B82F6 fake blue)
    //    非 Windows 直接失败；Windows 上注入的 PowerShell 采样失败也必须如实失败
    const badPick = (await media.handleColorPicker('pickColor', {})) as {
      ok: boolean
      error?: string
      hex?: string
    }
    assert.equal(badPick.ok, false)
    assert.equal(badPick.hex, undefined)
    assert.match(String(badPick.error), /屏幕像素采样失败|采样/)

    // 2. RecordPlugin startRecording for video/audio without ffmpeg immediately returns { ok: false, recording: false }
    const badRecStart = (await media.handleRecord('startRecording', {
      sourceModeId: 'fullscreen_video',
      codecContainer: 'mp4',
      saveDir: tempDir
    })) as {
      ok: boolean
      recording: boolean
      error?: string
    }
    assert.equal(badRecStart.ok, false)
    assert.equal(badRecStart.recording, false)
    assert.match(String(badRecStart.error), /ffmpeg/)

    // 2b. AudioDevicePlugin 旧接口经宿主路由统一提示更新插件（新插件走 audio_* 接口），不再返回编造的设备与音量
    for (const fn of ['listDevices', 'setDefault', 'setVolume', 'setMute']) {
      const audioRes = (await host.handlePluginCall('AudioDevicePlugin', fn, { id: 'win-out-1', volume: 30, muted: true })) as {
        ok: boolean
        errorCode?: string
        error?: string
        devices?: unknown
        volume?: unknown
      }
      assert.equal(audioRes.ok, false)
      assert.equal(audioRes.errorCode, 'UNSUPPORTED_ACTION')
      assert.match(String(audioRes.error), /请更新音频设备插件/)
      assert.equal(audioRes.devices, undefined)
      assert.equal(audioRes.volume, undefined)
    }

    // 3. BatchAudioPlugin normalizes 'mp3_320k' -> '.mp3' and returns top-level outputPath & sizeBytes
    const srcMp3 = path.join(tempDir, 'track.mp3')
    await fs.writeFile(srcMp3, 'MOCK_MP3_AUDIO_STREAM_BYTES', 'utf8')
    const audioCopyRes = (await media.handleBatchMedia('BatchAudioPlugin', 'copyAudio', {
      files: [srcMp3],
      outputFormat: 'mp3_320k',
      mode: 'copy',
      outputDir: tempDir
    })) as {
      ok: boolean
      outputPath: string
      sizeBytes: number
      outputBytes: number
    }
    assert.equal(audioCopyRes.ok, true)
    assert.ok(audioCopyRes.outputPath.endsWith('track_processed.mp3'))
    assert.ok(audioCopyRes.sizeBytes > 0)
    assert.equal(audioCopyRes.sizeBytes, audioCopyRes.outputBytes)

    // 4. PdfPlugin supports pageRangeMode ('odd', 'single_split'), PdfToHtml, and rejects PdfToWord
    const fourPagePdf = path.join(tempDir, 'four.pdf')
    const pdfBuf = buildMultiPagePdfFromStreams([
      'BT\n/F1 11 Tf\n48 760 Td\n(Page 1 Text) Tj\nET',
      'BT\n/F1 11 Tf\n48 760 Td\n(Page 2 Text) Tj\nET',
      'BT\n/F1 11 Tf\n48 760 Td\n(Page 3 Text) Tj\nET',
      'BT\n/F1 11 Tf\n48 760 Td\n(Page 4 Text) Tj\nET'
    ])
    await fs.writeFile(fourPagePdf, pdfBuf)

    const oddPdfRes = (await host.handlePluginCall('PdfPlugin', 'extractPages', {
      filePath: fourPagePdf,
      pageRangeMode: 'odd',
      outputPath: path.join(tempDir, 'odd.pdf')
    })) as {
      ok: boolean
      pageCount: number
    }
    assert.equal(oddPdfRes.ok, true)
    assert.equal(oddPdfRes.pageCount, 2)

    const splitPdfRes = (await host.handlePluginCall('PdfPlugin', 'splitPdf', {
      filePath: fourPagePdf,
      pageRangeMode: 'single_split',
      outputPath: path.join(tempDir, 'split_first.pdf')
    })) as {
      ok: boolean
      splitCount: number
      splitFiles: string[]
    }
    assert.equal(splitPdfRes.ok, true)
    assert.equal(splitPdfRes.splitCount, 4)
    assert.equal(splitPdfRes.splitFiles.length, 4)

    const htmlRes = (await host.handlePluginCall('PdfPlugin', 'PdfToHtml', {
      filePath: fourPagePdf,
      outputPath: path.join(tempDir, 'out.html')
    })) as {
      ok: boolean
      outputPath: string
    }
    assert.equal(htmlRes.ok, true)
    assert.ok((await fs.readFile(htmlRes.outputPath, 'utf8')).includes('<!doctype html>'))

    const wordRes = (await host.handlePluginCall('PdfPlugin', 'PdfToWord', {
      filePath: fourPagePdf
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(wordRes.ok, false)
    assert.match(String(wordRes.error), /Office/)

    // 5. ScreenshotsPlugin returns files, screenshots, and items
    const shotsRes = (await host.handlePluginCall('ScreenshotsPlugin', 'listScreenshots', {
      outputDir: tempDir
    })) as {
      ok: boolean
      files: unknown[]
      screenshots: unknown[]
      items: unknown[]
    }
    assert.equal(shotsRes.ok, true)
    assert.ok(Array.isArray(shotsRes.files))
    assert.ok(Array.isArray(shotsRes.screenshots))
    assert.ok(Array.isArray(shotsRes.items))
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('Security Hardening: protects user root directories (~/Desktop, homedir), enforces clipboard port, and sanitizes MultiDownload filenames', async () => {
  const hostWithoutClipboard = new BuiltinPluginHostService()
  const desktopDir = path.join(os.homedir(), 'Desktop')

  try {
    // 1. SoftwareManagerPlugin.uninstall refuses protected user Desktop root
    const uninstallRes = (await hostWithoutClipboard.handlePluginCall('SoftwareManagerPlugin', 'uninstall', {
      id: 'desktop-shortcut',
      name: 'DesktopApp',
      installLocation: desktopDir
    })) as {
      ok: boolean
      success: boolean
      error?: string
    }
    assert.equal(uninstallRes.ok, false)
    assert.equal(uninstallRes.success, false)
    assert.match(String(uninstallRes.error), /系统核心路径|系统保护路径|受保护/)

    // 2. ShredderPlugin refuses homedir root
    const shredRes = (await hostWithoutClipboard.handlePluginCall('ShredderPlugin', 'shred', {
      paths: [os.homedir()]
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(shredRes.ok, false)
    assert.match(String(shredRes.error), /受保护|保护/)

    // 3. ClipboardHistoryPlugin.setClipboardText fails explicitly when clipboard port is absent
    const clipRes = (await hostWithoutClipboard.handlePluginCall('ClipboardHistoryPlugin', 'setClipboardText', {
      text: 'should fail without port'
    })) as {
      ok: boolean
      copied: boolean
      error?: string
    }
    assert.equal(clipRes.ok, false)
    assert.equal(clipRes.copied, false)
    assert.match(String(clipRes.error), /剪贴板.*未注入/)

    // 4. MultiDownloadPlugin.addTask blocks protected saveDir
    const dlProtectedRes = (await hostWithoutClipboard.handlePluginCall('MultiDownloadPlugin', 'addTask', {
      url: 'https://example.com/file.zip',
      saveDir: 'C:\\Windows\\System32',
      filename: '../../pwned.exe'
    })) as {
      ok: boolean
      error?: string
    }
    assert.equal(dlProtectedRes.ok, false)
    assert.match(String(dlProtectedRes.error), /系统保护路径|路径/)
  } finally {
    await hostWithoutClipboard.stop()
  }
})



test('isFullyQualifiedPath 按平台判断完整绝对路径：相对路径、盘符相对、当前盘根相对、空字节一律不算', () => {
  // Windows
  assert.equal(isFullyQualifiedPath('C:\\Windows\\System32', 'win32'), true)
  assert.equal(isFullyQualifiedPath('d:/data/out', 'win32'), true)
  assert.equal(isFullyQualifiedPath('\\\\server\\share\\dir', 'win32'), true)
  assert.equal(isFullyQualifiedPath('\\\\?\\C:\\very\\long', 'win32'), true)
  assert.equal(isFullyQualifiedPath('C:relative', 'win32'), false)
  assert.equal(isFullyQualifiedPath('\\rooted-on-current-drive', 'win32'), false)
  assert.equal(isFullyQualifiedPath('\\\\server', 'win32'), false)
  assert.equal(isFullyQualifiedPath('relative\\dir', 'win32'), false)
  assert.equal(isFullyQualifiedPath('/C:/Users/x', 'win32'), false)
  // macOS / Linux：Windows 路径在这里是相对路径
  assert.equal(isFullyQualifiedPath('/Users/me/Downloads', 'darwin'), true)
  assert.equal(isFullyQualifiedPath('C:\\Windows\\System32', 'darwin'), false)
  assert.equal(isFullyQualifiedPath('C:\\Windows\\System32', 'linux'), false)
  assert.equal(isFullyQualifiedPath('./out', 'darwin'), false)
  assert.equal(isFullyQualifiedPath('~/Downloads', 'darwin'), false)
  // 边界：空串、空字节、非字符串
  assert.equal(isFullyQualifiedPath('', 'darwin'), false)
  assert.equal(isFullyQualifiedPath('/tmp/a\0b', 'darwin'), false)
  assert.equal(isFullyQualifiedPath('C:\\a\0b', 'win32'), false)
  assert.equal(isFullyQualifiedPath(undefined as unknown as string, 'darwin'), false)
})

test('[故障] 没有路径授权时，相对输出目录与相对输入路径被拒绝，且不会在进程工作目录下建出任何目录', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-relative-path-'))
  const previousCwd = process.cwd()
  const posixHost = new BuiltinPluginHostService({ platform: 'darwin' })
  const winHost = new BuiltinPluginHostService({ platform: 'win32' })
  process.chdir(workDir)
  try {
    const relativeDirs = ['C:\\Windows\\System32', 'downloads/sub', './out', '../escape']
    for (const saveDir of relativeDirs) {
      const res = (await posixHost.handlePluginCall('MultiDownloadPlugin', 'addTask', {
        url: 'https://example.invalid/file.zip',
        saveDir
      })) as { ok: boolean; error?: string }
      assert.equal(res.ok, false, `相对输出目录 ${saveDir} 必须被拒绝`)
      assert.match(String(res.error), /必须是绝对路径/)
    }
    // Windows 上盘符相对与当前盘根相对的路径同样拒绝
    for (const saveDir of ['C:relative', '\\rooted']) {
      const res = (await winHost.handlePluginCall('MultiDownloadPlugin', 'addTask', {
        url: 'https://example.invalid/file.zip',
        saveDir
      })) as { ok: boolean; error?: string }
      assert.equal(res.ok, false, `Windows 上 ${saveDir} 必须被拒绝`)
      assert.match(String(res.error), /必须是绝对路径/)
    }
    // 输入路径（粉碎文件）：相对路径不按工作目录解析
    await fs.writeFile(path.join(workDir, 'victim.txt'), 'keep me', 'utf8')
    const shred = (await posixHost.handlePluginCall('ShredderPlugin', 'shredFiles', {
      paths: ['victim.txt'],
      passes: 1
    })) as { ok: boolean; shreddedCount: number; errors: Array<{ path: string; error: string }> }
    assert.equal(shred.ok, false)
    assert.equal(shred.shreddedCount, 0)
    assert.equal(shred.errors.length, 1)
    assert.match(shred.errors[0]!.error, /必须是绝对路径/)
    assert.equal(await fs.readFile(path.join(workDir, 'victim.txt'), 'utf8'), 'keep me', '相对路径指向的文件不能被改动')
    // 工作目录里除了测试自己写的文件，什么都没有新建
    assert.deepEqual((await fs.readdir(workDir)).sort(), ['victim.txt'])
  } finally {
    process.chdir(previousCwd)
    await posixHost.stop()
    await winHost.stop()
    await fs.rm(workDir, { recursive: true, force: true })
  }
})

test('没有路径授权时，绝对输出目录照常可用（兜底只拒绝相对路径，不影响正常下载）', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-abs-path-'))
  try {
    const source = path.join(tempDir, 'source.bin')
    await fs.writeFile(source, 'payload', 'utf8')
    const outDir = path.join(tempDir, 'out')
    const res = (await host.handlePluginCall('MultiDownloadPlugin', 'addTask', {
      url: pathToFileURL(source).href,
      saveDir: outDir,
      fileName: 'copy.bin'
    })) as { ok: boolean; outputPath?: string; error?: string }
    assert.equal(res.ok, true, res.error)
    assert.equal(await fs.readFile(path.join(outDir, 'copy.bin'), 'utf8'), 'payload')
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('fileUrlToLocalPath 按平台解码 file:// 下载源：Windows 盘符与 UNC 得到 path.win32 的完整路径，不再是 /C:/x', () => {
  // macOS / Linux：%20 与中文转义被解码
  assert.equal(fileUrlToLocalPath('file:///tmp/a%20b/%E4%B8%AD.txt', 'darwin'), '/tmp/a b/中.txt')
  assert.equal(fileUrlToLocalPath('  file:///Users/me/x.bin  ', 'linux'), '/Users/me/x.bin')
  assert.equal(fileUrlToLocalPath('FILE:///tmp/x.bin', 'darwin'), '/tmp/x.bin')
  // Windows：盘符与 UNC，结果与 path.win32 的规范形式一致，且是完整绝对路径
  const drive = fileUrlToLocalPath('file:///C:/Users/a%20b/x.txt', 'win32')
  assert.equal(drive, 'C:\\Users\\a b\\x.txt')
  assert.equal(drive, path.win32.normalize('C:/Users/a b/x.txt'))
  assert.equal(path.win32.isAbsolute(drive), true)
  assert.notEqual(drive, new URL('file:///C:/Users/a%20b/x.txt').pathname, '旧写法得到 /C:/Users/a%20b/x.txt')
  assert.equal(isFullyQualifiedPath(new URL('file:///C:/Users/x.txt').pathname, 'win32'), false, '旧写法的结果在 Windows 上不是完整路径')
  const unc = fileUrlToLocalPath('file://server/share/dir/x.txt', 'win32')
  assert.equal(unc, '\\\\server\\share\\dir\\x.txt')
  assert.equal(path.win32.parse(unc).root, '\\\\server\\share\\')
  // 与真实平台的 pathToFileURL 往返一致
  const here = path.join(os.tmpdir(), 'ztools file url', '下载.bin')
  assert.equal(fileUrlToLocalPath(pathToFileURL(here).href), here)
})

test('[故障] fileUrlToLocalPath 拒绝畸形的 file:// 地址，错误为中文且不抛出 Node 的英文原始错误', () => {
  const cases: Array<[string, NodeJS.Platform, RegExp]> = [
    ['', 'darwin', /不是合法的 file:\/\/ 地址: \(空\)/],
    ['https://example.invalid/x.bin', 'darwin', /不是合法的 file:\/\/ 地址/],
    ['file:/tmp/x.bin', 'darwin', /不是合法的 file:\/\/ 地址/],
    ['file://%zz/x', 'darwin', /不是合法的 file:\/\/ 地址（ERR_INVALID_URL）/],
    ['file://[::1/x', 'win32', /不是合法的 file:\/\/ 地址（ERR_INVALID_URL）/],
    // macOS / Linux 上带主机名、路径里有编码后的分隔符
    ['file://remote-host/tmp/x.bin', 'darwin', /不是合法的 file:\/\/ 地址（ERR_INVALID_FILE_URL_HOST）/],
    ['file:///tmp/a%2Fb', 'linux', /不是合法的 file:\/\/ 地址（ERR_INVALID_FILE_URL_PATH）/],
    ['file:///C:/a%5Cb', 'win32', /不是合法的 file:\/\/ 地址（ERR_INVALID_FILE_URL_PATH）/],
    // Windows 上没有盘符的路径不是完整路径
    ['file:///tmp/x.bin', 'win32', /不是合法的 file:\/\/ 地址（ERR_INVALID_FILE_URL_PATH）/],
    // 空字节
    ['file:///tmp/a%00b', 'darwin', /没有指向完整的本地路径/],
    ['file:///C:/a%00b', 'win32', /没有指向完整的本地路径/],
    // 只指向根目录
    ['file:///', 'darwin', /只指向根目录/],
    ['file://', 'darwin', /只指向根目录/],
    ['file:///C:/', 'win32', /只指向根目录/],
    ['file://server/share/', 'win32', /只指向根目录/]
  ]
  for (const [url, platform, pattern] of cases) {
    assert.throws(() => fileUrlToLocalPath(url, platform), pattern, `${platform} ${url}`)
  }
  assert.throws(() => fileUrlToLocalPath(undefined as unknown as string), /不是合法的 file:\/\/ 地址: \(空\)/)
})

test('[集成] MultiDownloadPlugin 的 file:// 源：带空格与中文的路径能正确复制；畸形地址返回中文错误且不产生输出文件', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-file-url-'))
  try {
    const sourceDir = path.join(tempDir, 'source dir 中文')
    await fs.mkdir(sourceDir, { recursive: true })
    const source = path.join(sourceDir, 'my file.bin')
    await fs.writeFile(source, 'payload with spaces', 'utf8')
    const href = pathToFileURL(source).href
    assert.match(href, /%20/, '地址里的空格是转义过的，旧写法 new URL(url).pathname 不会解码')
    const outDir = path.join(tempDir, 'out')
    const ok = (await host.handlePluginCall('MultiDownloadPlugin', 'addTask', {
      url: href,
      saveDir: outDir,
      fileName: 'copy.bin'
    })) as { ok: boolean; outputPath?: string; sizeBytes?: number; error?: string }
    assert.equal(ok.ok, true, ok.error)
    assert.equal(ok.outputPath, path.join(outDir, 'copy.bin'))
    assert.equal(await fs.readFile(path.join(outDir, 'copy.bin'), 'utf8'), 'payload with spaces')
    assert.equal(ok.sizeBytes, Buffer.byteLength('payload with spaces'))

    const badDir = path.join(tempDir, 'bad-out')
    for (const [url, pattern] of [
      ['file://%zz/x', /不是合法的 file:\/\/ 地址/],
      [`file://remote-host${source.split(path.sep).join('/')}`, process.platform === 'win32' ? /./ : /不是合法的 file:\/\/ 地址（ERR_INVALID_FILE_URL_HOST）/],
      [`${href}.missing`, /ENOENT|不存在|no such file/i],
      // Windows 上 file:/// 没有盘符，按格式不合法拒绝；其余平台按只指向根目录拒绝
      ['file:///', /只指向根目录|不是合法的 file:\/\/ 地址/]
    ] as Array<[string, RegExp]>) {
      const res = (await host.handlePluginCall('MultiDownloadPlugin', 'addTask', {
        url,
        saveDir: badDir,
        fileName: 'never.bin'
      })) as { ok: boolean; success: boolean; error?: string }
      assert.equal(res.ok, false, url)
      assert.equal(res.success, false, url)
      assert.match(String(res.error), pattern, url)
      assert.equal(fsSync.existsSync(path.join(badDir, 'never.bin')), false, `${url}：不能产生输出文件`)
    }
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})
