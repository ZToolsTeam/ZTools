import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaOcrHostPluginHandler, type MediaOcrHostDeps } from '../../src/main/services/host-plugins/media-ocr-host.js'
import { buildMultiPagePdfFromStreams, PowerShellError, type HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

// 第四批：媒体处理器不再接受 __simulate*/mockDevices/simulateDisconnected 参数；真实分支用构造参数注入的替身测试。
type Result = { ok?: boolean; success: boolean; errorCode?: string; error?: string; [key: string]: unknown }
const ctx = { clipboard: null, processService: null, windowControl: null, authorizeExistingPath: async (p: string) => p, authorizeOutputPath: async (p: string) => p } as HostPluginContext
const handler = (deps: Partial<MediaOcrHostDeps>) => new MediaOcrHostPluginHandler(ctx, deps)
async function asPlatform<T>(platform: NodeJS.Platform, work: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}
const asWindows = <T>(work: () => Promise<T>) => asPlatform('win32', work)
async function withTempDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-legacy-media-'))
  try { await work(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
const ffmpegPresent: MediaOcrHostDeps['runCommand'] = async (command, args) =>
  command === 'ffmpeg' && args[0] === '-version' ? { stdout: 'ffmpeg version 7', stderr: '', exitCode: 0 } : { stdout: '', stderr: `未预设命令: ${command}`, exitCode: 1 }
/** 抓屏替身：写出给定内容（空字符串表示写出空文件），返回给定结果 */
const captureWriting = (content: string, result = true): MediaOcrHostDeps['captureScreenToPng'] => async (p) => { await fs.writeFile(p, content); return result }

/** ffmpeg 录制进程替身：onSpawn 决定启动后的行为，onQuit 决定收到 q 之后的行为 */
class FakeFfmpeg extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), { received: '', end: (chunk?: string) => { this.stdin.received += chunk ?? ''; this.onQuit?.(this) } })
  readonly stderr = new EventEmitter()
  killed = false
  onQuit?: (proc: FakeFfmpeg) => void
  constructor(readonly args: readonly string[]) { super() }
  get outputPath(): string { return this.args[this.args.length - 1]! }
  exit(code: number | null): void { setImmediate(() => this.emit('close', code)) }
  kill(): boolean { this.killed = true; this.exit(null); return true }
}
function fakeSpawner(setup: (proc: FakeFfmpeg) => void) {
  const spawned: FakeFfmpeg[] = []
  const spawnProcess: MediaOcrHostDeps['spawnProcess'] = (command, args) => {
    assert.equal(command, 'ffmpeg')
    const proc = new FakeFfmpeg(args)
    spawned.push(proc)
    setup(proc)
    return proc as unknown as ChildProcess
  }
  return { spawned, spawnProcess }
}

test('取色（Windows）：颜色只来自注入的 PowerShell 采样；失败、超时、畸形输出如实失败，不返回假颜色', async () => {
  await asWindows(async () => {
    const good = await handler({ runPowerShell: async () => '{"x":10,"y":20,"r":59,"g":130,"b":246}' }).handleColorPicker('pickColor', { __simulateSampleFailure: true, copyToClipboard: false }) as Result
    assert.equal(good.success, true); assert.equal(good.hex, '#3B82F6'); assert.equal(good.x, 10)
    // 坐标缺失时不能拿请求坐标或 0 顶替
    const noCoord = async () => '{"r":1,"g":2,"b":3}'
    for (const broken of [async () => { throw new PowerShellError(124, '') }, async () => { throw new PowerShellError(1, '拒绝访问') }, async () => '', async () => 'not json', async () => '{"x":1,"y":2,"r":"red","g":0,"b":0}', noCoord]) {
      const failed = await handler({ runPowerShell: broken }).handleColorPicker('pickColor', { x: 5, y: 6 }) as Result
      assert.equal(failed.success, false); assert.equal(failed.hex, undefined); assert.equal(failed.x, undefined); assert.match(failed.error!, /屏幕像素采样失败/)
    }
  })
})

