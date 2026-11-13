/**
 * 文字识别子进程入口：在独立进程里加载 PP-OCRv5 模型并识别（Electron utilityProcess；测试用 child_process.fork）。
 * 推理与模型内存都留在本进程，崩溃或被结束不影响主进程。模型目录由启动参数传入。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import * as ort from 'onnxruntime-web'
import { configureOnnxRuntime, serveRequests } from './ocr-worker-runtime.js'
import { parseCharacterDictionary, recognizeText, type OcrModelRunner } from './paddle-ocr-pipeline.js'
import { PADDLE_OCR_MODEL_FILES, type PaddleOcrWorkerRequest, type PaddleOcrWorkerResponse } from './paddle-ocr-protocol.js'

interface LoadedModels {
  runner: OcrModelRunner
  dictionary: string[]
}

const modelDirectory = process.argv[2] ?? ''
let models: Promise<LoadedModels> | undefined

async function loadModels(): Promise<LoadedModels> {
  if (!modelDirectory) throw new Error('没有指定识别模型目录')
  configureOnnxRuntime(ort)
  const [det, rec, dictionaryText] = await Promise.all([
    fs.readFile(path.join(modelDirectory, PADDLE_OCR_MODEL_FILES.detection)),
    fs.readFile(path.join(modelDirectory, PADDLE_OCR_MODEL_FILES.recognition)),
    fs.readFile(path.join(modelDirectory, PADDLE_OCR_MODEL_FILES.dictionary), 'utf8')
  ])
  const detection = await ort.InferenceSession.create(det)
  const recognition = await ort.InferenceSession.create(rec)
  const dictionary = parseCharacterDictionary(dictionaryText)
  const output = (result: ort.InferenceSession.OnnxValueMapType, session: ort.InferenceSession) => {
    const tensor = result[session.outputNames[0]!]
    if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error('识别模型输出格式无效')
    return tensor
  }
  return {
    dictionary,
    runner: {
      async detect(input, height, width) {
        const result = await detection.run({ [detection.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, height, width]) })
        return output(result, detection).data as Float32Array
      },
      async recognize(input, batch, height, width) {
        const result = await recognition.run({ [recognition.inputNames[0]!]: new ort.Tensor('float32', input, [batch, 3, height, width]) })
        const tensor = output(result, recognition)
        const [, steps, classes] = tensor.dims
        if (tensor.dims.length !== 3 || !steps || !classes) throw new Error('识别模型输出维度无效')
        return { data: tensor.data as Float32Array, steps, classes }
      }
    }
  }
}

async function handle(request: PaddleOcrWorkerRequest): Promise<PaddleOcrWorkerResponse> {
  try {
    // 加载失败不缓存，下次请求重新尝试
    models ??= loadModels().catch((error: unknown) => { models = undefined; throw error })
    const { runner, dictionary } = await models
    const lines = await recognizeText({ width: request.width, height: request.height, data: request.data }, runner, dictionary)
    return { id: request.id, ok: true, lines }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

serveRequests<PaddleOcrWorkerResponse>('文字识别', handle)
