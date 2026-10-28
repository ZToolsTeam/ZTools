import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { validateSpeedtestRequest } from '../../contracts/network-speedtest.js'
import { MacSpeedtestProvider, type SpeedtestProvider } from './network-speedtest-provider.js'

type Operation = { id: string; owner: string; windowId: number; controller: AbortController; done: Promise<unknown> }
const callerKey = (caller: CallerIdentity) => JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId])
export class NetworkSpeedtestService {
  private operation: Operation | undefined
  private stopped = false
  constructor(private readonly provider: SpeedtestProvider = new MacSpeedtestProvider(), private readonly platform = process.platform) {}
  closeOwner(windowId: number) { if (this.operation?.windowId === windowId) this.operation.controller.abort(new Error('测速窗口已关闭')) }
  async stop() {
    this.stopped = true
    const operation = this.operation
    if (operation) { operation.controller.abort(new Error('客户端正在退出')); await Promise.allSettled([operation.done]) }
  }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown> {
    try {
      validateSpeedtestRequest(value); signal.throwIfAborted()
      if (this.stopped || this.platform !== 'darwin') throw new Error(this.stopped ? '测速服务已停止' : '此测速接口需要 macOS')
      const key = callerKey(caller)
      if (value.action === 'cancel') {
        const operation = this.operation
        if (!operation || operation.id !== value.operationId) return { success: true, cancelled: false }
        if (operation.owner !== key) throw new Error('不能取消其他窗口的测速')
        operation.controller.abort(new Error('测速已停止'))
        await Promise.allSettled([operation.done])
        return { success: true, cancelled: true }
      }
      if (this.operation) throw new Error('已有测速正在进行，请完成或停止后再试')
      const controller = new AbortController(), deadline = AbortSignal.timeout(25000)
      const combined = AbortSignal.any([signal, controller.signal, deadline])
      const done = value.action === 'bandwidth' ? this.provider.bandwidth(combined) : this.provider.diagnose(value.target, combined)
      const operation: Operation = { id: value.operationId, owner: key, windowId: caller.webContentsId, controller, done }
      this.operation = operation
      try {
        const result = await done; combined.throwIfAborted()
        return { success: true, action: value.action, ...result }
      } finally { if (this.operation === operation) this.operation = undefined }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
    }
  }
}
