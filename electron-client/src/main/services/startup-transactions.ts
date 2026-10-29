import fs from 'node:fs/promises'
import path from 'node:path'
import { MacStartupReader, parseStartupOverrides, type StartupSnapshot } from './startup-reader.js'
import { startupCommandOutput } from './startup-command.js'
import { StartupBackupStore, type StartupBackup } from './startup-backups.js'
import type { StartupWriter, StartupWrite } from './startup-writer.js'

/** 自启允许状态与当前运行状态分离；切换不终止用户现有进程，也不立即启动任务。 */
export class StartupTransactions {
  constructor(readonly reader: MacStartupReader, readonly backups: StartupBackupStore, readonly writer: StartupWriter) {}
  async #fresh(before: StartupSnapshot, signal: AbortSignal) {
    const { item } = before
    if (item.blockedReason) throw new Error(item.blockedReason)
    const root = item.scope === 'user-agent' ? path.join(this.reader.env.home, 'Library/LaunchAgents') :
      item.scope === 'system-agent' ? this.reader.env.systemAgents : this.reader.env.daemons
    if (path.dirname(item.file) !== root || !item.file.endsWith('.plist') || await fs.realpath(root) !== root) throw new Error('启动项不在可管理的配置目录')
    const overrides = parseStartupOverrides(startupCommandOutput(await this.reader.run(['print-disabled', item.domain], signal)))
    const current = await this.reader.read(item.file, item.scope, overrides, signal)
    if (current.item.blockedReason || current.item.label !== item.label || current.item.domain !== item.domain || current.identity !== before.identity || current.revision !== before.revision || current.item.enabled !== item.enabled || current.disabledOverride !== before.disabledOverride) throw new Error('启动配置或自启状态已变化，请重新扫描')
    return current
  }
  async toggle(before: StartupSnapshot, enabled: boolean, signal: AbortSignal) {
    const current = await this.#fresh(before, signal)
    if (current.item.enabled === enabled) throw new Error('启动状态未变化，请重新扫描')
    const backup = await this.backups.save(current, enabled)
    let writeAttempted = false
    try {
      // 备份可能耗时，命令发出前再次核对，避免覆盖期间其他软件的变更。
      await this.#fresh(current, signal); signal.throwIfAborted()
      writeAttempted = true
      await this.writer.apply(this.#write(backup, 'toggle'), signal)
      const overrides = parseStartupOverrides(startupCommandOutput(await this.reader.run(['print-disabled', current.item.domain], AbortSignal.timeout(5000))))
      if (overrides.get(current.item.label) !== !enabled) throw new Error('系统返回的自启状态与请求不一致')
      return { success: true as const, backupId: backup.id, enabled, message: '自启允许状态已更新；当前运行中的任务不受影响，下一次加载时生效' }
    } catch (error) {
      const detail = String(error).slice(0, 1000)
      // 写入命令没发出，或发出后（例如用户取消管理员授权）复查确认系统自启状态仍是原值：
      // 本次没有改动任何东西，这条恢复记录无效，删除它；复查失败或状态已变化则保留记录供恢复。
      const unchanged = !writeAttempted || await this.#overrideUnchanged(backup)
      if (!unchanged) throw new Error(`自启修改未确认，请重新扫描；恢复记录 ${backup.id} 已保留。${detail}`)
      try {
        await this.backups.discard(backup.id)
      } catch (discardError) {
        console.warn(`[startup] 自启未修改，但删除无效恢复记录 ${backup.id} 失败:`, discardError)
        throw new Error(`自启状态未修改；无效恢复记录 ${backup.id} 删除失败，可在恢复记录中忽略。${detail}`)
      }
      throw new Error(`自启状态未修改，请重新扫描后再试。${detail}`)
    }
  }
  /** 复查系统自启覆盖值是否仍是备份时的原值；读取失败返回 false（无法确认就保留恢复记录） */
  async #overrideUnchanged(backup: StartupBackup): Promise<boolean> {
    try {
      const overrides = parseStartupOverrides(startupCommandOutput(await this.reader.run(['print-disabled', backup.domain], AbortSignal.timeout(5000))))
      return (overrides.get(backup.label) ?? null) === backup.originalOverride
    } catch (error) {
      console.warn(`[startup] 写入失败后复查自启状态失败，保留恢复记录 ${backup.id}:`, error)
      return false
    }
  }
  async restore(backup: StartupBackup, signal: AbortSignal) {
    if (backup.kind === 'remove') return this.#restoreRemoved(backup, signal)
    // 重新扫描可信目录；备份中的文件路径不会直接送入系统命令。
    const { snapshots } = await this.reader.scan(signal)
    const current = snapshots.find(s => s.item.file === backup.file && s.item.label === backup.label && s.item.domain === backup.domain)
    if (!current || current.revision !== backup.revision || current.identity !== backup.identity || current.item.enabled !== backup.afterEnabled || current.disabledOverride !== !backup.afterEnabled) throw new Error('当前启动项已变化或不存在，停止恢复以保留后续改动')
    return this.toggle(current, backup.beforeEnabled, signal)
  }
  #write(backup: StartupBackup, action: StartupWrite['action']): StartupWrite {
    return { action, file: backup.file, scope: backup.scope, label: backup.label, original: backup.original,
      identity: backup.identity, override: backup.originalOverride, backupId: backup.id, enabled: backup.afterEnabled }
  }
  async remove(before: StartupSnapshot, signal: AbortSignal) {
    const current = await this.#fresh(before, signal)
    if (current.item.programState !== 'missing') throw new Error('仅允许清理已确认程序丢失的配置')
    const backup = await this.backups.save(current, current.item.enabled, 'remove')
    await this.#fresh(current, signal); signal.throwIfAborted()
    try {
      const receipt = await this.writer.apply(this.#write(backup, 'remove'), signal)
      const exists = await fs.lstat(current.item.file).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (exists) throw new Error('原路径仍有配置，请重新扫描')
      return { success: true as const, removed: true, backupId: backup.id, recoveryPath: receipt.recoveryPath,
        message: '配置已移入恢复目录；当前已加载任务保持不变，重新登录后生效' }
    } catch (error) { throw new Error(`清理结果未确认；恢复记录 ${backup.id} 已保留。${String(error).slice(0, 1000)}`) }
  }
  async #restoreRemoved(backup: StartupBackup, signal: AbortSignal) {
    const root = backup.scope === 'user-agent' ? path.join(this.reader.env.home, 'Library/LaunchAgents') :
      backup.scope === 'system-agent' ? this.reader.env.systemAgents : this.reader.env.daemons
    const domain = backup.scope === 'daemon' ? 'system' : `gui/${this.reader.env.uid}`
    if (path.dirname(backup.file) !== root || await fs.realpath(root) !== root || backup.domain !== domain) throw new Error('恢复记录不属于当前系统启动目录')
    const overrides = parseStartupOverrides(startupCommandOutput(await this.reader.run(['print-disabled', domain], signal)))
    if ((overrides.get(backup.label) ?? null) !== backup.originalOverride) throw new Error('自启状态已有后续修改，停止恢复')
    const current = await fs.lstat(backup.file).then(() => true, error => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (current) {
      const existing = await this.reader.read(backup.file, backup.scope, overrides, signal)
      if (existing.identity !== backup.identity || existing.revision !== backup.revision) throw new Error('原位置已有新配置，停止恢复以保留后续改动')
      return { success: true as const, restored: true, backupId: backup.id, message: '原配置已完整存在，无需重复恢复' }
    }
    await this.writer.apply(this.#write(backup, 'restore'), signal)
    const restored = await this.reader.read(backup.file, backup.scope, overrides, AbortSignal.timeout(10000))
    if (restored.identity !== backup.identity || restored.revision !== backup.revision) throw new Error('恢复后校验不一致，请检查原配置和恢复目录')
    return { success: true as const, restored: true, backupId: backup.id, message: '启动配置已恢复；未立即启动任务，下一次登录时生效' }
  }

}
