import { spawn } from 'node:child_process'

/** 等待 close 后才完成，取消和超时均先终止辅助进程，不把 error 事件当成资源已释放。 */
export function runProjectCommand(file: string, args: string[], signal: AbortSignal, timeoutMs: number, env = process.env): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env })
    let failure: Error | undefined, force: NodeJS.Timeout | undefined, size = 0
    const output: Buffer[] = [], errors: Buffer[] = []
    const end = (reason: Error) => {
      failure ??= reason
      if (force) return
      child.kill('SIGTERM')
      force = setTimeout(() => { child.kill('SIGKILL') }, 300)
    }
    const abort = () => end(new Error('打开请求已取消，若编辑器已启动请检查其窗口'))
    const timeout = setTimeout(() => end(new Error('打开请求超时，请检查编辑器是否已启动')), timeoutMs)
    const read = (list: Buffer[], chunk: Buffer) => {
      size += chunk.length
      if (size > 65536) end(new Error('编辑器辅助进程输出超限'))
      else list.push(chunk)
    }
    child.stdout.on('data', chunk => read(output, chunk)); child.stderr.on('data', chunk => read(errors, chunk))
    child.on('error', error => { failure ??= error })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout); if (force) clearTimeout(force); signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0 || exitSignal) reject(new Error(`系统打开命令失败：${Buffer.concat(errors).toString('utf8').trim().slice(0, 1500) || exitSignal || code}`))
      else resolve(Buffer.concat(output).toString('utf8'))
    })
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
}
