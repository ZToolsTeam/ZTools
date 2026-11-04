import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  arrangeLines,
  ctcDecode,
  detectionBoxes,
  detectionSize,
  minAreaRect,
  parseCharacterDictionary,
  recognitionInput,
  recognizeText,
  type BgraImage,
  type OcrModelRunner,
  type TextBox
} from '../../src/main/services/ocr/paddle-ocr-pipeline.js'
import {
  createLocalOcr,
  decodeImage,
  PaddleOcrEngine,
  paddleOcrModelsPresent,
  type DecodableImage,
  type OcrWorkerProcess
} from '../../src/main/services/ocr/paddle-ocr.js'
import type { PaddleOcrWorkerRequest, PaddleOcrWorkerResponse } from '../../src/main/services/ocr/paddle-ocr-protocol.js'

// 编译后位于 out-test/tests/unit，源码目录与模型目录按客户端根目录定位
const clientRoot = path.resolve(__dirname, '../../..')
const modelDirectory = path.join(clientRoot, 'out', 'ocr-models')
const workerEntry = path.resolve(__dirname, '../../src/main/services/ocr/paddle-ocr-worker.js')
const fixture = path.join(clientRoot, 'tests', 'fixtures', 'ocr', 'small-text-screenshot.png')

function box(cx: number, cy: number, w: number, h: number): TextBox {
  return { cx, cy, ux: 1, uy: 0, vx: 0, vy: 1, w, h }
}

function solidImage(width: number, height: number, value = 255): BgraImage {
  return { width, height, data: new Uint8Array(width * height * 4).fill(value) }
}

function readPng(file: string): BgraImage {
  const png = PNG.sync.read(fs.readFileSync(file))
  const data = new Uint8Array(png.width * png.height * 4)
  for (let i = 0; i < png.width * png.height; i++) {
    data[i * 4] = png.data[i * 4 + 2]!
    data[i * 4 + 1] = png.data[i * 4 + 1]!
    data[i * 4 + 2] = png.data[i * 4]!
    data[i * 4 + 3] = png.data[i * 4 + 3]!
  }
  return { width: png.width, height: png.height, data }
}

test('字典解析：保留全角空格等字符，只去掉末尾空行与 CRLF', () => {
  assert.deepEqual(parseCharacterDictionary('\u3000\r\n一\n乙\n'), ['\u3000', '一', '乙'])
  assert.deepEqual(parseCharacterDictionary('a\nb'), ['a', 'b'])
  assert.deepEqual(parseCharacterDictionary(''), [])
})

test('检测尺寸：小图最多放大 2 倍，大图总像素不超过 400 万，宽高取 32 的倍数', () => {
  assert.deepEqual(detectionSize(420, 92), { width: 832, height: 192 })
  assert.deepEqual(detectionSize(1349, 900), { width: 1344, height: 896 })
  const large = detectionSize(3840, 2160)
  assert.ok(large.width * large.height <= 4_100_000)
  assert.equal(large.width % 32, 0)
  assert.equal(large.height % 32, 0)
  assert.deepEqual(detectionSize(1, 1), { width: 32, height: 32 })
})

test('最小外接矩形：旋转 30° 的矩形求得原尺寸，轴规整为 u 朝右、v 朝下', () => {
  const angle = Math.PI / 6
  const corners = [[-50, -10], [50, -10], [50, 10], [-50, 10]].map(([x, y]) =>
    [200 + x! * Math.cos(angle) - y! * Math.sin(angle), 100 + x! * Math.sin(angle) + y! * Math.cos(angle)] as const)
  const rect = minAreaRect(corners)!
  assert.ok(Math.abs(rect.w - 100) < 1e-6 && Math.abs(rect.h - 20) < 1e-6)
  assert.ok(Math.abs(rect.cx - 200) < 1e-6 && Math.abs(rect.cy - 100) < 1e-6)
  assert.ok(rect.ux > 0 && Math.abs(Math.atan2(rect.uy, rect.ux) - angle) < 1e-6)
  assert.ok(Math.abs(rect.vx + rect.uy) < 1e-9 && Math.abs(rect.vy - rect.ux) < 1e-9)
  assert.equal(minAreaRect([]), undefined)
})

