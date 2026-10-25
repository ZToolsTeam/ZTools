import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BuiltinPluginHostService } from '../electron-client/out/main/services/builtin-plugin-host-service.js'
import {
  inspectFileFromBuffer,
  convertTextBufferEncoding,
  fixFileExtension,
  saveConvertedTextFile
} from '../packages/declarative-ui/dist/examples/file-inspector/inspector-service.js'
import {
  buildSyntheticJpegWithMetadata,
  extractJpegPixelScanPayload,
  inspectMediaBuffer,
  stripGpsOnlyFromBuffer,
  stripAllMetadataFromBuffer,
  saveCleanedMediaToDisk
} from '../packages/declarative-ui/dist/examples/media-metadata/media-service.js'
import {
  getPresetWatermarkTemplates,
  validateImageBufferHeader,
  renderWatermarkOnImage
} from '../packages/declarative-ui/dist/examples/id-watermark/watermark-service.js'
import {
  detectAndParse,
  gridToMarkdown,
  gridToJson,
  gridToSql,
  gridToHtml,
  gridToCsv,
  buildAllConversionTargets
} from '../packages/declarative-ui/dist/examples/table-converter/table-service.js'
import {
  validateQuicklinkUrlPattern,
  buildTargetUrl,
  launchQuicklink,
  filterQuicklinks,
  exportQuicklinksJson,
  importQuicklinksJson,
  DEFAULT_QUICKLINKS
} from '../packages/declarative-ui/dist/examples/quicklinks/quicklinks-storage.js'
import {
  PomodoroTimerEngine,
  FOCUS_DURATION_MS,
  SHORT_BREAK_DURATION_MS,
  LONG_BREAK_DURATION_MS,
  calculateDaysLeft,
  validateCountdownInput,
  enrichAndSortCountdowns,
  DEFAULT_COUNTDOWNS
} from '../packages/declarative-ui/dist/examples/pomodoro-focus/pomodoro-service.js'

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function createHostBridge(hostService) {
  return {
    __isRealHost: true,
    dllplugin_call: async (payload) =>
      hostService.handlePluginCall(payload.plugin, payload.func, payload.params || {}),
    dllplugin: {
      call: async (plugin, fn, params) => hostService.handlePluginCall(plugin, fn, params || {})
    }
  }
}

