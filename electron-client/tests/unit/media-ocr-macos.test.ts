import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { createMacOcrPorts, type MacOcrPorts } from '../../src/main/platform/macos/mac-ocr.js'
import { captureRegionPng, createRegionSelector, type RegionSelectorPort } from '../../src/main/platform/region-capture.js'
import { joinWindowsOcrWords, MediaOcrHostPluginHandler, type MediaOcrHostDeps } from '../../src/main/services/host-plugins/media-ocr-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
import type { ScreenRectangle } from '../../src/main/services/screen-service.js'

const ctx: HostPluginContext = { clipboard: null, processService: null, windowControl: null,
  authorizeExistingPath: async value => value, authorizeOutputPath: async value => value }
type OcrResult = { ok: boolean; text?: string; error?: string; canceled?: boolean; empty?: boolean; engine?: string }

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try { return await run() } finally { Object.defineProperty(process, 'platform', original) }
}

/** 记录调用的识别替身；tesseract 等外部命令一旦被调用就失败 */
function fakeMacOcr(overrides: Partial<MacOcrPorts & RegionSelectorPort> = {}) {
  const calls = { recognize: [] as Array<{ bytes: Buffer; languages: readonly string[] }>, select: 0, stop: 0 }
  const ports: MacOcrPorts & RegionSelectorPort = {
    async recognizeLocal(image, languages) { calls.recognize.push({ bytes: image, languages }); return { text: '  识别结果\nSecond line  ' } },
    async selectScreenRegion() { calls.select++; return { x: -100, y: 20, width: 300, height: 120 } },
    async stop() { calls.stop++ },
    ...overrides
  }
  return { ports, calls }
}

/** 测试替身同时实现识别与框选：未单独指定 regionSelector 时沿用 macOcr */
function handlerWith(deps: Partial<MediaOcrHostDeps>) {
  const commands: string[][] = []
  const regionSelector = 'regionSelector' in deps ? deps.regionSelector : deps.macOcr as (MacOcrPorts & RegionSelectorPort) | undefined
  const handler = new MediaOcrHostPluginHandler(ctx, {
    regionSelector,
    runCommand: async (command, args) => { commands.push([command, ...args]); return { exitCode: 1, stdout: '', stderr: 'not expected' } },
    runPowerShell: async () => { throw new Error('macOS 不能调用 PowerShell') },
    ...deps
  })
  return { handler, commands }
}