test('检测后处理：两块文字区域各得一个外扩后的框，低分与过小区域丢弃，尺寸不符报错', () => {
  const width = 200
  const height = 100
  const pred = new Float32Array(width * height)
  const fill = (x0: number, y0: number, x1: number, y1: number, value: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pred[y * width + x] = value
  }
  fill(10, 10, 109, 29, 0.9) // 100×20 的文字行
  fill(10, 60, 59, 79, 0.9) // 50×20 的文字行
  fill(150, 60, 189, 79, 0.4) // 过了二值化阈值但平均分低于 0.5
  fill(150, 10, 151, 11, 0.9) // 2×2 的噪点
  const boxes = detectionBoxes(pred, width, height).sort((a, b) => a.cy - b.cy)
  assert.equal(boxes.length, 2)
  const [first, second] = boxes as [TextBox, TextBox]
  assert.ok(Math.abs(first.cx - 59.5) < 0.6 && Math.abs(first.cy - 19.5) < 0.6)
  assert.ok(first.w > 99 + 2 * 6 && first.h > 19 + 2 * 6, '按 unclip 比例外扩')
  assert.ok(Math.abs(second.cx - 34.5) < 0.6 && Math.abs(second.cy - 69.5) < 0.6)
  assert.throws(() => detectionBoxes(new Float32Array(10), 5, 5), /输出尺寸与输入不一致/)
  assert.deepEqual(detectionBoxes(new Float32Array(width * height), width, height), [])
})

test('识别输入：高 48、最小宽 320，补零区为 0；竖排文字逆时针转 90°', () => {
  const image = solidImage(400, 100, 255)
  const horizontal = recognitionInput(image, box(100, 50, 96, 24))
  assert.equal(horizontal.width, 320)
  const plane = 48 * 320
  assert.equal(horizontal.data[0], 1, '白色归一化为 1')
  assert.equal(horizontal.data[plane - 1], 0, '右侧补零')
  assert.equal(horizontal.data.length, 3 * plane)
  const wide = recognitionInput(image, box(200, 50, 390, 20))
  assert.equal(wide.width, Math.ceil((48 * 390) / 20))
  // 竖排：上半黑、下半白；转 90° 后左侧是原来的上方
  const vertical: BgraImage = { width: 40, height: 200, data: new Uint8Array(40 * 200 * 4) }
  for (let y = 0; y < 200; y++) for (let x = 0; x < 40; x++) vertical.data.fill(y < 100 ? 0 : 255, (y * 40 + x) * 4, (y * 40 + x) * 4 + 4)
  const rotated = recognitionInput(vertical, box(20, 100, 40, 200))
  assert.equal(rotated.width, 320)
  assert.ok(rotated.data[24 * 320 + 5]! < -0.9, '左侧来自原图上方（黑）')
  assert.ok(rotated.data[24 * 320 + 235]! > 0.9, '右侧来自原图下方（白）')
})

test('CTC 解码：合并重复、去掉空白，末位类别是空格，分数取保留字符的平均', () => {
  const dictionary = ['甲', '乙']
  const classes = dictionary.length + 2
  const steps = [1, 1, 0, 1, 3, 2, 0, 0]
  const probs = new Float32Array(steps.length * classes)
  steps.forEach((k, t) => { probs[t * classes + k] = 0.8 })
  const decoded = ctcDecode(probs, steps.length, classes, dictionary)
  assert.equal(decoded.text, '甲甲 乙')
  assert.ok(Math.abs(decoded.score - 0.8) < 1e-6)
  assert.deepEqual(ctcDecode(new Float32Array(classes * 2).fill(0), 2, classes, dictionary), { text: '', score: 0 })
})

test('排版：同一行按横向顺序用空格隔开，全角标点处直接相连，不同行按纵向顺序', () => {
  const line = (text: string, cx: number, cy: number, h = 20) => ({ text, score: 0.9, box: box(cx, cy, 80, h) })
  assert.deepEqual(arrangeLines([
    line('Line 2', 50, 60),
    line('合同编号', 140, 21),
    line('文字识别：', 50, 19),
    line('A-17', 230, 20),
    line('（附件）', 320, 20),
    line('工作台', 50, 100),
    line('图片识字', 140, 100)
  ]), ['文字识别：合同编号 A-17（附件）', 'Line 2', '工作台 图片识字'])
  assert.deepEqual(arrangeLines([]), [])
})

test('完整流程：按批次识别并过滤低分结果；模型与字典不匹配、像素无效时报错', async () => {
  const dictionary = ['好']
  const calls: Array<{ batch: number; width: number }> = []
  const detectSize = detectionSize(200, 60)
  const runner = (classes: number, score: number): OcrModelRunner => ({
    async detect(_input, height, width) {
      assert.deepEqual({ height, width }, detectSize)
      const pred = new Float32Array(width * height)
      for (let y = 30; y < 70; y++) for (let x = 40; x < 300; x++) pred[y * width + x] = 0.9
      return pred
    },
    async recognize(_input, batch, height, width) {
      calls.push({ batch, width })
      assert.equal(height, 48)
      const data = new Float32Array(batch * 2 * classes)
      for (let n = 0; n < batch; n++) data[n * 2 * classes + 1] = score
      return { data, steps: 2, classes }
    }
  })
  assert.deepEqual(await recognizeText(solidImage(200, 60), runner(3, 0.9), dictionary), ['好'])
  assert.deepEqual(calls, [{ batch: 1, width: 320 }])
  assert.deepEqual(await recognizeText(solidImage(200, 60), runner(3, 0.3), dictionary), [], '低分结果丢弃')
  await assert.rejects(recognizeText(solidImage(200, 60), runner(5, 0.9), dictionary), /模型与字典不匹配/)
  await assert.rejects(recognizeText({ width: 10, height: 10, data: new Uint8Array(4) }, runner(3, 0.9), dictionary), /像素数据无效/)
})

