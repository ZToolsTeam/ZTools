/**
 * transaction.ts
 * Atomic transaction manager with Undo Log, line ending preservation, and rollback
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { LineEndingHelper } from './helpers/line-ending.ts'
import { ChecksumHelper } from './helpers/checksum.ts'
import { GitSafetyGuard } from './helpers/git-guard.ts'
import { TransformerEngine } from './transformer.ts'
import type {
  MigrationPlan,
  MigrationOperation,
  UndoLogItem,
  RollbackResult,
  TransactionResult
} from './types.ts'

export class TransactionAbortedError extends Error {
  rollbackResult: RollbackResult
  originalError: any

  constructor(message: string, rollbackResult: RollbackResult, originalError: any = null) {
    super(message)
    this.name = 'TransactionAbortedError'
    this.rollbackResult = rollbackResult
    this.originalError = originalError
  }
}

export class TransactionManager {
  /**
   * Walk directory excluding node_modules, .git, .ztools-backups
   */
  static walkDir(dir: string, relativeTo: string = dir): Array<{ fullPath: string; relativePath: string }> {
    const results: Array<{ fullPath: string; relativePath: string }> = []
    if (!fs.existsSync(dir)) return results

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.ztools-backups') {
        continue
      }
      const fullPath = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        results.push(...this.walkDir(fullPath, relativeTo))
      } else if (ent.isFile()) {
        results.push({
          fullPath,
          relativePath: path.relative(relativeTo, fullPath).replace(/\\/g, '/')
        })
      }
    }
    return results
  }

  /**
   * Create MigrationPlan
   */
  static createPlan(
    sourceDir: string,
    targetDir: string,
    options: {
      dryRun?: boolean
      pluginId?: string
      strictTargets?: boolean
      allowDirty?: boolean
    } = {}
  ): MigrationPlan {
    const absSource = path.resolve(sourceDir)
    const absTarget = path.resolve(targetDir)
    const isDryRun = !!options.dryRun

    if (!fs.existsSync(absSource)) {
      throw new Error(`源目录不存在: ${absSource}`)
    }

    const sourceManifest = path.join(absSource, 'plugin.json')
    if (!fs.existsSync(sourceManifest)) {
      throw new Error(`源目录未发现 plugin.json: ${absSource}`)
    }

    const gitStatus = GitSafetyGuard.check(absTarget)
    const planId = `plan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`

    // 执行 transformer 规划
    const { scanResult, normalizedManifest, filesToCreateOrModify } = TransformerEngine.planTransform(
      absSource,
      absTarget,
      options
    )

    const operations: MigrationOperation[] = []
    const sourceFiles = this.walkDir(absSource)
    const targetFilesMap = new Map<string, { fullPath: string; relativePath: string }>()

    if (fs.existsSync(absTarget)) {
      const targetFiles = this.walkDir(absTarget)
      for (const tf of targetFiles) {
        targetFilesMap.set(tf.relativePath, tf)
      }
    }

    const transformedMap = new Map<string, { relativePath: string; content: string | Buffer; reason: string }>()
    for (const f of filesToCreateOrModify) {
      transformedMap.set(f.relativePath, f)
    }

    // 1. 遍历原工程源码文件
    for (const sf of sourceFiles) {
      const rel = sf.relativePath
      const sourceBuf = fs.readFileSync(sf.fullPath)
      const sourceHash = ChecksumHelper.sha256(sourceBuf)!
      const targetPath = path.join(absTarget, rel)
      const targetExists = targetFilesMap.has(rel)

      if (transformedMap.has(rel)) {
        // 使用转换后内容
        const item = transformedMap.get(rel)!
        const ending = targetExists
          ? LineEndingHelper.detect(fs.readFileSync(targetPath))
          : LineEndingHelper.detect(sourceBuf)

        const finalContent = typeof item.content === 'string'
          ? LineEndingHelper.convert(item.content, ending)
          : item.content

        const targetHash = ChecksumHelper.sha256(finalContent)!
        const existingHash = targetExists ? ChecksumHelper.sha256File(targetPath) : null
        const type = !targetExists ? 'CREATE' : (existingHash === targetHash ? 'RETAIN' : 'MODIFY')

        operations.push({
          type,
          relativePath: rel,
          sourcePath: sf.fullPath,
          targetPath,
          sourceHash,
          targetHash,
          targetContent: finalContent,
          lineEnding: ending,
          reason: item.reason
        })
        transformedMap.delete(rel)
      } else {
        // 普通文件直接复制
        const existingHash = targetExists ? ChecksumHelper.sha256File(targetPath) : null
        const isIdentical = existingHash === sourceHash
        const type = !targetExists ? 'CREATE' : (isIdentical ? 'RETAIN' : 'MODIFY')

        operations.push({
          type,
          relativePath: rel,
          sourcePath: sf.fullPath,
          targetPath,
          sourceHash,
          targetHash: sourceHash,
          targetContent: sourceBuf,
          lineEnding: LineEndingHelper.detect(sourceBuf),
          reason: type === 'RETAIN' ? '内容与源文件哈希一致，保留' : '复制原工程源码文件'
        })
      }
    }

    // 2. 添加额外新增的文件 (例如 plugin.utools.json, utools-db-sync-shim.js, services-adapter.js 等)
    for (const [rel, item] of transformedMap.entries()) {
      const targetPath = path.join(absTarget, rel)
      const targetExists = targetFilesMap.has(rel)
      const ending = targetExists
        ? LineEndingHelper.detect(fs.readFileSync(targetPath))
        : LineEndingHelper.getDefaultEnding(targetPath)

      const finalContent = typeof item.content === 'string'
        ? LineEndingHelper.convert(item.content, ending)
        : item.content

      const targetHash = ChecksumHelper.sha256(finalContent)!
      const existingHash = targetExists ? ChecksumHelper.sha256File(targetPath) : null
      const type = !targetExists ? 'CREATE' : (existingHash === targetHash ? 'RETAIN' : 'MODIFY')

      operations.push({
        type,
        relativePath: rel,
        sourcePath: null,
        targetPath,
        sourceHash: null,
        targetHash,
        targetContent: finalContent,
        lineEnding: ending,
        reason: item.reason
      })
    }

    const summary = {
      total: operations.length,
      create: operations.filter(o => o.type === 'CREATE').length,
      modify: operations.filter(o => o.type === 'MODIFY').length,
      delete: operations.filter(o => o.type === 'DELETE').length,
      retain: operations.filter(o => o.type === 'RETAIN').length
    }

    return {
      planId,
      timestamp: new Date().toISOString(),
      sourceDir: absSource,
      targetDir: absTarget,
      backupDir: null,
      isDryRun,
      dirtyWarning: gitStatus.isClean ? null : gitStatus.warning,
      operations,
      summary
    }
  }

  /**
   * Execute MigrationPlan with atomic rollback on failure
   */
  static executeTransaction(
    plan: MigrationPlan,
    options: {
      dryRun?: boolean
      backup?: boolean
      allowDirty?: boolean
      _syntheticErrorAtStep?: number
    } = {}
  ): TransactionResult {
    const isDryRun = plan.isDryRun || !!options.dryRun
    const absTarget = plan.targetDir

    if (isDryRun) {
      return {
        success: true,
        committed: false,
        isDryRun: true,
        plan,
        backupPath: null,
        appliedCount: 0
      }
    }

    // Git dirty check
    if (plan.dirtyWarning && !options.allowDirty && absTarget === plan.sourceDir) {
      throw new Error(`事务中止：目标工作区存在未提交代码。\n${plan.dirtyWarning}\n请使用 --allow-dirty 强制继续，或指定独立输出目录。`)
    }

    // 建立备份快照
    let backupPath: string | null = null
    const needsBackup = options.backup !== false
    if (needsBackup && fs.existsSync(absTarget)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const rand = crypto.randomBytes(3).toString('hex')
      backupPath = path.join(absTarget, '.ztools-backups', `${timestamp}-${rand}`)
      fs.mkdirSync(backupPath, { recursive: true })

      for (const op of plan.operations) {
        if (op.type === 'MODIFY' || op.type === 'DELETE') {
          if (fs.existsSync(op.targetPath)) {
            const backupFile = path.join(backupPath, op.relativePath)
            fs.mkdirSync(path.dirname(backupFile), { recursive: true })
            fs.copyFileSync(op.targetPath, backupFile)
          }
        }
      }
    }

    const undoLog: UndoLogItem[] = []
    let currentOpIndex = 0

    try {
      for (let i = 0; i < plan.operations.length; i++) {
        currentOpIndex = i
        const op = plan.operations[i]

        // 模拟错误测试支持
        if (options._syntheticErrorAtStep === i + 1) {
          throw new Error(`[SYNTHETIC_TEST_ERROR] 模拟在步骤 ${i + 1} 发生不可预料异常`)
        }

        if (op.type === 'RETAIN') {
          continue
        }

        const targetDir = path.dirname(op.targetPath)
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }

        if (op.type === 'CREATE') {
          const existed = fs.existsSync(op.targetPath)
          if (!existed) {
            undoLog.push({ type: 'DELETE_CREATED', filePath: op.targetPath })
          } else {
            const originalContent = fs.readFileSync(op.targetPath)
            undoLog.push({ type: 'RESTORE_ORIGINAL', filePath: op.targetPath, content: originalContent })
          }

          const buf = typeof op.targetContent === 'string'
            ? Buffer.from(op.targetContent, 'utf8')
            : (op.targetContent || Buffer.alloc(0))
          fs.writeFileSync(op.targetPath, buf)
        } else if (op.type === 'MODIFY') {
          const originalContent = fs.readFileSync(op.targetPath)
          undoLog.push({ type: 'RESTORE_ORIGINAL', filePath: op.targetPath, content: originalContent })

          const buf = typeof op.targetContent === 'string'
            ? Buffer.from(op.targetContent, 'utf8')
            : (op.targetContent || Buffer.alloc(0))
          fs.writeFileSync(op.targetPath, buf)
        } else if (op.type === 'DELETE') {
          if (fs.existsSync(op.targetPath)) {
            const originalContent = fs.readFileSync(op.targetPath)
            undoLog.push({ type: 'RESTORE_ORIGINAL', filePath: op.targetPath, content: originalContent })
            fs.unlinkSync(op.targetPath)
          }
        }
      }

      // 后置完整性校验
      this.validateTarget(absTarget)

      // 写入迁移元数据 (.ztools-migration.json)
      const metaPath = path.join(absTarget, '.ztools-migration.json')
      const metadata = {
        $schema: 'https://ztools.dev/schemas/migration-metadata.v1.json',
        toolVersion: '1.0.0',
        migratedAt: new Date().toISOString(),
        upstreamDir: plan.sourceDir,
        planId: plan.planId,
        backupPath,
        undoLog: undoLog.map(u => ({
          type: u.type,
          filePath: path.relative(absTarget, u.filePath).replace(/\\/g, '/')
        }))
      }
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8')

      return {
        success: true,
        committed: true,
        isDryRun: false,
        plan,
        backupPath,
        appliedCount: undoLog.length,
        undoLog
      }
    } catch (err: any) {
      // 触发原子回滚
      const rollbackResult = this.rollback(undoLog)
      throw new TransactionAbortedError(
        `迁移事务在操作 ${currentOpIndex + 1}/${plan.operations.length} 中断并已全量原子回滚: ${err.message}`,
        rollbackResult,
        err
      )
    }
  }

  /**
   * Rollback undo log
   */
  static rollback(undoLog: UndoLogItem[]): RollbackResult {
    let restoredCount = 0
    let deletedCount = 0

    for (let i = undoLog.length - 1; i >= 0; i--) {
      const item = undoLog[i]
      try {
        if (item.type === 'DELETE_CREATED') {
          if (fs.existsSync(item.filePath)) {
            fs.unlinkSync(item.filePath)
            deletedCount++
          }
        } else if (item.type === 'RESTORE_ORIGINAL') {
          if (item.content !== undefined) {
            fs.writeFileSync(item.filePath, item.content)
            restoredCount++
          }
        }
      } catch (e: any) {
        console.error(`[ROLLBACK_ERROR] 回滚单项失败 (${item.filePath}): ${e.message}`)
      }
    }

    return {
      restoredCount,
      deletedCount,
      totalReverted: restoredCount + deletedCount
    }
  }

  /**
   * Explicit rollback for a target directory from .ztools-migration.json or .ztools-backups
   */
  static rollbackTarget(targetDir: string): RollbackResult {
    const absTarget = path.resolve(targetDir)
    if (!fs.existsSync(absTarget)) {
      throw new Error(`目标目录不存在: ${absTarget}`)
    }

    const metaPath = path.join(absTarget, '.ztools-migration.json')
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        const backupPath = meta.backupPath

        if (backupPath && fs.existsSync(backupPath)) {
          // 从快照完整恢复修改文件
          const backupFiles = this.walkDir(backupPath)
          let restored = 0
          for (const bf of backupFiles) {
            const dest = path.join(absTarget, bf.relativePath)
            fs.copyFileSync(bf.fullPath, dest)
            restored++
          }
        }

        // 清理新建的文件
        let deleted = 0
        if (Array.isArray(meta.undoLog)) {
          for (const u of meta.undoLog) {
            if (u.type === 'DELETE_CREATED') {
              const fullPath = path.join(absTarget, u.filePath)
              if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath)
                deleted++
              }
            }
          }
        }

        // 移除元数据文件
        fs.unlinkSync(metaPath)

        return {
          restoredCount: 0,
          deletedCount: deleted,
          totalReverted: deleted
        }
      } catch (e: any) {
        throw new Error(`读取迁移元数据执行回滚失败: ${e.message}`)
      }
    }

    // 若目标目录只有迁移产物，清理典型迁移新增文件
    const filesToClean = [
      'plugin.utools.json',
      'utools-db-sync-shim.js',
      'services-adapter.js',
      '.ztools-migration.json'
    ]

    let deleted = 0
    for (const f of filesToClean) {
      const p = path.join(absTarget, f)
      if (fs.existsSync(p)) {
        fs.unlinkSync(p)
        deleted++
      }
    }

    return {
      restoredCount: 0,
      deletedCount: deleted,
      totalReverted: deleted
    }
  }

  /**
   * Validate target directory integrity
   */
  static validateTarget(targetDir: string): boolean {
    const manifestPath = path.join(targetDir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error('后置校验失败: 目标目录缺少 plugin.json')
    }

    let manifest: any
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (err: any) {
      throw new Error(`后置校验失败: plugin.json 不是合法的 JSON 格式 (${err.message})`)
    }

    if (!manifest.name && !manifest.id) {
      throw new Error('后置校验失败: plugin.json 缺少必要属性 (name 或 id)')
    }

    return true
  }
}
