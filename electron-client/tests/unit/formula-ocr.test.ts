import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { isPlatformSupportedMethod } from '../../src/contracts/capabilities.js'
import {
  analyzeContent,
  cleanLatex,
  decodeTokens,
  greedyDecode,
  invertImage,
  MAX_FORMULA_TOKENS,
  parseVocabulary,
  toPixelValues,
  type FormulaModelRunner
} from '../../src/main/services/ocr/formula-ocr-pipeline.js'
import { FORMULA_INPUT_SIZE, FORMULA_MODEL, FORMULA_TOKENS } from '../../src/main/services/ocr/formula-ocr-protocol.js'
import { FormulaModelStore } from '../../src/main/services/ocr/formula-model-store.js'
import { createFormulaOcr, createFormulaPreview, FormulaOcrEngine, prepareFormulaImage, type FormulaImage, type FormulaOcrPort } from '../../src/main/services/ocr/formula-ocr.js'
import type { BgraImage, OcrWorkerImageRequest, OcrWorkerProcess } from '../../src/main/services/ocr/ocr-worker-engine.js'
import { MediaOcrHostPluginHandler } from '../../src/main/services/host-plugins/media-ocr-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

const clientRoot = path.resolve(__dirname, '..', '..', '..')
const fixtures = path.join(clientRoot, 'tests', 'fixtures', 'formula')

// ---------- 图片替身 ----------

function canvas(width: number, height: number, background: [number, number, number, number] = [255, 255, 255, 255]): BgraImage {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(background, i)
  return { width, height, data }
}

function paint(image: BgraImage, x0: number, y0: number, x1: number, y1: number, bgra: [number, number, number, number]) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) image.data.set(bgra, (y * image.width + x) * 4)
}

/** 用 BGRA 像素实现 nativeImage 的最小接口：裁剪与双线性缩放，记录调用 */
function bitmapImage(image: BgraImage, calls: string[] = []): FormulaImage {
  return {
    isEmpty: () => image.width === 0,
    getSize: () => ({ width: image.width, height: image.height }),
    toBitmap: () => Buffer.from(image.data),
    toPNG: () => {
      const rgba = Buffer.from(image.data)
      for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2]!, rgba[i]!]
      const png = new PNG({ width: image.width, height: image.height })
      png.data = rgba
      return PNG.sync.write(png)
    },
    crop(rect) {
      calls.push(`crop ${rect.x},${rect.y},${rect.width},${rect.height}`)
      const out = canvas(rect.width, rect.height)
      for (let y = 0; y < rect.height; y++) {
        const start = ((rect.y + y) * image.width + rect.x) * 4
        out.data.set(image.data.subarray(start, start + rect.width * 4), y * rect.width * 4)
      }
      return bitmapImage(out, calls)
    },
    resize({ width, height }) {
      calls.push(`resize ${width}x${height}`)
      const out = canvas(width, height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * image.width / width - 0.5))
          const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * image.height / height - 0.5))
          const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1)
          for (let c = 0; c < 4; c++) {
            const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + c]!
            const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * (sx - x0)
            const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * (sx - x0)
            out.data[(y * width + x) * 4 + c] = Math.round(top + (bottom - top) * (sy - y0))
          }
        }
      }
      return bitmapImage(out, calls)
    }
  }
}

function readPng(file: string): BgraImage {
  const png = PNG.sync.read(fs.readFileSync(file))
  const data = new Uint8Array(png.width * png.height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = png.data[i + 2]!
    data[i + 1] = png.data[i + 1]!
    data[i + 2] = png.data[i]!
    data[i + 3] = png.data[i + 3]!
  }
  return { width: png.width, height: png.height, data }
}

// ---------- 预处理 ----------

test('裁边：按背景找出笔画外接框并留白；深色背景识别为需要反色；空白图返回 undefined；像素无效报错', () => {
  const white = canvas(200, 100)
  paint(white, 50, 40, 149, 59, [0, 0, 0, 255])
  assert.deepEqual(analyzeContent(white), { x: 46, y: 36, width: 108, height: 28, darkBackground: false })

  const dark = canvas(120, 60, [30, 30, 30, 255])
  paint(dark, 100, 50, 119, 59, [240, 240, 240, 255])
  const layout = analyzeContent(dark)!
  assert.equal(layout.darkBackground, true)
  assert.deepEqual([layout.x + layout.width, layout.y + layout.height], [120, 60], '外接框贴边时不超出图片')

  // 透明背景（PNG 截图）按白色处理，半透明的灰色笔画算内容
  const transparent = canvas(50, 50, [0, 0, 0, 0])
  paint(transparent, 20, 20, 29, 29, [0, 0, 0, 255])
  assert.equal(analyzeContent(transparent)!.darkBackground, false)
  assert.equal(analyzeContent(canvas(30, 30)), undefined)
  assert.equal(analyzeContent(canvas(30, 30, [250, 250, 250, 255])), undefined, '轻微底色不算内容')
  assert.throws(() => analyzeContent({ width: 10, height: 10, data: new Uint8Array(4) }), /像素数据无效/)
})