test('图片解码：空图返回 undefined，超大图先缩小，像素长度不符返回 undefined', () => {
  const image = (width: number, height: number, bytes = width * height * 4, resized?: DecodableImage): DecodableImage => ({
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: options => resized ?? image(options.width, options.height),
    toBitmap: () => Buffer.alloc(bytes)
  })
  assert.equal(decodeImage(image(0, 0)), undefined)
  assert.deepEqual(decodeImage(image(2, 3))?.data.length, 24)
  const big = decodeImage(image(10_000, 5_000))!
  assert.ok(big.width * big.height <= 25_000_000 && big.width / big.height > 1.99)
  assert.equal(decodeImage(image(4, 4, 10)), undefined)
})

/** 子进程替身：记录收到的请求，由测试决定何时回复或退出 */
function fakeWorkers() {
  const workers: Array<{ requests: PaddleOcrWorkerRequest[]; killed: boolean; reply(message: unknown): void; exit(code: number | null): void }> = []
  const spawn = (): OcrWorkerProcess => {
    let onMessage: (message: unknown) => void = () => undefined
    let onExit: (code: number | null) => void = () => undefined
    const worker = {
      requests: [] as PaddleOcrWorkerRequest[],
      killed: false,
      reply: (message: unknown) => onMessage(message),
      exit: (code: number | null) => onExit(code)
    }
    workers.push(worker)
    return {
      postMessage: message => { worker.requests.push(message) },
      onMessage: handler => { onMessage = handler },
      onExit: handler => { onExit = handler },
      kill: () => { worker.killed = true; queueMicrotask(() => onExit(null)) }
    }
  }
  return { workers, spawn }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const image = solidImage(4, 4)

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ZToolsError)
    assert.equal(error.code, code)
    if (message) assert.match(error.message, message)
    return true
  })
}

test('子进程管理：懒启动、复用同一进程、请求逐个发送，空闲后结束', async () => {
  const { workers, spawn } = fakeWorkers()
  const engine = new PaddleOcrEngine({ spawnWorker: spawn, idleMs: 20 })
  assert.equal(workers.length, 0)
  const first = engine.recognize(image)
  const second = engine.recognize(image)
  await tick()
  assert.equal(workers.length, 1)
  assert.equal(workers[0]!.requests.length, 1, '上一个完成前不发送下一个')
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, ok: true, lines: ['一'] } satisfies PaddleOcrWorkerResponse)
  assert.deepEqual(await first, ['一'])
  await tick()
  assert.equal(workers[0]!.requests.length, 2)
  workers[0]!.reply({ id: 999, ok: true, lines: ['迟到的其它编号'] })
  workers[0]!.reply({ id: workers[0]!.requests[1]!.id, ok: true, lines: ['二'] })
  assert.deepEqual(await second, ['二'])
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(workers[0]!.killed, true, '空闲后结束子进程释放内存')
  const third = engine.recognize(image)
  await tick()
  assert.equal(workers.length, 2, '空闲退出后重新启动')
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, ok: true, lines: [] })
  assert.deepEqual(await third, [])
  engine.stop()
})

test('子进程管理：识别报错、无效结果、意外退出、超时都如实失败，下次重新启动', async () => {
  const { workers, spawn } = fakeWorkers()
  const engine = new PaddleOcrEngine({ spawnWorker: spawn, timeoutMs: 30, maxFailuresPerMinute: 10 })
  const failed = engine.recognize(image)
  await tick()
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, ok: false, error: '模型加载失败' })
  await expectCode(failed, errorCodes.processError, /模型加载失败/)

  for (const bad of [{ ok: true, lines: [1] }, { ok: true }, { ok: 'yes', lines: [] }]) {
    const invalid = engine.recognize(image)
    await tick()
    const worker = workers.at(-1)!
    worker.reply({ id: worker.requests.at(-1)!.id, ...bad })
    await expectCode(invalid, errorCodes.processError, /无效结果/)
  }

  const crashed = engine.recognize(image)
  await tick()
  workers.at(-1)!.exit(3)
  await expectCode(crashed, errorCodes.processError, /意外退出（退出码 3）/)

  const count = workers.length
  const timedOut = engine.recognize(image)
  await tick()
  assert.equal(workers.length, count + 1, '崩溃后重新启动')
  await expectCode(timedOut, errorCodes.requestTimeout, /超时/)
  assert.equal(workers.at(-1)!.killed, true, '超时结束子进程')
  engine.stop()
})

