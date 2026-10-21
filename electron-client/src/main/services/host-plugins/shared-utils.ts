import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import type { ProcessService } from '../process-service.js'

export interface HostClipboardPort {
  getText(): Promise<string>
  setText(text: string): Promise<unknown>
}

export interface HostWindowControlPort {
  getActiveWindow?(): Promise<unknown>
}

export interface HostPathAuthorityPort {
  resolveAuthorizedPath(
    rawPath: string,
    caller: CallerIdentity,
    access: 'read' | 'write',
    allowMissing: boolean
  ): Promise<string>
}

export interface SharedFileDescriptor {
  id: string
  name: string
  path: string
  size: number
  sizeBytes?: number
  shared?: boolean
  isDirectory: boolean
  addedAt: string
}

export interface LanShareServerState {
  server: http.Server | null
  port: number
  pin: string
  requirePin: boolean
  sharedFiles: Map<string, SharedFileDescriptor>
  activeTransfers: number
  totalClientRequests?: number
  uploadDir: string
}

export interface ActiveRecordingSession {
  id: string
  type: 'video' | 'gif' | 'region' | 'audio'
  outputPath: string
  startedAt: number
  fps: number
  childProcess?: ReturnType<typeof spawn> | undefined
}

export interface HostPluginContext {
  readonly clipboard: HostClipboardPort | null
  readonly processService: ProcessService | null
  readonly windowControl: HostWindowControlPort | null
  authorizeExistingPath(rawPath: string, caller?: CallerIdentity, access?: 'read' | 'write'): Promise<string>
  authorizeOutputPath(rawPath: string, caller?: CallerIdentity): Promise<string>
}

export const PROTECTED_PROCESS_NAMES = new Set([
  'system',
  'idle',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'winlogon.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'memory compression',
  'spoolsv.exe',
  'explorer.exe'
])

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i] ?? 'B'}`
}

export function guessMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.txt':
    case '.log':
    case '.md':
      return 'text/plain; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.mp4':
      return 'video/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

export function escapeHtml(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function isProtectedSystemPath(resolvedPath: string): boolean {
  const normalized = path.resolve(resolvedPath).replace(/[\\/]+$/, '').toLowerCase()
  if (/^[a-z]:\\?$/.test(normalized) || normalized === '' || normalized === '/') {
    return true
  }
  const homeDir = path.resolve(os.homedir()).replace(/[\\/]+$/, '').toLowerCase()
  const exactProtectedDirs = new Set<string>([
    homeDir,
    path.join(homeDir, 'desktop'),
    path.join(homeDir, 'documents'),
    path.join(homeDir, 'downloads'),
    path.join(homeDir, 'pictures'),
    path.join(homeDir, 'music'),
    path.join(homeDir, 'videos'),
    path.join(homeDir, 'appdata'),
    path.join(homeDir, 'appdata', 'local'),
    path.join(homeDir, 'appdata', 'roaming'),
    path.join(homeDir, 'library'),
    'c:\\users',
    'c:\\programdata',
    '/users',
    '/home',
    '/var',
    '/tmp'
  ])
  if (exactProtectedDirs.has(normalized)) {
    return true
  }

  const winDir = (process.env.WINDIR || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
  const sysRoot = (process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
  const progFiles = (process.env.ProgramFiles || 'C:\\Program Files').replace(/[\\/]+$/, '').toLowerCase()
  const progFilesX86 = (process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').replace(/[\\/]+$/, '').toLowerCase()
  const protectedPrefixes = [
    winDir,
    sysRoot,
    progFiles,
    progFilesX86,
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\system volume information',
    'c:\\$recycle.bin',
    '/system',
    '/usr',
    '/bin',
    '/sbin',
    '/etc'
  ]
  return protectedPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + path.sep)
  )
}

export function isForbiddenRegistryPath(regKeyPath: string): boolean {
  const normalized = regKeyPath.trim().toLowerCase().replace(/\//g, '\\')
  const forbiddenPatterns = [
    '\\currentversion\\run',
    '\\currentversion\\runonce',
    '\\winlogon',
    '\\system\\currentcontrolset\\services',
    '\\policies\\system',
    '\\windows defender',
    '\\security center',
    '\\image file execution options',
    '\\appinit_dlls'
  ]
  return forbiddenPatterns.some((pattern) => normalized.includes(pattern))
}

export async function calculateDirectorySize(
  targetPath: string,
  maxDepth = 3
): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0
  let fileCount = 0

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let stat: fsSync.Stats
    try {
      stat = await fs.lstat(current)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      totalBytes += stat.size
      fileCount += 1
      return
    }
    if (!stat.isDirectory()) return
    let entries: fsSync.Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.slice(0, 250)) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isFile()) {
        try {
          const s = await fs.stat(fullPath)
          totalBytes += s.size
          fileCount += 1
        } catch {
          // ignore unreadable file
        }
      } else if (entry.isDirectory()) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(targetPath, 0)
  return { totalBytes, fileCount }
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fsSync.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (err) {
      stderr = err instanceof Error ? err.message : String(err)
      finish(1)
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish(124)
    }, timeoutMs)

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          try {
            child.kill()
          } catch {
            // ignore
          }
          finish(130)
        },
        { once: true }
      )
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      stderr += err.message
      finish(1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? 0)
    })
  })
}

export async function runPowerShell(script: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') {
    return ''
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    timeoutMs,
    signal
  )
  return stdout
}

export function isValidPdfBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 8) return false
  return buf.subarray(0, 1024).toString('latin1').includes('%PDF-')
}

export function countPdfPages(buf: Buffer): number {
  const raw = buf.toString('latin1')
  const pageMatches = raw.match(/\/Type\s*\/Page\b(?!s)/g)
  if (pageMatches && pageMatches.length > 0) {
    return pageMatches.length
  }
  const countMatch = raw.match(/\/Count\s+(\d+)/)
  if (countMatch?.[1]) {
    return Math.max(1, Number(countMatch[1]))
  }
  return 1
}

export function extractPdfPageStreams(buf: Buffer): string[] {
  const raw = buf.toString('latin1')
  const streams: string[] = []
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match: RegExpExecArray | null
  while ((match = streamRegex.exec(raw)) !== null) {
    if (match[1] !== undefined) {
      streams.push(match[1])
    }
  }
  const declaredPageCount = countPdfPages(buf)
  if (streams.length === 0) {
    const fallbackText = raw
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .slice(0, 512)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
    for (let i = 0; i < declaredPageCount; i++) {
      streams.push(`BT\n/F1 11 Tf\n48 760 Td\n(${fallbackText}) Tj\nET`)
    }
  } else if (streams.length < declaredPageCount) {
    while (streams.length < declaredPageCount) {
      streams.push(streams[streams.length - 1] ?? '')
    }
  }
  return streams
}

export function buildMultiPagePdfFromStreams(pageStreams: string[]): Buffer {
  const validStreams = pageStreams.length > 0 ? pageStreams : ['BT\n/F1 11 Tf\n48 760 Td\n() Tj\nET']
  const pageCount = validStreams.length
  const kidsRefs: string[] = []
  for (let i = 0; i < pageCount; i++) {
    kidsRefs.push(`${4 + i * 2} 0 R`)
  }

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${pageCount} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]

  for (let i = 0; i < pageCount; i++) {
    const pageObjId = 4 + i * 2
    const contentObjId = 5 + i * 2
    const streamBody = validStreams[i] ?? ''
    const streamByteLen = Buffer.byteLength(streamBody, 'latin1')
    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 595 842] /Contents ${contentObjId} 0 R >>\nendobj\n`
    )
    objects.push(
      `${contentObjId} 0 obj\n<< /Length ${streamByteLen} >>\nstream\n${streamBody}\nendstream\nendobj\n`
    )
  }

  let body = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    body += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