test('音频设备旧接口：所有操作统一提示更新插件，不读系统、不编造设备与音量、不把只改内存的操作报成功', async () => {
  let psCalls = 0
  const h = handler({ runPowerShell: async () => { psCalls++; return '[{"id":"win-out-1","volume":75,"isDefault":true}]' } })
  for (const platform of ['win32', 'darwin'] as const) {
    await asPlatform(platform, async () => {
      for (const [fn, params] of [
        ['listDevices', {}], ['list', { skipSystemScan: true }], ['getDevices', { mockDevices: [{ id: 'fake' }] }],
        ['setDefault', { id: 'win-out-2', type: 'output' }], ['setDefault', { id: '' }], ['setVolume', { id: 'win-out-1', volume: 30 }],
        ['setVolume', { volume: 'NaN' }], ['setMute', { id: 'win-out-1', muted: true }], ['toggleMute', {}], ['unknownFn', {}]
      ] as const) {
        const res = await h.handleAudioDevice(fn, { ...params }) as Result
        assert.equal(res.ok, false, fn); assert.equal(res.success, false, fn)
        assert.equal(res.errorCode, 'UNSUPPORTED_ACTION', fn)
        assert.match(res.error!, /请更新音频设备插件/)
        for (const fabricated of ['devices', 'volume', 'muted', 'id', 'type']) assert.equal(res[fabricated], undefined, `${fn} 不应返回 ${fabricated}`)
      }
    })
  }
  assert.equal(psCalls, 0)
  // 旧实现 setVolume 后会把内存里的音量带进下一次列表；现在没有任何内存状态可以残留
  assert.equal(((await h.handleAudioDevice('listDevices', {})) as Result).devices, undefined)
})

test('批量转码：ffmpeg 是否可用与转码结果都来自注入的命令执行器；转码失败不复制源文件', async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, 'in.mov'); await fs.writeFile(src, 'MOV')
    const calls: string[] = []
    const h = handler({ runCommand: async (command, args) => { calls.push([command, ...args].join(' ')); return args[0] === '-version' ? { stdout: 'ffmpeg version 7', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'Invalid data found when processing input', exitCode: 1 } } })
    const failed = await h.handleBatchMedia('BatchVideoPlugin', 'transcode', { files: [src], format: 'mp4', outputDir: dir, __simulateNoFfmpeg: true }) as Result
    assert.equal(failed.success, false); assert.match(failed.error!, /Invalid data/)
    assert.deepEqual(calls, ['ffmpeg -version', `ffmpeg -y -i ${src} ${path.join(dir, 'in_processed.mp4')}`])
    await assert.rejects(fs.stat(path.join(dir, 'in_processed.mp4')))
  })
})

test('录屏 PNG 单帧：开始时先抓一帧，抓屏返回失败、抛错或写出空文件都直接失败，不进入录制状态、不留临时文件、不覆盖旧文件', async () => {
  await withTempDir(async (dir) => {
    const out = path.join(dir, 'shot.png')
    const failures: Array<[MediaOcrHostDeps['captureScreenToPng'], RegExp]> = [
      [async () => false, /未生成有效输出文件/],
      [captureWriting('PARTIAL', false), /未生成有效输出文件/],
      [async () => { throw new PowerShellError(1, '拒绝访问') }, /拒绝访问/],
      [captureWriting(''), /未生成有效输出文件/]
    ]
    for (const [captureScreenToPng, expected] of failures) {
      let ffmpegChecked = false
      const rec = handler({ captureScreenToPng, runCommand: async () => { ffmpegChecked = true; return { stdout: '', stderr: '', exitCode: 0 } }, spawnProcess: () => { throw new Error('PNG 模式不应启动 ffmpeg') } })
      const start = await rec.handleRecord('startRecording', { type: 'video', outputPath: out }) as Result
      assert.equal(start.success, false); assert.equal(start.recording, false); assert.equal(start.sessionId, undefined)
      assert.match(start.error!, expected)
      assert.equal(ffmpegChecked, false)
      assert.equal(((await rec.handleRecord('status', {})) as Result).recording, false)
      assert.deepEqual(await fs.readdir(dir), [], '失败后不能留下截图或临时文件')
      const stop = await rec.handleRecord('stopRecording', {}) as Result
      assert.equal(stop.success, false); assert.match(stop.error!, /没有正在进行的录制/)
    }
    // 目标位置已有旧文件：抓屏失败时旧文件保持原样，也不能被当成本次结果
    await fs.writeFile(out, 'OLD_FILE')
    const keep = await handler({ captureScreenToPng: async () => false }).handleRecord('startRecording', { outputPath: out }) as Result
    assert.equal(keep.success, false)
    assert.equal(await fs.readFile(out, 'utf8'), 'OLD_FILE')
    assert.deepEqual(await fs.readdir(dir), ['shot.png'])
    // 成功：开始即写出帧，停止时核对文件
    const rec = handler({ captureScreenToPng: captureWriting('PNG_FRAME') })
    const start = await rec.handleRecord('startRecording', { outputPath: out }) as Result
    assert.equal(start.success, true); assert.equal(start.recording, true); assert.equal(start.sizeBytes, 9)
    assert.equal(await fs.readFile(out, 'utf8'), 'PNG_FRAME')
    const stop = await rec.handleRecord('stopRecording', { sessionId: start.sessionId }) as Result
    assert.equal(stop.success, true); assert.equal(stop.outputPath, out); assert.equal(stop.sizeBytes, 9)
    assert.deepEqual(await fs.readdir(dir), ['shot.png'])
  })
})