test('模型输入：反色得到白底深字；384×384 归一化到 [-1, 1] 并按 RGB 排列；尺寸不符报错', () => {
  const inverted = invertImage({ width: 1, height: 2, data: Uint8Array.from([20, 40, 60, 255, 255, 255, 255, 0]) })
  assert.deepEqual([...inverted.data], [235, 215, 195, 255, 255, 255, 255, 255], '透明像素按深色背景反色成白色')

  const size = FORMULA_INPUT_SIZE
  const image = canvas(size, size)
  image.data.set([0, 128, 255, 255], 0)
  image.data.set([0, 0, 0, 0], 4)
  const values = toPixelValues(image)
  const plane = size * size
  assert.equal(values.length, 3 * plane)
  assert.deepEqual([values[0], values[plane]!.toFixed(3), values[2 * plane]], [1, '0.004', -1], 'R G B 顺序')
  assert.deepEqual([values[1], values[plane + 1], values[2 * plane + 1]], [1, 1, 1], '透明像素按白色')
  assert.throws(() => toPixelValues(canvas(10, 10)), /384×384/)
})

test('准备识别图片：先裁边再缩放到 384，深色背景反色，超大图先缩小，空白图与无法解码分别返回', () => {
  const calls: string[] = []
  const source = canvas(400, 200)
  paint(source, 100, 80, 299, 119, [0, 0, 0, 255])
  const prepared = prepareFormulaImage(bitmapImage(source, calls))
  assert.ok(prepared && prepared !== 'blank')
  assert.deepEqual([prepared.width, prepared.height], [384, 384])
  assert.deepEqual(calls, ['crop 96,76,208,48', 'resize 384x384'])

  const dark = canvas(100, 50, [20, 20, 20, 255])
  paint(dark, 30, 20, 69, 29, [230, 230, 230, 255])
  const flipped = prepareFormulaImage(bitmapImage(dark)) as BgraImage
  assert.ok(flipped.data[0]! > 200, '深色背景反色后是白底')

  const big: string[] = []
  const huge = canvas(3000, 2000)
  paint(huge, 1000, 900, 1999, 1099, [0, 0, 0, 255])
  prepareFormulaImage(bitmapImage(huge, big))
  assert.equal(big[0], 'resize 2449x1632', '超过 400 万像素先缩小再分析')

  assert.equal(prepareFormulaImage(bitmapImage(canvas(64, 64))), 'blank')
  assert.equal(prepareFormulaImage(bitmapImage({ width: 0, height: 0, data: new Uint8Array(0) })), undefined)
  const broken = { ...bitmapImage(source), toBitmap: () => Buffer.alloc(3) }
  assert.equal(prepareFormulaImage(broken), undefined)
})

// ---------- 解码 ----------

function scriptedRunner(sequence: number[], vocab: number = FORMULA_TOKENS.vocabSize) {
  const seen: number[][] = []
  const runner: FormulaModelRunner = {
    async encode(pixels) { return { pixels: pixels.length } },
    async nextLogits(_encoded, tokens) {
      seen.push([...tokens])
      const logits = new Float32Array(vocab).fill(-10)
      logits[sequence[tokens.length - 1] ?? FORMULA_TOKENS.eos] = 10
      return logits
    }
  }
  return { runner, seen }
}

test('贪心解码：从起始符开始逐个取最大概率词元，遇结束符停止；分数为几何平均；输出维度不符、过长报错', async () => {
  const { runner, seen } = scriptedRunner([100, 200, FORMULA_TOKENS.eos])
  const result = await greedyDecode(runner, new Float32Array(3))
  assert.deepEqual(result.tokens, [100, 200])
  assert.deepEqual(seen, [[1], [1, 100], [1, 100, 200]])
  assert.ok(result.score > 0.99 && result.score <= 1)

  await assert.rejects(greedyDecode(scriptedRunner([5], 10).runner, new Float32Array(3)), /输出维度无效/)
  const endless = scriptedRunner(Array(MAX_FORMULA_TOKENS + 5).fill(7))
  await assert.rejects(greedyDecode(endless.runner, new Float32Array(3)), /公式过长/)
  assert.equal(endless.seen.length, MAX_FORMULA_TOKENS, '达到上限后不再继续推理')
})

