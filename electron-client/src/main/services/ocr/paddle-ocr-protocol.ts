/** 主进程与文字识别子进程之间的消息格式，以及模型文件名（两边共用） */
import type { OcrWorkerImageRequest } from './ocr-worker-engine.js'

/** 模型目录里的文件：PP-OCRv5 移动版检测、识别模型与字符字典 */
export const PADDLE_OCR_MODEL_FILES = Object.freeze({
  detection: 'ch_PP-OCRv5_mobile_det.onnx',
  recognition: 'ch_PP-OCRv5_rec_mobile_infer.onnx',
  dictionary: 'ppocrv5_dict.txt'
})

export type PaddleOcrWorkerRequest = OcrWorkerImageRequest

export type PaddleOcrWorkerResponse =
  | { id: number; ok: true; lines: string[] }
  | { id: number; ok: false; error: string }