test('截图：使用抓屏结果而不是检查目标文件是否存在；失败时旧文件保留且不报成功', async () => {
  await withTempDir(async (dir) => {
    const out = path.join(dir, 'screen.png')
    await fs.writeFile(out, 'OLD')
    for (const captureScreenToPng of [async () => false, async () => { throw new PowerShellError(124, '') }, captureWriting('')]) {
      const res = await handler({ captureScreenToPng }).handleRecord('captureScreen', { outputPath: out }) as Result
      assert.equal(res.success, false); assert.equal(res.outputPath, undefined)
      assert.equal(await fs.readFile(out, 'utf8'), 'OLD')
      assert.deepEqual(await fs.readdir(dir), ['screen.png'])
    }
    const ok = await handler({ captureScreenToPng: captureWriting('NEWSHOT') }).handleScreenshots('takeScreenshot', { outputPath: out }) as Result
    assert.equal(ok.success, true); assert.equal(ok.sizeBytes, 7)
    assert.equal(await fs.readFile(out, 'utf8'), 'NEWSHOT')
  })
})

test('录屏视频（Windows）：ffmpeg 正常运行时开始成功；收到 q 正常退出才把临时文件替换为目标文件', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const out = path.join(dir, 'clip.mp4')
    const { spawned, spawnProcess } = fakeSpawner((proc) => {
      proc.onQuit = async (p) => { await fs.writeFile(p.outputPath, 'MP4_WITH_MOOV'); p.exit(0) }
    })
    const rec = handler({ runCommand: ffmpegPresent, spawnProcess })
    const start = await rec.handleRecord('startRecording', { type: 'video', outputPath: out, fps: 24 }) as Result
    assert.equal(start.success, true); assert.equal(start.recording, true)
    assert.equal(spawned.length, 1)
    const args = spawned[0]!.args
    assert.ok(args.includes('gdigrab') && args.includes('24'))
    assert.notEqual(spawned[0]!.outputPath, out, 'ffmpeg 先写临时文件')
    assert.equal(path.dirname(spawned[0]!.outputPath), dir)
    const stop = await rec.handleRecord('stopRecording', { sessionId: start.sessionId }) as Result
    assert.equal(spawned[0]!.stdin.received, 'q'); assert.equal(spawned[0]!.killed, false)
    assert.equal(stop.success, true); assert.equal(stop.outputPath, out); assert.equal(stop.sizeBytes, 13)
    assert.equal(await fs.readFile(out, 'utf8'), 'MP4_WITH_MOOV')
    assert.deepEqual(await fs.readdir(dir), ['clip.mp4'])
  }))
})

test('录屏视频（Windows）：ffmpeg 立即退出、spawn 报错、无 ffmpeg、录音、非 Windows 都在开始阶段如实失败', async () => {
  await withTempDir(async (dir) => {
    const out = path.join(dir, 'clip.mp4')
    await asWindows(async () => {
      // 参数或输出格式错误：ffmpeg 立即退出，错误输出带回给调用方
      const quick = fakeSpawner((proc) => { setImmediate(() => { proc.stderr.emit('data', Buffer.from('Could not find output format')); proc.exit(1) }) })
      const early = await handler({ runCommand: ffmpegPresent, spawnProcess: quick.spawnProcess }).handleRecord('startRecording', { outputPath: out }) as Result
      assert.equal(early.success, false); assert.equal(early.recording, false)
      assert.match(early.error!, /立即退出（退出码 1）.*Could not find output format/)
      assert.deepEqual(await fs.readdir(dir), [])
      // spawn 异步报错（ENOENT）：不会变成未捕获异常
      const enoent = fakeSpawner((proc) => { setImmediate(() => proc.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }))) })
      const spawnErr = await handler({ runCommand: ffmpegPresent, spawnProcess: enoent.spawnProcess }).handleRecord('startRecording', { outputPath: out }) as Result
      assert.equal(spawnErr.success, false); assert.match(spawnErr.error!, /ENOENT/)
      // spawn 同步抛错
      const thrown = await handler({ runCommand: ffmpegPresent, spawnProcess: () => { throw new Error('EINVAL') } }).handleRecord('startRecording', { outputPath: out }) as Result
      assert.equal(thrown.success, false); assert.match(thrown.error!, /启动 ffmpeg 录制进程失败：EINVAL/)
      // 没有 ffmpeg（含超时 124）
      for (const exitCode of [127, 124]) {
        const none = await handler({ runCommand: async () => ({ stdout: '', stderr: '', exitCode }), spawnProcess: () => { throw new Error('不应启动') } }).handleRecord('startRecording', { outputPath: out }) as Result
        assert.equal(none.success, false); assert.match(none.error!, /未检测到 ffmpeg/)
      }
      // 录音：gdigrab 只能抓画面，直接拒绝
      const audio = await handler({ runCommand: ffmpegPresent, spawnProcess: () => { throw new Error('不应启动') } }).handleRecord('startRecording', { sourceModeId: 'rec-wasapi-audio', type: 'audio', saveDir: dir }) as Result
      assert.equal(audio.success, false); assert.equal(audio.errorCode, 'UNSUPPORTED_ACTION')
    })
    await asPlatform('darwin', async () => {
      const mac = await handler({ runCommand: ffmpegPresent, spawnProcess: () => { throw new Error('不应启动') } }).handleRecord('startRecording', { outputPath: out }) as Result
      assert.equal(mac.success, false); assert.match(mac.error!, /只支持在 Windows/)
    })
    assert.deepEqual(await fs.readdir(dir), [])
  })
})