test('词表与还原：字节级 BPE 还原 ASCII、空格与中文；跳过特殊词元；词表不匹配、编号越界报错', () => {
  const vocab: Record<string, number> = { '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '<mask>': 4 }
  for (let id = 5; id < FORMULA_TOKENS.vocabSize; id++) vocab[`t${id}`] = id
  vocab['\\frac'] = 10; delete vocab.t10
  vocab['Ġx'] = 11; delete vocab.t11
  // 「当」的 UTF-8 是 E5 BD 93，字节级表示为 å½ĵ（0x93 不可见，映射到 U+0135）
  vocab['å½ĵ'] = 12; delete vocab.t12
  const words = parseVocabulary(JSON.stringify({ model: { type: 'BPE', vocab } }))
  assert.equal(decodeTokens([1, 10, 11, 12, 2, 0], words), '\\frac x当')
  assert.throws(() => decodeTokens([FORMULA_TOKENS.vocabSize + 1], words), /词表外/)
  assert.throws(() => parseVocabulary(JSON.stringify({ model: { type: 'WordPiece', vocab } })), /格式无效/)
  assert.throws(() => parseVocabulary(JSON.stringify({ model: { type: 'BPE', vocab: { a: 0 } } })), /不匹配/)
  assert.throws(() => parseVocabulary(JSON.stringify({ model: { type: 'BPE', vocab: { ...vocab, bad: 99999 } } })), /编号无效/)
})

test('保真：向量、粗体数字、算子上下限、文本空格、分组与注释只去掉首尾空白', () => {
  const samples = [
    String.raw`\boldsymbol{x}+\bm{y}=\mathbf{v}`,
    String.raw`\mathbf{1}+{\bf 2}`,
    String.raw`\operatorname*{lim}_{x\to 0} f(x)`,
    String.raw`\text{if x > 0}\quad\text{当 x 大于 0 时}`,
    String.raw`\frac{{a+b}}{c}+{a+b}^{2}`,
    String.raw`\begin{cases}x^{2}&x\geq 0\\-x&x<0\end{cases}`,
    String.raw`{\displaystyle x}+y`,
    '\\text{a  b}\n% 保留注释的换行\nx+y',
    String.raw`\left\{x\right.\quad`,
    '{ x ', ''
  ]
  for (const sample of samples) assert.equal(cleanLatex(`  ${sample}\n`), sample.trim())
})

test('原图预览：保留宽高比和深色背景，有尺寸与编码上限；预览为空或过大时不返回伪数据', () => {
  const image = canvas(2000, 400, [30, 30, 30, 255])
  paint(image, 20, 20, 60, 100, [240, 240, 240, 255])
  const preview = createFormulaPreview(bitmapImage(image))!
  assert.ok(preview.startsWith('data:image/png;base64,'))
  const png = PNG.sync.read(Buffer.from(preview.split(',')[1]!, 'base64'))
  assert.deepEqual([png.width, png.height], [1600, 320])
  assert.equal(png.data[0], 30, '预览不使用模型反色或方形拉伸后的图片')
  assert.ok(preview.length < 525_000)
  assert.equal(createFormulaPreview(bitmapImage({ width: 0, height: 0, data: new Uint8Array(0) })), undefined)
  const sizes: number[] = []
  const oversized = (width: number): FormulaImage => ({
    ...bitmapImage(canvas(width, Math.max(1, width / 2 | 0))),
    toPNG: () => Buffer.alloc(400 * 1024),
    resize: options => { sizes.push(options.width); return oversized(options.width) }
  })
  assert.equal(createFormulaPreview(oversized(800)), undefined)
  assert.ok(sizes.length > 0 && sizes.at(-1)! <= 200)
})

// ---------- 子进程管理 ----------

function fakeWorkers() {
  const workers: Array<{ requests: OcrWorkerImageRequest[]; reply(message: unknown): void; killed: boolean }> = []
  const spawn = (): OcrWorkerProcess => {
    let onMessage: (message: unknown) => void = () => undefined
    const worker = { requests: [] as OcrWorkerImageRequest[], killed: false, reply: (message: unknown) => onMessage(message) }
    workers.push(worker)
    return {
      postMessage: message => { worker.requests.push(message) },
      onMessage: handler => { onMessage = handler },
      onExit: () => undefined,
      kill: () => { worker.killed = true }
    }
  }
  return { workers, spawn }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('公式识别子进程：返回 LaTeX 与分数（分数限制在 0–1）；格式不对、报错如实失败', async () => {
  const { workers, spawn } = fakeWorkers()
  const engine = new FormulaOcrEngine({ spawnWorker: spawn })
  const image = canvas(FORMULA_INPUT_SIZE, FORMULA_INPUT_SIZE)
  const ok = engine.recognize(image)
  await tick()
  workers[0]!.reply({ id: workers[0]!.requests[0]!.id, ok: true, latex: 'E=mc^{2}', score: 1.2 })
  assert.deepEqual(await ok, { latex: 'E=mc^{2}', score: 1 })
  for (const bad of [{ ok: true, latex: 1, score: 0.5 }, { ok: true, latex: 'x', score: Number.NaN }, { ok: true, lines: ['x'] }]) {
    const pending = engine.recognize(image)
    await tick()
    workers[0]!.reply({ id: workers[0]!.requests.at(-1)!.id, ...bad })
    await assert.rejects(pending, /公式识别进程返回了无效结果/)
  }
  const failed = engine.recognize(image)
  await tick()
  workers[0]!.reply({ id: workers[0]!.requests.at(-1)!.id, ok: false, error: '公式识别词表与模型不匹配' })
  await assert.rejects(failed, (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.processError && /词表/.test(error.message))
  engine.stop()
  assert.equal(workers[0]!.killed, true)
})

// ---------- 模型下载 ----------

interface FakeSource { status?: number; body?: Buffer; stall?: boolean; lengthHeader?: string }

function smallModel(contents: Record<string, Buffer>) {
  return {
    id: 'test-model',
    files: Object.entries(contents).map(([name, body]) => ({ name, size: body.length, sha256: createHash('sha256').update(body).digest('hex') })),
    sources: ['https://cdn.example/', 'https://mirror.example/']
  }
}

/** 按“地址 → 响应”返回，记录请求；stall 的响应先给一块数据然后不再给 */
function fakeFetch(routes: Record<string, FakeSource>) {
  const requests: string[] = []
  const fetch = async (url: string, init: { signal: AbortSignal }) => {
    requests.push(url)
    const route = routes[url]
    if (!route) return new Response('missing', { status: 404 })
    if (route.status && route.status !== 200) return new Response('error', { status: route.status })
    const body = route.body ?? Buffer.alloc(0)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (route.stall) {
          controller.enqueue(body.subarray(0, 1))
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
          return
        }
        for (let offset = 0; offset < body.length; offset += 4) controller.enqueue(body.subarray(offset, offset + 4))
        controller.close()
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-length': route.lengthHeader ?? String(body.length) } })
  }
  return { fetch, requests }
}

async function withDirectory<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ztools-formula-model-'))
  try { return await run(dir) } finally { await fsp.rm(dir, { recursive: true, force: true }) }
}

test('模型下载：没有模型 → 下载中 → 就绪；重复请求不重复下载；写入标记后新实例直接识别为就绪', async () => {
  await withDirectory(async dir => {
    const files = { 'a.onnx': Buffer.from('encoder-bytes'), 'b.json': Buffer.from('{"vocab":1}') }
    const model = smallModel(files)
    const { fetch, requests } = fakeFetch({ 'https://cdn.example/a.onnx': { body: files['a.onnx'] }, 'https://cdn.example/b.json': { body: files['b.json'] } })
    const store = new FormulaModelStore({ directory: dir, fetch, model })
    assert.deepEqual(await store.status(), { state: 'missing', totalBytes: 24 })
    const first = await store.download()
    assert.equal(first.state, 'downloading')
    assert.equal((await store.download()).state, 'downloading')
    await store.settled()
    assert.deepEqual(await store.status(), { state: 'ready', totalBytes: 24 })
    assert.deepEqual(requests, ['https://cdn.example/a.onnx', 'https://cdn.example/b.json'])
    assert.equal(fs.readFileSync(path.join(dir, 'a.onnx'), 'utf8'), 'encoder-bytes')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.json', 'model.json'])

    const reopened = new FormulaModelStore({ directory: dir, fetch: () => { throw new Error('不应联网') }, model })
    assert.equal(await reopened.isReady(), true)
    assert.equal((await reopened.download()).state, 'ready', '已就绪时下载是空操作')

    // 文件被截断或标记里的校验值与清单不同：不算就绪
    fs.writeFileSync(path.join(dir, 'a.onnx'), 'short')
    assert.equal(await new FormulaModelStore({ directory: dir, fetch, model }).isReady(), false)
    assert.equal(await new FormulaModelStore({ directory: dir, fetch, model: { ...model, id: 'other' } }).isReady(), false)
  })
})

test('模型下载：CDN 和上游均失败时使用第三来源，仍逐个验证同一份哈希', async () => {
  await withDirectory(async dir => {
    const files = { 'encoder.onnx': Buffer.from('encoder'), 'decoder.onnx': Buffer.from('decoder') }
    const model = { ...smallModel(files), sources: ['https://cdn.example/', 'https://upstream.example/', 'https://fallback.example/'] }
    const { fetch, requests } = fakeFetch({
      'https://cdn.example/encoder.onnx': { status: 404 },
      'https://upstream.example/encoder.onnx': { status: 503 },
      'https://fallback.example/encoder.onnx': { body: files['encoder.onnx'] },
      'https://fallback.example/decoder.onnx': { body: files['decoder.onnx'] }
    })
    const store = new FormulaModelStore({ directory: dir, fetch, model })
    await store.download()
    await store.settled()
    assert.equal((await store.status()).state, 'ready')
    assert.deepEqual(requests, [
      'https://cdn.example/encoder.onnx', 'https://upstream.example/encoder.onnx',
      'https://fallback.example/encoder.onnx', 'https://fallback.example/decoder.onnx'
    ])
    for (const [name, body] of Object.entries(files)) assert.deepEqual(await fsp.readFile(path.join(dir, name)), body)
    assert.equal(FORMULA_MODEL.sources.length, 3)
    assert.ok(FORMULA_MODEL.sources.slice(1).every(source => source.includes('/resolve/1cef9f0bdcd6a4c63df7de1311fb0894593340cc/')))
  })
})

test('模型下载：一个地址失败（HTTP 错误、校验值不一致、大小不符、长时间没有数据）就换下一个，全部失败如实报告各地址原因', async () => {
  await withDirectory(async dir => {
    const body = Buffer.from('model-weights-0123456789')
    const model = smallModel({ 'w.onnx': body })
    const tampered = Buffer.from(body); tampered[0] = tampered[0]! ^ 0xff
    const { fetch, requests } = fakeFetch({
      'https://cdn.example/w.onnx': { body: tampered },
      'https://mirror.example/w.onnx': { body }
    })
    const store = new FormulaModelStore({ directory: dir, fetch, model })
    await store.download()
    await store.settled()
    assert.equal((await store.status()).state, 'ready', '第一个地址校验不一致，改用第二个')
    assert.deepEqual(requests, ['https://cdn.example/w.onnx', 'https://mirror.example/w.onnx'])
  })

  await withDirectory(async dir => {
    const body = Buffer.from('model-weights-0123456789')
    const model = smallModel({ 'w.onnx': body })
    const { fetch } = fakeFetch({
      'https://cdn.example/w.onnx': { status: 503 },
      'https://mirror.example/w.onnx': { body, lengthHeader: '999' }
    })
    const store = new FormulaModelStore({ directory: dir, fetch, model })
    await store.download()
    await store.settled()
    const status = await store.status()
    assert.equal(status.state, 'failed')
    assert.match((status as { error: string }).error, /下载 w\.onnx 失败（cdn\.example：HTTP 503；mirror\.example：文件大小与清单不一致）/)
    assert.deepEqual(fs.readdirSync(dir), [], '失败不留下临时文件或标记')
  })

  await withDirectory(async dir => {
    const files = { 'w.onnx': Buffer.from('model-weights-0123456789'), 'v.json': Buffer.from('{"vocab":2}') }
    const model = smallModel(files)
    const { fetch, requests } = fakeFetch({
      'https://cdn.example/w.onnx': { body: files['w.onnx'], stall: true },
      'https://mirror.example/w.onnx': { body: files['w.onnx'] },
      'https://mirror.example/v.json': { body: files['v.json'] }
    })
    const store = new FormulaModelStore({ directory: dir, fetch, model, stallTimeoutMs: 50 })
    await store.download()
    await store.settled()
    assert.equal((await store.status()).state, 'ready', '卡住的地址超时后换下一个')
    assert.deepEqual(requests, ['https://cdn.example/w.onnx', 'https://mirror.example/w.onnx', 'https://mirror.example/v.json'],
      '失败过的地址后面的文件不再尝试，不用每个文件都等一次超时')
  })
})

test('模型下载：取消回到没有模型且不算失败；已校验的文件保留，重试只补缺的；进度按已收到的字节计算', async () => {
  await withDirectory(async dir => {
    const files = { 'a.onnx': Buffer.from('first-file'), 'b.onnx': Buffer.from('second-file-bytes') }
    const model = smallModel(files)
    let stall = true
    const routes = { 'https://cdn.example/a.onnx': { body: files['a.onnx'] }, 'https://cdn.example/b.onnx': { body: files['b.onnx'], stall } }
    const { fetch, requests } = fakeFetch(routes)
    const store = new FormulaModelStore({ directory: dir, fetch, model, stallTimeoutMs: 60_000 })
    await store.download()
    for (let i = 0; i < 50 && !requests.includes('https://cdn.example/b.onnx'); i++) await new Promise(resolve => setTimeout(resolve, 5))
    await new Promise(resolve => setTimeout(resolve, 10))
    const progress = await store.status()
    assert.equal(progress.state, 'downloading')
    assert.equal((progress as { receivedBytes: number }).receivedBytes, files['a.onnx'].length + 1)
    assert.equal((await store.cancel()).state, 'missing')
    assert.ok(!fs.existsSync(path.join(dir, 'b.onnx.download')))
    assert.ok(fs.existsSync(path.join(dir, 'a.onnx')))

    stall = false
    routes['https://cdn.example/b.onnx'].stall = stall
    requests.length = 0
    await store.download()
    await store.settled()
    assert.equal((await store.status()).state, 'ready')
    assert.deepEqual(requests, ['https://cdn.example/b.onnx'], '已下载完整的文件不重新下载')
  })
})

test('模型下载：写盘出错（如磁盘满）如实失败而不是一直停在下载中，临时文件不留下', { timeout: 10_000 }, async () => {
  await withDirectory(async dir => {
    // 超过写入流缓冲（16 KB）才会等 drain；把临时文件路径占成目录，写入流打开即报错
    const body = Buffer.alloc(256 * 1024, 7)
    const model = smallModel({ 'big.onnx': body })
    fs.mkdirSync(path.join(dir, 'big.onnx.download'))
    const { fetch } = fakeFetch({ 'https://cdn.example/big.onnx': { body }, 'https://mirror.example/big.onnx': { body } })
    const store = new FormulaModelStore({ directory: dir, fetch, model })
    await store.download()
    await store.settled()
    const status = await store.status()
    assert.equal(status.state, 'failed')
    assert.match((status as { error: string }).error, /EISDIR|illegal operation on a directory/)
  })
})

// ---------- 宿主接入 ----------

const ctx: HostPluginContext = { clipboard: null, processService: null, windowControl: null,
  authorizeExistingPath: async value => value, authorizeOutputPath: async value => value }

function fakeFormula(overrides: Partial<FormulaOcrPort> = {}): FormulaOcrPort & { recognized: string[] } {
  const recognized: string[] = []
  return {
    recognized,
    modelStatus: async () => ({ state: 'ready', totalBytes: 1 }),
    downloadModel: async () => ({ state: 'downloading', receivedBytes: 0, totalBytes: 1 }),
    cancelDownload: async () => ({ state: 'missing', totalBytes: 1 }),
    async recognizeImage(imagePath) { recognized.push(imagePath); return { latex: 'x^{2}', score: 0.99 } },
    stop: () => undefined,
    ...overrides
  }
}

test('宿主：公式模式识别图片、剪贴板与框选，模型没下载时直接提示（框选前就拦下），分数低标记核对', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ztools-formula-host-'))
  const image = path.join(dir, 'a.png')
  await fsp.writeFile(image, 'png')
  try {
    const formula = fakeFormula()
    let selections = 0
    const handler = new MediaOcrHostPluginHandler(ctx, {
      formulaOcr: formula,
      readClipboardImage: () => Buffer.from('clip'),
      regionSelector: { selectScreenRegion: async () => { selections++; return { x: 0, y: 0, width: 10, height: 10 } }, stop: async () => undefined },
      captureScreenRegionToPng: async (_rect, output) => { await fsp.writeFile(output, 'shot'); return true },
      screenCapturePermission: () => 'granted'
    })
    const viaPlatform = async <T>(run: () => Promise<T>) => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      try { return await run() } finally { Object.defineProperty(process, 'platform', original) }
    }
    assert.deepEqual(await handler.handleOcr('recognizeImage', { path: image, mode: 'formula' }),
      { ok: true, success: true, latex: 'x^{2}', score: 0.99, lowConfidence: false, engine: 'Pix2Text-MFR 1.5' })
    assert.equal((await handler.handleOcr('recognizeClipboard', { mode: 'formula' }) as { latex: string }).latex, 'x^{2}')
    assert.equal((await viaPlatform(() => handler.handleOcr('captureRegionAndRecognize', { mode: 'formula' })) as { latex: string }).latex, 'x^{2}')
    assert.equal(selections, 1)
    assert.equal(formula.recognized.length, 3)
    for (const file of formula.recognized) assert.equal(fs.existsSync(file) && file !== image, false, '临时截图与剪贴板图片识别后删除')

    const missing = new MediaOcrHostPluginHandler(ctx, {
      formulaOcr: fakeFormula({ modelStatus: async () => ({ state: 'missing', totalBytes: 1 }) }),
      regionSelector: { selectScreenRegion: async () => { selections++; return undefined }, stop: async () => undefined }
    })
    assert.deepEqual(await viaPlatform(() => missing.handleOcr('captureRegionAndRecognize', { mode: 'formula' })),
      { ok: false, success: false, modelMissing: true, error: '公式识别模型还没有下载' })
    assert.equal(selections, 1, '模型没下载时不让用户先框选')

    const unsure = new MediaOcrHostPluginHandler(ctx, { formulaOcr: fakeFormula({ recognizeImage: async () => ({ latex: 'y', score: 0.5 }) }) })
    assert.equal((await unsure.handleOcr('recognizeImage', { path: image, mode: 'formula' }) as { lowConfidence: boolean }).lowConfidence, true)
    const blank = new MediaOcrHostPluginHandler(ctx, { formulaOcr: fakeFormula({ recognizeImage: async () => ({ latex: '', score: 0 }) }) })
    assert.deepEqual(await blank.handleOcr('recognizeImage', { path: image, mode: 'formula' }), { ok: false, success: false, empty: true, error: '没有识别到公式' })
    const crash = new MediaOcrHostPluginHandler(ctx, { formulaOcr: fakeFormula({ recognizeImage: async () => { throw new Error('公式识别进程意外退出（退出码 9）') } }) })
    assert.match((await crash.handleOcr('recognizeImage', { path: image, mode: 'formula' }) as { error: string }).error, /意外退出/)
    const unsupported = new MediaOcrHostPluginHandler(ctx, {})
    assert.deepEqual(await unsupported.handleOcr('recognizeImage', { path: image, mode: 'formula' }), { ok: false, success: false, error: '当前客户端不支持公式识别' })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('识别入口：模型没下载时报错不解码图片；空白图片直接返回空结果，不启动子进程', async () => {
  await withDirectory(async dir => {
    let forks = 0
    const store = new FormulaModelStore({ directory: dir, fetch: () => { throw new Error('不应联网') } })
    const ocr = createFormulaOcr({
      store,
      createImageFromPath: () => bitmapImage(canvas(80, 40)),
      forkUtilityProcess: () => { forks++; throw new Error('不应启动') }
    })
    await assert.rejects(ocr.recognizeImage('/tmp/a.png'), (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.serviceUnavailable)
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ id: FORMULA_MODEL.id, files: FORMULA_MODEL.files.map(({ name, sha256 }) => ({ name, sha256 })) }))
    for (const file of FORMULA_MODEL.files) {
      const handle = fs.openSync(path.join(dir, file.name), 'w')
      fs.ftruncateSync(handle, file.size)
      fs.closeSync(handle)
    }
    const fresh = createFormulaOcr({
      store: new FormulaModelStore({ directory: dir, fetch: () => { throw new Error('不应联网') } }),
      createImageFromPath: () => bitmapImage(canvas(80, 40)),
      forkUtilityProcess: () => { forks++; throw new Error('不应启动') }
    })
    assert.deepEqual(await fresh.recognizeImage('/tmp/a.png'), { latex: '', score: 0 })
    assert.equal(forks, 0)
    ocr.stop()
    fresh.stop()
  })
})

test('宿主预览契约：只在显式请求时返回原图，剪贴板临时图片识别后仍删除，识别内容原样透传', async () => {
  const previewDataUrl = `data:image/png;base64,${bitmapImage(canvas(2, 1)).toPNG().toString('base64')}`
  const requested: boolean[] = []
  const formula = fakeFormula({ recognizeImage: async (file, _signal, options) => {
    formula.recognized.push(file)
    requested.push(options?.includePreview === true)
    return { latex: String.raw`\boldsymbol{x}+\text{if x > 0}`, score: 0.99, previewDataUrl }
  } })
  const handler = new MediaOcrHostPluginHandler(ctx, { formulaOcr: formula, readClipboardImage: () => bitmapImage(canvas(2, 1)).toPNG() })
  const first = await handler.handleOcr('recognizeClipboard', { mode: 'formula' }) as Record<string, unknown>
  assert.equal(first.previewDataUrl, undefined)
  const second = await handler.handleOcr('recognizeClipboard', { mode: 'formula', includePreview: true }) as Record<string, unknown>
  assert.equal(second.previewDataUrl, previewDataUrl)
  assert.equal(second.latex, String.raw`\boldsymbol{x}+\text{if x > 0}`)
  assert.equal(second.lowConfidence, false)
  assert.deepEqual(requested, [false, true])
  for (const file of formula.recognized) assert.equal(fs.existsSync(file), false)
})

test('识别入口：模型文件在使用中被删除，提示重新下载并让状态回到没有模型', async () => {
  await withDirectory(async dir => {
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({ id: FORMULA_MODEL.id, files: FORMULA_MODEL.files.map(({ name, sha256 }) => ({ name, sha256 })) }))
    for (const file of FORMULA_MODEL.files) {
      const handle = fs.openSync(path.join(dir, file.name), 'w')
      fs.ftruncateSync(handle, file.size)
      fs.closeSync(handle)
    }
    const store = new FormulaModelStore({ directory: dir, fetch: () => { throw new Error('不应联网') } })
    const image = canvas(80, 40)
    paint(image, 20, 10, 59, 29, [0, 0, 0, 255])
    const ocr = createFormulaOcr({
      store,
      createImageFromPath: () => bitmapImage(image),
      forkUtilityProcess: () => {
        let onMessage: (message: unknown) => void = () => undefined
        return {
          postMessage: (message: unknown) => {
            const { id } = message as OcrWorkerImageRequest
            setImmediate(() => onMessage({ id, ok: false, error: `ENOENT: no such file or directory, open '${path.join(dir, 'encoder_model.onnx')}'` }))
          },
          on: (event: 'message' | 'exit', listener: (value: never) => void) => { if (event === 'message') onMessage = listener as (message: unknown) => void },
          kill: () => true
        }
      }
    })
    assert.equal((await store.status()).state, 'ready')
    fs.rmSync(path.join(dir, 'encoder_model.onnx'))
    await assert.rejects(ocr.recognizeImage('/tmp/a.png'), /模型文件缺失，请重新下载模型/)
    assert.equal((await store.status()).state, 'missing')
    ocr.stop()
  })
})