export function buildMinimalValidPdf(lines: string[]): Buffer {
  const escapedLines = lines.map((line) =>
    line
      .replace(/[^\x20-\x7E]/g, '?')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
  )
  const textOps = escapedLines
    .slice(0, 45)
    .map((line, index) => (index === 0 ? `(${line}) Tj` : `0 -16 Td (${line}) Tj`))
    .join('\n')
  const streamContent = `BT\n/F1 11 Tf\n48 780 Td\n${textOps}\nET`
  return buildMultiPagePdfFromStreams([streamContent])
}

export interface OptimizePdfOptions {
  watermarkText?: string | undefined
  pageIndices?: number[] | undefined
}

export function optimizePdfBuffer(
  sourceBuf: Buffer,
  options?: OptimizePdfOptions
): { buffer: Buffer; pageCount: number } {
  const streams = extractPdfPageStreams(sourceBuf)
  const selectedStreams =
    options?.pageIndices && options.pageIndices.length > 0
      ? options.pageIndices
          .filter((idx) => idx >= 0 && idx < streams.length)
          .map((idx) => streams[idx] ?? '')
      : streams
  const finalStreams = (selectedStreams.length > 0 ? selectedStreams : streams).map((stream) => {
    if (!options?.watermarkText) return stream
    const safeWm = options.watermarkText
      .replace(/[^\x20-\x7E]/g, '?')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
    return `${stream}\nBT\n/F1 14 Tf\n200 420 Td\n(${safeWm}) Tj\nET`
  })
  const rebuilt = buildMultiPagePdfFromStreams(finalStreams)
  return {
    buffer: rebuilt,
    pageCount: finalStreams.length
  }
}

export function mergePdfBuffers(buffers: Buffer[]): { buffer: Buffer; pageCount: number } {
  const allPageStreams: string[] = []
  for (const buf of buffers) {
    const streams = extractPdfPageStreams(buf)
    allPageStreams.push(...streams)
  }
  const merged = buildMultiPagePdfFromStreams(allPageStreams)
  return {
    buffer: merged,
    pageCount: allPageStreams.length
  }
}