test('录屏视频（Windows）：停止时 ffmpeg 异常退出或不响应 q 都如实失败并丢弃不完整文件；会话号不存在时不误停其他会话', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const out = path.join(dir, 'clip.mp4')
    // 收到 q 后以非零退出码结束（例如磁盘写满）
    const bad = fakeSpawner((proc) => { proc.onQuit = async (p) => { await fs.writeFile(p.outputPath, 'TRUNCATED'); p.stderr.emit('data', 'No space left on device'); p.exit(255) } })
    const rec = handler({ runCommand: ffmpegPresent, spawnProcess: bad.spawnProcess })
    const start = await rec.handleRecord('startRecording', { outputPath: out }) as Result
    assert.equal(start.success, true)
    // 指定的会话号不存在：不能结束正在进行的会话
    const wrong = await rec.handleRecord('stopRecording', { sessionId: 'rec-missing' }) as Result
    assert.equal(wrong.success, false); assert.match(wrong.error!, /录制会话不存在/)
    assert.equal(bad.spawned[0]!.stdin.received, '')
    assert.equal(((await rec.handleRecord('status', {})) as Result).recording, true)
    const stop = await rec.handleRecord('stopRecording', {}) as Result
    assert.equal(stop.success, false); assert.match(stop.error!, /退出码 255.*No space left/)
    assert.deepEqual(await fs.readdir(dir), [])

    // 不响应 q：限时后强制结束，结果判为失败
    const hang = fakeSpawner((proc) => { proc.onQuit = async (p) => { await fs.writeFile(p.outputPath, 'NO_MOOV') } })
    const rec2 = handler({ runCommand: ffmpegPresent, spawnProcess: hang.spawnProcess })
    const start2 = await rec2.handleRecord('startRecording', { outputPath: out }) as Result
    assert.equal(start2.success, true)
    const stop2 = await rec2.handleRecord('stopRecording', { sessionId: start2.sessionId }) as Result
    assert.equal(hang.spawned[0]!.killed, true)
    assert.equal(stop2.success, false); assert.match(stop2.error!, /未能在限定时间内正常结束/)
    assert.deepEqual(await fs.readdir(dir), [])
  }))
})

test('宿主关闭：正在录制的 ffmpeg 收到 q 正常收尾，不是直接结束进程', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const out = path.join(dir, 'clip.mp4')
    const { spawned, spawnProcess } = fakeSpawner((proc) => { proc.onQuit = async (p) => { await fs.writeFile(p.outputPath, 'DONE'); p.exit(0) } })
    const rec = handler({ runCommand: ffmpegPresent, spawnProcess })
    assert.equal(((await rec.handleRecord('startRecording', { outputPath: out })) as Result).success, true)
    await rec.stop()
    assert.equal(spawned[0]!.stdin.received, 'q'); assert.equal(spawned[0]!.killed, false)
    assert.equal(await fs.readFile(out, 'utf8'), 'DONE')
    assert.equal(((await rec.handleRecord('status', {})) as Result).recording, false)
  }))
})

