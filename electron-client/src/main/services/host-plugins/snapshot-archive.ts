import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import yazl from 'yazl'
import { errorCodes } from '../../../contracts/errors.js'
import { t } from '../../i18n/index.js'
import { hostPluginError } from './shared-utils.js'

export interface SnapshotSourceFailure {
  path: string
  error: string
}

interface SnapshotEntry {
  sourcePath: string
  archivePath: string
  directory: boolean
}

export const SNAPSHOT_MANIFEST_NAME = 'ztools-snapshot-manifest.json'

/** 先完成整个来源的可读性检查，避免目录扫描到一半失败却把它计为完整备份。 */
async function collectSource(sourcePath: string, archivePath: string): Promise<SnapshotEntry[]> {
  const stat = await fs.lstat(sourcePath)
  if (stat.isSymbolicLink()) {
    throw hostPluginError(errorCodes.permissionDenied, 'hostPlugin.snapshot.symlinkNotAllowed', {
      hostCode: 'SNAPSHOT_SYMLINK_NOT_ALLOWED'
    })
  }
  if (stat.isFile()) {
    await fs.access(sourcePath, fs.constants.R_OK)
    return [{ sourcePath, archivePath, directory: false }]
  }
  if (!stat.isDirectory()) {
    throw hostPluginError(errorCodes.fileError, 'hostPlugin.snapshot.regularFileOrDirOnly', {
      hostCode: 'SNAPSHOT_REGULAR_ONLY'
    })
  }
  const entries: SnapshotEntry[] = [{ sourcePath, archivePath, directory: true }]
  for (const item of await fs.readdir(sourcePath)) {
    entries.push(...await collectSource(path.join(sourcePath, item), `${archivePath}/${item}`))
  }
  return entries
}

/** 每个来源使用独立编号目录；manifest 记录来源与归档路径，不执行原位置恢复。 */
export async function createSnapshotArchive(options: {
  sources: string[]
  backupDir: string
  backupName?: string
  authorizeSource: (sourcePath: string) => Promise<string>
  authorizeOutput: (outputPath: string) => Promise<string>
}) {
  const failedSources: SnapshotSourceFailure[] = []
  const entries: SnapshotEntry[] = []
  const sources: Array<{ sourcePath: string; archivePath: string; fileCount: number }> = []
  const uniqueSources = [...new Set(options.sources)]
  for (const [index, rawPath] of uniqueSources.entries()) {
    try {
      const sourcePath = await options.authorizeSource(rawPath)
      const archivePath = `files/${index + 1}/${path.basename(sourcePath) || 'root'}`
      const sourceEntries = await collectSource(sourcePath, archivePath)
      entries.push(...sourceEntries)
      sources.push({ sourcePath, archivePath, fileCount: sourceEntries.filter(entry => !entry.directory).length })
    } catch (error) {
      failedSources.push({ path: rawPath, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (sources.length === 0) {
    const firstErr = failedSources[0]?.error
    return {
      ok: false, success: false, backedUpCount: 0, fileCount: 0, failedSources,
      error: firstErr ? firstErr : t('hostPlugin.snapshot.noValidSources')
    }
  }

  const rawName = options.backupName || `ztools-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.zip`
  const backupName = path.basename(rawName.endsWith('.zip') ? rawName : `${rawName}.zip`)
  const archivePath = await options.authorizeOutput(path.join(options.backupDir, backupName))
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 })
  // 独占创建：显式指定了已有文件名时也不能覆盖以前的快照。
  const output = await fs.open(archivePath, 'wx', 0o600)
  const zip = new yazl.ZipFile()
  const zipStream = zip.outputStream as Readable
  zip.on('error', (error: Error) => zipStream.destroy(error))
  try {
    for (const entry of entries) {
      if (entry.directory) zip.addEmptyDirectory(entry.archivePath)
      else zip.addFile(entry.sourcePath, entry.archivePath)
    }
    zip.addBuffer(Buffer.from(JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      sources,
      failedSources
    }, null, 2)), SNAPSHOT_MANIFEST_NAME)
    const written = pipeline(zipStream, output.createWriteStream())
    zip.end()
    await written
  } catch (error) {
    zipStream.destroy()
    await output.close()
    await fs.unlink(archivePath)
    throw error
  }
  const stat = await fs.stat(archivePath)
  return {
    ok: true, success: true, partial: failedSources.length > 0,
    archivePath, backupPath: archivePath,
    backedUpCount: sources.length,
    fileCount: entries.filter(entry => !entry.directory).length,
    failedSources, sizeBytes: stat.size
  }
}

/** 总是在新目录中解压，保留原配置和已有解压结果；旧 ZIP 的重复条目也不得覆盖。 */
export async function extractSnapshotArchive(archivePath: string, outputParent: string) {
  await fs.mkdir(outputParent, { recursive: true, mode: 0o700 })
  const targetDir = await fs.mkdtemp(path.join(outputParent, `${path.parse(archivePath).name}_extracted-`))
  const extractedFiles: string[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
        if (openError || !zip) {
          reject(openError ?? hostPluginError(errorCodes.fileError, 'hostPlugin.snapshot.openZipFailed', {
            hostCode: 'SNAPSHOT_OPEN_ZIP_FAILED'
          }))
          return
        }
        const fail = (error: unknown) => {
          zip.close()
          reject(error)
        }
        zip.on('error', fail)
        zip.on('end', resolve)
        zip.on('entry', (entry: yauzl.Entry) => {
          void (async () => {
            const entryPath = path.resolve(targetDir, entry.fileName)
            if (!entryPath.startsWith(targetDir + path.sep)) {
              throw hostPluginError(errorCodes.permissionDenied, 'hostPlugin.snapshot.pathTraversal', {
                hostCode: 'SNAPSHOT_PATH_TRAVERSAL'
              })
            }
            if (entry.fileName.endsWith('/')) {
              await fs.mkdir(entryPath, { recursive: true, mode: 0o700 })
            } else {
              await fs.mkdir(path.dirname(entryPath), { recursive: true, mode: 0o700 })
              const input = await new Promise<Readable>((resolveStream, rejectStream) => {
                zip.openReadStream(entry, (error, stream) => {
                  if (error || !stream) {
                    rejectStream(error ?? hostPluginError(errorCodes.fileError, 'hostPlugin.snapshot.readEntryFailed', {
                      hostCode: 'SNAPSHOT_READ_ENTRY_FAILED'
                    }))
                  } else resolveStream(stream)
                })
              })
              let file: Awaited<ReturnType<typeof fs.open>>
              try {
                file = await fs.open(entryPath, 'wx', 0o600)
              } catch (error) {
                input.destroy()
                throw error
              }
              await pipeline(input, file.createWriteStream())
              extractedFiles.push(entryPath)
            }
            zip.readEntry()
          })().catch(fail)
        })
        zip.readEntry()
      })
    })
    return { ok: true, success: true, targetDir, extractedCount: extractedFiles.length, extractedFiles }
  } catch (error) {
    return {
      ok: false, success: false, targetDir, extractedCount: extractedFiles.length,
      error: t('hostPlugin.snapshot.extractFailed', {
        targetDir,
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
