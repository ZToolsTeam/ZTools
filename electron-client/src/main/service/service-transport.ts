import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export type ServiceTransport = Duplex & {
  readonly connecting: boolean
  readonly clientProcessId?: number
}

export type ServiceBridgeSpawner = (executable: string, args: readonly string[]) => ChildProcessWithoutNullStreams

// 原生桥在同一个管道句柄上验证服务身份；握手 PID 必须使用实际持有该句柄的桥进程。
export class ServiceBridgeTransport extends Duplex implements ServiceTransport {
  readonly clientProcessId: number
  connecting = true
  readonly #child: ChildProcessWithoutNullStreams
  #control = ''
  #controlReceived = false

  constructor(executable: string, pipeName: string, timeoutMs: number, spawnBridge?: ServiceBridgeSpawner) {
    super({ allowHalfOpen: false })
    if (!path.isAbsolute(executable)) {
      throw new ZToolsError(errorCodes.serviceAuthentication, 'ZToolsService 连接桥路径无效')
    }
    const args = ['--client-bridge', pipeName, String(timeoutMs)]
    this.#child = spawnBridge ? spawnBridge(executable, args) : spawn(executable, args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false
    })
    this.clientProcessId = this.#child.pid ?? 0
    this.#child.stdout.on('data', (chunk: Buffer) => {
      if (this.connecting) {
        this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥在身份核验前返回数据'))
      } else if (!this.push(chunk)) {
        this.#child.stdout.pause()
      }
    })
    this.#child.stderr.on('data', (chunk: Buffer) => this.#readControl(chunk))
    this.#child.stdin.on('error', (error: Error) => { if (!this.destroyed) this.destroy(error) })
    this.#child.on('error', (error: Error) => { if (!this.destroyed) this.destroy(error) })
    this.#child.on('close', (code) => {
      if (this.destroyed) return
      if (!this.#controlReceived && this.#control.length !== 0) {
        this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥控制消息不完整'))
        return
      }
      // 两条 stdio 流之间没有事件顺序保证；到 close 后再结束，保留晚于 stdout EOF 的鉴权错误。
      this.push(null)
      this.destroy(this.connecting || code !== 0
        ? new ZToolsError(errorCodes.serviceUnavailable, 'ZToolsService 连接桥已退出')
        : undefined)
    })
  }

  override _read(): void {
    this.#child.stdout.resume()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#child.stdin.write(chunk, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#child.stdin.end(callback)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const child = this.#child
    child.stdin.end()
    child.stdout.resume()
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      callback(error)
      return
    }
    if (process.platform === 'win32') {
      const cleanup = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        windowsHide: true,
        stdio: 'ignore'
      })
      cleanup.once('error', (failure: Error) => console.warn('ZToolsService 连接桥进程清理失败', failure))
    } else {
      child.kill('SIGKILL')
    }
    // 错误立即交给连接状态机；子进程退出清理独立收口，不能把鉴权错误拖成连接超时。
    callback(error)
  }

  #readControl(chunk: Buffer): void {
    if (this.destroyed) return
    this.#control += chunk.toString('utf8')
    if (this.#controlReceived || this.#control.length > 4096) {
      this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥控制消息无效'))
      return
    }
    const newline = this.#control.indexOf('\n')
    if (newline < 0) return
    if (this.#control.slice(newline + 1).length !== 0) {
      this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥控制消息重复'))
      return
    }
    this.#controlReceived = true
    let value: unknown
    try {
      value = JSON.parse(this.#control.slice(0, newline))
    } catch (error) {
      this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥控制消息无法解析', {
        hostCode: error instanceof Error ? error.name : 'BRIDGE_CONTROL_INVALID'
      }))
      return
    }
    if (!value || typeof value !== 'object') {
      this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥控制消息无效'))
      return
    }
    const control = value as Record<string, unknown>
    if (control.status === 'ready' && this.clientProcessId > 0 && control.clientPid === this.clientProcessId) {
      this.connecting = false
      this.emit('connect')
      return
    }
    if (control.status === 'error' && typeof control.win32 === 'number' &&
        Number.isInteger(control.win32) && control.win32 >= 0 && control.win32 <= 0xffffffff &&
        (control.code === errorCodes.serviceAuthentication || control.code === errorCodes.serviceUnavailable)) {
      this.destroy(new ZToolsError(control.code, 'ZToolsService 服务端身份核验或连接失败', {
        hostCode: `WIN32_${control.win32}`
      }))
      return
    }
    this.destroy(new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 连接桥身份信息无效'))
  }
}