test('PDF 旧接口：提取不到文字、转图片、转换非文本文件、中文或超长文本都如实失败，不写占位内容', async () => {
  await withTempDir(async (dir) => {
    const h = handler({})
    const noText = path.join(dir, 'scan.pdf')
    await fs.writeFile(noText, buildMultiPagePdfFromStreams(['q 100 0 0 100 0 0 cm /Im1 Do Q']))
    const txt = await h.handlePdf('pdfToTxt', { filePath: noText, outputPath: path.join(dir, 'scan.txt') }) as Result
    assert.equal(txt.success, false); assert.match(txt.error!, /未能从 PDF 中提取到文字/); assert.equal(txt.text, undefined)
    await assert.rejects(fs.stat(path.join(dir, 'scan.txt')))

    const toImage = await h.handlePdf('PdfToImage', { filePath: noText }) as Result
    assert.equal(toImage.errorCode, 'UNSUPPORTED_ACTION')
    await assert.rejects(fs.stat(path.join(dir, 'scan_output.pdf')), '不能输出一份 PDF 冒充转图片结果')

    const img = path.join(dir, 'photo.png'); await fs.writeFile(img, 'PNG')
    const docx = path.join(dir, 'report.docx'); await fs.writeFile(docx, 'DOCX')
    for (const [fn, files] of [['ImageToPdf', [img]], ['WordToPdf', [docx]]] as const) {
      const res = await h.handlePdf(fn, { files: [...files] }) as Result
      assert.equal(res.success, false, fn); assert.equal(res.errorCode, 'UNSUPPORTED_ACTION'); assert.match(res.error!, /只支持 \.txt/)
    }
    await assert.rejects(fs.stat(path.join(dir, 'photo_output.pdf')))
    await assert.rejects(fs.stat(path.join(dir, 'report_output.pdf')))

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ text: '   ' }, /没有可写入/],
      [{ text: '发票报销说明' }, /非 ASCII/],
      [{ text: Array.from({ length: 46 }, (_, i) => `line ${i}`).join('\n') }, /最多 45 行.*46 行/]
    ]
    for (const [params, expected] of cases) {
      const outputPath = path.join(dir, 'text.pdf')
      const res = await h.handlePdf('txtToPdf', { ...params, outputPath }) as Result
      assert.equal(res.success, false); assert.match(res.error!, expected)
      await assert.rejects(fs.stat(outputPath))
    }
    const ok = await h.handlePdf('txtToPdf', { text: 'Hello\tZTools', outputPath: path.join(dir, 'ok.pdf') }) as Result
    assert.equal(ok.success, true)
    assert.ok((await fs.readFile(path.join(dir, 'ok.pdf'), 'latin1')).includes('Hello    ZTools'))
  })
})

test('OCR（Windows）：Windows.Media.Ocr 失败、超时或输出异常时继续尝试 tesseract；两者都失败返回统一失败并带上两边原因', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const img = path.join(dir, 'scan.png'); await fs.writeFile(img, 'PNG')
    const tesseractOk: MediaOcrHostDeps['runCommand'] = async (command) =>
      command === 'tesseract' ? { stdout: '发票号码 123\n金额 45.00', stderr: '', exitCode: 0 } : { stdout: '', stderr: '', exitCode: 1 }
    const tesseractMissing: MediaOcrHostDeps['runCommand'] = async () => ({ stdout: '', stderr: 'spawn tesseract ENOENT', exitCode: 1 })
    // PowerShell 失败（第一批起 runPowerShell 非零退出即抛错）不能跳过 tesseract 兜底
    for (const brokenPs of [async () => { throw new PowerShellError(1, 'OcrEngine 不可用') }, async () => { throw new PowerShellError(124, '') }, async () => 'not json', async () => '{"text":"","lines":[]}']) {
      const ok = await handler({ runPowerShell: brokenPs, runCommand: tesseractOk }).handleOcr('recognize', { imagePath: img }) as Result
      assert.equal(ok.success, true); assert.equal(ok.engine, 'Tesseract-CLI'); assert.match(String(ok.text), /发票号码/)
    }
    const failed = await handler({ runPowerShell: async () => { throw new PowerShellError(1, 'OcrEngine 不可用') }, runCommand: tesseractMissing }).handleOcr('recognize', { imagePath: img }) as Result
    assert.equal(failed.ok, false); assert.equal(failed.success, false); assert.equal(failed.text, undefined)
    assert.match(failed.error!, /Windows\.Media\.Ocr：PowerShell 执行失败（退出码 1）：OcrEngine 不可用/)
    assert.match(failed.error!, /Tesseract：退出码 1：spawn tesseract ENOENT/)
    const malformed = await handler({ runPowerShell: async () => '<<garbage', runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }).handleOcr('recognize', { imagePath: img }) as Result
    assert.equal(malformed.success, false); assert.match(malformed.error!, /输出格式异常.*Tesseract：未识别到文字/)
    // Windows.Media.Ocr 识别成功时不调用 tesseract
    let tesseractCalls = 0
    const win = await handler({ runPowerShell: async () => '{"text":"Hello","lines":["Hello"]}', runCommand: async () => { tesseractCalls++; return { stdout: 'x', stderr: '', exitCode: 0 } } }).handleOcr('recognize', { imagePath: img }) as Result
    assert.equal(win.engine, 'Windows.Media.Ocr'); assert.equal(tesseractCalls, 0)
    // 已取消：不再尝试 tesseract
    const controller = new AbortController(); controller.abort()
    const cancelled = await handler({ runPowerShell: async () => { throw new PowerShellError(130, '') }, runCommand: async () => { tesseractCalls++; return { stdout: 'x', stderr: '', exitCode: 0 } } }).handleOcr('recognize', { imagePath: img }, undefined, controller.signal) as Result
    assert.equal(cancelled.success, false); assert.match(cancelled.error!, /已取消/); assert.equal(tesseractCalls, 0)
    assert.equal(await fs.readFile(img, 'utf8'), 'PNG', '调用方提供的图片不能被删除')
  }))
})

