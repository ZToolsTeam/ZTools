/** 公式识别模型（Pix2Text-MFR 1.5）的文件清单与子进程消息格式（主进程与子进程共用） */
import manifest from './formula-model.json'

export interface FormulaModelFile {
  name: string
  sha256: string
  size: number
}

/**
 * Pix2Text-MFR 1.5（MIT，https://huggingface.co/breezedeus/pix2text-mfr-1.5）：
 * TrOCR 结构，DeiT 编码器 + 6 层解码器，输入 384×384，输出 LaTeX 的字节级 BPE 词元。
 * 清单在 formula-model.json（上传 CDN 的脚本 scripts/publish-formula-model.mjs 读同一份）；
 * 校验值固定，换模型必须换 id（目录名），已下载的旧模型不会被误用。
 * 下载地址依次尝试：官方 CDN、Hugging Face 固定提交、同一提交的镜像；所有来源校验同一份文件哈希。
 */
export const FORMULA_MODEL: Readonly<{ id: string; label: string; files: readonly FormulaModelFile[]; sources: readonly string[] }> = Object.freeze({
  ...manifest,
  files: Object.freeze(manifest.files.map(file => Object.freeze({ ...file }))),
  sources: Object.freeze([...manifest.sources])
})

export const FORMULA_MODEL_TOTAL_BYTES = FORMULA_MODEL.files.reduce((sum, file) => sum + file.size, 0)

/** 模型输入边长与词表约定（来自模型的 preprocessor_config / generation_config） */
export const FORMULA_INPUT_SIZE = 384
export const FORMULA_TOKENS = Object.freeze({ pad: 0, bos: 1, eos: 2, firstText: 5, vocabSize: 1868 })

export type FormulaOcrWorkerResponse =
  | { id: number; ok: true; latex: string; score: number }
  | { id: number; ok: false; error: string }
