/** 识别子进程共用的运行环境：onnxruntime 设置、与主进程的通信通道、请求格式检查 */
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as Ort from 'onnxruntime-web'
import type { OcrWorkerImageRequest } from './ocr-worker-engine.js'

/** onnxruntime 的 wasm 文件打包时解到 asar 外（工作线程不能从 asar 里加载），这里指向真实目录 */
export function configureOnnxRuntime(ort: typeof Ort): void {
  const distDirectory = path.dirname(require.resolve('onnxruntime-web'))
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  ort.env.wasm.wasmPaths = pathToFileURL(distDirectory + path.sep).href
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)))
}

export interface WorkerChannel<Response> {
  send(message: Response): void
  onMessage(handler: (message: unknown) => void): void
}

/** Electron utilityProcess 用 parentPort，测试用 child_process.fork 的 IPC */
export function workerChannel<Response>(label: string): WorkerChannel<Response> {
  const parentPort = (process as unknown as { parentPort?: { postMessage(value: unknown): void; on(event: 'message', handler: (event: { data: unknown }) => void): void } }).parentPort
  if (parentPort) {
    return { send: message => parentPort.postMessage(message), onMessage: handler => parentPort.on('message', event => handler(event.data)) }
  }
  if (!process.send) throw new Error(`${label}进程缺少通信通道`)
  return { send: message => process.send!(message), onMessage: handler => process.on('message', handler) }
}

export function isImageRequest(value: unknown): value is OcrWorkerImageRequest {
  const request = value as Partial<OcrWorkerImageRequest> | null
  return !!request && request.type === 'recognize' && Number.isSafeInteger(request.id) &&
    Number.isSafeInteger(request.width) && Number.isSafeInteger(request.height) && request.data instanceof Uint8Array
}

/** 主进程逐个发送请求，这里按收到的顺序串行处理 */
export function serveRequests<Response>(label: string, handle: (request: OcrWorkerImageRequest) => Promise<Response>): void {
  const port = workerChannel<Response>(label)
  let queue = Promise.resolve()
  port.onMessage(message => {
    if (!isImageRequest(message)) return
    queue = queue.then(async () => port.send(await handle(message)))
  })
}