async function withImage<T>(bytes: Buffer | number, run: (image: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-mac-ocr-unit-'))
  const image = path.join(dir, 'scan.png')
  if (typeof bytes === 'number') { const handle = await fs.open(image, 'w'); await handle.truncate(bytes); await handle.close() } else await fs.writeFile(image, bytes)
  try { return await run(image, dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('macOS 图片识别走本机 Vision，按语言映射且不回退 tesseract/PowerShell', async () => {
  await withImage(Buffer.from('png-bytes'), image => onPlatform('darwin', async () => {
    const { ports, calls } = fakeMacOcr()
    const { handler, commands } = handlerWith({ macOcr: ports })
    const expected: Record<string, string[]> = { 'zh-Hans-CN': ['zh-Hans', 'en-US'], 'en-US': ['en-US'], 'ja-JP': ['ja-JP', 'en-US'], 'ko-KR': ['ko-KR', 'en-US'] }
    for (const [lang, languages] of Object.entries(expected)) {
      const result = await handler.handleOcr('recognizeImage', { path: image, lang }) as OcrResult
      assert.deepEqual({ ok: result.ok, text: result.text, engine: result.engine }, { ok: true, text: '识别结果\nSecond line', engine: 'Apple Vision' })
      assert.deepEqual(calls.recognize.at(-1)?.languages, languages)
      assert.equal(calls.recognize.at(-1)?.bytes.toString(), 'png-bytes')
    }
    const unsupported = await handler.handleOcr('recognizeImage', { path: image, lang: 'fr-FR' }) as OcrResult
    assert.equal(unsupported.ok, false)
    assert.match(unsupported.error ?? '', /不支持的 OCR 语言/)
    assert.deepEqual(commands, [])
  }))
})

test('macOS 识别失败如实返回：空文字、Vision 报错、取消、超过 16 MB、组件缺失', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('darwin', async () => {
    const empty = handlerWith({ macOcr: fakeMacOcr({ recognizeLocal: async () => ({ text: ' \n ' }) }).ports }).handler
    assert.deepEqual(await empty.handleOcr('recognizeImage', { path: image }), { ok: false, success: false, empty: true, error: '没有识别到文字' })

    const broken = handlerWith({ macOcr: fakeMacOcr({ recognizeLocal: async () => { throw new ZToolsError(errorCodes.invalidRequest, '当前Vision版本不支持所选语言') } }).ports }).handler
    const failure = await broken.handleOcr('recognizeImage', { path: image, lang: 'ko-KR' }) as OcrResult
    assert.deepEqual([failure.ok, failure.error], [false, '当前Vision版本不支持所选语言'])

    const controller = new AbortController()
    const aborting = handlerWith({ macOcr: fakeMacOcr({ recognizeLocal: async () => { controller.abort(); throw new ZToolsError(errorCodes.callerDestroyed, '本地OCR已取消') } }).ports }).handler
    assert.equal((await aborting.handleOcr('recognizeImage', { path: image }, undefined, controller.signal) as OcrResult).error, 'OCR 识别已取消')

    const missing = handlerWith({ macOcr: undefined }).handler
    assert.match((await missing.handleOcr('recognizeImage', { path: image }) as OcrResult).error ?? '', /本地文字识别组件不可用/)
  }))
  await withImage(16 * 1024 * 1024 + 1, image => onPlatform('darwin', async () => {
    const { ports, calls } = fakeMacOcr()
    const result = await handlerWith({ macOcr: ports }).handler.handleOcr('recognizeImage', { path: image }) as OcrResult
    assert.deepEqual([result.ok, result.error], [false, '图片超过 16 MB，无法识别'])
    assert.equal(calls.recognize.length, 0, '超限图片不能读入内存交给识别组件')
  }))
})

test('识别剪贴板图片：没有图片明确报错；有图片时写临时文件识别后删除', async () => {
  await onPlatform('darwin', async () => {
    const { ports, calls } = fakeMacOcr()
    const none = handlerWith({ macOcr: ports, readClipboardImage: () => undefined }).handler
    assert.deepEqual(await none.handleOcr('recognizeClipboard', {}), { ok: false, success: false, error: '剪贴板里没有图片' })
    assert.equal(calls.recognize.length, 0)

    const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('ztools_ocr_clip_')))
    const withImageHandler = handlerWith({ macOcr: ports, readClipboardImage: () => Buffer.from('clipboard-png') }).handler
    const result = await withImageHandler.handleOcr('recognizeClipboard', { lang: 'en-US' }) as OcrResult
    assert.equal(result.ok, true)
    assert.equal(calls.recognize.at(-1)?.bytes.toString(), 'clipboard-png')
    const leftovers = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('ztools_ocr_clip_') && !before.has(name))
    assert.deepEqual(leftovers, [], '剪贴板临时图片必须删除')
  })
})