test('请求契约：formula_ocr 只接受模型管理与三种识别动作，macOS 与 Windows 都支持', () => {
  for (const params of [
    { action: 'modelStatus' }, { action: 'downloadModel' }, { action: 'cancelDownload' }, { action: 'recognizeClipboard' },
    { action: 'captureRegion' }, { action: 'captureRegion', restoreWindow: false, includePreview: true }, { action: 'recognizeImage', path: '/Users/me/a.png', includePreview: false }, { action: 'recognizeClipboard', includePreview: true }
  ]) validateMethodParams('formula_ocr', params)
  for (const params of [
    { action: 'recognizeClipboard', includePreview: 'yes' }, { action: 'modelStatus', includePreview: true }, {}, { action: 'deleteModel' }, { action: 'recognizeImage' }, { action: 'recognizeImage', path: 'relative.png' },
    { action: 'recognizeClipboard', lang: 'en-US' }, { action: 'captureRegion', restoreWindow: 'yes' }, { action: 'modelStatus', url: 'https://x' }
  ]) assert.throws(() => validateMethodParams('formula_ocr', params as Record<string, unknown>), { code: 'INVALID_REQUEST' })
  assert.equal(isPlatformSupportedMethod('formula_ocr', 'darwin'), true)
  assert.equal(isPlatformSupportedMethod('formula_ocr', 'win32'), true)
})