test('子进程管理：取消只结束当前识别，排队中的请求已取消时不发送', async () => {
  const { workers, spawn } = fakeWorkers()
  const engine = new PaddleOcrEngine({ spawnWorker: spawn })
  const controller = new AbortController()
  const running = engine.recognize(image, controller.signal)
  const queuedController = new AbortController()
  const queued = engine.recognize(image, queuedController.signal)
  const next = engine.recognize(image)
  await tick()
  queuedController.abort()
  controller.abort()
  await expectCode(running, errorCodes.cancelled)
  assert.equal(workers[0]!.killed, true)
  await expectCode(queued, errorCodes.cancelled)
  await tick()
  assert.equal(workers.length, 2, '取消后下一个请求在新进程中识别')
  assert.equal(workers[1]!.requests.length, 1)
  workers[1]!.reply({ id: workers[1]!.requests[0]!.id, ok: true, lines: ['ok'] })
  assert.deepEqual(await next, ['ok'])
  // 迟到的旧进程消息不影响新请求
  workers[0]!.reply({ id: workers[1]!.requests[0]!.id, ok: true, lines: ['旧进程'] })
  await expectCode(engine.recognize(image, AbortSignal.abort()), errorCodes.cancelled)
  engine.stop()
})

test('子进程管理：一分钟内连续失败 3 次后暂停，过一分钟恢复；启动失败、宿主退出', async () => {
  const { workers, spawn } = fakeWorkers()
  let now = 1_000_000
  const engine = new PaddleOcrEngine({ spawnWorker: spawn, now: () => now })
  for (let i = 0; i < 3; i++) {
    const crashed = engine.recognize(image)
    await tick()
    workers.at(-1)!.exit(1)
    await expectCode(crashed, errorCodes.processError)
  }
  assert.equal(engine.suspended, true)
  const spawned = workers.length
  await expectCode(engine.recognize(image), errorCodes.serviceUnavailable, /已暂停使用/)
  assert.equal(workers.length, spawned, '暂停期间不再启动子进程')
  now += 61_000
  assert.equal(engine.suspended, false)

  const broken = new PaddleOcrEngine({ spawnWorker: () => { throw new Error('找不到入口') } })
  await expectCode(broken.recognize(image), errorCodes.processError, /无法启动文字识别进程：找不到入口/)

  const pending = engine.recognize(image)
  await tick()
  engine.stop()
  await expectCode(pending, errorCodes.appStopping)
  assert.equal(workers.at(-1)!.killed, true)
})

test('本机识别入口：模型不全时不启用，图片无法解码时报读取失败', async () => {
  assert.equal(paddleOcrModelsPresent(path.join(clientRoot, 'tests', 'fixtures', 'ocr')), false)
  assert.equal(createLocalOcr({
    modelDirectory: path.join(clientRoot, 'missing-models'),
    createImageFromPath: () => { throw new Error('不应解码') },
    forkUtilityProcess: () => { throw new Error('不应启动') }
  }), undefined)
  if (!paddleOcrModelsPresent(modelDirectory)) return
  let forks = 0
  const local = createLocalOcr({
    modelDirectory,
    createImageFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => { throw new Error() }, toBitmap: () => Buffer.alloc(0) }),
    forkUtilityProcess: () => { forks++; throw new Error('不应启动') }
  })!
  await expectCode(local.recognizeImage('broken.png'), errorCodes.fileError, /无法读取图片/)
  assert.equal(forks, 0)
  local.stop()
})

test('端到端：真实子进程加载 PP-OCRv5 模型识别小字截图', {
  skip: paddleOcrModelsPresent(modelDirectory) ? false : '没有识别模型，先运行 npm run fetch:ocr-models',
  timeout: 120_000
}, async () => {
  const engine = new PaddleOcrEngine({
    spawnWorker: () => {
      const child = fork(workerEntry, [modelDirectory], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      return {
        postMessage: message => { child.send(message) },
        onMessage: handler => { child.on('message', handler) },
        onExit: handler => { child.on('exit', code => handler(code)) },
        kill: () => { child.kill() }
      }
    },
    timeoutMs: 60_000
  })
  try {
    const lines = await engine.recognize(readPng(fixture))
    assert.deepEqual(lines, ['文字识别测试：合同编号A-17，金额300元', 'Settings > General > Language', 'C:\\Users\\Public\\Pictures'])
    assert.deepEqual(await engine.recognize(solidImage(64, 64)), [], '空白图片没有文字')
  } finally {
    engine.stop()
  }
})