test('框选识字：取消不当失败、无屏幕录制权限先拒绝、成功按所选区域截屏识别并清理临时图', async () => {
  await onPlatform('darwin', async () => {
    const captured: Array<{ rect: ScreenRectangle; file: string }> = []
    const capture = async (rect: ScreenRectangle, file: string) => { captured.push({ rect, file }); await fs.writeFile(file, 'region'); return true }

    const denied = fakeMacOcr()
    const deniedResult = await handlerWith({ macOcr: denied.ports, captureScreenRegionToPng: capture, screenCapturePermission: () => 'denied' })
      .handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.equal(deniedResult.ok, false)
    assert.match(deniedResult.error ?? '', /屏幕录制权限/)
    assert.equal(denied.calls.select, 0, '没有权限时不能弹出框选遮罩')

    const cancel = fakeMacOcr({ selectScreenRegion: async () => undefined })
    assert.deepEqual(await handlerWith({ macOcr: cancel.ports, captureScreenRegionToPng: capture, screenCapturePermission: () => 'granted' })
      .handler.handleOcr('captureRegionAndRecognize', {}), { ok: false, success: false, canceled: true, error: '已取消框选' })
    assert.equal(captured.length, 0)

    const ok = fakeMacOcr()
    const result = await handlerWith({ macOcr: ok.ports, captureScreenRegionToPng: capture, screenCapturePermission: () => 'not-determined' })
      .handler.handleOcr('captureRegionAndRecognize', { lang: 'ja-JP' }) as OcrResult
    assert.deepEqual([result.ok, result.text], [true, '识别结果\nSecond line'])
    assert.deepEqual(captured[0]?.rect, { x: -100, y: 20, width: 300, height: 120 })
    assert.equal(ok.calls.recognize[0]?.bytes.toString(), 'region')
    assert.deepEqual(ok.calls.recognize[0]?.languages, ['ja-JP', 'en-US'])
    await assert.rejects(fs.access(captured[0]!.file), '框选截图识别后必须删除')

    const notCaptured = await handlerWith({ macOcr: fakeMacOcr().ports, captureScreenRegionToPng: async () => false })
      .handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.deepEqual([notCaptured.ok, notCaptured.error], [false, '截取所选区域失败'])
  })
})

test('框选识字：进行中再次触发被拒绝；中途取消返回 canceled；Windows 明确不支持', async () => {
  await onPlatform('darwin', async () => {
    let release!: (rect: ScreenRectangle | undefined) => void
    const pendingSelect = fakeMacOcr({ selectScreenRegion: () => new Promise(resolve => { release = resolve }) })
    const { handler } = handlerWith({ macOcr: pendingSelect.ports })
    const first = handler.handleOcr('captureRegionAndRecognize', {})
    const second = await handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.match(second.error ?? '', /正在框选识别/)
    release(undefined)
    assert.equal((await first as OcrResult).canceled, true)
    // 第一次结束后可以再次框选
    const again = handler.handleOcr('captureRegionAndRecognize', {})
    release(undefined)
    assert.equal((await again as OcrResult).canceled, true)

    const controller = new AbortController()
    const aborted = fakeMacOcr({ selectScreenRegion: async () => { controller.abort(); throw new ZToolsError(errorCodes.callerDestroyed, '区域选择已取消') } })
    const result = await handlerWith({ macOcr: aborted.ports }).handler.handleOcr('captureRegionAndRecognize', {}, undefined, controller.signal) as OcrResult
    assert.deepEqual([result.ok, result.canceled], [false, true])

    const failing = fakeMacOcr({ selectScreenRegion: async () => { throw new ZToolsError(errorCodes.screenError, '显示器布局已更改，请重新选择') } })
    assert.equal((await handlerWith({ macOcr: failing.ports }).handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult).error, '显示器布局已更改，请重新选择')
  })
  await onPlatform('linux', async () => {
    const { ports, calls } = fakeMacOcr()
    const result = await handlerWith({ macOcr: ports }).handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.deepEqual([result.ok, result.error], [false, '当前系统暂不支持框选识别'])
    assert.equal(calls.select, 0)
  })
  await onPlatform('darwin', async () => {
    const result = await handlerWith({ macOcr: fakeMacOcr().ports, regionSelector: undefined }).handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.deepEqual([result.ok, result.error], [false, '当前系统暂不支持框选识别'])
  })
})

test('宿主退出时关闭仍打开的框选遮罩', async () => {
  const { ports, calls } = fakeMacOcr()
  await handlerWith({ macOcr: ports }).handler.stop()
  assert.equal(calls.stop, 1)
  const failing = fakeMacOcr({ stop: async () => { throw new Error('遮罩关闭未确认') } })
  await handlerWith({ macOcr: failing.ports }).handler.stop()
})

