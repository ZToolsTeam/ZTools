import fs from 'node:fs/promises'
import path from 'node:path'
import type { AnchoredPathObject, PathAccessAdapter } from '../platform/path-access.js'

/** 保留实际移出的原对象；提交和失败恢复都不覆盖期间出现的新文件。 */
export async function preserveAndWriteEnvironment(adapter: PathAccessAdapter, profile: string, original: string, next: string, signal: AbortSignal): Promise<string> {
  const parent = await adapter.pin(path.dirname(profile), 'directory', ['read', 'write'], signal)
  let recovery: AnchoredPathObject | undefined, moved = false, recoveryPath = '', failure = ''
  const name = path.basename(profile)
  try {
    recoveryPath = await fs.mkdtemp(path.join(path.dirname(profile), '.ztools-env-recovery-'))
    recovery = await adapter.pin(recoveryPath, 'directory', ['read', 'write'], signal)
    const incoming = await adapter.deriveSave(recovery, ['updated'], signal)
    try {
      await adapter.save(incoming, Buffer.from(next), false, signal)
      const written = await adapter.pinCommittedSave(incoming, signal)
      try { if ((await adapter.read(written, [], 1024 * 1024, signal)).toString('utf8') !== next) throw new Error('新配置副本核验失败') }
      finally { await adapter.release(written) }
    } finally { await adapter.release(incoming) }
    const old = await adapter.deriveRead(parent, [name], signal)
    try { if ((await adapter.read(old, [], 1024 * 1024, signal)).toString('utf8') !== original) throw new Error('移动前配置已变化') }
    finally { await adapter.release(old) }
    signal.throwIfAborted()
    // 原对象离开原位后，用独立时限完成提交或恢复；界面取消不能中断恢复。
    const commitSignal = AbortSignal.timeout(15000)
    const retained = await adapter.deriveSave(recovery, ['original'], commitSignal)
    try { await adapter.move(parent, [name], retained, false, commitSignal); moved = true }
    finally { await adapter.release(retained) }
    const retainedRead = await adapter.deriveRead(recovery, ['original'], commitSignal)
    try { if ((await adapter.read(retainedRead, [], 1024 * 1024, commitSignal)).toString('utf8') !== original) throw new Error('移出后检测到并发编辑，已停止提交') }
    finally { await adapter.release(retainedRead) }
    const target = await adapter.deriveSave(parent, [name], commitSignal)
    try { await adapter.move(recovery, ['updated'], target, false, commitSignal) }
    finally { await adapter.release(target) }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    if (moved && recovery) {
      const restoreSignal = AbortSignal.timeout(15000)
      try {
        const target = await adapter.deriveSave(parent, [name], restoreSignal)
        try { await adapter.move(recovery, ['original'], target, false, restoreSignal) }
        finally { await adapter.release(target) }
      } catch (restoreError) {
        failure += `；原位恢复未确认：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
      }
    }
  } finally {
    for (const object of [recovery, parent]) if (object) {
      try { await adapter.release(object) }
      catch (error) { failure += `${failure ? '；' : ''}文件句柄释放未确认：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  if (failure) throw new Error(`${failure}；未确认保存成功。请检查原配置 ${profile}${recoveryPath ? ` 与恢复目录 ${recoveryPath}（original 为移出的原对象）` : ''}`)
  return path.join(recoveryPath, 'original')
}
