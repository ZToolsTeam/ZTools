import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startupRecord } from './startup-reader.js'
import { runStartupProcess, startupCommandOutput } from './startup-command.js'

export interface StartupWrite {
  action: 'toggle' | 'remove' | 'restore'; scope: 'user-agent' | 'system-agent' | 'daemon'
  file: string; label: string; original: string; identity: string
  override: boolean | null; backupId: string; enabled: boolean
}
export interface StartupWriter { apply(input: StartupWrite, signal: AbortSignal): Promise<{ recoveryPath: string }> }
export function macStartupHelperPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacStartup') : path.resolve(__dirname, '../../mac-startup-native/native/ZToolsMacStartup')
}
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
export class MacStartupWriter implements StartupWriter {
  constructor(private readonly helper: string, private readonly run = runStartupProcess) {}
  async apply(input: StartupWrite, signal: AbortSignal) {
    signal.throwIfAborted()
    if (process.platform !== 'darwin') throw new Error('启动项安全组件仅支持 macOS')
    const stat = await fs.lstat(this.helper)
    if (!path.isAbsolute(this.helper) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('启动项安全组件不可用，请更新客户端')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-startup-request-'))
    const requestFile = path.join(directory, 'request.json'), cancelled = path.join(directory, 'cancel')
    let cancelError: unknown
    const cancel = () => {
      try { fsSync.writeFileSync(cancelled, 'cancel', { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          cancelError = error
          try { fsSync.unlinkSync(requestFile) } catch (removeError) { cancelError = removeError }
        }
      }
    }
    try {
      await fs.chmod(directory, 0o700)
      const request = { version: 1, action: input.action, scope: input.scope, filename: path.basename(input.file), label: input.label,
        original: input.original, identity: input.identity, override: input.override, backupId: input.backupId, enabled: input.enabled, deadline: Date.now() + 85000 }
      await fs.writeFile(requestFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
      signal.addEventListener('abort', cancel, { once: true }); signal.throwIfAborted()
      let executable = this.helper, args = ['--apply', requestFile, String(process.getuid!())]
      if (input.scope !== 'user-agent') {
        const command = [this.helper, ...args].map(quote).join(' ')
        executable = '/usr/bin/osascript'; args = ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`]
      }
      // 取消标记由组件在提交前检查。提交一旦开始就等结果，不能杀掉一半的文件移动。
      const output = startupCommandOutput(await this.run(executable, args, AbortSignal.timeout(110000), undefined, 100000, 10000))
      const result: unknown = JSON.parse(output)
      if (!startupRecord(result) || result.version !== 1 || typeof result.success !== 'boolean' || typeof result.code !== 'string' || typeof result.recoveryPath !== 'string') throw new Error('安全组件响应不完整')
      if (!result.success) throw new Error(`系统未确认修改：${result.code}${result.recoveryPath ? `；恢复目录 ${result.recoveryPath}` : ''}${cancelError ? '；取消请求写入失败' : ''}`)
      const expectedRecovery = input.action === 'toggle' ? '' : path.join(path.dirname(input.file), '.ztools-startup-recovery', input.backupId)
      if (result.code !== 'APPLIED' || result.recoveryPath !== expectedRecovery) throw new Error('系统写入结果无法验证')
      return { recoveryPath: result.recoveryPath }
    } finally {
      signal.removeEventListener('abort', cancel)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