test('Mac 识别端口：校验图片大小与 Vision 返回，框选使用全部显示器的副本', async () => {
  const runs: unknown[] = []
  let response: unknown = { version: 1, success: true, text: 'abc' }
  const selected: ScreenRectangle[][] = []
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: -1920, y: 0, width: 1920, height: 1080 }]
  const ports = createMacOcrPorts({ vision: { run: async request => { runs.push(request); return response } } })
  const selector = createRegionSelector({
    regionSelection: { select: async bounds => { selected.push(bounds); bounds[0]!.x = 999; return undefined }, stop: async () => {} },
    getDisplayBounds: () => displays
  })
  assert.deepEqual(await ports.recognizeLocal(Buffer.from('img'), ['en-US']), { text: 'abc' })
  assert.deepEqual(runs[0], { version: 1, operation: 'recognize', imageBase64: Buffer.from('img').toString('base64'), languages: ['en-US'] })
  await assert.rejects(ports.recognizeLocal(Buffer.alloc(0), []), { code: 'INVALID_REQUEST' })
  await assert.rejects(ports.recognizeLocal(Buffer.alloc(16 * 1024 * 1024 + 1), []), { code: 'FILE_TOO_LARGE' })
  response = { version: 1, success: true }
  await assert.rejects(ports.recognizeLocal(Buffer.from('img'), []), { code: 'FILE_ERROR' })
  assert.equal(runs.length, 2, '超限或空图片不能交给识别组件')

  assert.equal(await selector.selectScreenRegion(), undefined)
  assert.equal(selected[0]?.length, 2)
  assert.equal(displays[0]!.x, 0, '框选组件拿到的是副本，不能改动显示器信息')
  const noDisplay = createRegionSelector({ regionSelection: { select: async () => undefined, stop: async () => {} }, getDisplayBounds: () => [] })
  await assert.rejects(noDisplay.selectScreenRegion(), { code: 'SCREEN_ERROR' })
})

test('image_ocr 请求只接受三种动作、绝对路径和已支持的语言，Windows 与 macOS 都开放', async () => {
  const { validateMethodParams } = await import('../../src/contracts/method-params.js')
  const { parseRequest } = await import('../../src/contracts/ipc.js')
  const { isPlatformSupportedMethod } = await import('../../src/contracts/capabilities.js')
  for (const params of [
    { action: 'recognizeImage', path: '/Users/me/a.png', lang: 'ja-JP' },
    { action: 'recognizeImage', path: 'C:\\Users\\me\\a.png' },
    { action: 'recognizeClipboard', lang: 'ko-KR' },
    { action: 'captureRegion' },
    { action: 'captureRegion', restoreWindow: false }
  ]) validateMethodParams('image_ocr', params)
  for (const params of [
    {}, { action: 'recognize' }, { action: 'recognizeImage' }, { action: 'recognizeImage', path: 'relative.png' },
    { action: 'recognizeImage', path: '/a\0.png' }, { action: 'captureRegion', path: '/a.png' },
    { action: 'recognizeClipboard', lang: 'fr-FR' }, { action: 'captureRegion', func: 'anything' }, null,
    { action: 'captureRegion', restoreWindow: 'yes' }, { action: 'recognizeClipboard', restoreWindow: true }
  ]) assert.throws(() => validateMethodParams('image_ocr', params as Record<string, unknown>), { code: 'INVALID_REQUEST' })
  assert.equal(isPlatformSupportedMethod('image_ocr', 'darwin'), true)
  assert.equal(isPlatformSupportedMethod('image_ocr', 'win32'), true)
  // 框选要等待用户操作，调用方可以把超时设到 3 分钟
  assert.equal(parseRequest({ messageId: 'ocr_1', method: 'image_ocr', params: { action: 'captureRegion' }, timeoutMs: 180_000 }).timeoutMs, 180_000)
})

