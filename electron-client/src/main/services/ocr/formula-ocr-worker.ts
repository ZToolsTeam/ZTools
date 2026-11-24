/**
 * 公式识别子进程入口：在独立进程里加载 Pix2Text-MFR 模型并识别（Electron utilityProcess；测试用 child_process.fork）。
 * 主进程已把图片裁边、缩放到 384×384；这里只做归一化、推理与解码。模型目录由启动参数传入。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import * as ort from 'onnxruntime-web'
import { cleanLatex, decodeTokens, greedyDecode, parseVocabulary, toPixelValues, type FormulaModelRunner } from './formula-ocr-pipeline.js'
import { FORMULA_INPUT_SIZE, FORMULA_MODEL, FORMULA_TOKENS, type FormulaOcrWorkerResponse } from './formula-ocr-protocol.js'
import type { OcrWorkerImageRequest } from './ocr-worker-engine.js'
import { configureOnnxRuntime, serveRequests } from './ocr-worker-runtime.js'

interface LoadedModel {
  runner: FormulaModelRunner
  vocabulary: string[]
}

const modelDirectory = process.argv[2] ?? ''
let model: Promise<LoadedModel> | undefined

const fileNamed = (name: string) => {
  const file = FORMULA_MODEL.files.find(item => item.name === name)
  if (!file) throw new Error(`Formula OCR model is missing ${name}`)
  return path.join(modelDirectory, file.name)
}

async function loadModel(): Promise<LoadedModel> {
  if (!modelDirectory) throw new Error('Formula OCR model directory is not specified')
  configureOnnxRuntime(ort)
  const [encoderBytes, decoderBytes, tokenizer] = await Promise.all([
    fs.readFile(fileNamed('encoder_model.onnx')),
    fs.readFile(fileNamed('decoder_model.onnx')),
    fs.readFile(fileNamed('tokenizer.json'), 'utf8')
  ])
  const vocabulary = parseVocabulary(tokenizer)
  const encoder = await ort.InferenceSession.create(encoderBytes)
  const decoder = await ort.InferenceSession.create(decoderBytes)
  const size = FORMULA_INPUT_SIZE
  return {
    vocabulary,
    runner: {
      async encode(pixelValues) {
        const result = await encoder.run({ [encoder.inputNames[0]!]: new ort.Tensor('float32', pixelValues, [1, 3, size, size]) })
        const hidden = result[encoder.outputNames[0]!]
        if (!hidden || hidden.dims.length !== 3) throw new Error('Invalid formula OCR encoder output')
        return hidden
      },
      async nextLogits(encoded, tokens) {
        const ids = new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length])
        const result = await decoder.run({ input_ids: ids, encoder_hidden_states: encoded as ort.Tensor })
        const logits = result[decoder.outputNames[0]!]
        const vocab = FORMULA_TOKENS.vocabSize
        if (!logits || !(logits.data instanceof Float32Array) || logits.data.length !== tokens.length * vocab) {
          throw new Error('Invalid formula OCR decoder output')
        }
        return logits.data.slice((tokens.length - 1) * vocab, tokens.length * vocab)
      }
    }
  }
}

async function handle(request: OcrWorkerImageRequest): Promise<FormulaOcrWorkerResponse> {
  try {
    // 加载失败不缓存，下次请求重新尝试
    model ??= loadModel().catch((error: unknown) => { model = undefined; throw error })
    const { runner, vocabulary } = await model
    const { tokens, score } = await greedyDecode(runner, toPixelValues(request))
    return { id: request.id, ok: true, latex: cleanLatex(decodeTokens(tokens, vocabulary)), score }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

serveRequests<FormulaOcrWorkerResponse>('Formula OCR', handle)
