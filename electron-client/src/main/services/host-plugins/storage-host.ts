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
      const backupSourcePath = `${resolvedSource}.ztools-mover-bak-${Date.now()}`
      await fs.rename(resolvedSource, backupSourcePath)

      try {
        if (process.platform === 'win32') {
          const mklink = await runCommand('cmd.exe', ['/c', 'mklink', '/J', resolvedSource, destDir], 15_000, signal)
          if (mklink.exitCode !== 0) {
            await fs.symlink(destDir, resolvedSource, 'junction')
          }
        } else {
          await fs.symlink(destDir, resolvedSource, 'dir')
        }
      } catch (linkErr) {
        // 联接建立失败时立即回滚源目录，绝不丢失用户源文件
        await fs.rm(resolvedSource, { recursive: true, force: true }).catch(() => undefined)
        await fs.rename(backupSourcePath, resolvedSource).catch(async () => {
          await fs.cp(backupSourcePath, resolvedSource, { recursive: true, force: true })
          await fs.rm(backupSourcePath, { recursive: true, force: true })
        })
        await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined)
        throw linkErr
      }

      await fs.rm(backupSourcePath, { recursive: true, force: true })

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
      const stagingRestorePath = `${resolvedSource}.ztools-restore-tmp-${Date.now()}`
      await fs.cp(realTarget, stagingRestorePath, { recursive: true, force: true })
      try {
        await fs.unlink(resolvedSource)
        await fs.rename(stagingRestorePath, resolvedSource)
      } catch (restoreErr) {
        if (!fsSync.existsSync(resolvedSource)) {
          await fs
            .symlink(realTarget, resolvedSource, process.platform === 'win32' ? 'junction' : 'dir')
            .catch(() => undefined)
        }
        await fs.rm(stagingRestorePath, { recursive: true, force: true }).catch(() => undefined)
        throw restoreErr
      }
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
      const customScanDirs = new Set<string>()
      if (typeof params.scanPath === 'string' && params.scanPath.trim()) {
        try {
          const authScanPath = await this.#ctx.authorizeExistingPath(params.scanPath.trim(), caller, 'read')
          searchDirs.push(authScanPath)
          customScanDirs.add(authScanPath)
        } catch {
          // ignore unauthorized custom scan path
        }
      }
      if (params.scanTmp === true) {
        searchDirs.push(os.tmpdir())
      }

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
        const isRecycleBin = dir.includes('$Recycle.Bin') || dir.includes('.Trash')
        const isCustomDir = customScanDirs.has(dir)
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          for (const entry of entries.slice(0, 120)) {
            if (!entry.isFile()) continue
            if (entry.name.startsWith('$I') || entry.name === 'desktop.ini') continue
            if (
              !isRecycleBin &&
              !isCustomDir &&
              !/(?:\.(?:bak|tmp|old|orig|recover|deleted)$|^~\$|\$R|backup|deleted|recycle)/i.test(entry.name)
            ) {
              continue
            }
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
                integrity: isRecycleBin || ext === '.bak' ? '回收站/备份可恢复' : '临时缓存快照',
                locationType: isRecycleBin ? '回收站残留' : '临时缓存区'
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

  #decodeZipFileName(rawName: Buffer | string, isUtf8Flag: boolean): string {
    if (typeof rawName === 'string') return rawName.replace(/\\/g, '/')
    if (isUtf8Flag) {
      return rawName.toString('utf8').replace(/\\/g, '/')
    }
    const utf8Str = rawName.toString('utf8')
    if (!utf8Str.includes('\uFFFD')) {
      const reconverted = Buffer.from(utf8Str, 'utf8')
      if (reconverted.equals(rawName)) {
        return utf8Str.replace(/\\/g, '/')
      }
    }
    try {
      const gbkDecoder = new TextDecoder('gb18030', { fatal: false })
      return gbkDecoder.decode(rawName).replace(/\\/g, '/')
    } catch {
      return utf8Str.replace(/\\/g, '/')
    }
  }

  #classifyArchiveEntryCategory(name: string, isDirectory: boolean): string {
    if (isDirectory) return '文件夹'
    const ext = path.extname(name).toLowerCase()
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv'].includes(ext)) {
      return '办公文档'
    }
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.mp4', '.mov', '.mp3', '.wav'].includes(ext)) {
      return '图片与媒体'
    }
    if (['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.cs', '.html', '.css', '.sql', '.xml', '.yaml', '.yml'].includes(ext)) {
      return '源码与配置'
    }
    if (['.exe', '.msi', '.dll', '.bat', '.cmd', '.ps1', '.sh'].includes(ext)) {
      return '可执行程序'
    }
    return '其他文件'
  }

  #isUnsafeArchiveEntryPath(entryName: string): boolean {
    const normalized = String(entryName || '').replace(/\\/g, '/')
    if (!normalized || normalized.includes('\0')) return true
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true
    const parts = normalized.split('/')
    return parts.some((p) => p === '..')
  }

  async handleArchiveManager(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()

    if (
      lowerFn === 'listarchiveentries' ||
      lowerFn === 'inspectarchive' ||
      lowerFn === 'listentries' ||
      lowerFn === 'scanarchive'
    ) {
      const rawArchivePath = String(
        params.archivePath ?? params.filePath ?? params.path ?? params.zipPath ?? ''
      ).trim()
      if (!rawArchivePath) {
        return { ok: false, success: false, error: '未指定待透视的压缩包路径 (archivePath)' }
      }

      let resolvedArchive: string
      try {
        resolvedArchive = await this.#ctx.authorizeExistingPath(rawArchivePath, caller, 'read')
      } catch (err) {
        return { ok: false, success: false, error: err instanceof Error ? err.message : String(err) }
      }

      if (!fsSync.existsSync(resolvedArchive)) {
        return { ok: false, success: false, error: `压缩包文件不存在: ${resolvedArchive}` }
      }

      const stat = await fs.stat(resolvedArchive)
      if (stat.size === 0) {
        return { ok: false, success: false, error: '压缩包文件为空 (0 B) 或头部已损坏' }
      }

      const entries: Array<{
        entryName: string
        name: string
        category: string
        uncompressedSize: number
        compressedSize: number
        uncompressedText: string
        compressedText: string
        compressionRatio: number
        crc32: string
        isDirectory: boolean
        isEncrypted: boolean
        hasPathTraversalRisk: boolean
        lastModified: string
      }> = []

      let totalUncompressedBytes = 0
      let totalCompressedBytes = 0
      let encryptedCount = 0
      let traversalRiskCount = 0

      try {
        await new Promise<void>((resolve, reject) => {
          yauzl.open(
            resolvedArchive,
            { lazyEntries: true, decodeStrings: false, validateEntrySizes: false },
            (err, zipfile) => {
              if (err || !zipfile) {
                reject(err ?? new Error('无法解析 ZIP 归档头部结构'))
                return
              }
              zipfile.readEntry()
              zipfile.on('entry', (entry) => {
                if (signal?.aborted) {
                  zipfile.close()
                  reject(new Error('操作已取消'))
                  return
                }
                const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0
                const isEncrypted = (entry.generalPurposeBitFlag & 0x1) !== 0
                const decodedName = this.#decodeZipFileName(entry.fileName as unknown as Buffer, isUtf8)
                const isDir = decodedName.endsWith('/')
                const cleanName = decodedName.replace(/\/+$/, '')
                const baseName = cleanName.split('/').pop() || cleanName
                const hasRisk = this.#isUnsafeArchiveEntryPath(decodedName)
                const uncomp = Math.max(0, Number(entry.uncompressedSize || 0))
                const comp = Math.max(0, Number(entry.compressedSize || 0))
                const ratio = uncomp > 0 ? Math.max(0, Math.min(100, Math.round((1 - comp / uncomp) * 100))) : 0

                if (!isDir) {
                  totalUncompressedBytes += uncomp
                  totalCompressedBytes += comp
                }
                if (isEncrypted) encryptedCount += 1
                if (hasRisk) traversalRiskCount += 1

                let mtimeIso = stat.mtime.toISOString()
                try {
                  if (typeof entry.getLastModDate === 'function') {
                    const dt = entry.getLastModDate()
                    if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
                      mtimeIso = dt.toISOString()
                    }
                  }
                } catch {
                  // ignore invalid dos date
                }

                entries.push({
                  entryName: decodedName,
                  name: baseName,
                  category: this.#classifyArchiveEntryCategory(baseName, isDir),
                  uncompressedSize: uncomp,
                  compressedSize: comp,
                  uncompressedText: formatBytes(uncomp),
                  compressedText: formatBytes(comp),
                  compressionRatio: ratio,
                  crc32: (entry.crc32 >>> 0).toString(16).toUpperCase().padStart(8, '0'),
                  isDirectory: isDir,
                  isEncrypted,
                  hasPathTraversalRisk: hasRisk,
                  lastModified: mtimeIso
                })
                zipfile.readEntry()
              })
              zipfile.on('end', () => resolve())
              zipfile.on('error', reject)
            }
          )
        })
      } catch (err) {
        return {
          ok: false,
          success: false,
          archivePath: resolvedArchive,
          error: `压缩包损坏或格式不受支持: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const fileEntries = entries.filter((e) => !e.isDirectory)
      const topLevelNames = new Set(
        entries
          .map((e) => e.entryName.replace(/^\/+/, '').split('/')[0])
          .filter(Boolean)
      )
      const hasSingleRootFolder = topLevelNames.size === 1 && entries.some((e) => e.entryName.includes('/'))
      const overallRatio =
        totalUncompressedBytes > 0
          ? Math.max(0, Math.min(100, Math.round((1 - totalCompressedBytes / totalUncompressedBytes) * 100)))
          : 0

      return {
        ok: true,
        success: true,
        archivePath: resolvedArchive,
        archiveName: path.basename(resolvedArchive),
        archiveSizeBytes: stat.size,
        archiveSizeText: formatBytes(stat.size),
        totalEntries: entries.length,
        fileCount: fileEntries.length,
        totalUncompressedBytes,
        totalUncompressedText: formatBytes(totalUncompressedBytes),
        totalCompressedBytes,
        totalCompressedText: formatBytes(totalCompressedBytes),
        compressionRatio: overallRatio,
        encryptedCount,
        isEncrypted: encryptedCount > 0,
        traversalRiskCount,
        hasSingleRootFolder,
        singleRootFolderName: hasSingleRootFolder ? Array.from(topLevelNames)[0] : null,
        entries
      }
    }

    if (
      lowerFn === 'extractarchiveentries' ||
      lowerFn === 'extractarchive' ||
      lowerFn === 'extract' ||
      lowerFn === 'unzip'
    ) {
      const rawArchivePath = String(
        params.archivePath ?? params.filePath ?? params.path ?? params.zipPath ?? ''
      ).trim()
      if (!rawArchivePath) {
        return { ok: false, success: false, error: '需指定待解压的压缩包路径 (archivePath)' }
      }

      const resolvedArchive = await this.#ctx.authorizeExistingPath(rawArchivePath, caller, 'read')
      if (!fsSync.existsSync(resolvedArchive)) {
        return { ok: false, success: false, error: `压缩包文件不存在: ${resolvedArchive}` }
      }

      const selectedEntries = Array.isArray(params.entryNames)
        ? new Set(params.entryNames.map((s) => String(s).replace(/\\/g, '/')))
        : Array.isArray(params.entries)
          ? new Set(params.entries.map((s) => String(s).replace(/\\/g, '/')))
          : null

      const smartUnwrap = params.smartUnwrap !== false
      const archiveBaseName = path.parse(resolvedArchive).name
      const rawTargetDir = String(params.targetDir ?? params.outputDir ?? '').trim()

      const inspected = (await this.handleArchiveManager(
        'ListArchiveEntries',
        { archivePath: resolvedArchive },
        caller,
        signal
      )) as Record<string, unknown>

      if (!inspected.ok) {
        return inspected
      }

      if (inspected.isEncrypted && !params.password) {
        return {
          ok: false,
          success: false,
          error: 'ENCRYPTED_ARCHIVE: 该压缩包包含加密条目，当前暂不支持无密码提取加密流'
        }
      }

      const hasSingleRoot = Boolean(inspected.hasSingleRootFolder)
      const defaultOutDir =
        smartUnwrap && hasSingleRoot && (!selectedEntries || selectedEntries.size === 0)
          ? path.dirname(resolvedArchive)
          : path.join(path.dirname(resolvedArchive), archiveBaseName)

      const resolvedTargetDir = await this.#ctx.authorizeOutputPath(rawTargetDir || defaultOutDir, caller)
      if (isProtectedSystemPath(resolvedTargetDir)) {
        return { ok: false, success: false, error: '拒绝解压到受保护的系统核心目录' }
      }
      await fs.mkdir(resolvedTargetDir, { recursive: true })

      const extractedFiles: string[] = []
      const blockedEntries: string[] = []

      try {
        await new Promise<void>((resolve, reject) => {
          yauzl.open(
            resolvedArchive,
            { lazyEntries: true, decodeStrings: false, validateEntrySizes: false },
            (err, zipfile) => {
              if (err || !zipfile) {
                reject(err ?? new Error('无法打开 ZIP 压缩包'))
                return
              }
              zipfile.readEntry()
              zipfile.on('entry', (entry) => {
                if (signal?.aborted) {
                  zipfile.close()
                  reject(new Error('解压任务已取消'))
                  return
                }
                const isUtf8 = (entry.generalPurposeBitFlag & 0x800) !== 0
                const decodedName = this.#decodeZipFileName(entry.fileName as unknown as Buffer, isUtf8)

                if (selectedEntries && selectedEntries.size > 0) {
                  const normalized = decodedName.replace(/\/+$/, '')
                  const matched =
                    selectedEntries.has(decodedName) ||
                    selectedEntries.has(normalized) ||
                    Array.from(selectedEntries).some((sel) => decodedName.startsWith(`${sel.replace(/\/+$/, '')}/`))
                  if (!matched) {
                    zipfile.readEntry()
                    return
                  }
                }

                if (this.#isUnsafeArchiveEntryPath(decodedName)) {
                  blockedEntries.push(decodedName)
                  zipfile.readEntry()
                  return
                }

                const targetEntryPath =
                  selectedEntries && selectedEntries.size > 0 && params.flattenSelected === true
                    ? path.resolve(resolvedTargetDir, path.basename(decodedName))
                    : path.resolve(resolvedTargetDir, decodedName)

                const rel = path.relative(resolvedTargetDir, targetEntryPath)
                if (rel.startsWith('..') || path.isAbsolute(rel)) {
                  blockedEntries.push(decodedName)
                  zipfile.readEntry()
                  return
                }

                if (decodedName.endsWith('/')) {
                  fs.mkdir(targetEntryPath, { recursive: true })
                    .then(() => zipfile.readEntry())
                    .catch(reject)
                  return
                }

                fs.mkdir(path.dirname(targetEntryPath), { recursive: true })
                  .then(() => {
                    zipfile.openReadStream(entry, (streamErr, readStream) => {
                      if (streamErr || !readStream) {
                        reject(streamErr ?? new Error(`读取条目流失败: ${decodedName}`))
                        return
                      }
                      const writeStream = fsSync.createWriteStream(targetEntryPath)
                      writeStream.on('close', () => {
                        extractedFiles.push(targetEntryPath)
                        zipfile.readEntry()
                      })
                      writeStream.on('error', reject)
                      readStream.on('error', reject)
                      readStream.pipe(writeStream)
                    })
                  })
                  .catch(reject)
              })
              zipfile.on('end', () => resolve())
              zipfile.on('error', reject)
            }
          )
        })
      } catch (err) {
        return {
          ok: false,
          success: false,
          targetDir: resolvedTargetDir,
          extractedFiles,
          blockedEntries,
          error: err instanceof Error ? err.message : String(err)
        }
      }

      if (blockedEntries.length > 0 && extractedFiles.length === 0) {
        return {
          ok: false,
          success: false,
          targetDir: resolvedTargetDir,
          extractedCount: 0,
          extractedFiles: [],
          blockedEntries,
          error: `ZIP_SLIP_BLOCKED: 已拦截 ${blockedEntries.length} 个包含非法路径穿越 (../) 的恶意条目`
        }
      }

      return {
        ok: true,
        success: true,
        archivePath: resolvedArchive,
        targetDir: resolvedTargetDir,
        extractedCount: extractedFiles.length,
        extractedFiles,
        blockedEntries
      }
    }

    if (lowerFn === 'createarchive' || lowerFn === 'packfiles' || lowerFn === 'zipfiles') {
      const rawSources = Array.isArray(params.sourcePaths)
        ? params.sourcePaths.map(String)
        : Array.isArray(params.paths)
          ? params.paths.map(String)
          : Array.isArray(params.files)
            ? params.files.map(String)
            : typeof params.sourcePath === 'string'
              ? [params.sourcePath]
              : []

      if (rawSources.length === 0) {
        return { ok: false, success: false, error: '需提供至少一个待打包的文件或目录 (sourcePaths)' }
      }

      const firstResolved = await this.#ctx.authorizeExistingPath(rawSources[0]!, caller, 'read')
      const rawOutputZip = String(params.outputPath ?? params.archivePath ?? params.zipPath ?? '').trim()
      const defaultZipPath = path.join(
        path.dirname(firstResolved),
        `${path.parse(firstResolved).name}_归档_${Date.now()}.zip`
      )
      const resolvedOutZip = await this.#ctx.authorizeOutputPath(rawOutputZip || defaultZipPath, caller)
      if (isProtectedSystemPath(resolvedOutZip)) {
        return { ok: false, success: false, error: '禁止在系统核心受保护目录创建压缩包' }
      }
      await fs.mkdir(path.dirname(resolvedOutZip), { recursive: true })

      const zipfile = new yazl.ZipFile()
      let addedCount = 0

      const addDir = async (dirPath: string, prefix: string) => {
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
        for (const de of dirEntries) {
          if (de.isSymbolicLink()) continue
          const full = path.join(dirPath, de.name)
          const rel = prefix ? `${prefix}/${de.name}` : de.name
          if (de.isFile()) {
            zipfile.addFile(full, rel)
            addedCount += 1
          } else if (de.isDirectory()) {
            await addDir(full, rel)
          }
        }
      }

      for (const rawSrc of rawSources) {
        const resolved = await this.#ctx.authorizeExistingPath(rawSrc, caller, 'read')
        if (!fsSync.existsSync(resolved)) continue
        const st = await fs.lstat(resolved)
        if (st.isFile()) {
          zipfile.addFile(resolved, path.basename(resolved))
          addedCount += 1
        } else if (st.isDirectory()) {
          await addDir(resolved, path.basename(resolved))
        }
      }

      if (addedCount === 0) {
        return { ok: false, success: false, error: '未找到任何有效可打包的文件' }
      }

      await new Promise<void>((resolve, reject) => {
        const outStream = fsSync.createWriteStream(resolvedOutZip)
        outStream.on('close', () => resolve())
        outStream.on('error', reject)
        zipfile.outputStream.pipe(outStream)
        zipfile.end()
      })

      const outStat = await fs.stat(resolvedOutZip)
      const sha256 = await computeFileSha256(resolvedOutZip)
      return {
        ok: true,
        success: true,
        archivePath: resolvedOutZip,
        fileCount: addedCount,
        sizeBytes: outStat.size,
        sizeText: formatBytes(outStat.size),
        sha256
      }
    }

    if (lowerFn === 'verifyarchive' || lowerFn === 'testarchive') {
      const rawArchivePath = String(
        params.archivePath ?? params.filePath ?? params.path ?? ''
      ).trim()
      if (!rawArchivePath) {
        return { ok: false, success: false, error: '需指定待校验的压缩包路径' }
      }
      const resolvedArchive = await this.#ctx.authorizeExistingPath(rawArchivePath, caller, 'read')
      const inspected = (await this.handleArchiveManager(
        'ListArchiveEntries',
        { archivePath: resolvedArchive },
        caller,
        signal
      )) as Record<string, unknown>
      if (!inspected.ok) {
        return inspected
      }
      const sha256 = await computeFileSha256(resolvedArchive)
      return {
        ok: true,
        success: true,
        archivePath: resolvedArchive,
        sha256,
        totalEntries: inspected.totalEntries,
        fileCount: inspected.fileCount,
        traversalRiskCount: inspected.traversalRiskCount,
        isEncrypted: inspected.isEncrypted,
        verified: Number(inspected.traversalRiskCount ?? 0) === 0
      }
    }

    return this.handleArchiveManager('ListArchiveEntries', params, caller, signal)
  }

  #isDownloadTempOrHiddenFile(fileName: string): boolean {
    const lower = String(fileName || '').trim().toLowerCase()
    if (!lower || lower === 'desktop.ini' || lower === '.ds_store' || lower === 'thumbs.db') {
      return true
    }
    const tempSuffixes = [
      '.crdownload',
      '.part',
      '.partial',
      '.opdownload',
      '.download',
      '.td',
      '.xltd',
      '.baiduyun.p.downloading',
      '.aria2',
      '.tmp'
    ]
    return tempSuffixes.some((ext) => lower.endsWith(ext))
  }

  #classifyDownloadFileType(fileName: string): string {
    const ext = path.extname(String(fileName || '')).toLowerCase()
    if (['.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk', '.msix'].includes(ext)) {
      return 'installer'
    }
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.zst', '.iso'].includes(ext)) {
      return 'archive'
    }
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.md', '.rtf', '.epub', '.ofd'].includes(ext)) {
      return 'document'
    }
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.psd', '.tif', '.tiff'].includes(ext)) {
      return 'image'
    }
    if (['.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.wmv', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'].includes(ext)) {
      return 'media'
    }
    if (['.json', '.yaml', '.yml', '.xml', '.sql', '.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.sh', '.ps1', '.bat', '.log'].includes(ext)) {
      return 'code'
    }
    return 'other'
  }

  async #discoverDownloadSources(customDirs: string[] = []): Promise<Array<{
    id: string
    label: string
    channel: 'browser' | 'netdisk' | 'im' | 'custom'
    appName: string
    path: string
  }>> {
    const home = os.homedir()
    const docs = path.join(home, 'Documents')
    const sysDownloads = path.join(home, 'Downloads')
    const seen = new Set<string>()
    const sources: Array<{
      id: string
      label: string
      channel: 'browser' | 'netdisk' | 'im' | 'custom'
      appName: string
      path: string
    }> = []

    const addSource = (
      id: string,
      label: string,
      channel: 'browser' | 'netdisk' | 'im' | 'custom',
      appName: string,
      dirPath: string
    ) => {
      if (!dirPath) return
      const resolved = path.resolve(dirPath)
      const normKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(normKey)) return
      try {
        if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isDirectory()) return
      } catch {
        return
      }
      seen.add(normKey)
      sources.push({ id, label, channel, appName, path: resolved })
    }

    addSource('browser-default', '浏览器与系统下载', 'browser', '系统下载', sysDownloads)

    if (process.platform === 'win32') {
      try {
        const regOut = await runCommand(
          'reg',
          [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
            '/v',
            '{374DE290-123F-4565-9164-39C4925E467B}'
          ],
          2500
        )
        const match = regOut.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/im)
        if (match?.[1]) {
          const expanded = match[1]
            .trim()
            .replace(/%USERPROFILE%/gi, home)
            .replace(/%HOMEDRIVE%%HOMEPATH%/gi, home)
          addSource('browser-shell-downloads', '系统重定向下载目录', 'browser', '系统下载', expanded)
        }
      } catch {
        // ignore registry query error
      }
    }

    const drives = process.platform === 'win32'
      ? ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\'].filter((d) => {
          try {
            return fsSync.existsSync(d)
          } catch {
            return false
          }
        })
      : [home, sysDownloads]

    const netdiskCandidates: Array<{ sub: string; label: string; appName: string; ch?: 'browser' | 'netdisk' }> = [
      { sub: 'BaiduNetdiskDownload', label: '百度网盘下载', appName: '百度网盘' },
      { sub: 'QuarkDownload', label: '夸克网盘下载', appName: '夸克网盘' },
      { sub: '夸克网盘下载', label: '夸克网盘下载', appName: '夸克网盘' },
      { sub: 'AliyunPanDownload', label: '阿里云盘下载', appName: '阿里云盘' },
      { sub: '阿里云盘下载', label: '阿里云盘下载', appName: '阿里云盘' },
      { sub: '115download', label: '115网盘下载', appName: '115网盘' },
      { sub: '迅雷下载', label: '迅雷下载', appName: '迅雷' },
      { sub: 'TDDOWNLOAD', label: '迅雷下载 (TDDOWNLOAD)', appName: '迅雷' },
      { sub: '360Download', label: '360浏览器下载', appName: '360浏览器', ch: 'browser' },
      { sub: '360安全浏览器下载', label: '360安全浏览器下载', appName: '360浏览器', ch: 'browser' }
    ]

    for (const root of drives) {
      for (const cand of netdiskCandidates) {
        const candidatePath = path.join(root, cand.sub)
        addSource(
          `netdisk-${cand.appName}-${cand.sub}-${root.replace(/[^A-Za-z0-9]/g, '')}`,
          cand.label,
          cand.ch ?? 'netdisk',
          cand.appName,
          candidatePath
        )
      }
    }

    for (const idmSub of ['Compressed', 'Programs', 'Video', 'Documents', 'Music']) {
      addSource(`idm-${idmSub.toLowerCase()}`, `IDM 下载 (${idmSub})`, 'netdisk', 'IDM', path.join(sysDownloads, idmSub))
    }

    const collectRecentMonthDirs = (parentDir: string, maxMonths = 3): string[] => {
      try {
        if (!fsSync.existsSync(parentDir)) return []
        const entries = fsSync.readdirSync(parentDir, { withFileTypes: true })
        return entries
          .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
          .map((e) => e.name)
          .sort((a, b) => b.localeCompare(a))
          .slice(0, maxMonths)
          .map((m) => path.join(parentDir, m))
      } catch {
        return []
      }
    }

    const wechatRoots = [
      path.join(docs, 'WeChat Files'),
      ...drives.map((d) => path.join(d, 'WeChat Files')),
      ...drives.map((d) => path.join(d, 'Documents', 'WeChat Files'))
    ]
    for (const wcRoot of wechatRoots) {
      try {
        if (!fsSync.existsSync(wcRoot)) continue
        const accounts = fsSync.readdirSync(wcRoot, { withFileTypes: true })
        for (const acc of accounts) {
          if (!acc.isDirectory() || ['All Users', 'Applet', 'WMPF'].includes(acc.name)) continue
          const fileRoot = path.join(wcRoot, acc.name, 'FileStorage', 'File')
          const monthDirs = collectRecentMonthDirs(fileRoot, 3)
          if (monthDirs.length > 0) {
            for (const mDir of monthDirs) {
              addSource(`im-wechat-${acc.name}-${path.basename(mDir)}`, `微信接收 (${path.basename(mDir)})`, 'im', '微信', mDir)
            }
          } else {
            addSource(`im-wechat-${acc.name}`, '微信接收文件', 'im', '微信', fileRoot)
          }
        }
      } catch {
        // ignore unreadable WeChat root
      }
    }

    const xwechatRoots = [
      path.join(docs, 'xwechat_files'),
      path.join(home, 'xwechat_files'),
      ...drives.map((d) => path.join(d, 'xwechat_files'))
    ]
    for (const xwRoot of xwechatRoots) {
      try {
        if (!fsSync.existsSync(xwRoot)) continue
        const accounts = fsSync.readdirSync(xwRoot, { withFileTypes: true })
        for (const acc of accounts) {
          if (!acc.isDirectory() || ['all_users', 'applet', 'wmpf'].includes(acc.name.toLowerCase())) continue
          const fileRoot = path.join(xwRoot, acc.name, 'msg', 'file')
          const monthDirs = collectRecentMonthDirs(fileRoot, 3)
          if (monthDirs.length > 0) {
            for (const mDir of monthDirs) {
              addSource(`im-xwechat-${acc.name}-${path.basename(mDir)}`, `微信接收 (${path.basename(mDir)})`, 'im', '微信', mDir)
            }
          } else {
            addSource(`im-xwechat-${acc.name}`, '微信接收文件', 'im', '微信', fileRoot)
          }
        }
      } catch {
        // ignore unreadable xwechat root
      }
    }

    const wxworkRoots = [path.join(docs, 'WXWork'), ...drives.map((d) => path.join(d, 'WXWork'))]
    for (const wxwRoot of wxworkRoots) {
      try {
        if (!fsSync.existsSync(wxwRoot)) continue
        const accounts = fsSync.readdirSync(wxwRoot, { withFileTypes: true })
        for (const acc of accounts) {
          if (!acc.isDirectory()) continue
          const fileRoot = path.join(wxwRoot, acc.name, 'File')
          const monthDirs = collectRecentMonthDirs(fileRoot, 3)
          for (const mDir of monthDirs) {
            addSource(`im-wxwork-${acc.name}-${path.basename(mDir)}`, `企业微信 (${path.basename(mDir)})`, 'im', '企业微信', mDir)
          }
        }
      } catch {
        // ignore
      }
    }

    const qqRoots = [
      path.join(docs, 'Tencent Files'),
      ...drives.map((d) => path.join(d, 'Tencent Files'))
    ]
    for (const qqRoot of qqRoots) {
      try {
        if (!fsSync.existsSync(qqRoot)) continue
        const accounts = fsSync.readdirSync(qqRoot, { withFileTypes: true })
        for (const acc of accounts) {
          if (!acc.isDirectory() || acc.name === 'All Users') continue
          addSource(`im-qq-${acc.name}`, `QQ 接收 (${acc.name})`, 'im', 'QQ', path.join(qqRoot, acc.name, 'FileRecv'))
        }
      } catch {
        // ignore
      }
    }

    addSource('im-dingtalk-dl', '钉钉下载', 'im', '钉钉', path.join(sysDownloads, 'DingTalk'))
    addSource('im-dingtalk-doc', '钉钉接收文件', 'im', '钉钉', path.join(docs, 'DingTalk Files'))
    addSource('im-lark-dl', '飞书下载', 'im', '飞书', path.join(sysDownloads, 'Lark'))
    addSource('im-feishu-dl', '飞书下载', 'im', '飞书', path.join(sysDownloads, 'Feishu'))

    for (let i = 0; i < customDirs.length; i++) {
      const rawCustom = String(customDirs[i] ?? '').trim()
      if (!rawCustom || rawCustom.includes('\0') || rawCustom.includes('..') || !path.isAbsolute(rawCustom)) {
        continue
      }
      addSource(`custom-${i + 1}`, `自定义 (${path.basename(rawCustom) || rawCustom})`, 'custom', '自定义目录', rawCustom)
    }

    return sources
  }

  async handleDownloadsManager(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawCustomDirs = Array.isArray(params.customDirs)
      ? params.customDirs.map((d) => String(d ?? '').trim()).filter(Boolean)
      : []

    if (lowerFn === 'validatecustomdir' || lowerFn === 'addcustomdir') {
      const rawDir = String(params.dirPath ?? params.path ?? '').trim()
      if (!rawDir) {
        return { ok: false, success: false, error: 'INVALID_DIR_PATH: 目录路径不能为空' }
      }
      if (rawDir.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawDir) || !path.isAbsolute(rawDir)) {
        return { ok: false, success: false, error: 'PATH_TRAVERSAL_REJECTED: 仅允许无路径穿越的绝对目录路径' }
      }
      try {
        const resolved = await this.#ctx.authorizeExistingPath(rawDir, caller, 'read')
        const st = await fs.stat(resolved)
        if (!st.isDirectory()) {
          return { ok: false, success: false, error: 'NOT_A_DIRECTORY: 目标路径不是文件夹' }
        }
        return {
          ok: true,
          success: true,
          path: resolved,
          name: path.basename(resolved) || resolved
        }
      } catch (err) {
        return {
          ok: false,
          success: false,
          error: `DIRECTORY_UNREADABLE: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    const sources = await this.#discoverDownloadSources(rawCustomDirs)

    if (lowerFn === 'discoversources' || lowerFn === 'getsources' || lowerFn === 'scansources') {
      return {
        ok: true,
        success: true,
        sources
      }
    }

    const maxFilesPerSource = Math.min(Math.max(Number(params.maxFilesPerSource) || 80, 10), 250)
    const items: Array<Record<string, unknown>> = []
    const seenFiles = new Set<string>()

    for (const src of sources) {
      if (signal?.aborted) break
      try {
        const entries = await fs.readdir(src.path, { withFileTypes: true })
        let countInSource = 0
        for (const entry of entries) {
          if (countInSource >= maxFilesPerSource) break
          if (entry.isSymbolicLink() || entry.isDirectory()) continue
          if (this.#isDownloadTempOrHiddenFile(entry.name)) continue
          const fullPath = path.join(src.path, entry.name)
          const normFileKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath
          if (seenFiles.has(normFileKey)) continue
          try {
            const st = await fs.stat(fullPath)
            if (!st.isFile() || st.size <= 0) continue
            seenFiles.add(normFileKey)
            countInSource += 1
            const ext = path.extname(entry.name).toLowerCase()
            const category = this.#classifyDownloadFileType(entry.name)
            items.push({
              id: crypto.createHash('md5').update(normFileKey).digest('hex').slice(0, 12),
              name: entry.name,
              path: fullPath,
              dirPath: src.path,
              ext,
              size: st.size,
              sizeBytes: st.size,
              sizeText: formatBytes(st.size),
              mtimeMs: st.mtimeMs,
              modifiedAt: st.mtime.toISOString(),
              channel: src.channel,
              sourceId: src.id,
              sourceLabel: src.label,
              appName: src.appName,
              category
            })
          } catch {
            // skip unreadable file
          }
        }
      } catch {
        // skip unreadable source directory
      }
    }

    items.sort((a, b) => Number(b.mtimeMs ?? 0) - Number(a.mtimeMs ?? 0))
    const totalBytes = items.reduce((acc, item) => acc + Number(item.sizeBytes ?? 0), 0)

    return {
      ok: true,
      success: true,
      sources,
      items,
      files: items,
      totalCount: items.length,
      totalBytes,
      totalSizeText: formatBytes(totalBytes)
    }
  }

  // ==================== 11. 目录增量同步 (FolderSyncPlugin) ====================
  static readonly #DEV_JUNK_NAMES = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    'dist',
    '.ds_store',
    'thumbs.db',
    'desktop.ini'
  ])

  static #isJunkEntry(name: string, ignoreDevJunk: boolean): boolean {
    if (!ignoreDevJunk) return false
    const lower = name.toLowerCase()
    if (StorageHostPluginHandler.#DEV_JUNK_NAMES.has(lower)) return true
    if (lower.startsWith('~$')) return true
    return false
  }

  static #areNestedOrSameDirs(dirA: string, dirB: string): boolean {
    const resA = path.resolve(dirA)
    const resB = path.resolve(dirB)
    const normA = process.platform === 'win32' ? resA.toLowerCase() : resA
    const normB = process.platform === 'win32' ? resB.toLowerCase() : resB
    if (normA === normB) return true
    const sep = path.sep
    const prefixA = normA.endsWith(sep) ? normA : `${normA}${sep}`
    const prefixB = normB.endsWith(sep) ? normB : `${normB}${sep}`
    return normB.startsWith(prefixA) || normA.startsWith(prefixB)
  }

  async #scanSyncTree(
    rootDir: string,
    ignoreDevJunk: boolean,
    maxFiles = 5000
  ): Promise<Map<string, { relPath: string; fullPath: string; sizeBytes: number; mtimeMs: number }>> {
    const map = new Map<string, { relPath: string; fullPath: string; sizeBytes: number; mtimeMs: number }>()
    if (!fsSync.existsSync(rootDir)) return map

    const walk = async (currentDir: string, relPrefix: string) => {
      if (map.size >= maxFiles) return
      let entries: fsSync.Dirent[] = []
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (map.size >= maxFiles) break
        if (entry.isSymbolicLink()) continue
        if (StorageHostPluginHandler.#isJunkEntry(entry.name, ignoreDevJunk)) continue
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath, relPath)
        } else if (entry.isFile()) {
          try {
            const st = await fs.stat(fullPath)
            map.set(relPath, {
              relPath,
              fullPath,
              sizeBytes: st.size,
              mtimeMs: st.mtimeMs
            })
          } catch {
            // ignore unreadable file
          }
        }
      }
    }

    await walk(rootDir, '')
    return map
  }

  async handleFolderSync(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    const rawSource = String(params.sourceDir ?? params.srcDir ?? '').trim()
    const rawTarget = String(params.targetDir ?? params.dstDir ?? '').trim()
    const syncMode = String(params.syncMode ?? 'incremental').toLowerCase() as
      | 'incremental'
      | 'mirror'
      | 'two-way'
    const ignoreDevJunk = params.ignoreDevJunk !== false

    if (lowerFn === 'comparedirs' || lowerFn === 'compare' || lowerFn === 'scandiff') {
      if (!rawSource || !rawTarget) {
        return {
          ok: false,
          success: false,
          errorCode: 'EMPTY_DIRECTORY_PATH',
          error: 'EMPTY_DIRECTORY_PATH: 请先选择源目录与目标目录'
        }
      }

      if (StorageHostPluginHandler.#areNestedOrSameDirs(rawSource, rawTarget)) {
        return {
          ok: false,
          success: false,
          errorCode: 'NESTED_DIRECTORY_FORBIDDEN',
          error: 'NESTED_DIRECTORY_FORBIDDEN: 源目录与目标目录不能相同或互相包含（防止无限递归复制）'
        }
      }

      const sourceDir = await this.#ctx.authorizeExistingPath(rawSource, caller, 'read')
      const targetDir = path.resolve(rawTarget)

      if (!fsSync.existsSync(sourceDir)) {
        return {
          ok: false,
          success: false,
          errorCode: 'SOURCE_NOT_FOUND',
          error: `SOURCE_NOT_FOUND: 源目录不存在 (${sourceDir})`
        }
      }

      const [srcMap, dstMap] = await Promise.all([
        this.#scanSyncTree(sourceDir, ignoreDevJunk),
        this.#scanSyncTree(targetDir, ignoreDevJunk)
      ])

      const diffs: Array<{
        relPath: string
        diffType: 'added' | 'modified' | 'reverse-add' | 'orphan'
        direction: 'src-to-dst' | 'dst-to-src' | 'delete-dst'
        actionBadge: string
        reasonText: string
        sizeBytes: number
        sourceMtimeMs: number | null
        targetMtimeMs: number | null
        sourceFullPath: string
        targetFullPath: string
      }> = []

      // 1. Check files in sourceDir
      for (const [relPath, srcFile] of srcMap.entries()) {
        const dstFile = dstMap.get(relPath)
        const dstFull = path.join(targetDir, ...relPath.split('/'))
        if (!dstFile) {
          diffs.push({
            relPath,
            diffType: 'added',
            direction: 'src-to-dst',
            actionBadge: '+ 新增到目标',
            reasonText: `目标目录缺失 · 将从源目录复制 (${formatBytes(srcFile.sizeBytes)})`,
            sizeBytes: srcFile.sizeBytes,
            sourceMtimeMs: srcFile.mtimeMs,
            targetMtimeMs: null,
            sourceFullPath: srcFile.fullPath,
            targetFullPath: dstFull
          })
          continue
        }

        const timeDiffMs = srcFile.mtimeMs - dstFile.mtimeMs
        const isDifferentTime = Math.abs(timeDiffMs) > 2000
        const isDifferentSize = srcFile.sizeBytes !== dstFile.sizeBytes

        if (!isDifferentTime && !isDifferentSize) {
          continue
        }

        if (syncMode === 'two-way' && timeDiffMs < -2000) {
          diffs.push({
            relPath,
            diffType: 'modified',
            direction: 'dst-to-src',
            actionBadge: '← 反向更新源',
            reasonText: `目标端文件较新 (${Math.round(Math.abs(timeDiffMs) / 1000)}秒) · 反向同步回源目录`,
            sizeBytes: dstFile.sizeBytes,
            sourceMtimeMs: srcFile.mtimeMs,
            targetMtimeMs: dstFile.mtimeMs,
            sourceFullPath: srcFile.fullPath,
            targetFullPath: dstFile.fullPath
          })
        } else if (timeDiffMs > 2000 || isDifferentSize) {
          diffs.push({
            relPath,
            diffType: 'modified',
            direction: 'src-to-dst',
            actionBadge: '↑ 覆盖更新',
            reasonText: `源端已修改 · 覆盖目标旧文件 (${formatBytes(srcFile.sizeBytes)})`,
            sizeBytes: srcFile.sizeBytes,
            sourceMtimeMs: srcFile.mtimeMs,
            targetMtimeMs: dstFile.mtimeMs,
            sourceFullPath: srcFile.fullPath,
            targetFullPath: dstFile.fullPath
          })
        }
      }

      // 2. Check files only in targetDir
      for (const [relPath, dstFile] of dstMap.entries()) {
        if (srcMap.has(relPath)) continue
        const srcFull = path.join(sourceDir, ...relPath.split('/'))
        if (syncMode === 'mirror') {
          diffs.push({
            relPath,
            diffType: 'orphan',
            direction: 'delete-dst',
            actionBadge: '- 目标多余(移入回收站)',
            reasonText: `源目录已不存在 · 镜像模式下移入系统回收站`,
            sizeBytes: dstFile.sizeBytes,
            sourceMtimeMs: null,
            targetMtimeMs: dstFile.mtimeMs,
            sourceFullPath: srcFull,
            targetFullPath: dstFile.fullPath
          })
        } else if (syncMode === 'two-way') {
          diffs.push({
            relPath,
            diffType: 'reverse-add',
            direction: 'dst-to-src',
            actionBadge: '← 反向补齐',
            reasonText: `仅目标端存在 · 双向合并补齐至源目录`,
            sizeBytes: dstFile.sizeBytes,
            sourceMtimeMs: null,
            targetMtimeMs: dstFile.mtimeMs,
            sourceFullPath: srcFull,
            targetFullPath: dstFile.fullPath
          })
        }
      }

      const transferBytes = diffs
        .filter((d) => d.direction !== 'delete-dst')
        .reduce((acc, d) => acc + d.sizeBytes, 0)

      let realFreeBytes = 50 * 1024 * 1024 * 1024
      if (typeof params.mockTargetFreeBytes === 'number') {
        realFreeBytes = params.mockTargetFreeBytes
      } else {
        try {
          const stFs = await fs.statfs(fsSync.existsSync(targetDir) ? targetDir : path.dirname(targetDir))
          const computed = Number(stFs.bavail) * Number(stFs.bsize)
          if (Number.isFinite(computed) && computed > 0) {
            realFreeBytes = computed
          }
        } catch {
          // keep fallback if statfs unsupported on virtual fs
        }
      }
      const targetFreeBytes = realFreeBytes

      return {
        ok: true,
        success: true,
        sourceDir,
        targetDir,
        syncMode,
        ignoreDevJunk,
        diffs,
        totalDiffs: diffs.length,
        transferBytes,
        targetFreeBytes
      }
    }

    if (lowerFn === 'executesync' || lowerFn === 'sync' || lowerFn === 'runsync') {
      if (!rawSource || !rawTarget) {
        return {
          ok: false,
          success: false,
          errorCode: 'EMPTY_DIRECTORY_PATH',
          error: 'EMPTY_DIRECTORY_PATH: 源目录与目标目录不能为空'
        }
      }

      if (StorageHostPluginHandler.#areNestedOrSameDirs(rawSource, rawTarget)) {
        return {
          ok: false,
          success: false,
          errorCode: 'NESTED_DIRECTORY_FORBIDDEN',
          error: 'NESTED_DIRECTORY_FORBIDDEN: 源目录与目标目录不能相同或互相包含'
        }
      }

      const compareRes = (await this.handleFolderSync(
        'compareDirs',
        params,
        caller
      )) as Record<string, unknown>
      if (!compareRes.ok) {
        return compareRes
      }

      const allDiffs = (compareRes.diffs as Array<Record<string, unknown>>) || []
      const selectedSet = Array.isArray(params.selectedRelPaths)
        ? new Set(params.selectedRelPaths.map(String))
        : null
      const itemsToSync = selectedSet
        ? allDiffs.filter((d) => selectedSet.has(String(d.relPath)))
        : allDiffs

      const requiredBytes = itemsToSync
        .filter((d) => d.direction !== 'delete-dst')
        .reduce((acc, d) => acc + Number(d.sizeBytes ?? 0), 0)
      const targetFreeBytes = Number(compareRes.targetFreeBytes ?? 50 * 1024 * 1024 * 1024)

      if (requiredBytes > targetFreeBytes) {
        return {
          ok: false,
          success: false,
          errorCode: 'INSUFFICIENT_DISK_SPACE',
          error: `INSUFFICIENT_DISK_SPACE: 目标磁盘剩余空间不足（需 ${formatBytes(requiredBytes)}，仅剩 ${formatBytes(targetFreeBytes)}）`
        }
      }

      const lockedSet = new Set<string>(
        Array.isArray(params.simulateLockedRelPaths)
          ? params.simulateLockedRelPaths.map(String)
          : []
      )

      let syncedCount = 0
      let deletedCount = 0
      let transferredBytes = 0
      const failures: Array<{ relPath: string; errorCode: string; error: string }> = []

      for (const item of itemsToSync) {
        const relPath = String(item.relPath ?? '')
        if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) {
          failures.push({
            relPath,
            errorCode: 'UNSAFE_RELATIVE_PATH',
            error: `拒绝越界相对路径: ${relPath}`
          })
          continue
        }

        if (lockedSet.has(relPath)) {
          failures.push({
            relPath,
            errorCode: 'EBUSY',
            error: `EBUSY: 文件正在被其他程序占用，跳过同步 (${relPath})`
          })
          continue
        }

        const direction = String(item.direction ?? 'src-to-dst')
        const srcFull = String(item.sourceFullPath ?? '')
        const dstFull = String(item.targetFullPath ?? '')

        try {
          if (direction === 'delete-dst') {
            const recycleDir = path.join(os.tmpdir(), 'ztools-folder-sync-recycle', String(Date.now()))
            await fs.mkdir(path.dirname( path.join(recycleDir, relPath) ), { recursive: true }).catch(() => undefined)
            await fs.copyFile(dstFull, path.join(recycleDir, relPath)).catch(() => undefined)
            await fs.rm(dstFull, { recursive: true, force: true })
            deletedCount += 1
          } else if (direction === 'src-to-dst') {
            await fs.mkdir(path.dirname(dstFull), { recursive: true })
            await fs.copyFile(srcFull, dstFull)
            const st = await fs.stat(srcFull)
            await fs.utimes(dstFull, st.atime, st.mtime)
            syncedCount += 1
            transferredBytes += st.size
          } else if (direction === 'dst-to-src') {
            await fs.mkdir(path.dirname(srcFull), { recursive: true })
            await fs.copyFile(dstFull, srcFull)
            const st = await fs.stat(dstFull)
            await fs.utimes(srcFull, st.atime, st.mtime)
            syncedCount += 1
            transferredBytes += st.size
          }
        } catch (err) {
          failures.push({
            relPath,
            errorCode: 'IO_SYNC_ERROR',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      return {
        ok: failures.length === 0,
        success: syncedCount > 0 || deletedCount > 0 || itemsToSync.length === 0,
        syncedCount,
        deletedCount,
        transferredBytes,
        failures,
        ...(failures.length > 0 ? { errorCode: failures[0]!.errorCode, error: failures[0]!.error } : {})
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported FolderSyncPlugin function: ${fn}`
    }
  }

  #pasteStackItems: Array<{
    id: string
    text: string
    textPreview: string
    charCount: number
    timestamp: number
    sourceApp?: string
  }> = []
  #pasteStackListening = true

  async handleBrowserBookmarks(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'scanbookmarks' || lowerFn === 'scan') {
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      const appData =
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')

      const candidateFiles: Array<{
        browser: string
        browserLabel: string
        filePath: string
      }> = Array.isArray(params.customSources)
        ? (params.customSources as Array<{
            browser: string
            browserLabel: string
            filePath: string
          }>)
        : [
            {
              browser: 'edge',
              browserLabel: 'Edge',
              filePath: path.join(
                localAppData,
                'Microsoft',
                'Edge',
                'User Data',
                'Default',
                'Bookmarks'
              )
            },
            {
              browser: 'chrome',
              browserLabel: 'Chrome',
              filePath: path.join(
                localAppData,
                'Google',
                'Chrome',
                'User Data',
                'Default',
                'Bookmarks'
              )
            },
            {
              browser: '360chrome',
              browserLabel: '360极速',
              filePath: path.join(
                localAppData,
                '360ChromeX',
                'Chrome',
                'User Data',
                'Default',
                'Bookmarks'
              )
            },
            {
              browser: 'qqbrowser',
              browserLabel: 'QQ浏览器',
              filePath: path.join(
                localAppData,
                'Tencent',
                'QQBrowser',
                'User Data',
                'Default',
                'Bookmarks'
              )
            },
            {
              browser: 'brave',
              browserLabel: 'Brave',
              filePath: path.join(
                localAppData,
                'BraveSoftware',
                'Brave-Browser',
                'User Data',
                'Default',
                'Bookmarks'
              )
            },
            ...(process.platform === 'darwin'
              ? [
                  {
                    browser: 'chrome',
                    browserLabel: 'Google Chrome',
                    filePath: path.join(
                      os.homedir(),
                      'Library',
                      'Application Support',
                      'Google',
                      'Chrome',
                      'Default',
                      'Bookmarks'
                    )
                  },
                  {
                    browser: 'edge',
                    browserLabel: 'Microsoft Edge',
                    filePath: path.join(
                      os.homedir(),
                      'Library',
                      'Application Support',
                      'Microsoft Edge',
                      'Default',
                      'Bookmarks'
                    )
                  },
                  {
                    browser: 'brave',
                    browserLabel: 'Brave',
                    filePath: path.join(
                      os.homedir(),
                      'Library',
                      'Application Support',
                      'BraveSoftware',
                      'Brave-Browser',
                      'Default',
                      'Bookmarks'
                    )
                  }
                ]
              : [])
          ]

      const bookmarks: Array<{
        id: string
        title: string
        url: string
        hostname: string
        folderBreadcrumb: string
        browser: string
        browserLabel: string
        dateAdded: number
      }> = []
      const warnings: string[] = []

      const walkChromiumNode = (
        node: Record<string, unknown>,
        browser: string,
        browserLabel: string,
        trail: string[]
      ) => {
        if (!node || typeof node !== 'object') return
        const nodeType = String(node.type || '')
        const name = String(node.name || '').trim()
        if (nodeType === 'url') {
          const rawUrl = String(node.url || '').trim()
          if (!/^https?:\/\//i.test(rawUrl)) return
          let hostname = ''
          try {
            hostname = new URL(rawUrl).hostname
          } catch {
            return
          }
          const rawDate = Number(node.date_added || 0)
          const dateAdded =
            rawDate > 11644473600000000
              ? Math.floor(rawDate / 1000 - 11644473600000)
              : Date.now()
          bookmarks.push({
            id: String(node.id || `${browser}-${bookmarks.length + 1}`),
            title: name || rawUrl,
            url: rawUrl,
            hostname,
            folderBreadcrumb: trail.join(' / '),
            browser,
            browserLabel,
            dateAdded
          })
          return
        }
        const children = Array.isArray(node.children)
          ? (node.children as Array<Record<string, unknown>>)
          : []
        const nextTrail =
          name && !['书签栏', 'Bookmarks bar', '其他书签', 'Other bookmarks'].includes(name)
            ? [...trail, name]
            : trail
        for (const child of children) {
          walkChromiumNode(child, browser, browserLabel, nextTrail)
        }
      }

      for (const src of candidateFiles) {
        try {
          if (!fsSync.existsSync(src.filePath)) continue
          const rawText = await fs.readFile(src.filePath, 'utf8')
          const parsed = JSON.parse(rawText) as { roots?: Record<string, Record<string, unknown>> }
          const roots = parsed.roots || {}
          for (const rootKey of Object.keys(roots)) {
            const rootNode = roots[rootKey]
            if (rootNode) {
              walkChromiumNode(rootNode, src.browser, src.browserLabel, [])
            }
          }
        } catch (err) {
          warnings.push(
            `${src.browserLabel} 书签解析跳过: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }

      const ingestFirefoxSqlite = async (sqlitePath: string): Promise<void> => {
        if (!sqlitePath || !fsSync.existsSync(sqlitePath)) return
        const tmpCopy = path.join(
          os.tmpdir(),
          `ztools-ff-places-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`
        )
        try {
          await fs.copyFile(sqlitePath, tmpCopy)
          const SQL = await this.#getSqlJs()
          const buf = await fs.readFile(tmpCopy)
          const db = new SQL.Database(new Uint8Array(buf))
          try {
            const stmt = db.exec(
              "SELECT b.id, b.title, p.url, b.dateAdded FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1 AND p.url NOT LIKE 'place:%'"
            )
            if (stmt.length > 0 && stmt[0]) {
              for (const row of stmt[0].values) {
                const rawUrl = String(row[2] || '').trim()
                if (!/^https?:\/\//i.test(rawUrl)) continue
                let hostname = ''
                try {
                  hostname = new URL(rawUrl).hostname
                } catch {
                  continue
                }
                bookmarks.push({
                  id: `ff-${row[0]}`,
                  title: String(row[1] || rawUrl),
                  url: rawUrl,
                  hostname,
                  folderBreadcrumb: 'Firefox 书签',
                  browser: 'firefox',
                  browserLabel: 'Firefox',
                  dateAdded: Math.floor(Number(row[3] || Date.now() * 1000) / 1000)
                })
              }
            }
          } finally {
            db.close()
          }
        } catch (err) {
          warnings.push(`Firefox 书签读取警告: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          await fs.rm(tmpCopy, { force: true }).catch(() => undefined)
        }
      }

      // Check Firefox places.sqlite if present or passed via firefoxSqlitePath
      const ffPath =
        typeof params.firefoxSqlitePath === 'string' ? params.firefoxSqlitePath : ''
      if (ffPath && fsSync.existsSync(ffPath)) {
        await ingestFirefoxSqlite(ffPath)
      } else {
        // Check default Firefox profile dir (Windows & macOS)
        const ffRoots = [
          path.join(appData, 'Mozilla', 'Firefox', 'Profiles'),
          path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles')
        ]
        for (const ffProfilesRoot of ffRoots) {
          if (!fsSync.existsSync(ffProfilesRoot)) continue
          try {
            const dirs = await fs.readdir(ffProfilesRoot)
            for (const d of dirs) {
              const pSqlite = path.join(ffProfilesRoot, d, 'places.sqlite')
              if (fsSync.existsSync(pSqlite)) {
                await ingestFirefoxSqlite(pSqlite)
              }
            }
          } catch {
            // ignore
          }
        }
      }

      return {
        ok: true,
        bookmarks: bookmarks.slice(0, 500),
        warnings
      }
    }

    return { ok: false, error: `Unsupported BrowserBookmarksPlugin action: ${fn}` }
  }

  async handlePasteStack(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'getstate' || lowerFn === 'getstack') {
      return {
        ok: true,
        isListening: this.#pasteStackListening,
        items: this.#pasteStackItems
      }
    }
    if (lowerFn === 'setlistening') {
      this.#pasteStackListening = Boolean(params.enabled)
      return {
        ok: true,
        isListening: this.#pasteStackListening,
        items: this.#pasteStackItems
      }
    }
    if (lowerFn === 'pushitem') {
      const rawText = String(params.text || '').trim()
      if (!rawText) {
        return { ok: false, errorCode: 'EMPTY_TEXT', error: 'EMPTY_TEXT: 仅支持非空纯文本入栈' }
      }
      const last = this.#pasteStackItems[this.#pasteStackItems.length - 1]
      if (last && last.text === rawText) {
        return {
          ok: true,
          deduplicated: true,
          items: this.#pasteStackItems
        }
      }
      const item = {
        id: `stk-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        text: rawText,
        textPreview: rawText.replace(/\s+/g, ' ').slice(0, 60),
        charCount: rawText.length,
        timestamp: Date.now(),
        sourceApp: typeof params.sourceApp === 'string' ? params.sourceApp : '系统剪贴板'
      }
      this.#pasteStackItems.push(item)
      return { ok: true, deduplicated: false, item, items: this.#pasteStackItems }
    }
    if (lowerFn === 'popandpaste') {
      if (this.#pasteStackItems.length === 0) {
        return {
          ok: false,
          errorCode: 'STACK_EMPTY',
          error: 'STACK_EMPTY: 粘贴栈为空，无法执行出栈上屏'
        }
      }
      const mode = params.mode === 'lifo' ? 'lifo' : 'fifo'
      const itemId = typeof params.itemId === 'string' ? params.itemId : ''
      let popped
      if (itemId) {
        const idx = this.#pasteStackItems.findIndex((i) => i.id === itemId)
        if (idx >= 0) {
          popped = this.#pasteStackItems.splice(idx, 1)[0]
        }
      }
      if (!popped) {
        popped =
          mode === 'lifo' ? this.#pasteStackItems.pop() : this.#pasteStackItems.shift()
      }
      if (popped && this.#ctx.clipboard) {
        await this.#ctx.clipboard.setText(popped.text)
      }
      return {
        ok: true,
        popped,
        remainingCount: this.#pasteStackItems.length,
        items: this.#pasteStackItems
      }
    }
    if (lowerFn === 'clearstack') {
      this.#pasteStackItems = []
      return { ok: true, items: [] }
    }
    return { ok: false, error: `Unsupported PasteStackPlugin action: ${fn}` }
  }

  async handleSnippets(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'pastetoactivewindow' || lowerFn === 'insertsnippet') {
      const text = String(params.text || '')
      if (!text) {
        return { ok: false, errorCode: 'EMPTY_SNIPPET', error: 'EMPTY_SNIPPET: 短语内容不能为空' }
      }
      if (this.#ctx.clipboard) {
        await this.#ctx.clipboard.setText(text)
      }
      return {
        ok: true,
        injected: true,
        fallbackToClipboard: !this.#ctx.windowControl,
        cursorOffsetFromEnd: Number(params.cursorOffsetFromEnd || 0)
      }
    }
    return { ok: true }
  }

  async handleOfficeSlim(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'readfile' || lowerFn === 'readbytes') {
      const rawPath = String(params.filePath ?? params.path ?? '').trim()
      if (!rawPath) {
        return { ok: false, success: false, errorCode: 'INVALID_ARGS', error: '文档路径不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeExistingPath(rawPath, caller, 'read')
      const stat = await fs.stat(authorizedPath)
      const buf = await fs.readFile(authorizedPath)
      return {
        ok: true,
        success: true,
        filePath: authorizedPath,
        fileName: path.basename(authorizedPath),
        sizeBytes: stat.size,
        base64Data: buf.toString('base64')
      }
    }
    if (lowerFn === 'writeslim' || lowerFn === 'save') {
      const outputPath = String(params.outputPath ?? params.filePath ?? '').trim()
      const base64Data = String(params.base64Data ?? '')
      if (!outputPath || !base64Data) {
        return { ok: false, success: false, errorCode: 'INVALID_ARGS', error: '输出路径与数据不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeOutputPath(outputPath, caller)
      await fs.writeFile(authorizedPath, Buffer.from(base64Data, 'base64'))
      return { ok: true, success: true, outputPath: authorizedPath }
    }
    if (lowerFn === 'inspect' || lowerFn === 'slim' || lowerFn === 'extractimages') {
      return { ok: true, success: true, ...params }
    }
    return { ok: false, error: `Unsupported OfficeSlimPlugin action: ${fn}` }
  }

  async handleMdToOffice(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = (fn || String(params.action || '')).toLowerCase()
    if (lowerFn === 'read_clipboard_md' || lowerFn === 'readclipboard') {
      const text = this.#ctx.clipboard ? await this.#ctx.clipboard.getText() : ''
      return { ok: true, success: true, markdown: text, text }
    }
    if (lowerFn === 'save_docx' || lowerFn === 'exportdocx') {
      const outputPath = String(params.outputPath ?? '').trim()
      const base64Data = String(params.base64Data ?? '')
      if (outputPath && base64Data) {
        const authorizedPath = await this.#ctx.authorizeOutputPath(outputPath, caller)
        const buf = Buffer.from(base64Data, 'base64')
        await fs.writeFile(authorizedPath, buf)
        return { ok: true, success: true, outputPath: authorizedPath, byteLength: buf.byteLength }
      }
      return { ok: true, success: true, ...params }
    }
    if (lowerFn === 'copy_rich_html' || lowerFn === 'copyrich') {
      const plainText = String(params.plainText ?? params.html ?? '')
      if (plainText && this.#ctx.clipboard) {
        await this.#ctx.clipboard.setText(plainText)
      }
      return { ok: true, success: true, ...params }
    }
    return { ok: false, error: `Unsupported MdToOfficePlugin action: ${fn}` }
  }

  static #parseOpenTypeFontHeader(buf: Buffer, fallbackName: string, filePath: string, sizeBytes: number): {
    id: string
    family: string
    chineseName?: string
    fullName: string
    postScriptName: string
    style: string
    format: 'TTF' | 'OTF' | 'TTC'
    scope: 'system' | 'user'
    filePath: string
    fileSize: number
  } | null {
    const ext = path.extname(filePath).toLowerCase()
    const format: 'TTF' | 'OTF' | 'TTC' =
      ext === '.otf' ? 'OTF' : ext === '.ttc' ? 'TTC' : 'TTF'
    const scope: 'system' | 'user' =
      filePath.toLowerCase().includes('appdata') || filePath.includes(path.join(os.homedir(), 'Library', 'Fonts'))
        ? 'user'
        : 'system'

    let family = fallbackName
    let chineseName: string | undefined
    let fullName = fallbackName
    let postScriptName = fallbackName.replace(/\s+/g, '')
    let style = 'Regular'

    try {
      if (buf.byteLength >= 12) {
        let sfntOffset = 0
        const sig = buf.toString('ascii', 0, 4)
        if (sig === 'ttcf' && buf.byteLength >= 16) {
          sfntOffset = buf.readUInt32BE(12)
        }
        if (sfntOffset + 12 <= buf.byteLength) {
          const numTables = buf.readUInt16BE(sfntOffset + 4)
          let nameTableOffset = 0
          let nameTableLength = 0
          for (let i = 0; i < numTables; i++) {
            const recOff = sfntOffset + 12 + i * 16
            if (recOff + 16 > buf.byteLength) break
            const tag = buf.toString('ascii', recOff, recOff + 4)
            if (tag === 'name') {
              nameTableOffset = buf.readUInt32BE(recOff + 8)
              nameTableLength = buf.readUInt32BE(recOff + 12)
              break
            }
          }
          if (nameTableOffset > 0 && nameTableOffset + 6 <= buf.byteLength) {
            const count = buf.readUInt16BE(nameTableOffset + 2)
            const stringStorageOffset = nameTableOffset + buf.readUInt16BE(nameTableOffset + 4)
            const maxRecords = Math.min(count, 120)
            for (let i = 0; i < maxRecords; i++) {
              const rOff = nameTableOffset + 6 + i * 12
              if (rOff + 12 > buf.byteLength || rOff + 12 > nameTableOffset + nameTableLength) break
              const platformId = buf.readUInt16BE(rOff)
              const langId = buf.readUInt16BE(rOff + 4)
              const nameId = buf.readUInt16BE(rOff + 6)
              const strLen = buf.readUInt16BE(rOff + 8)
              const strOff = stringStorageOffset + buf.readUInt16BE(rOff + 10)
              if (strLen <= 0 || strOff + strLen > buf.byteLength) continue
              let decoded = ''
              if (platformId === 3 || platformId === 0) {
                const chars: number[] = []
                for (let j = 0; j + 1 < strLen; j += 2) {
                  chars.push(buf.readUInt16BE(strOff + j))
                }
                decoded = String.fromCharCode(...chars).replace(/\0+/g, '').trim()
              } else if (platformId === 1) {
                decoded = buf.toString('utf8', strOff, strOff + strLen).replace(/\0+/g, '').trim()
              }
              if (!decoded) continue
              const isZh = langId === 0x0804 || langId === 0x0404 || /[\u4e00-\u9fa5]/.test(decoded)
              if (nameId === 1) {
                if (isZh) chineseName = decoded
                else family = decoded
              } else if (nameId === 2 && !isZh) {
                style = decoded
              } else if (nameId === 4) {
                if (isZh && !chineseName) chineseName = decoded
                else fullName = decoded
              } else if (nameId === 6) {
                postScriptName = decoded
              }
            }
          }
        }
      }
    } catch {
      // Fallback to filename metadata
    }

    const fontId = `font-${fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    return {
      id: fontId,
      family: family || fallbackName,
      ...(chineseName ? { chineseName } : {}),
      fullName: fullName || family || fallbackName,
      postScriptName,
      style,
      format,
      scope,
      filePath,
      fileSize: sizeBytes
    }
  }

  async handleFontManager(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn || String(params.action || '')).toLowerCase()
    if (lowerFn === 'scanfonts' || lowerFn === 'scan') {
      if (Array.isArray(params.fonts)) {
        return { ok: true, success: true, fonts: params.fonts }
      }
      const dirs: string[] = []
      if (typeof params.customFontsDir === 'string' && params.customFontsDir.trim()) {
        dirs.push(params.customFontsDir.trim())
      } else if (process.platform === 'win32') {
        const winDir = process.env.WINDIR || 'C:\\Windows'
        dirs.push(path.join(winDir, 'Fonts'))
        const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
        dirs.push(path.join(localApp, 'Microsoft', 'Windows', 'Fonts'))
      } else if (process.platform === 'darwin') {
        dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts'))
      } else {
        dirs.push('/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts'))
      }

      const fonts: Array<Record<string, unknown>> = []
      const seenFamilies = new Set<string>()
      for (const dir of dirs) {
        if (!fsSync.existsSync(dir)) continue
        try {
          const entries = await fs.readdir(dir)
          for (const name of entries) {
            if (fonts.length >= 160) break
            const ext = path.extname(name).toLowerCase()
            if (ext !== '.ttf' && ext !== '.otf' && ext !== '.ttc') continue
            const fullPath = path.join(dir, name)
            try {
              const st = await fs.stat(fullPath)
              if (!st.isFile() || st.size < 64) continue
              const handle = await fs.open(fullPath, 'r')
              const headBuf = Buffer.alloc(Math.min(st.size, 65536))
              try {
                await handle.read(headBuf, 0, headBuf.byteLength, 0)
              } finally {
                await handle.close()
              }
              const baseName = path.basename(name, ext)
              const parsed = StorageHostPluginHandler.#parseOpenTypeFontHeader(
                headBuf,
                baseName,
                fullPath,
                st.size
              )
              if (parsed) {
                const dedupKey = `${parsed.family.toLowerCase()}::${parsed.style.toLowerCase()}`
                if (!seenFamilies.has(dedupKey)) {
                  seenFamilies.add(dedupKey)
                  fonts.push(parsed)
                }
              }
            } catch {
              // skip locked or unreadable font file
            }
          }
        } catch {
          // skip inaccessible font directory
        }
      }

      return { ok: true, success: true, fonts }
    }
    return { ok: false, error: `Unsupported FontManagerPlugin action: ${fn}` }
  }

  async handleFileInspector(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'fixextension') {
      const rawPath = String(params.filePath || '').trim()
      const correctExt = String(params.correctExt || '').trim().replace(/^\./, '')
      if (!rawPath || !correctExt) {
        return { ok: false, errorCode: 'INVALID_ARGS', error: '文件路径与目标扩展名不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeExistingPath(rawPath, caller, 'write')
      const parsed = path.parse(authorizedPath)
      const newPath = path.join(parsed.dir, `${parsed.name}.${correctExt}`)
      await fs.rename(authorizedPath, newPath)
      return { ok: true, newPath }
    }
    if (lowerFn === 'writeencoded') {
      const rawPath = String(params.filePath || '').trim()
      const base64Data = String(params.base64Data || '')
      if (!rawPath) {
        return { ok: false, errorCode: 'INVALID_ARGS', error: '文件路径不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeOutputPath(rawPath, caller)
      const tmpPath = `${authorizedPath}.ztools-tmp-${process.pid}`
      try {
        await fs.writeFile(tmpPath, Buffer.from(base64Data, 'base64'))
        await fs.rename(tmpPath, authorizedPath)
      } catch (err) {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined)
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          return {
            ok: false,
            errorCode: 'FILE_LOCKED',
            error: '文件正被其他应用打开，请关闭后重试'
          }
        }
        throw err
      }
      return { ok: true, outputPath: authorizedPath }
    }
    if (lowerFn === 'readfile' || lowerFn === 'readbytes' || lowerFn === 'inspectfile') {
      const rawPath = String(params.filePath ?? params.path ?? '').trim()
      if (!rawPath) {
        return { ok: false, success: false, errorCode: 'INVALID_ARGS', error: '文件路径不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeExistingPath(rawPath, caller, 'read')
      const stat = await fs.stat(authorizedPath)
      const maxBytes = Math.min(stat.size, Number(params.maxBytes) || 10 * 1024 * 1024)
      const handle = await fs.open(authorizedPath, 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const { bytesRead } = await handle.read(buf, 0, maxBytes, 0)
        return {
          ok: true,
          success: true,
          filePath: authorizedPath,
          fileName: path.basename(authorizedPath),
          sizeBytes: stat.size,
          base64Data: buf.subarray(0, bytesRead).toString('base64')
        }
      } finally {
        await handle.close()
      }
    }
    return { ok: false, success: false, error: `Unsupported FileInspectorPlugin function: ${fn}` }
  }

  async handleMediaMetadata(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = (fn || '').toLowerCase()
    if (lowerFn === 'writesafe') {
      const outputPath = String(params.outputPath || '').trim()
      const base64Data = String(params.base64Data || '')
      if (!outputPath) {
        return { ok: false, errorCode: 'INVALID_ARGS', error: '输出路径不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeOutputPath(outputPath, caller)
      await fs.writeFile(authorizedPath, Buffer.from(base64Data, 'base64'))
      return { ok: true, outputPath: authorizedPath }
    }
    if (lowerFn === 'readfile' || lowerFn === 'readbytes') {
      const rawPath = String(params.filePath ?? params.path ?? '').trim()
      if (!rawPath) {
        return { ok: false, success: false, errorCode: 'INVALID_ARGS', error: '媒体文件路径不能为空' }
      }
      const authorizedPath = await this.#ctx.authorizeExistingPath(rawPath, caller, 'read')
      const stat = await fs.stat(authorizedPath)
      const buf = await fs.readFile(authorizedPath)
      return {
        ok: true,
        success: true,
        filePath: authorizedPath,
        fileName: path.basename(authorizedPath),
        sizeBytes: stat.size,
        base64Data: buf.toString('base64')
      }
    }
    return { ok: false, success: false, error: `Unsupported MediaMetadataPlugin function: ${fn}` }
  }
}