/** GDI+ 替身：从脚本里取出 Save 的目标（临时文件）写入内容，返回尺寸 JSON；记录收到的脚本 */
function gdiWriting(content: string, scripts: string[] = []): MediaOcrHostDeps['runPowerShell'] {
  return async (script) => {
    scripts.push(script)
    const format = /\$format = '([a-z]+)'/.exec(script)![1]!
    const target = new RegExp(`\\$format -eq '${format}'\\) \\{[\\s\\S]*?Save\\('((?:[^']|'')+)'`).exec(script)![1]!.replace(/''/g, "'")
    await fs.writeFile(target, content)
    return '{"width":640,"height":480}'
  }
}
/** ffmpeg 替身：-version 正常；转码时写出最后一个参数（输出文件）或按 exitCode 失败 */
function ffmpegWriting(content: string, calls: string[][] = [], exitCode = 0, stderr = ''): MediaOcrHostDeps['runCommand'] {
  return async (command, args) => {
    calls.push([command, ...args])
    if (command !== 'ffmpeg') return { stdout: '', stderr: 'unexpected', exitCode: 1 }
    if (exitCode !== 0) return { stdout: '', stderr, exitCode }
    await fs.writeFile(args[args.length - 1]!, content)
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

test('批量图片（Windows）：缩放预设、输出格式与源扩展名只接受白名单，注入内容不会进入 PowerShell 脚本', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const src = path.join(dir, 'photo.jpg'); await fs.writeFile(src, 'JPG')
    let psCalls = 0
    const counting: MediaOcrHostDeps['runPowerShell'] = async () => { psCalls++; return '' }
    const injected = "source'; Remove-Item -Recurse -Force C:\\Users; '"
    for (const params of [{ resizePreset: injected }, { resize: 'max9999' }, { outputFormat: "png'; calc; '" }, { format: 'heic' }]) {
      const res = await handler({ runPowerShell: counting, runCommand: ffmpegWriting('X') }).handleBatchImage('CompressImages', { files: [src], ...params }) as Result
      assert.equal(res.success, false); assert.equal(res.errorCode, 'INVALID_PARAMS'); assert.match(res.error!, /不支持的/)
    }
    // 保持原格式时扩展名来自源文件名：不在白名单内（含引号）同样拒绝
    const evil = path.join(dir, "evil.p'ng"); await fs.writeFile(evil, 'IMG')
    const heic = path.join(dir, 'live.heic'); await fs.writeFile(heic, 'HEIC')
    for (const file of [evil, heic]) {
      const res = await handler({ runPowerShell: counting, runCommand: ffmpegWriting('X') }).handleBatchImage('CompressImages', { files: [file], outputFormat: 'keep' }) as Result
      assert.equal(res.success, false); assert.match(res.error!, /不支持输出/)
    }
    assert.equal(psCalls, 0)
    // 合法取值：脚本里只出现白名单里的固定取值，写临时文件，成功后才替换目标文件
    const scripts: string[] = []
    const ok = await handler({ runPowerShell: gdiWriting('JPEG_DATA', scripts) }).handleBatchImage('CompressImages', { files: [src], resizePreset: 'MAX1920', outputDir: dir }) as Result
    assert.equal(ok.success, true, String(ok.error))
    assert.match(scripts[0]!, /\$preset = 'max1920'/); assert.match(scripts[0]!, /\$format = 'jpeg'/)
    assert.doesNotMatch(scripts[0]!, /'\.jpg' -eq/)
    assert.equal(await fs.readFile(path.join(dir, 'photo_opt.jpg'), 'utf8'), 'JPEG_DATA')
    assert.deepEqual((await fs.readdir(dir)).sort(), ['evil.p\'ng', 'live.heic', 'photo.jpg', 'photo_opt.jpg'])
    // 显式输出路径的扩展名与输出格式不一致：拒绝，不写出内容与扩展名不符的文件
    const mismatch = await handler({ runPowerShell: gdiWriting('PNG_DATA') }).handleBatchImage('CompressImages', { files: [src], outputFormat: 'png', outputPath: path.join(dir, 'out.gif') }) as Result
    assert.equal(mismatch.success, false); assert.match(mismatch.error!, /不一致/)
    await assert.rejects(fs.stat(path.join(dir, 'out.gif')))
  }))
})