test('框选前收起调用方窗口：截图完成后立即重新显示，不必等识别结束；无界面命令保持收起，取消和失败也会恢复', async () => {
  await onPlatform('darwin', async () => {
    const events: string[] = []
    const hideCallerWindow = () => { events.push('hide'); return () => { events.push('restore') } }
    const capture = async (_rect: ScreenRectangle, file: string) => { events.push('capture'); await fs.writeFile(file, 'region'); return true }
    const ok = fakeMacOcr({
      selectScreenRegion: async () => { events.push('select'); return { x: 0, y: 0, width: 10, height: 10 } },
      recognizeLocal: async () => { events.push('recognize'); return { text: '识别结果' } }
    })
    const handler = handlerWith({ macOcr: ok.ports, captureScreenRegionToPng: capture, hideCallerWindow }).handler

    await handler.handleOcr('captureRegionAndRecognize', { restoreWindow: true })
    assert.deepEqual(events.splice(0), ['hide', 'select', 'capture', 'restore', 'recognize'], '窗口要在弹出框选遮罩之前收起，并在截图完成后、识别开始前立即恢复')
    await handler.handleOcr('captureRegionAndRecognize', { restoreWindow: false })
    assert.deepEqual(events.splice(0), ['hide', 'select', 'capture', 'recognize'])

    const cancel = fakeMacOcr({ selectScreenRegion: async () => undefined })
    await handlerWith({ macOcr: cancel.ports, hideCallerWindow }).handler.handleOcr('captureRegionAndRecognize', { restoreWindow: true })
    assert.deepEqual(events.splice(0), ['hide', 'restore'])
    const broken = fakeMacOcr({ recognizeLocal: async () => { throw new Error('识别崩溃') } })
    await handlerWith({ macOcr: broken.ports, captureScreenRegionToPng: capture, hideCallerWindow: () => () => { throw new Error('窗口已销毁') } })
      .handler.handleOcr('captureRegionAndRecognize', { restoreWindow: true })
    assert.deepEqual(events.splice(0), ['capture'])

    const denied = await handlerWith({ macOcr: ok.ports, hideCallerWindow, screenCapturePermission: () => 'denied' }).handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult
    assert.equal(denied.ok, false)
    assert.deepEqual(events, [], '没有权限时不收起窗口')
  })
})


test('Windows 识别：去掉中文日文字间空格、保留韩文与英文空格，按行拼接，超大图先缩小', async () => {
  assert.equal(joinWindowsOcrWords('识 别 结 果'), '识别结果')
  assert.equal(joinWindowsOcrWords('合 同 编 号 A-17 金 额 300 元'), '合同编号 A-17 金额 300 元')
  assert.equal(joinWindowsOcrWords('こ ん に ち は 、 世 界'), 'こんにちは、世界')
  assert.equal(joinWindowsOcrWords('안녕하세요 세계'), '안녕하세요 세계')
  assert.equal(joinWindowsOcrWords('Hello world'), 'Hello world')
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    const scripts: string[] = []
    const { handler, commands } = handlerWith({ runPowerShell: async script => {
      scripts.push(script)
      return JSON.stringify({ text: '第 一 行 第 二 行 Line 3', lines: ['第 一 行', '第 二 行', 'Line 3'] })
    } })
    const result = await handler.handleOcr('recognizeImage', { path: image, lang: 'zh-Hans-CN' }) as OcrResult
    assert.deepEqual([result.ok, result.text, result.engine], [true, '第一行\n第二行\nLine 3', 'Windows.Media.Ocr'])
    assert.match(scripts[0]!, /MaxImageDimension/)
    assert.match(scripts[0]!, /BitmapTransform/)
    assert.deepEqual(commands, [], '系统识别成功时不调用 tesseract')
    // 只有一行时 PowerShell 可能把数组输出成字符串
    const single = handlerWith({ runPowerShell: async () => JSON.stringify({ text: '单 行', lines: '单 行' }) }).handler
    assert.equal((await single.handleOcr('recognizeImage', { path: image }) as OcrResult).text, '单行')
  }))
})

