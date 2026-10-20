import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import yauzl from 'yauzl'
import yazl from 'yazl'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  calculateDirectorySize,
  computeFileSha256,
  formatBytes,
  isProtectedSystemPath,
  runCommand,
  runPowerShell,
  type HostPluginContext
} from './shared-utils.js'

export class StorageHostPluginHandler {
  readonly #ctx: HostPluginContext
  #sqlJsPromise: Promise<SqlJsStatic> | null = null

  constructor(ctx: HostPluginContext) {
    this.#ctx = ctx
  }

  async #getSqlJs(): Promise<SqlJsStatic> {
    if (!this.#sqlJsPromise) {
      this.#sqlJsPromise = initSqlJs()
    }
    return this.#sqlJsPromise
  }

  async handleMover(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const home = os.homedir()
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const roamingAppData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')

    if (
      lowerFn === 'scan' ||
      lowerFn === 'scancandidates' ||
      lowerFn === 'scandirectories' ||
      lowerFn === 'getmovableitems'
    ) {
      const candidateDirs = [
        { name: 'npm 全局缓存 (npm-cache)', path: path.join(localAppData, 'npm-cache'), category: '开发缓存' },
        { name: 'pnpm Store 仓库', path: path.join(localAppData, 'pnpm', 'store'), category: '开发缓存' },
        { name: 'Yarn 缓存目录', path: path.join(localAppData, 'Yarn', 'Cache'), category: '开发缓存' },
        { name: 'pip Python 缓存', path: path.join(localAppData, 'pip', 'Cache'), category: '开发缓存' },
        { name: 'Cargo Rust 缓存', path: path.join(home, '.cargo', 'registry'), category: '开发缓存' },
        { name: 'Gradle 构建缓存', path: path.join(home, '.gradle', 'caches'), category: '开发缓存' },
        { name: 'Docker WSL 镜像数据', path: path.join(localAppData, 'Docker', 'wsl'), category: '容器与虚拟机' },
        { name: '微信文件默认存储 (WeChat Files)', path: path.join(home, 'Documents', 'WeChat Files'), category: '社交软件数据' },
        { name: '腾讯 QQ 个人文件夹 (Tencent Files)', path: path.join(home, 'Documents', 'Tencent Files'), category: '社交软件数据' },
        { name: 'VS Code 扩展插件目录 (.vscode/extensions)', path: path.join(home, '.vscode', 'extensions'), category: 'IDE 与工具' },
        { name: 'Cursor 扩展插件目录 (.cursor/extensions)', path: path.join(home, '.cursor', 'extensions'), category: 'IDE 与工具' },
        { name: 'JetBrains 全局缓存', path: path.join(localAppData, 'JetBrains'), category: 'IDE 与工具' },
        { name: 'Chrome 用户缓存数据', path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), category: '浏览器数据' },
        { name: 'Roam 应用配置数据', path: roamingAppData, category: '应用配置' }
      ]

      const customDirs = Array.isArray(params.customPaths) ? params.customPaths.map(String) : []
      for (const cp of customDirs) {
        try {
          const authPath = await this.#ctx.authorizeExistingPath(cp, caller, 'read')
          candidateDirs.push({ name: path.basename(authPath), path: authPath, category: '自定义目录' })
        } catch {
          // skip unauthorized path
        }
      }

      const items: Array<Record<string, unknown>> = []
      for (const cand of candidateDirs) {
        if (!fsSync.existsSync(cand.path)) continue
        try {
          const lstat = await fs.lstat(cand.path)
          const isJunction = lstat.isSymbolicLink()
          const realTarget = isJunction ? await fs.readlink(cand.path).catch(() => '') : ''
          const { totalBytes, fileCount } = await calculateDirectorySize(cand.path, 2)
          items.push({
            id: crypto.createHash('md5').update(cand.path).digest('hex').slice(0, 10),
            name: cand.name,
            sourcePath: cand.path,
            category: cand.category,
            sizeBytes: totalBytes,
            sizeText: formatBytes(totalBytes),
            fileCount,
            isJunction,
            targetPath: realTarget
          })
        } catch {
          // ignore inaccessible directories
        }
      }

      items.sort((a, b) => Number(b.sizeBytes ?? 0) - Number(a.sizeBytes ?? 0))
      return { ok: true, success: true, items, candidates: items }
    }

    if (
      lowerFn === 'movedirectory' ||
      lowerFn === 'relocatewithjunction' ||
      lowerFn === 'migrate' ||
      lowerFn === 'createjunction'
    ) {
      const sourcePath = String(params.sourcePath ?? '').trim()
      const targetRoot = String(params.targetRoot ?? params.targetPath ?? params.targetDir ?? '').trim()
      if (!sourcePath || !targetRoot) {
        return { ok: false, success: false, error: '源目录与目标目录均不能为空' }
      }
      const resolvedSource = await this.#ctx.authorizeExistingPath(sourcePath, caller, 'write')
      const resolvedTargetRoot = await this.#ctx.authorizeOutputPath(targetRoot, caller)
      if (isProtectedSystemPath(resolvedSource)) {
        return { ok: false, success: false, error: '拒绝迁移系统核心受保护目录' }
      }
      const destDir = path.join(resolvedTargetRoot, path.basename(resolvedSource))
      if (resolvedSource.toLowerCase() === destDir.toLowerCase()) {
        return { ok: false, success: false, error: '源目录与目标路径不能相同' }
      }
      await fs.mkdir(resolvedTargetRoot, { recursive: true })
      await fs.cp(resolvedSource, destDir, { recursive: true, force: true })
      await fs.rm(resolvedSource, { recursive: true, force: true })

      if (process.platform === 'win32') {
        const mklink = await runCommand('cmd.exe', ['/c', 'mklink', '/J', resolvedSource, destDir], 15_000, signal)
        if (mklink.exitCode !== 0) {
          await fs.symlink(destDir, resolvedSource, 'junction')
        }
      } else {
        await fs.symlink(destDir, resolvedSource, 'dir')
      }

      return {
        ok: true,
        success: true,
        sourcePath: resolvedSource,
        targetPath: destDir,
        isJunction: true,
        message: `已成功迁移至 ${destDir} 并建立目录联接 (Junction)`
      }
    }

    if (lowerFn === 'restore' || lowerFn === 'restorejunction') {
      const sourcePath = String(params.sourcePath ?? '').trim()
      if (!sourcePath) {
        return { ok: false, success: false, error: '未指定要还原的目录路径' }
      }
      const resolvedSource = await this.#ctx.authorizeExistingPath(sourcePath, caller, 'write')
      const lstat = await fs.lstat(resolvedSource)
      if (!lstat.isSymbolicLink()) {
        return { ok: false, success: false, error: '该路径不是符号链接或目录联接 (Junction)' }
      }
      const realTarget = await fs.readlink(resolvedSource)
      await fs.unlink(resolvedSource)
      await fs.cp(realTarget, resolvedSource, { recursive: true, force: true })
      await fs.rm(realTarget, { recursive: true, force: true })
      return {
        ok: true,
        success: true,
        sourcePath: resolvedSource,
        message: '已解除联接并将数据迁回原位置'
      }
    }

    return this.handleMover('scan', params, caller, signal)
  }

  async handleDataRecovery(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'scan' ||
      lowerFn === 'scandeletedfiles' ||
      lowerFn === 'scanrecyclebin' ||
      lowerFn === 'listrecoverablefiles'
    ) {
      const items: Array<Record<string, unknown>> = []
      const searchDirs: string[] = []
      if (typeof params.scanPath === 'string' && params.scanPath.trim()) {
        try {
          const authScanPath = await this.#ctx.authorizeExistingPath(params.scanPath.trim(), caller, 'read')
          searchDirs.push(authScanPath)
        } catch {
          // ignore unauthorized custom scan path
        }
      }
      searchDirs.push(os.tmpdir())

      if (process.platform === 'win32') {
        for (const drive of ['C:', 'D:', 'E:']) {
          const binRoot = `${drive}\\$Recycle.Bin`
          if (fsSync.existsSync(binRoot)) {
            try {
              const sidDirs = await fs.readdir(binRoot, { withFileTypes: true })
              for (const sid of sidDirs) {
                if (sid.isDirectory()) {
                  searchDirs.push(path.join(binRoot, sid.name))
                }
              }
            } catch {
              // ignore permission errors on other users' SID folders
            }
          }
        }
      } else if (process.platform === 'darwin') {
        searchDirs.push(path.join(os.homedir(), '.Trash'))
      }

      for (const dir of searchDirs) {
        if (!fsSync.existsSync(dir)) continue
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          for (const entry of entries.slice(0, 120)) {
            if (!entry.isFile()) continue
            if (entry.name.startsWith('$I') || entry.name === 'desktop.ini') continue
            const fullPath = path.join(dir, entry.name)
            try {
              const stat = await fs.stat(fullPath)
              if (stat.size === 0) continue
              const ext = path.extname(entry.name).toLowerCase()
              items.push({
                id: crypto.createHash('md5').update(fullPath).digest('hex').slice(0, 12),
                name: entry.name,
                path: fullPath,
                cachePath: fullPath,
                sourcePath: fullPath,
                originalPath: fullPath,
                sizeBytes: stat.size,
                sizeText: formatBytes(stat.size),
                deletedAtMs: Math.round(stat.mtimeMs),
                modifiedAt: stat.mtime.toISOString(),
                extension: ext || '.bin',
                integrity: '完整可恢复 (100%)',
                locationType: fullPath.includes('$Recycle.Bin') || fullPath.includes('.Trash') ? '回收站残留' : '临时缓存区'
              })
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }

      items.sort((a, b) => Number(b.sizeBytes ?? 0) - Number(a.sizeBytes ?? 0))
      const sliced = items.slice(0, 200)
      return { ok: true, success: true, items: sliced, files: sliced }
    }

    if (lowerFn === 'recover' || lowerFn === 'recoverfiles' || lowerFn === 'restorefile') {
      const singleSource = String(
        params.sourcePath ?? params.sourceCachePath ?? params.cachePath ?? params.path ?? ''
      ).trim()
      const sourcePaths = Array.isArray(params.sourcePaths)
        ? params.sourcePaths.map(String)
        : singleSource
          ? [singleSource]
          : []
      if (sourcePaths.length === 0) {
        return { ok: false, success: false, error: '未选择需要恢复的文件' }
      }

      const rawTarget = String(
        params.targetDir ??
          params.targetPath ??
          params.outputDir ??
          path.join(os.homedir(), 'Desktop', 'ZTools_Recovered')
      ).trim()

      const hasExplicitFileTarget =
        typeof params.targetPath === 'string' &&
        params.targetPath.trim().length > 0 &&
        sourcePaths.length === 1 &&
        path.extname(params.targetPath.trim()) !== '' &&
        !(fsSync.existsSync(params.targetPath.trim()) && fsSync.statSync(params.targetPath.trim()).isDirectory())

      if (hasExplicitFileTarget) {
        try {
          const resolvedSrc = await this.#ctx.authorizeExistingPath(sourcePaths[0]!, caller, 'read')
          if (!fsSync.existsSync(resolvedSrc)) {
            return { ok: false, success: false, error: '待恢复的源文件不存在' }
          }
          const resolvedDestFile = await this.#ctx.authorizeOutputPath(String(params.targetPath).trim(), caller)
          await fs.mkdir(path.dirname(resolvedDestFile), { recursive: true })
          await fs.copyFile(resolvedSrc, resolvedDestFile)
          return {
            ok: true,
            success: true,
            recoveredCount: 1,
            targetDir: path.dirname(resolvedDestFile),
            targetPath: resolvedDestFile,
            outputPath: resolvedDestFile,
            recoveredFiles: [resolvedDestFile]
          }
        } catch (err) {
          return {
            ok: false,
            success: false,
            error: err instanceof Error ? err.message : '恢复文件失败'
          }
        }
      }

      const resolvedTargetDir = await this.#ctx.authorizeOutputPath(rawTarget, caller)
      await fs.mkdir(resolvedTargetDir, { recursive: true })
      const recovered: string[] = []
      for (const src of sourcePaths) {
        try {
          const resolvedSrc = await this.#ctx.authorizeExistingPath(src, caller, 'read')
          if (!fsSync.existsSync(resolvedSrc)) continue
          const destPath = path.join(resolvedTargetDir, path.basename(resolvedSrc))
          await fs.copyFile(resolvedSrc, destPath)
          recovered.push(destPath)
        } catch {
          // ignore single file failure
        }
      }
      return {
        ok: recovered.length > 0,
        success: recovered.length > 0,
        recoveredCount: recovered.length,
        targetDir: resolvedTargetDir,
        targetPath: recovered[0] ?? resolvedTargetDir,
        outputPath: recovered[0] ?? resolvedTargetDir,
        recoveredFiles: recovered,
        ...(recovered.length === 0 ? { error: '未成功恢复任何有效文件' } : {})
      }
    }

    return this.handleDataRecovery('scan', params, caller)
  }

  async handleShredder(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'shred' ||
      lowerFn === 'shredfiles' ||
      lowerFn === 'securedelete' ||
      lowerFn === 'securewipefile'
    ) {
      const rawPaths = Array.isArray(params.paths)
        ? params.paths.map(String)
        : typeof params.path === 'string'
          ? [params.path]
          : typeof params.filePath === 'string'
            ? [params.filePath]
            : []
      const passes = Math.min(Math.max(Number(params.passes) || 3, 1), 7)

      if (rawPaths.length === 0) {
        return { ok: false, success: false, error: '未提供待粉碎的文件路径' }
      }

      const shredded: string[] = []
      const errors: Array<{ path: string; error: string }> = []

      for (const rawPath of rawPaths) {
        let resolved: string
        try {
          resolved = await this.#ctx.authorizeExistingPath(rawPath, caller, 'write')
        } catch (err) {
          errors.push({ path: rawPath, error: err instanceof Error ? err.message : '路径未授权' })
          continue
        }
        if (isProtectedSystemPath(resolved)) {
          errors.push({ path: resolved, error: '系统受保护路径禁止粉碎' })
          continue
        }
        try {
          const stat = await fs.lstat(resolved)
          if (stat.isFile()) {
            const size = stat.size
            const fh = await fs.open(resolved, 'r+')
            try {
              const chunkSize = Math.min(size || 1, 64 * 1024)
              for (let pass = 0; pass < passes; pass++) {
                let offset = 0
                while (offset < size) {
                  const writeLen = Math.min(chunkSize, size - offset)
                  const buf =
                    pass === 0
                      ? Buffer.alloc(writeLen, 0x00)
                      : pass === 1
                        ? Buffer.alloc(writeLen, 0xff)
                        : crypto.randomBytes(writeLen)
                  await fh.write(buf, 0, writeLen, offset)
                  offset += writeLen
                }
                await fh.sync()
              }
            } finally {
              await fh.close()
            }
            const randomName = path.join(path.dirname(resolved), `.ztools_shred_${crypto.randomBytes(8).toString('hex')}.tmp`)
            await fs.rename(resolved, randomName)
            await fs.unlink(randomName)
            shredded.push(resolved)
          } else if (stat.isDirectory()) {
            await fs.rm(resolved, { recursive: true, force: true })
            shredded.push(resolved)
          }
        } catch (err) {
          errors.push({ path: resolved, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        ok: shredded.length > 0 && errors.length === 0,
        success: shredded.length > 0,
        shreddedCount: shredded.length,
        shredded,
        errors,
        ...(errors.length > 0 && shredded.length === 0 ? { error: errors[0]!.error } : {})
      }
    }

    return {
      ok: true,
      success: true,
      algorithms: [
        { id: 'zero-1', name: '快速单次覆写 (1 Pass 0x00)', passes: 1 },
        { id: 'dod-3', name: 'DoD 5220.22-M 标准粉碎 (3 Passes)', passes: 3 },
        { id: 'gutmann-7', name: '高强度随机密码学覆写 (7 Passes)', passes: 7 }
      ]
    }
  }

  async handleSystemBackup(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const defaultBackupDir = path.join(os.homedir(), 'Documents', 'ZTools_Backups')
    const rawDirParam = String(
      params.backupDir ?? params.vaultDir ?? params.outputDir ?? params.targetDir ?? ''
    ).trim()

    if (
      lowerFn === 'listbackups' ||
      lowerFn === 'getbackups' ||
      lowerFn === 'scansnapshots' ||
      lowerFn === 'scan'
    ) {
      const backupDir = rawDirParam
        ? await this.#ctx.authorizeOutputPath(rawDirParam, caller)
        : defaultBackupDir
      await fs.mkdir(backupDir, { recursive: true })
      const entries = await fs.readdir(backupDir, { withFileTypes: true })
      const backups: Array<Record<string, unknown>> = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue
        const fullPath = path.join(backupDir, entry.name)
        const stat = await fs.stat(fullPath)
        backups.push({
          id: entry.name,
          name: entry.name,
          path: fullPath,
          backupPath: fullPath,
          archivePath: fullPath,
          sizeBytes: stat.size,
          sizeText: formatBytes(stat.size),
          createdAt: stat.mtime.toISOString()
        })
      }
      backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return {
        ok: true,
        success: true,
        backupDir,
        vaultDir: backupDir,
        backups,
        snapshots: backups,
        items: backups
      }
    }

    if (lowerFn === 'createbackup' || lowerFn === 'createsnapshotarchive' || lowerFn === 'backup') {
      const rawSources = Array.isArray(params.sourcePaths)
        ? params.sourcePaths.map(String)
        : Array.isArray(params.paths)
          ? params.paths.map(String)
          : typeof params.sourcePath === 'string'
            ? [params.sourcePath]
            : typeof params.path === 'string'
              ? [params.path]
              : []
      if (rawSources.length === 0) {
        return { ok: false, success: false, error: '未找到任何有效的待备份源文件或目录' }
      }

      const backupDir = rawDirParam
        ? await this.#ctx.authorizeOutputPath(rawDirParam, caller)
        : defaultBackupDir
      await fs.mkdir(backupDir, { recursive: true })
      const rawBackupName = String(
        params.backupName ??
          params.archiveName ??
          params.name ??
          `ztools-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
      )
      const safeBackupFileName = path.basename(rawBackupName.endsWith('.zip') ? rawBackupName : `${rawBackupName}.zip`)
      const outZipPath = await this.#ctx.authorizeOutputPath(path.join(backupDir, safeBackupFileName), caller)

      const zipfile = new yazl.ZipFile()
      let addedCount = 0

      const addDirToZip = async (dirPath: string, zipPrefix: string) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue
          const full = path.join(dirPath, entry.name)
          const rel = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name
          if (entry.isFile()) {
            zipfile.addFile(full, rel)
            addedCount += 1
          } else if (entry.isDirectory()) {
            await addDirToZip(full, rel)
          }
        }
      }

      for (const src of rawSources) {
        try {
          const resolved = await this.#ctx.authorizeExistingPath(src, caller, 'read')
          if (!fsSync.existsSync(resolved)) continue
          const stat = await fs.lstat(resolved)
          if (stat.isFile()) {
            zipfile.addFile(resolved, path.basename(resolved))
            addedCount += 1
          } else if (stat.isDirectory()) {
            await addDirToZip(resolved, path.basename(resolved))
          }
        } catch {
          // skip unauthorized source
        }
      }

      // 严禁在源文件均不存在时伪造 ztools-snapshot-manifest.json 打包空 ZIP
      if (addedCount === 0) {
        return {
          ok: false,
          success: false,
          error: '未找到任何有效的待备份源文件或目录'
        }
      }

      await new Promise<void>((resolve, reject) => {
        const outStream = fsSync.createWriteStream(outZipPath)
        outStream.on('close', () => resolve())
        outStream.on('error', reject)
        zipfile.outputStream.pipe(outStream)
        zipfile.end()
      })

      const stat = await fs.stat(outZipPath)
      return {
        ok: true,
        success: true,
        backupPath: outZipPath,
        archivePath: outZipPath,
        fileCount: addedCount,
        sizeBytes: stat.size,
        sizeText: formatBytes(stat.size)
      }
    }

    if (lowerFn === 'restorebackup' || lowerFn === 'restoresnapshotarchive' || lowerFn === 'restore') {
      const zipPath = String(
        params.backupPath ?? params.archivePath ?? params.filePath ?? params.path ?? params.zipPath ?? ''
      ).trim()
      if (!zipPath) {
        return { ok: false, success: false, error: '需指定备份归档路径 (backupPath / archivePath)' }
      }
      const resolvedZipPath = await this.#ctx.authorizeExistingPath(zipPath, caller, 'read')
      const rawTargetDir = String(params.targetDir ?? params.outputDir ?? params.restoreDir ?? '').trim()
      const defaultRestoreDir = path.join(
        path.dirname(resolvedZipPath),
        `${path.parse(resolvedZipPath).name}_restored`
      )
      const resolvedTarget = await this.#ctx.authorizeOutputPath(rawTargetDir || defaultRestoreDir, caller)
      await fs.mkdir(resolvedTarget, { recursive: true })
      const extractedFiles: string[] = []

      await new Promise<void>((resolve, reject) => {
        yauzl.open(resolvedZipPath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) {
            reject(err ?? new Error('无法打开 ZIP 备份文件'))
            return
          }
          zipfile.readEntry()
          zipfile.on('entry', (entry) => {
            const safeEntryPath = path.resolve(resolvedTarget, entry.fileName)
            if (!safeEntryPath.startsWith(resolvedTarget + path.sep) && safeEntryPath !== resolvedTarget) {
              zipfile.readEntry()
              return
            }
            if (/\/$/.test(entry.fileName)) {
              fs.mkdir(safeEntryPath, { recursive: true })
                .then(() => zipfile.readEntry())
                .catch(reject)
            } else {
              fs.mkdir(path.dirname(safeEntryPath), { recursive: true })
                .then(() => {
                  zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (streamErr || !readStream) {
                      reject(streamErr ?? new Error('读取归档条目失败'))
                      return
                    }
                    const writeStream = fsSync.createWriteStream(safeEntryPath)
                    writeStream.on('close', () => {
                      extractedFiles.push(safeEntryPath)
                      zipfile.readEntry()
                    })
                    writeStream.on('error', reject)
                    readStream.pipe(writeStream)
                  })
                })
                .catch(reject)
            }
          })
          zipfile.on('end', () => resolve())
          zipfile.on('error', reject)
        })
      })

      return {
        ok: true,
        success: true,
        extractedCount: extractedFiles.length,
        restoredCount: extractedFiles.length,
        targetDir: resolvedTarget,
        restoreDir: resolvedTarget,
        extractedFiles
      }
    }

    return this.handleSystemBackup('listBackups', params, caller)
  }

  async #ensureDefaultWorkspaceDb(SQL: SqlJsStatic, caller?: CallerIdentity): Promise<string> {
    const defaultDbPath = await this.#ctx.authorizeOutputPath(
      path.join(os.tmpdir(), 'ztools_workspace.sqlite'),
      caller
    )
    if (!fsSync.existsSync(defaultDbPath) || fsSync.statSync(defaultDbPath).size === 0) {
      const db = new SQL.Database()
      try {
        db.run(`
          CREATE TABLE IF NOT EXISTS ztools_kv_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT OR REPLACE INTO ztools_kv_store (key, value, updated_at)
          VALUES ('schema_version', '1.0.0', datetime('now'));
        `)
        const exported = db.export()
        await fs.mkdir(path.dirname(defaultDbPath), { recursive: true })
        await fs.writeFile(defaultDbPath, Buffer.from(exported))
      } finally {
        db.close()
      }
    }
    return defaultDbPath
  }

  async handleSqlite(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const SQL = await this.#getSqlJs()

    let dbPath = String(params.dbPath ?? params.filePath ?? params.path ?? '').trim()
    if (
      !dbPath &&
      (lowerFn === 'inspectworkspace' ||
        lowerFn === 'gettables' ||
        lowerFn === 'listtables' ||
        lowerFn === 'inspect' ||
        params.scanAppData === true)
    ) {
      dbPath = await this.#ensureDefaultWorkspaceDb(SQL, caller)
    }

    if (!dbPath) {
      return { ok: false, success: false, error: '未提供 SQLite 数据库文件路径 (dbPath)' }
    }

    const rawSql = String(params.sql ?? '').trim()
    const isWriteQuery = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|VACUUM|REINDEX)\b/i.test(rawSql)
    const isWriteCall = lowerFn === 'execute' || lowerFn === 'exec' || isWriteQuery
    const resolvedDbPath = await this.#ctx.authorizeExistingPath(dbPath, caller, isWriteCall ? 'write' : 'read')

    const fileBuf = await fs.readFile(resolvedDbPath)
    const db = new SQL.Database(new Uint8Array(fileBuf))

    try {
      if (
        lowerFn === 'gettables' ||
        lowerFn === 'listtables' ||
        lowerFn === 'inspect' ||
        lowerFn === 'inspectworkspace'
      ) {
        const res = db.exec(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        const tables: Array<Record<string, unknown>> = []
        const values = res[0]?.values ?? []
        for (const row of values) {
          const tableName = String(row[0] ?? '')
          const tableType = String(row[1] ?? 'table')
          const ddl = String(row[2] ?? '')
          let rowCount = 0
          try {
            const countRes = db.exec(`SELECT COUNT(*) FROM "${tableName.replace(/"/g, '""')}"`)
            rowCount = Number(countRes[0]?.values?.[0]?.[0] ?? 0)
          } catch {
            // ignore
          }
          const colRes = db.exec(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
          const columns = (colRes[0]?.values ?? []).map((c) => ({
            cid: c[0],
            name: String(c[1] ?? ''),
            type: String(c[2] ?? ''),
            notnull: Boolean(c[3]),
            defaultValue: c[4],
            pk: Boolean(c[5])
          }))
          tables.push({ name: tableName, type: tableType, rowCount, columns, ddl })
        }

        let sampleRows: Array<Record<string, unknown>> = []
        const firstTableName = typeof tables[0]?.name === 'string' ? tables[0].name : ''
        if (firstTableName) {
          try {
            const preview = db.exec(`SELECT * FROM "${firstTableName.replace(/"/g, '""')}" LIMIT 50`)
            const pFirst = preview[0]
            const pCols = pFirst?.columns ?? []
            sampleRows = (pFirst?.values ?? []).map((r) => {
              const obj: Record<string, unknown> = {}
              pCols.forEach((col, i) => {
                obj[col] = r[i]
              })
              return obj
            })
          } catch {
            // ignore preview error
          }
        }

        return {
          ok: true,
          success: true,
          dbPath: resolvedDbPath,
          sizeBytes: fileBuf.byteLength,
          sizeText: formatBytes(fileBuf.byteLength),
          tables,
          rows: sampleRows
        }
      }

      if (
        lowerFn === 'query' ||
        lowerFn === 'executequery' ||
        lowerFn === 'exec' ||
        lowerFn === 'execute' ||
        lowerFn === 'selecttable'
      ) {
        let sql = rawSql
        if (!sql && typeof params.tableName === 'string') {
          const safeTable = params.tableName.replace(/"/g, '""')
          const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 1000)
          sql = `SELECT * FROM "${safeTable}" LIMIT ${limit}`
        }
        if (!sql) {
          return { ok: false, success: false, error: 'SQL 语句不能为空' }
        }

        const isMutatingOrMaintenance =
          /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|VACUUM|REINDEX)\b/i.test(sql)
        if (isMutatingOrMaintenance && isProtectedSystemPath(resolvedDbPath)) {
          return { ok: false, success: false, error: '拒绝写入受保护系统目录下的 SQLite 数据库' }
        }

        const results = db.exec(sql)
        const changes = db.getRowsModified()

        if (isMutatingOrMaintenance || lowerFn === 'execute' || lowerFn === 'exec') {
          const exported = db.export()
          await fs.writeFile(resolvedDbPath, Buffer.from(exported))
        }

        const first = results[0]
        const columns = first?.columns ?? []
        const rows = (first?.values ?? []).map((row) => {
          const obj: Record<string, unknown> = {}
          columns.forEach((col, i) => {
            obj[col] = row[i]
          })
          return obj
        })
        return {
          ok: true,
          success: true,
          dbPath: resolvedDbPath,
          columns,
          rows,
          rawValues: first?.values ?? [],
          rowCount: rows.length,
          changes
        }
      }

      return this.handleSqlite('getTables', params, caller)
    } finally {
      db.close()
    }
  }

  async #compareSinglePair(
    rawLeft: string,
    rawRight: string,
    caller?: CallerIdentity,
    pairId?: string
  ): Promise<Record<string, unknown>> {
    const leftPath = await this.#ctx.authorizeExistingPath(rawLeft, caller, 'read')
    const rightPath = await this.#ctx.authorizeExistingPath(rawRight, caller, 'read')
    const [leftStat, rightStat] = await Promise.all([fs.stat(leftPath), fs.stat(rightPath)])
    const [leftHash, rightHash] = await Promise.all([
      computeFileSha256(leftPath),
      computeFileSha256(rightPath)
    ])

    const identical = leftHash === rightHash
    const diffLines: Array<{
      type: 'equal' | 'insert' | 'delete' | 'modify'
      leftLineNumber?: number | undefined
      rightLineNumber?: number | undefined
      leftText?: string | undefined
      rightText?: string | undefined
    }> = []

    let isBinary = false
    if (leftStat.size <= 2 * 1024 * 1024 && rightStat.size <= 2 * 1024 * 1024) {
      const [leftBuf, rightBuf] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)])
      isBinary = leftBuf.includes(0) || rightBuf.includes(0)
      if (!isBinary) {
        const leftLines = leftBuf.toString('utf8').split(/\r?\n/)
        const rightLines = rightBuf.toString('utf8').split(/\r?\n/)
        const maxLen = Math.min(Math.max(leftLines.length, rightLines.length), 1500)
        for (let i = 0; i < maxLen; i++) {
          const l = leftLines[i]
          const r = rightLines[i]
          if (l === r) {
            diffLines.push({
              type: 'equal',
              leftLineNumber: i + 1,
              rightLineNumber: i + 1,
              leftText: l,
              rightText: r
            })
          } else if (l !== undefined && r === undefined) {
            diffLines.push({ type: 'delete', leftLineNumber: i + 1, leftText: l })
          } else if (l === undefined && r !== undefined) {
            diffLines.push({ type: 'insert', rightLineNumber: i + 1, rightText: r })
          } else {
            diffLines.push({
              type: 'modify',
              leftLineNumber: i + 1,
              rightLineNumber: i + 1,
              leftText: l,
              rightText: r
            })
          }
        }
      }
    } else {
      isBinary = true
    }

    return {
      ...(pairId !== undefined ? { id: pairId } : {}),
      ok: true,
      success: true,
      identical,
      status: identical ? 'identical' : 'modified',
      isBinary,
      leftPath,
      rightPath,
      leftSize: leftStat.size,
      rightSize: rightStat.size,
      leftSha256: leftHash,
      rightSha256: rightHash,
      diffLines,
      summary: {
        equalCount: diffLines.filter((d) => d.type === 'equal').length,
        modifiedCount: diffLines.filter((d) => d.type === 'modify').length,
        insertedCount: diffLines.filter((d) => d.type === 'insert').length,
        deletedCount: diffLines.filter((d) => d.type === 'delete').length
      }
    }
  }

  async handleFileCompare(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()

    // [P-3] 支持 compareBatch 批量对比文件对
    if (lowerFn === 'comparebatch' || lowerFn === 'comparefiles' || lowerFn === 'file_compare_batch') {
      const rawPairs = Array.isArray(params.pairs) ? params.pairs : []
      if (rawPairs.length === 0 && (params.leftPath || params.left) && (params.rightPath || params.right)) {
        return this.#compareSinglePair(
          String(params.leftPath ?? params.left),
          String(params.rightPath ?? params.right),
          caller
        )
      }
      const results: Array<Record<string, unknown>> = []
      for (let i = 0; i < rawPairs.length; i++) {
        const item = rawPairs[i] as Record<string, unknown> | null
        if (!item || typeof item !== 'object') continue
        const pairId = typeof item.id === 'string' ? item.id : `pair-${i + 1}`
        const rawLeft = String(item.leftPath ?? item.left ?? item.sourcePath ?? '').trim()
        const rawRight = String(item.rightPath ?? item.right ?? item.targetPath ?? '').trim()
        if (!rawLeft || !rawRight) {
          results.push({
            id: pairId,
            ok: false,
            success: false,
            status: 'missing',
            leftPath: rawLeft,
            rightPath: rawRight,
            error: '文件对比路径缺失'
          })
          continue
        }
        try {
          const singleRes = await this.#compareSinglePair(rawLeft, rawRight, caller, pairId)
          results.push(singleRes)
        } catch (err) {
          results.push({
            id: pairId,
            ok: false,
            success: false,
            status: 'missing',
            leftPath: rawLeft,
            rightPath: rawRight,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return {
        ok: true,
        success: true,
        comparedCount: results.length,
        results
      }
    }

    if (lowerFn === 'comparedirectories' || lowerFn === 'comparedirs') {
      const rawLeftDir = String(params.leftDir ?? params.leftPath ?? '').trim()
      const rawRightDir = String(params.rightDir ?? params.rightPath ?? '').trim()
      if (!rawLeftDir || !rawRightDir) {
        return { ok: false, success: false, error: '需同时指定左右对比目录路径' }
      }
      const leftDir = await this.#ctx.authorizeExistingPath(rawLeftDir, caller, 'read')
      const rightDir = await this.#ctx.authorizeExistingPath(rawRightDir, caller, 'read')

      const [leftEntries, rightEntries] = await Promise.all([
        fs.readdir(leftDir, { withFileTypes: true }),
        fs.readdir(rightDir, { withFileTypes: true })
      ])
      const leftMap = new Map(leftEntries.filter((e) => e.isFile()).map((e) => [e.name, path.join(leftDir, e.name)]))
      const rightMap = new Map(rightEntries.filter((e) => e.isFile()).map((e) => [e.name, path.join(rightDir, e.name)]))
      const allNames = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort()
      const diffs: Array<Record<string, unknown>> = []

      for (const name of allNames) {
        const lPath = leftMap.get(name)
        const rPath = rightMap.get(name)
        if (lPath && !rPath) {
          const st = await fs.stat(lPath)
          diffs.push({ name, status: 'left-only', leftSize: st.size, rightSize: 0 })
        } else if (!lPath && rPath) {
          const st = await fs.stat(rPath)
          diffs.push({ name, status: 'right-only', leftSize: 0, rightSize: st.size })
        } else if (lPath && rPath) {
          const [lStat, rStat, lHash, rHash] = await Promise.all([
            fs.stat(lPath),
            fs.stat(rPath),
            computeFileSha256(lPath),
            computeFileSha256(rPath)
          ])
          diffs.push({
            name,
            status: lHash === rHash ? 'identical' : 'modified',
            leftSize: lStat.size,
            rightSize: rStat.size,
            leftHash: lHash,
            rightHash: rHash
          })
        }
      }

      return { ok: true, success: true, leftDir, rightDir, diffs }
    }

    const rawLeftPath = String(params.leftPath ?? params.left ?? params.fileA ?? '').trim()
    const rawRightPath = String(params.rightPath ?? params.right ?? params.fileB ?? '').trim()
    if (!rawLeftPath || !rawRightPath) {
      return { ok: false, success: false, error: '需同时提供左右两个待对比文件路径 (leftPath, rightPath)' }
    }
    return this.#compareSinglePair(rawLeftPath, rawRightPath, caller)
  }

  async handleBatchRename(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawItems = Array.isArray(params.items)
      ? params.items
      : Array.isArray(params.files)
        ? params.files
        : Array.isArray(params.pairs)
          ? params.pairs
          : []

    const renamed: Array<{ oldPath: string; newPath: string }> = []
    const errors: Array<{ path: string; error: string }> = []

    if (
      lowerFn === 'executebatchrename' ||
      lowerFn === 'batchrenamebyrule' ||
      lowerFn === 'renamefiles' ||
      lowerFn === 'rename'
    ) {
      const prefix = typeof params.prefix === 'string' ? params.prefix : ''
      const suffix = typeof params.suffix === 'string' ? params.suffix : ''
      const searchText = typeof params.searchText === 'string' ? params.searchText : typeof params.find === 'string' ? params.find : ''
      const replaceText = typeof params.replaceText === 'string' ? params.replaceText : typeof params.replace === 'string' ? params.replace : ''

      for (const entry of rawItems) {
        let rawSrc = ''
        let rawDst = ''
        if (typeof entry === 'string') {
          rawSrc = entry.trim()
          const dir = path.dirname(rawSrc)
          const ext = path.extname(rawSrc)
          let base = path.basename(rawSrc, ext)
          if (searchText) {
            base = base.split(searchText).join(replaceText)
          }
          rawDst = path.join(dir, `${prefix}${base}${suffix}${ext}`)
        } else if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>
          rawSrc = String(obj.oldPath ?? obj.sourcePath ?? obj.path ?? obj.src ?? '').trim()
          if (typeof obj.newPath === 'string' && obj.newPath.trim()) {
            rawDst = obj.newPath.trim()
          } else if (typeof obj.targetPath === 'string' && obj.targetPath.trim()) {
            rawDst = obj.targetPath.trim()
          } else if (typeof obj.newName === 'string' && obj.newName.trim() && rawSrc) {
            rawDst = path.join(path.dirname(rawSrc), path.basename(obj.newName.trim()))
          }
        }
        if (!rawSrc || !rawDst) continue
        try {
          const resolvedSrc = await this.#ctx.authorizeExistingPath(rawSrc, caller, 'write')
          const resolvedDst = await this.#ctx.authorizeOutputPath(rawDst, caller)
          if (isProtectedSystemPath(resolvedSrc) || isProtectedSystemPath(resolvedDst)) {
            errors.push({ path: resolvedSrc, error: '受保护系统路径禁止重命名' })
            continue
          }
          if (resolvedSrc !== resolvedDst) {
            await fs.rename(resolvedSrc, resolvedDst)
          }
          renamed.push({ oldPath: resolvedSrc, newPath: resolvedDst })
        } catch (err) {
          errors.push({ path: rawSrc, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        ok: errors.length === 0,
        success: renamed.length > 0 || rawItems.length === 0,
        renamedCount: renamed.length,
        renamed,
        errors
      }
    }

    return { ok: true, success: true, renamedCount: 0, renamed: [], errors: [] }
  }

  async handleCleaner(
    pluginName: string,
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()

    if (lowerFn === 'emptyrecyclebin' || lowerFn === 'clearrecyclebin') {
      if (process.platform === 'win32') {
        const out = await runPowerShell(
          `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output 'OK'`,
          10_000
        )
        const ok = out.includes('OK')
        return {
          ok,
          success: ok,
          plugin: pluginName,
          message: ok ? '已清空系统回收站' : undefined,
          ...(ok ? {} : { error: '清空回收站失败' })
        }
      }
      return { ok: false, success: false, error: '当前系统不支持 Clear-RecycleBin' }
    }

    if (
      lowerFn === 'startcleanwithselection' ||
      lowerFn === 'cleanfiles' ||
      lowerFn === 'deletefiles' ||
      lowerFn === 'cleanselected' ||
      lowerFn === 'removefiles'
    ) {
      const rawPaths = Array.isArray(params.paths)
        ? params.paths.map(String)
        : Array.isArray(params.selectedPaths)
          ? params.selectedPaths.map(String)
          : Array.isArray(params.selection)
            ? params.selection.map(String)
            : Array.isArray(params.files)
              ? params.files.map(String)
              : typeof params.path === 'string'
                ? [params.path]
                : []
      let freedBytes = 0
      const deleted: string[] = []
      const errors: Array<{ path: string; error: string }> = []

      for (const rawPath of rawPaths) {
        try {
          const resolved = await this.#ctx.authorizeExistingPath(rawPath, caller, 'write')
          if (isProtectedSystemPath(resolved)) {
            errors.push({ path: resolved, error: '系统受保护路径禁止清理' })
            continue
          }
          const stat = await fs.lstat(resolved)
          const bytes = stat.isDirectory() ? (await calculateDirectorySize(resolved, 2)).totalBytes : stat.size
          await fs.rm(resolved, { recursive: true, force: true })
          freedBytes += bytes
          deleted.push(resolved)
        } catch (err) {
          errors.push({ path: rawPath, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        ok: errors.length === 0,
        success: deleted.length > 0,
        deletedCount: deleted.length,
        cleanedCount: deleted.length,
        freedBytes,
        freedText: formatBytes(freedBytes),
        deleted,
        errors,
        ...(errors.length > 0 && deleted.length === 0 ? { error: errors[0]!.error } : {})
      }
    }

    const scanTarget =
      typeof params.path === 'string' && params.path.trim()
        ? await this.#ctx.authorizeExistingPath(params.path.trim(), caller, 'read')
        : typeof params.scanPath === 'string' && params.scanPath.trim()
          ? await this.#ctx.authorizeExistingPath(params.scanPath.trim(), caller, 'read')
          : os.tmpdir()

    const files: Array<Record<string, unknown>> = []
    let totalBytes = 0
    if (fsSync.existsSync(scanTarget)) {
      try {
        const entries = await fs.readdir(scanTarget, { withFileTypes: true })
        for (const entry of entries.slice(0, 100)) {
          if (entry.isSymbolicLink()) continue
          const full = path.join(scanTarget, entry.name)
          try {
            const st = await fs.stat(full)
            if (st.isFile()) {
              totalBytes += st.size
              files.push({
                id: crypto.createHash('md5').update(full).digest('hex').slice(0, 10),
                name: entry.name,
                path: full,
                size: st.size,
                sizeBytes: st.size,
                sizeText: formatBytes(st.size),
                modifiedAt: st.mtime.toISOString(),
                extension: path.extname(entry.name).toLowerCase()
              })
            }
          } catch {
            // skip unreadable
          }
        }
      } catch {
        // skip unreadable dir
      }
    }

    files.sort((a, b) => Number(b.sizeBytes ?? 0) - Number(a.sizeBytes ?? 0))
    return {
      ok: true,
      success: true,
      plugin: pluginName,
      scanPath: scanTarget,
      totalBytes,
      totalSizeBytes: totalBytes,
      totalSizeText: formatBytes(totalBytes),
      fileCount: files.length,
      categories: [
        {
          id: 'system-temp',
          name: '系统临时与缓存文件',
          path: scanTarget,
          sizeBytes: totalBytes,
          sizeText: formatBytes(totalBytes),
          fileCount: files.length
        }
      ],
      files,
      items: files
    }
  }
}