test('批量图片（Windows）：GDI+ 打不开源图时交给 ffmpeg 并按同样预设处理；两者都失败才报错并带上两边原因，不留临时文件、不动旧文件', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const webp = path.join(dir, 'pic.webp'); await fs.writeFile(webp, 'RIFF_WEBP')
    const out = path.join(dir, 'pic_opt.png')
    const gdiFails: MediaOcrHostDeps['runPowerShell'] = async () => { throw new PowerShellError(1, '参数无效。') }
    // GDI+ 失败（第一批起 runPowerShell 直接抛错）不能跳过 ffmpeg 兜底
    const calls: string[][] = []
    const viaFfmpeg = await handler({ runPowerShell: gdiFails, runCommand: ffmpegWriting('PNG_FROM_FFMPEG', calls) }).handleBatchImage('enhanceDoc', { files: [webp], outputFormat: 'png', resizePreset: 'scale50' }) as Result
    assert.equal(viaFfmpeg.success, true, String(viaFfmpeg.error))
    assert.equal(await fs.readFile(out, 'utf8'), 'PNG_FROM_FFMPEG')
    const ffArgs = calls[0]!
    assert.equal(ffArgs[ffArgs.indexOf('-i') + 1], webp)
    assert.match(ffArgs[ffArgs.indexOf('-vf') + 1]!, /^scale=w=max\(1\\,trunc\(iw\/2\)\):h=max\(1\\,trunc\(ih\/2\)\),hue=s=0$/)
    assert.notEqual(ffArgs[ffArgs.length - 1], out, 'ffmpeg 先写临时文件')
    assert.deepEqual((await fs.readdir(dir)).sort(), ['pic.webp', 'pic_opt.png'])

    // 两者都失败：错误里同时有 GDI+ 与 ffmpeg 的原因；已有的旧输出文件保持原样
    await fs.writeFile(out, 'OLD_OUTPUT')
    const both = await handler({ runPowerShell: gdiFails, runCommand: ffmpegWriting('', [], 1, 'Invalid data found when processing input') }).handleBatchImage('CompressImages', { files: [webp], outputFormat: 'png' }) as Result
    assert.equal(both.success, false)
    assert.match(both.error!, /GDI\+：PowerShell 执行失败（退出码 1）：参数无效。；ffmpeg：退出码 1：Invalid data/)
    assert.equal(await fs.readFile(out, 'utf8'), 'OLD_OUTPUT')
    assert.deepEqual((await fs.readdir(dir)).sort(), ['pic.webp', 'pic_opt.png'])

    // PowerShell 正常退出却没有写出文件：同样交给 ffmpeg，不把旧文件当成结果
    const noFile = await handler({ runPowerShell: async () => '{"width":1,"height":1}', runCommand: ffmpegWriting('', [], 1, 'boom') }).handleBatchImage('CompressImages', { files: [webp], outputFormat: 'png' }) as Result
    assert.equal(noFile.success, false); assert.match(noFile.error!, /GDI\+：未生成输出文件/)
    assert.equal(await fs.readFile(out, 'utf8'), 'OLD_OUTPUT')
  }))
})

test('批量图片（Windows）：.jpeg 用 JPEG 编码器；GDI+ 不能编码的 webp 只交给 ffmpeg，ffmpeg 不可用时如实报不支持', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const jpeg = path.join(dir, 'cam.jpeg'); await fs.writeFile(jpeg, 'JPEG_SRC_LONGER_THAN_OUTPUT')
    const scripts: string[] = []
    const keep = await handler({ runPowerShell: gdiWriting('JPEG_OUT', scripts) }).handleBatchImage('CompressImages', { files: [jpeg], qualityTier: 'q70' }) as Result
    assert.equal(keep.success, true, String(keep.error))
    assert.match(scripts[0]!, /\$format = 'jpeg'/); assert.match(scripts[0]!, /\[long\]70\)/)
    assert.equal(await fs.readFile(path.join(dir, 'cam_opt.jpeg'), 'utf8'), 'JPEG_OUT')
    // gif / tiff 走 GDI+ 对应的编码器，不再一律存成 PNG
    for (const [fmt, encoder] of [['gif', 'gif'], ['tiff', 'tiff'], ['bmp', 'bmp']] as const) {
      const s: string[] = []
      const res = await handler({ runPowerShell: gdiWriting('DATA', s) }).handleBatchImage('CompressImages', { files: [jpeg], outputFormat: fmt }) as Result
      assert.equal(res.success, true, fmt); assert.match(s[0]!, new RegExp(`\\$format = '${encoder}'`))
    }

    let psCalls = 0
    const neverPs: MediaOcrHostDeps['runPowerShell'] = async () => { psCalls++; return '' }
    const calls: string[][] = []
    const webpOk = await handler({ runPowerShell: neverPs, runCommand: ffmpegWriting('WEBP_DATA', calls) }).handleBatchImage('CompressImages', { files: [jpeg], outputFormat: 'webp', qualityTier: 'q95' }) as Result
    assert.equal(webpOk.success, true, String(webpOk.error)); assert.equal(psCalls, 0)
    assert.equal(await fs.readFile(path.join(dir, 'cam_opt.webp'), 'utf8'), 'WEBP_DATA')
    assert.equal(calls[0]![calls[0]!.indexOf('-q:v') + 1], '95')
    assert.ok(calls[0]![calls[0]!.length - 1]!.endsWith('.webp'), '临时文件保留扩展名，ffmpeg 才会按 webp 编码')
    await fs.rm(path.join(dir, 'cam_opt.webp'))

    const noFfmpeg = await handler({ runPowerShell: neverPs, runCommand: async () => ({ stdout: '', stderr: 'spawn ffmpeg ENOENT', exitCode: 1 }) }).handleBatchImage('CompressImages', { files: [jpeg], outputFormat: 'webp' }) as Result
    assert.equal(noFfmpeg.success, false); assert.equal(psCalls, 0)
    assert.match(noFfmpeg.error!, /GDI\+：不支持编码 \.webp 格式；ffmpeg：本机未检测到 ffmpeg/)
    await assert.rejects(fs.stat(path.join(dir, 'cam_opt.webp')))
  }))
})