test('Windows 先用本机 PP-OCRv5：成功不调用系统识别，空结果直接提示，失败改用系统识别，韩文直接用系统识别', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    const calls: string[] = []
    const localOcr = (result: () => Promise<string[]>) => ({
      recognizeImage: async (imagePath: string) => { calls.push(imagePath); return result() },
      stop: () => undefined
    })
    const scripts: string[] = []
    const systemOcr = async (script: string) => { scripts.push(script); return JSON.stringify({ text: '系 统', lines: ['系 统'] }) }

    const ok = handlerWith({ localOcr: localOcr(async () => ['第一行', ' Second line ']), runPowerShell: systemOcr })
    const success = await ok.handler.handleOcr('recognizeImage', { path: image, lang: 'zh-Hans-CN' }) as OcrResult
    assert.deepEqual([success.ok, success.text, success.engine], [true, '第一行\n Second line', 'PP-OCRv5'])
    assert.deepEqual([calls, scripts, ok.commands], [[image], [], []])
    const info = await ok.handler.handleOcr('info', {}) as { engine?: string }
    assert.equal(info.engine, 'PP-OCRv5')

    const empty = handlerWith({ localOcr: localOcr(async () => ['  ']), runPowerShell: systemOcr })
    assert.deepEqual(await empty.handler.handleOcr('recognizeImage', { path: image, lang: 'en-US' }), { ok: false, success: false, empty: true, error: '没有识别到文字' })
    assert.equal(scripts.length, 0, '本机识别的空结果不是故障，不再调用系统识别')

    const broken = handlerWith({ localOcr: localOcr(async () => { throw new Error('文字识别进程意外退出') }), runPowerShell: systemOcr })
    const fallback = await broken.handler.handleOcr('recognizeImage', { path: image, lang: 'ja-JP' }) as OcrResult
    assert.deepEqual([fallback.ok, fallback.text, fallback.engine], [true, '系统', 'Windows.Media.Ocr'])
    assert.equal(scripts.length, 1)

    calls.length = 0
    const korean = handlerWith({ localOcr: localOcr(async () => ['不应调用']), runPowerShell: systemOcr })
    const ko = await korean.handler.handleOcr('recognizeImage', { path: image, lang: 'ko-KR' }) as OcrResult
    assert.deepEqual([ko.ok, ko.engine, calls.length], [true, 'Windows.Media.Ocr', 0])

    const allFailed = handlerWith({
      localOcr: localOcr(async () => { throw new Error('无法读取图片') }),
      runPowerShell: async () => { throw new Error('系统识别超时') }
    })
    const failed = await allFailed.handler.handleOcr('recognizeImage', { path: image }) as OcrResult
    assert.equal(failed.ok, false)
    assert.match(failed.error ?? '', /PP-OCRv5：无法读取图片；Windows.Media.Ocr：系统识别超时；Tesseract：/)
  }))
})

test('Windows 本机识别中取消：直接返回已取消，不改用系统识别', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    const controller = new AbortController()
    const scripts: string[] = []
    const { handler, commands } = handlerWith({
      localOcr: {
        recognizeImage: async () => { controller.abort(); throw new Error('OCR 识别已取消') },
        stop: () => undefined
      },
      runPowerShell: async script => { scripts.push(script); return '{}' }
    })
    assert.deepEqual(await handler.handleOcr('recognizeImage', { path: image }, undefined, controller.signal), { ok: false, success: false, error: 'OCR 识别已取消' })
    assert.deepEqual([scripts, commands], [[], []])
    const late = handlerWith({ localOcr: { recognizeImage: async () => { controller.abort(); return ['迟到的文字'] }, stop: () => undefined } })
    const lateController = controller
    assert.deepEqual(await late.handler.handleOcr('recognizeImage', { path: image }, undefined, lateController.signal), { ok: false, success: false, error: 'OCR 识别已取消' })
  }))
})