// ---------- 端到端（需要真实模型） ----------

const realModelDirectory = process.env.ZTOOLS_FORMULA_MODEL_DIR ?? ''
const workerEntry = path.join(__dirname, '..', '..', 'src', 'main', 'services', 'ocr', 'formula-ocr-worker.js')

test('端到端：真实子进程识别印刷体、深色背景、透明背景与宽松框选，并返回原图预览', {
  skip: realModelDirectory && fs.existsSync(path.join(realModelDirectory, 'model.json')) ? false : '设置 ZTOOLS_FORMULA_MODEL_DIR 指向已下载的模型目录后运行',
  timeout: 180_000
}, async () => {
  const ocr = createFormulaOcr({
    store: new FormulaModelStore({ directory: realModelDirectory, fetch: () => { throw new Error('不应联网') } }),
    createImageFromPath: file => {
      const [imagePath, variant] = file.split('#')
      const image = readPng(imagePath!)
      if (variant === 'dark') return bitmapImage(invertImage(image))
      if (variant === 'transparent') {
        for (let i = 0; i < image.data.length; i += 4) {
          if (image.data[i]! > 250 && image.data[i + 1]! > 250 && image.data[i + 2]! > 250) image.data[i + 3] = 0
        }
      }
      if (variant === 'padded') {
        const padded = canvas(image.width + 160, image.height + 120)
        for (let y = 0; y < image.height; y++) padded.data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + 60) * padded.width + 80) * 4)
        return bitmapImage(padded)
      }
      return bitmapImage(image)
    },
    forkUtilityProcess: (modulePath, args) => {
      assert.equal(modulePath, workerEntry)
      const child = fork(modulePath, args, { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      return { postMessage: message => { child.send(message as object) }, on: (event: string, listener: (...args: any[]) => void) => child.on(event, listener), kill: () => child.kill() }
    }
  })
  try {
    const quadratic = await ocr.recognizeImage(path.join(fixtures, 'quadratic.png'))
    assert.equal(quadratic.latex.replace(/[{}\s]/g, ''), 'x=\\frac-b\\pm\\sqrtb^2-4ac2a')
    assert.ok(quadratic.score > 0.9)
    const dark = await ocr.recognizeImage(`${path.join(fixtures, 'quadratic.png')}#dark`)
    assert.equal(dark.latex.replace(/[{}\s]/g, ''), 'x=\\frac-b\\pm\\sqrtb^2-4ac2a')
    const cases = await ocr.recognizeImage(path.join(fixtures, 'cases.png'))
    assert.match(cases.latex.replace(/\s/g, ''), /\\begin\{cases\}.*x\}?\^\{2\}.*\\geq0.*\\end\{cases\}/)
    assert.ok(cases.latex.includes('\\boldsymbol'), '保留模型输出中的粗体命令，不再默认删去')
    for (const variant of ['padded', 'transparent']) {
      const result = await ocr.recognizeImage(`${path.join(fixtures, 'quadratic.png')}#${variant}`, undefined, { includePreview: true })
      assert.equal(result.latex.replace(/[{}\s]/g, ''), 'x=\\frac-b\\pm\\sqrtb^2-4ac2a', variant)
      assert.ok(result.previewDataUrl?.startsWith('data:image/png;base64,'), '实际推理链路返回原图预览')
      const original = readPng(path.join(fixtures, 'quadratic.png'))
      const preview = PNG.sync.read(Buffer.from(result.previewDataUrl!.split(',')[1]!, 'base64'))
      assert.equal(preview.width, original.width + (variant === 'padded' ? 160 : 0), '预览保留原图比例而不是 384×384 模型输入')
    }
  } finally {
    ocr.stop()
  }
})