test('录屏视频（Windows）：不再带 -t 60 截断；调用方窗口关闭时自动发送 q 收尾保存，正常停止时取消监听', async () => {
  await asWindows(() => withTempDir(async (dir) => {
    const out = path.join(dir, 'long.mp4')
    const { spawned, spawnProcess } = fakeSpawner((proc) => { proc.onQuit = async (p) => { await fs.writeFile(p.outputPath, 'FULL_LENGTH'); p.exit(0) } })
    const watchers: Array<{ caller: unknown; onClosed: () => void; unwatched: boolean }> = []
    const watchCallerClosed: MediaOcrHostDeps['watchCallerClosed'] = (caller, onClosed) => {
      const w = { caller, onClosed, unwatched: false }
      watchers.push(w)
      return () => { w.unwatched = true }
    }
    const caller = { type: 'plugin', webContentsId: 42, pluginId: 'record' } as const
    const rec = handler({ runCommand: ffmpegPresent, spawnProcess, watchCallerClosed })
    const start = await rec.handleRecord('startRecording', { outputPath: out }, caller) as Result
    assert.equal(start.success, true)
    assert.equal(spawned[0]!.args.includes('-t'), false, '不能再用 -t 限制时长')
    assert.equal(start.maxDurationMs, undefined)
    assert.equal(watchers.length, 1); assert.equal(watchers[0]!.caller, caller)
    // 插件窗口关闭：没人会再调用停止，宿主发送 q 收尾并保存文件
    watchers[0]!.onClosed()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(spawned[0]!.stdin.received, 'q'); assert.equal(spawned[0]!.killed, false)
    assert.equal(await fs.readFile(out, 'utf8'), 'FULL_LENGTH')
    assert.equal(watchers[0]!.unwatched, true)
    assert.equal(((await rec.handleRecord('status', {})) as Result).recording, false)
    // 正常停止：监听被取消；之后窗口关闭的回调不会重复收尾
    const out2 = path.join(dir, 'second.mp4')
    const start2 = await rec.handleRecord('startRecording', { outputPath: out2 }, caller) as Result
    const stop2 = await rec.handleRecord('stopRecording', { sessionId: start2.sessionId }) as Result
    assert.equal(stop2.success, true); assert.equal(watchers[1]!.unwatched, true)
    watchers[1]!.onClosed()
    assert.equal(spawned[1]!.stdin.received, 'q')
    // 监听本身抛错：录制照常开始（仍可由停止指令或宿主退出收尾）
    const rec3 = handler({ runCommand: ffmpegPresent, spawnProcess, watchCallerClosed: () => { throw new Error('webContents 不可用') } })
    const start3 = await rec3.handleRecord('startRecording', { outputPath: path.join(dir, 'third.mp4') }, caller) as Result
    assert.equal(start3.success, true)
    assert.equal(((await rec3.handleRecord('stopRecording', {})) as Result).success, true)
    // 默认监听在没有 Electron 的环境（单元测试）里不监听，录制照常开始与停止
    const rec4 = handler({ runCommand: ffmpegPresent, spawnProcess })
    const start4 = await rec4.handleRecord('startRecording', { outputPath: path.join(dir, 'fourth.mp4') }, caller) as Result
    assert.equal(start4.success, true)
    assert.equal(((await rec4.handleRecord('stopRecording', {})) as Result).success, true)
  }))
})