test('Windows 系统识别小字时放大再识别一次；宿主退出时结束本机识别进程', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    const scripts: string[] = []
    const { handler } = handlerWith({ runPowerShell: async script => { scripts.push(script); return JSON.stringify({ text: 'a', lines: ['a'] }) } })
    await handler.handleOcr('recognizeImage', { path: image })
    assert.match(scripts[0]!, /\$median -lt 20/)
    assert.match(scripts[0]!, /32\.0 \/ \$median/)
    assert.match(scripts[0]!, /BitmapInterpolationMode\]::Cubic/)
  }))
  let stopped = 0
  const { handler } = handlerWith({ localOcr: { recognizeImage: async () => [], stop: () => { stopped++ } } })
  await handler.stop()
  assert.equal(stopped, 1)
})

test('Windows 有效空结果直接提示没有文字，不调用回退引擎', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    for (const output of [{ text: '', lines: [] }, { text: ' \n ', lines: [' ', '\n'] }, { text: '', lines: '' }]) {
      const { handler, commands } = handlerWith({ runPowerShell: async () => JSON.stringify(output) })
      assert.deepEqual(await handler.handleOcr('recognizeImage', { path: image }), {
        ok: false, success: false, empty: true, error: '没有识别到文字'
      })
      assert.deepEqual(commands, [], '空图片不需要安装或调用 tesseract')
    }
  }))
})

test('Windows 异常输出不能冒充空图片或识别文字，仍按引擎故障处理', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    for (const output of ['', 'broken-json', 'null', '[]', '{}', '{"text":""}', '{"text":0,"lines":[]}', '{"text":"","lines":[null]}', '{"text":"","lines":[123]}', '{"ok":false,"text":"","lines":[]}']) {
      const { handler, commands } = handlerWith({ runPowerShell: async () => output })
      const result = await handler.handleOcr('recognizeImage', { path: image }) as OcrResult
      assert.equal(result.ok, false, output)
      assert.equal(result.empty, undefined, output)
      assert.equal(result.text, undefined, output)
      assert.match(result.error ?? '', /Windows.Media.Ocr：(?:输出格式异常|没有输出)/)
      assert.equal(commands.length, 1)
      assert.equal(commands[0]![0], 'tesseract')
    }
    const failure = handlerWith({ runPowerShell: async () => JSON.stringify({ ok: false, error: '无法读取图片' }) })
    const failed = await failure.handler.handleOcr('recognizeImage', { path: image }) as OcrResult
    assert.equal(failed.ok, false)
    assert.equal(failed.empty, undefined)
    assert.match(failed.error ?? '', /Windows.Media.Ocr：无法读取图片/)
    assert.equal(failure.commands.length, 1)
    const fallback = handlerWith({
      runPowerShell: async () => { throw new Error('系统识别超时') },
      runCommand: async () => ({ exitCode: 0, stdout: '回退引擎的文字', stderr: '' })
    }).handler
    const result = await fallback.handleOcr('recognizeImage', { path: image }) as OcrResult
    assert.deepEqual([result.ok, result.text, result.engine], [true, '回退引擎的文字', 'Tesseract-CLI'])
  }))
})

test('Windows 取消识别后忽略迟到的空结果和文字，不调用回退引擎', async () => {
  await withImage(Buffer.from('png'), image => onPlatform('win32', async () => {
    for (const text of ['', '迟到的文字']) {
      const controller = new AbortController()
      const { handler, commands } = handlerWith({ runPowerShell: async () => {
        controller.abort()
        return JSON.stringify({ text, lines: [text] })
      } })
      assert.deepEqual(await handler.handleOcr('recognizeImage', { path: image }, undefined, controller.signal), {
        ok: false, success: false, error: 'OCR 识别已取消'
      })
      assert.deepEqual(commands, [])
    }
  }))
})

