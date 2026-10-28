import { spawn } from 'node:child_process'

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions { input?: Buffer; timeoutMs?: number; graceMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv; cwd?: string; label?: string }
/** 无 shell；超限或取消后等待 close，调用方决定哪些退出码可接受。 */
export function runBoundedProcess(executable: string, args: string[], signal: AbortSignal, options: CommandOptions = {}): Promise<CommandResult> {
  signal.throwIfAborted()
  const label = options.label ?? '系统命令'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? { ...process.env, LANG: 'C', LC_ALL: 'C' }, ...(options.cwd ? { cwd: options.cwd } : {}) })
    const chunks: Buffer[] = [], errors: Buffer[] = []
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined, bytes = 0
    function terminate(reason: Error) {
      failure ??= reason
      if (!killTimer) { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), options.graceMs ?? 300) }
    }
    const abort = () => terminate(new Error(`${label}已取消；如已开始修改，请重新读取确认状态`))
    const timeout = setTimeout(() => terminate(new Error(`${label}超时，请重新读取确认状态`)), options.timeoutMs ?? 5000)
    function collect(target: Buffer[], data: Buffer) {
      bytes += data.length
      if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) terminate(new Error(`${label}输出超过限制`))
      else target.push(data)
    }
    child.stdout.on('data', data => collect(chunks, data)); child.stderr.on('data', data => collect(errors, data))
    child.on('error', () => { failure ??= new Error(`${label}无法启动，请检查工具是否已安装`) })
    child.stdin.on('error', () => { failure ??= new Error(`${label}输入通道中断`) })
    child.once('exit', () => {
      // 直接子进程已退出；后代可能仍持有继承的管道，不能无限等待 close。
      drainTimer = setTimeout(() => {
        failure ??= new Error(`${label}已退出，但输出管道未及时关闭`)
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
      }, 500)
    })
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); if (drainTimer) clearTimeout(drainTimer)
      signal.removeEventListener('abort', abort)
      if (failure || exitSignal || code === null) reject(failure ?? new Error(`${label}中断`))
      else resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') })
    })
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    child.stdin.end(options.input)
  })
}