export async function captureScreenToPng(outputPath: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === 'win32') {
    const escapedPath = outputPath.replace(/'/g, "''")
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bmp)
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $bmp.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bmp.Dispose()
      Write-Output 'OK'
    `
    const out = await runPowerShell(psScript, 15_000, signal)
    return out.includes('OK') && fsSync.existsSync(outputPath)
  } else if (process.platform === 'darwin') {
    const { exitCode } = await runCommand('screencapture', ['-x', outputPath], 10_000, signal)
    return exitCode === 0 && fsSync.existsSync(outputPath)
  }
  return false
}

export async function processSingleImageFile(
  srcPath: string,
  outPath: string,
  mode: string,
  scaleFactor = 2
): Promise<{ width: number; height: number; outputBytes: number }> {
  const ext = path.extname(srcPath).toLowerCase()
  const outExt = path.extname(outPath).toLowerCase()
  const lowerMode = mode.toLowerCase()
  const isNoScaleMode =
    lowerMode.includes('compress') || lowerMode.includes('denoise') || lowerMode.includes('bg_remove')
  const factor = isNoScaleMode ? 1 : Math.max(1, Math.min(4, Math.round(scaleFactor) || 2))

  if (ext === '.png' && (outExt === '.png' || outExt === '')) {
    const buf = await fs.readFile(srcPath)
    const png = PNG.sync.read(buf)
    const outPng = new PNG({ width: png.width * factor, height: png.height * factor })
    for (let y = 0; y < outPng.height; y++) {
      const srcY = Math.min(png.height - 1, Math.floor(y / factor))
      for (let x = 0; x < outPng.width; x++) {
        const srcX = Math.min(png.width - 1, Math.floor(x / factor))
        const srcIdx = (png.width * srcY + srcX) << 2
        const dstIdx = (outPng.width * y + x) << 2
        let r = png.data[srcIdx] ?? 0
        let g = png.data[srcIdx + 1] ?? 0
        let b = png.data[srcIdx + 2] ?? 0
        const a = png.data[srcIdx + 3] ?? 255
        if (lowerMode.includes('enhance') || lowerMode.includes('denoise')) {
          r = Math.min(255, Math.max(0, Math.round((r - 128) * 1.08 + 128)))
          g = Math.min(255, Math.max(0, Math.round((g - 128) * 1.08 + 128)))
          b = Math.min(255, Math.max(0, Math.round((b - 128) * 1.08 + 128)))
        }
        outPng.data[dstIdx] = r
        outPng.data[dstIdx + 1] = g
        outPng.data[dstIdx + 2] = b
        outPng.data[dstIdx + 3] = a
      }
    }
    const outBuf = PNG.sync.write(outPng)
    await fs.writeFile(outPath, outBuf)
    return { width: outPng.width, height: outPng.height, outputBytes: outBuf.length }
  }

  if (process.platform === 'win32') {
    const escapedSrc = srcPath.replace(/'/g, "''")
    const escapedOut = outPath.replace(/'/g, "''")
    const imgFormat =
      outExt === '.jpg' || outExt === '.jpeg'
        ? 'Jpeg'
        : outExt === '.bmp'
          ? 'Bmp'
          : outExt === '.gif'
            ? 'Gif'
            : 'Png'
    const psScript = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Drawing
      $srcBmp = New-Object System.Drawing.Bitmap('${escapedSrc}')
      try {
        $newW = [Math]::Max(1, [int]($srcBmp.Width * ${factor}))
        $newH = [Math]::Max(1, [int]($srcBmp.Height * ${factor}))
        $dstBmp = New-Object System.Drawing.Bitmap($newW, $newH)
        try {
          $g = [System.Drawing.Graphics]::FromImage($dstBmp)
          try {
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.DrawImage($srcBmp, 0, 0, $newW, $newH)
          } finally {
            $g.Dispose()
          }
          $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::${imgFormat})
          [PSCustomObject]@{ width = $newW; height = $newH } | ConvertTo-Json -Compress
        } finally {
          $dstBmp.Dispose()
        }
      } finally {
        $srcBmp.Dispose()
      }
    `
    const out = await runPowerShell(psScript, 20_000)
    if (out && fsSync.existsSync(outPath)) {
      const stat = await fs.stat(outPath)
      if (stat.size > 0) {
        try {
          const parsed = JSON.parse(out) as { width?: number; height?: number }
          return {
            width: Number(parsed.width) || 0,
            height: Number(parsed.height) || 0,
            outputBytes: stat.size
          }
        } catch {
          return { width: 0, height: 0, outputBytes: stat.size }
        }
      }
    }
  }

  throw new Error(`图像处理失败，不支持直接复制冒充超分结果: ${path.basename(srcPath)}`)
}