test('Windows 框选空图片后清理临时文件、恢复窗口，并允许再次识别', async () => {
  await onPlatform('win32', async () => {
    const captures: string[] = []
    let restored = 0
    let output = { text: '', lines: [] as string[] }
    const { handler, commands } = handlerWith({
      regionSelector: { selectScreenRegion: async () => ({ x: 0, y: 0, width: 100, height: 40 }), stop: async () => {} },
      hideCallerWindow: () => () => { restored++ },
      captureScreenRegionToPng: async (_rect, file) => { captures.push(file); await fs.writeFile(file, 'png'); return true },
      runPowerShell: async () => JSON.stringify(output)
    })
    assert.equal((await handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult).empty, true)
    assert.equal(restored, 1)
    await assert.rejects(fs.stat(captures[0]!), { code: 'ENOENT' })
    output = { text: '下一次识别', lines: ['下一次识别'] }
    assert.equal((await handler.handleOcr('captureRegionAndRecognize', {}) as OcrResult).text, '下一次识别')
    assert.equal(restored, 2)
    await assert.rejects(fs.stat(captures[1]!), { code: 'ENOENT' })
    assert.deepEqual(commands, [])
  })
})

test('Windows 框选识字：收起窗口、框选、按物理像素截取后用系统文字识别', async () => {
  await onPlatform('win32', async () => {
    const events: string[] = []
    const selector: RegionSelectorPort = { selectScreenRegion: async () => { events.push('select'); return { x: 10, y: 20, width: 100, height: 40 } }, stop: async () => {} }
    const { handler } = handlerWith({
      regionSelector: selector,
      hideCallerWindow: () => { events.push('hide'); return () => events.push('restore') },
      captureScreenRegionToPng: async (rect, file) => { events.push(`capture ${rect.width}x${rect.height}`); await fs.writeFile(file, 'png'); return true },
      runPowerShell: async () => JSON.stringify({ text: '识 别', lines: ['识 别'] })
    })
    const result = await handler.handleOcr('captureRegionAndRecognize', { lang: 'zh-Hans-CN', restoreWindow: true }) as OcrResult
    assert.deepEqual([result.ok, result.text], [true, '识别'])
    assert.deepEqual(events, ['hide', 'select', 'capture 100x40', 'restore'])
  })
})

test('按物理像素截取区域：按缩略图实际尺寸换算，区域跨屏或找不到截图源时报错', async () => {
  const crops: Array<{ x: number; y: number; width: number; height: number }> = []
  const image = (width: number, height: number) => ({
    isEmpty: () => false, getSize: () => ({ width, height }),
    crop(rect: { x: number; y: number; width: number; height: number }) { crops.push(rect); return { ...image(rect.width, rect.height), toPNG: () => Buffer.from('cropped') } },
    toPNG: () => Buffer.from('full')
  })
  const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 }, { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 }]
  let requested: { width: number; height: number } | undefined
  const deps = { getAllDisplays: () => displays, getSources: async (size: { width: number; height: number }) => {
    requested = size
    return [{ display_id: '1', thumbnail: image(2880, 1620) }, { display_id: '2', thumbnail: image(1280, 1024) }]
  } }
  assert.equal((await captureRegionPng(deps, { x: 100, y: 50, width: 200, height: 100 })).toString(), 'cropped')
  assert.deepEqual(requested, { width: 2880, height: 1620 })
  assert.deepEqual(crops[0], { x: 150, y: 75, width: 300, height: 150 }, '150% 缩放下按物理像素截取')
  await captureRegionPng(deps, { x: 2000, y: 10, width: 50, height: 50 })
  assert.deepEqual(crops[1], { x: 80, y: 10, width: 50, height: 50 })
  await assert.rejects(captureRegionPng(deps, { x: 1900, y: 0, width: 100, height: 100 }), { code: 'SCREEN_ERROR' })
  await assert.rejects(captureRegionPng(deps, { x: 0, y: 0, width: 0, height: 10 }), { code: 'INVALID_REQUEST' })
  await assert.rejects(captureRegionPng({ getAllDisplays: () => displays, getSources: async () => [] }, { x: 0, y: 0, width: 10, height: 10 }), { code: 'SCREEN_ERROR' })
})