test('20-file-inspector: Magic Bytes 伪装后缀识破、BOM/GBK 编码转换、原子写回与异常防御', async () => {
  const tmpDir = createTempDir('ztools-file-inspector-')
  const hostService = new BuiltinPluginHostService()
  const hostBridge = createHostBridge(hostService)

  try {
    // 1. 伪装后缀识破：真实 PNG (89 50 4E 47 0D 0A 1A 0A) 却命名为 .jpg
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    const disguisedPath = path.join(tmpDir, 'avatar_photo.jpg')
    fs.writeFileSync(disguisedPath, pngMagic)

    const diag = inspectFileFromBuffer(pngMagic, disguisedPath)
    assert.equal(diag.extensionMismatch, true)
    assert.equal(diag.currentExtension, 'jpg')
    assert.equal(diag.realExtension, 'png')
    assert.equal(diag.realMimeType, 'image/png')

    // 2. 通过真实宿主 IPC 修正后缀
    const fixRes = await fixFileExtension(disguisedPath, 'png', hostBridge)
    assert.equal(fixRes.ok, true)
    assert.equal(path.basename(fixRes.newPath), 'avatar_photo.png')
    assert.equal(fs.existsSync(fixRes.newPath), true)

    // 3. UTF-8-BOM 文本诊断与转无 BOM + LF 换行 + 宿主原子写盘
    const bomBytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('第一行中文\r\n第二行数据\r\n')
    ])
    const txtDiag = inspectFileFromBuffer(bomBytes, 'report.csv')
    assert.equal(txtDiag.isText, true)
    assert.equal(txtDiag.detectedEncoding, 'UTF-8-BOM')
    assert.equal(txtDiag.hasBom, true)
    assert.equal(txtDiag.lineEnding, 'CRLF')

    const convertedBytes = convertTextBufferEncoding(bomBytes, 'UTF-8-BOM', 'utf-8', 'LF')
    assert.notEqual(convertedBytes[0], 0xef)
    const outPath = path.join(tmpDir, 'report_utf8.csv')
    const saveRes = await saveConvertedTextFile(outPath, convertedBytes, hostBridge)
    assert.equal(saveRes.ok, true)
    assert.equal(fs.readFileSync(outPath, 'utf8'), '第一行中文\n第二行数据\n')

    // 4. 异常场景：0 字节空文件诊断与转码拒绝
    const emptyDiag = inspectFileFromBuffer(new Uint8Array(0), 'empty.txt')
    assert.equal(emptyDiag.fileSize, 0)
    assert.equal(emptyDiag.detectedEncoding, 'Empty')
    assert.throws(
      () => convertTextBufferEncoding(new Uint8Array(0), 'UTF-8', 'utf-8'),
      /EMPTY_FILE_BUFFER/
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('21-media-metadata: JPEG EXIF/GPS 透视、无损像素级仅抹除 GPS vs 抹除全部元数据与异常拦截', async () => {
  const tmpDir = createTempDir('ztools-media-meta-')
  const hostService = new BuiltinPluginHostService()
  const hostBridge = createHostBridge(hostService)

  try {
    // 1. 构造含 GPS 与相机型号的真实 JPEG 字节流
    const originalPixels = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x12, 0x34])
    const jpegBytes = buildSyntheticJpegWithMetadata({
      deviceModel: 'Sony A7M4',
      dateTimeOriginal: '2026-10-25 10:30:00',
      gpsLatitude: 39.9042,
      gpsLongitude: 116.4074,
      gpsLocationLabel: '北京市东城区',
      pixelPayload: originalPixels
    })

    const inspected = inspectMediaBuffer(jpegBytes, 'photo.jpg')
    assert.equal(inspected.summary.hasExif, true)
    assert.equal(inspected.summary.hasGps, true)
    assert.equal(inspected.summary.deviceModel, 'Sony A7M4')

    // 2. 仅抹除 GPS 位置，保留相机型号，且像素扫描区 1:1 零损保真
    const gpsStripped = stripGpsOnlyFromBuffer(jpegBytes)
    const afterGpsStrip = inspectMediaBuffer(gpsStripped, 'photo_nogps.jpg')
    assert.equal(afterGpsStrip.summary.hasGps, false)
    assert.equal(afterGpsStrip.summary.hasExif, true)
    assert.equal(afterGpsStrip.summary.deviceModel, 'Sony A7M4')
    assert.deepEqual(extractJpegPixelScanPayload(gpsStripped), originalPixels)

    // 3. 彻底抹除全部 EXIF 元数据并写入磁盘
    const allStripped = stripAllMetadataFromBuffer(jpegBytes)
    const afterAllStrip = inspectMediaBuffer(allStripped, 'photo_clean.jpg')
    assert.equal(afterAllStrip.summary.hasExif, false)
    assert.equal(afterAllStrip.summary.hasGps, false)
    assert.deepEqual(extractJpegPixelScanPayload(allStripped), originalPixels)

    const outPath = path.join(tmpDir, 'photo_clean.jpg')
    const writeRes = await saveCleanedMediaToDisk(outPath, allStripped, hostBridge)
    assert.equal(writeRes.ok, true)
    assert.equal(fs.existsSync(outPath), true)

    // 4. 异常场景：截断的 EXIF 头不死循环，非媒体文本伪装成 .jpg 抛错拦截
    const truncatedExif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x10, 0x00, 0x45, 0x78])
    const truncInfo = inspectMediaBuffer(truncatedExif, 'truncated.jpg')
    assert.equal(truncInfo.summary.fileType, 'image')

    const fakeJpg = new TextEncoder().encode('Hello Plain Text Not Image')
    assert.throws(() => inspectMediaBuffer(fakeJpg, 'fake.jpg'), /INVALID_MEDIA_FILE/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('22-id-watermark: 证件防盗斜向平铺水印自适应字号、XML 防注入与非图像头拦截', async () => {
  // 1. 预设模板动态替换业务名与日期
  const presets = getPresetWatermarkTemplates('租房备案', '2026.10.25')
  assert.equal(presets.length, 4)
  assert.ok(presets[0].resolvedText.includes('租房备案'))
  assert.ok(presets[0].resolvedText.includes('2026.10.25'))

  // 2. 高清证件图 + 超长防伪文案自动换行 + XML 特殊字符转义
  const validPngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const renderRes = await renderWatermarkOnImage(
    { width: 1000, height: 630, fileName: 'id_front.png', rawBytes: validPngHeader },
    {
      text: '仅供办理中国建设银行房贷审批 <script>alert(1)</script> 使用 他用无效 2026.10.25',
      opacityPercent: 25,
      rotateDegree: -30,
      gapPx: 140,
      colorMode: 'dark'
    }
  )
  assert.equal(renderRes.width, 1000)
  assert.equal(renderRes.height, 630)
  assert.ok(renderRes.wrappedLines.length >= 2)
  assert.ok(!renderRes.svgOverlay.includes('<script>'))
  assert.ok(renderRes.svgOverlay.includes('&lt;script&gt;'))

  // 3. 极小尺寸缩略图 (200x150) 自适应字号缩减校验
  const smallRes = await renderWatermarkOnImage(
    { width: 200, height: 150 },
    {
      text: '仅供办理入职使用',
      opacityPercent: 25,
      rotateDegree: -30,
      gapPx: 120,
      colorMode: 'dark'
    }
  )
  assert.ok(smallRes.effectiveFontSizePx <= 14)

  // 4. 异常场景：伪造非图片文件头与非法尺寸拦截
  const badBytes = new TextEncoder().encode('PDF-1.5 not an image')
  const headerCheck = validateImageBufferHeader(badBytes)
  assert.equal(headerCheck.valid, false)
  await assert.rejects(
    () =>
      renderWatermarkOnImage(
        { width: 800, height: 600, rawBytes: badBytes },
        { text: 'test', opacityPercent: 25, rotateDegree: -30, gapPx: 120, colorMode: 'dark' }
      ),
    /INVALID_IMAGE_FILE/
  )
})

test('23-table-converter: TSV/CSV/Markdown/JSON/HTML 5 格式互转、RFC4180 复杂引号与 SQL 防注入转义', () => {
  // 1. RFC 4180 CSV（含双引号内逗号、换行与双引号转义）
  const complexCsv = 'id,title,comment,active\n1,"Project A, Phase 1","Line1\nLine2 ""Quoted""",true\n2,"O\'Reilly Book","Pipe | Char",false'
  const parsed = detectAndParse(complexCsv, true)
  assert.equal(parsed.format, 'csv')
  assert.deepEqual(parsed.grid.headers, ['id', 'title', 'comment', 'active'])
  assert.deepEqual(parsed.grid.inferredTypes, ['number', 'string', 'string', 'boolean'])
  assert.equal(parsed.grid.rows.length, 2)

  // 2. Markdown 转换（管道符 `|` 转义为 `\|`，换行转为 `<br>`，数值右对齐 `--:`）
  const md = gridToMarkdown(parsed.grid)
  assert.ok(md.includes('<br>'))
  assert.ok(md.includes('\\|'))
  assert.ok(md.includes('--:'))

  // 3. JSON 转换（number / boolean 自动还原类型）
  const jsonArr = JSON.parse(gridToJson(parsed.grid))
  assert.equal(jsonArr[0].id, 1)
  assert.equal(jsonArr[0].active, true)
  assert.equal(jsonArr[1].active, false)

  // 4. SQL 转换（单引号 O'Reilly 自动双写转义为 O''Reilly，危险表名清洗）
  const sql = gridToSql(parsed.grid, 'books; DROP TABLE users')
  assert.ok(sql.includes('INSERT INTO books__DROP_TABLE_users'))
  assert.ok(sql.includes("'O''Reilly Book'"))

  // 5. HTML 与全目标构建
  const html = gridToHtml(parsed.grid)
  assert.ok(html.includes('<table>'))
  const targets = buildAllConversionTargets(parsed.grid, 'orders')
  assert.equal(targets.length, 5)

  // 6. 空输入边界验证
  const emptyParsed = detectAndParse('   ')
  assert.equal(emptyParsed.format, 'empty')
  assert.equal(emptyParsed.grid.rows.length, 0)
})

test('24-quicklinks: 占位符编码替换、无参降级站点首页、网址组并发打开与危险协议拦截', async () => {
  // 1. 含特殊字符（C++ & Rust #1）的 {query} 严格 URL 编码
  const urlWithQuery = buildTargetUrl('https://github.com/search?q={query}', 'C++ & Rust #1')
  assert.equal(urlWithQuery, 'https://github.com/search?q=C%2B%2B%20%26%20Rust%20%231')

  // 2. 未输入参数直接按回车时，智能降级访问站点首页 origin
  const fallbackOrigin = buildTargetUrl('https://github.com/search?q={query}', '')
  assert.equal(fallbackOrigin, 'https://github.com')

  // 3. 网址组一键并发打开全部分支链接
  const openedUrls = []
  const groupItem = DEFAULT_QUICKLINKS.find((x) => x.isGroup)
  await launchQuicklink(groupItem, '', (u) => {
    openedUrls.push(u)
  })
  assert.equal(openedUrls.length, 3)

  // 4. 危险伪协议拦截 (javascript: / data:text/html / vbscript:)
  const xssCheck = validateQuicklinkUrlPattern('javascript:alert(document.cookie)')
  assert.equal(xssCheck.valid, false)
  assert.match(xssCheck.error, /DANGEROUS_PROTOCOL/)
  assert.throws(() => buildTargetUrl('javascript:alert(1)', 'test'), /DANGEROUS_PROTOCOL/)

  // 5. 别名快捷匹配与 JSON 导入过滤危险协议
  const filtered = filterQuicklinks(DEFAULT_QUICKLINKS, 'gh declarativ-ui')
  assert.ok(filtered.directMatch)
  assert.equal(filtered.directMatch.quicklink.alias, 'gh')
  assert.equal(filtered.directMatch.queryArg, 'declarativ-ui')

  const exported = exportQuicklinksJson(DEFAULT_QUICKLINKS)
  const imported = importQuicklinksJson(exported, [])
  assert.equal(imported.success, true)
  assert.equal(imported.importedCount, DEFAULT_QUICKLINKS.length)
})

test('25-pomodoro-focus: 物理时间戳防漂移番茄钟状态机、跨月循环倒数日钳位与非法日期拦截', () => {
  // 1. 基于 Date.now() 差值的物理防休眠漂移计时器测试
  const notifications = []
  const engine = new PomodoroTimerEngine({}, (title, body, nextPhase) => {
    notifications.push({ title, body, nextPhase })
  })

  const t0 = 1_700_000_000_000
  engine.startFocus(t0, FOCUS_DURATION_MS)
  assert.equal(engine.getState().phase, 'focus')
  assert.equal(engine.getRemainingMs(t0 + 10 * 60 * 1000), 15 * 60 * 1000)

  // 暂停 5 分钟后恢复，验证剩余时长不丢失
  engine.pause(t0 + 10 * 60 * 1000)
  const tResume = t0 + 15 * 60 * 1000
  engine.resume(tResume)
  assert.equal(engine.getRemainingMs(tResume), 15 * 60 * 1000)

  // 模拟电脑合盖休眠后直接唤醒（时间跨过剩余 15 分钟），tick 立即准确进入 short_break
  const tickRes = engine.tick(tResume + 16 * 60 * 1000)
  assert.equal(tickRes.transitioned, true)
  assert.equal(tickRes.state.phase, 'short_break')
  assert.equal(tickRes.state.completedCycles, 1)
  assert.equal(notifications.length, 1)

  // 连续完成第 4 个番茄钟后进入 15 分钟 long_break
  const engine4 = new PomodoroTimerEngine({ completedCycles: 3 })
  engine4.startFocus(t0, FOCUS_DURATION_MS)
  const tick4 = engine4.tick(t0 + FOCUS_DURATION_MS + 1000)
  assert.equal(tick4.state.phase, 'long_break')
  assert.equal(tick4.remainingMs, LONG_BREAK_DURATION_MS)

  // 2. 跨月循环倒数日边界钳位测试（每月 31 号发薪日在平年 2 月自动对齐至 2026-02-28，绝不产生 NaN）
  const febCalc = calculateDaysLeft('2026-01-31', true, '2026-02-10')
  assert.equal(febCalc.resolvedDate, '2026-02-28')
  assert.equal(febCalc.days, 18)

  // 3. 异常场景：非法日期 (2026-02-30) 与空标题拦截
  const invalidFeb30 = validateCountdownInput({ title: '测试', targetDate: '2026-02-30' })
  assert.equal(invalidFeb30.valid, false)
  assert.match(invalidFeb30.error, /不存在第 30 日/)
  assert.throws(() => calculateDaysLeft('2026-02-30', false, '2026-02-01'), /INVALID_DATE/)

  const sorted = enrichAndSortCountdowns(DEFAULT_COUNTDOWNS, '2026-10-25')
  assert.equal(sorted.length, DEFAULT_COUNTDOWNS.length)
})
