/**
 * 下载 Windows 本机文字识别用的 PP-OCRv5 模型到 out/ocr-models（已存在且校验通过则跳过）。
 * 模型来自 PaddleOCR（Apache-2.0），ONNX 格式由 RapidOCR 转换发布；地址与 SHA-256 固定，校验不一致直接失败。
 * 用法：node scripts/fetch-ocr-models.mjs [目标目录]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OCR_MODEL_DIRECTORY = path.join(root, 'out', 'ocr-models')

const MODELSCOPE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv5'
/** 文件名与 src/main/services/ocr/paddle-ocr-protocol.ts 的 PADDLE_OCR_MODEL_FILES 一致 */
export const OCR_MODEL_FILES = Object.freeze([
  {
    name: 'ch_PP-OCRv5_mobile_det.onnx',
    url: `${MODELSCOPE}/det/ch_PP-OCRv5_mobile_det.onnx`,
    sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae'
  },
  {
    name: 'ch_PP-OCRv5_rec_mobile_infer.onnx',
    url: `${MODELSCOPE}/rec/ch_PP-OCRv5_rec_mobile_infer.onnx`,
    sha256: '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'
  },
  {
    name: 'ppocrv5_dict.txt',
    url: 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v3.3.0/ppocr/utils/dict/ppocrv5_dict.txt',
    sha256: 'd1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b'
  }
])

const NOTICE = `PP-OCRv5 文字识别模型
来源：PaddleOCR（https://github.com/PaddlePaddle/PaddleOCR），Apache License 2.0
ONNX 转换：RapidOCR（https://github.com/RapidAI/RapidOCR），Apache License 2.0
许可证全文：https://www.apache.org/licenses/LICENSE-2.0
`

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function isValid(file, expected) {
  try { return fs.statSync(file).isFile() && sha256(file) === expected } catch { return false }
}

async function download(url, target, expected) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）：${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`校验不一致：${url}\n  期望 ${expected}\n  实际 ${actual}`)
  const temporary = `${target}.download`
  fs.writeFileSync(temporary, bytes)
  fs.renameSync(temporary, target)
}

/** 确保模型齐全且校验通过，返回模型目录 */
export async function ensureOcrModels(directory = DEFAULT_OCR_MODEL_DIRECTORY) {
  fs.mkdirSync(directory, { recursive: true })
  for (const file of OCR_MODEL_FILES) {
    const target = path.join(directory, file.name)
    if (isValid(target, file.sha256)) continue
    console.log(`下载 ${file.name} …`)
    await download(file.url, target, file.sha256)
  }
  fs.writeFileSync(path.join(directory, 'NOTICE.txt'), NOTICE)
  return directory
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const directory = await ensureOcrModels(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
  console.log(`文字识别模型已就绪：${directory}`)
}
