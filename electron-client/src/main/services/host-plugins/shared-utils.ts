import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import type { ProcessService } from '../process-service.js'

export interface HostClipboardPort {
  getText(): Promise<string>
  setText(text: string): Promise<unknown>
  getImage?(): Promise<string | Buffer | null>
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

/**
 * 宿主插件收到的路径必须是完整的绝对路径：相对路径会按主进程当前工作目录解析（打包后的应用可能是 / 或安装目录），
 * 写入位置不可预期，一律拒绝而不是替调用方猜。按平台判断：
 *   - Windows：盘符 + 分隔符（C:\ 或 C:/）、UNC（\\server\share）与 \\?\ 扩展路径；C:foo（盘符相对）与 \foo（当前盘根相对）都不算；
 *   - macOS / Linux：以 / 开头（"C:\Windows\System32" 这类 Windows 路径在这里是相对路径）。
 */
export function isFullyQualifiedPath(rawPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    return false
  }
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(rawPath) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(rawPath)
  }
  return path.posix.isAbsolute(rawPath)
}

/**
 * 把 file:// 下载源转成本地路径：按目标平台解码（Windows 盘符 file:///C:/x → C:\x、UNC file://server/share/x、
 * %20 等转义），不能像 new URL(url).pathname 那样在 Windows 上得到 /C:/x 这种无效路径。
 * 格式不合法（不是 file:// 地址、macOS / Linux 上带主机名、路径里有编码后的分隔符等）或只指向根目录时抛出中文错误。
 */
export function fileUrlToLocalPath(url: string, platform: NodeJS.Platform = process.platform): string {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!/^file:\/\//i.test(raw)) {
    throw new Error(`不是合法的 file:// 地址: ${raw || '(空)'}`)
  }
  const windows = platform === 'win32'
  let localPath: string
  try {
    localPath = fileURLToPath(raw, { windows })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    throw new Error(`不是合法的 file:// 地址${code ? `（${code}）` : ''}: ${raw}`)
  }
  const pathApi = windows ? path.win32 : path.posix
  if (!localPath || localPath.includes('\0') || !isFullyQualifiedPath(localPath, platform)) {
    throw new Error(`file:// 地址没有指向完整的本地路径: ${raw}`)
  }
  if (pathApi.parse(localPath).root === localPath) {
    throw new Error(`file:// 地址只指向根目录，没有指向具体文件: ${raw}`)
  }
  return localPath
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

/**
 * Windows 代码页 → TextDecoder（WHATWG Encoding）标签；未收录的返回 undefined，由调用方退回按界面语言猜测。
 * 437（美国）、850（西欧）、852、857、858、860~865、737、775、855、869 等 DOS 代码页 TextDecoder 不支持，
 * 只能退回 Windows-1252：ASCII 部分一致，0x80 以上的字母（如 cp850 的 é）会解成别的字符，但不会抛错或截断。
 */
export function codePageToTextDecoderLabel(codePage: number): string | undefined {
  if (!Number.isInteger(codePage) || codePage <= 0) return undefined
  switch (codePage) {
    case 65001: return 'utf-8'
    case 936:
    case 54936: return 'gb18030'
    case 950: return 'big5'
    case 932: return 'shift_jis'
    case 949: return 'euc-kr'
    case 866: return 'ibm866'
    case 874: return 'windows-874'
    case 20866: return 'koi8-r'
    case 21866: return 'koi8-u'
    case 10000: return 'macintosh'
    case 437: case 737: case 775: case 850: case 852: case 855: case 857: case 858:
    case 860: case 861: case 862: case 863: case 864: case 865: case 869:
      return 'windows-1252'
  }
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`
  // ISO-8859-x：28591 在 WHATWG 中即 windows-1252；28592~28605（跳过不存在的 12）对应 iso-8859-2~15
  if (codePage === 28591) return 'windows-1252'
  if (codePage >= 28592 && codePage <= 28605 && codePage !== 28600 && codePage !== 28601 && codePage !== 28602 && codePage !== 28604) {
    return `iso-8859-${codePage - 28590}`
  }
  return undefined
}

/**
 * 解码子进程输出（纯函数，代码页由调用方传入）：合法 UTF-8 一律按 UTF-8；否则按系统 OEM 代码页
 * （控制台原生命令 reg、netsh、tasklist、sc、schtasks、ipconfig 等按 OEM 代码页输出，与界面语言无关）。
 * 还没探测到代码页或代码页未收录时退回按界面语言猜：中文按 GB18030（兼容 GBK），其余按 Windows-1252。
 */
export function decodeCommandOutput(
  bytes: Buffer,
  codePage?: number,
  locale = Intl.DateTimeFormat().resolvedOptions().locale
): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch {
    const label = (codePage === undefined ? undefined : codePageToTextDecoderLabel(codePage)) ?? (/^zh/i.test(locale) ? 'gb18030' : 'windows-1252')
    return new TextDecoder(label).decode(bytes)
  }
}

/** 从 `reg query HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage /v OEMCP` 的输出取 OEM 代码页 */
export function parseOemCodePage(regOutput: string): number | undefined {
  const match = /\bOEMCP\s+REG_SZ\s+(\d{3,5})\b/i.exec(regOutput ?? '')
  const value = match ? Number(match[1]) : NaN
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 一次性 OEM 代码页探测：第一次调用时执行查询，之后返回同一结果（成功或失败都缓存，不反复启动 reg）。
 * 查询失败、退出码非零或输出无法解析时得到 undefined，解码退回按界面语言猜测；查询本身抛错也不外抛。
 */
export function createOemCodePageProbe(
  query: () => Promise<{ stdout: string; exitCode: number }>
): () => Promise<number | undefined> {
  let pending: Promise<number | undefined> | undefined
  return () => {
    pending ??= query().then(
      (res) => (res.exitCode === 0 ? parseOemCodePage(res.stdout) : undefined),
      () => undefined
    )
    return pending
  }
}

/**
 * PowerShell 单引号字符串转义：PowerShell 把 ' 以及弯引号 ‘ ’ ‚ ‛ 都当作单引号，必须全部成对转义，
 * 只转义 ASCII 单引号时，文件名里的弯引号可以提前结束字符串并注入命令。
 */
export function escapePsSingleQuoted(value: string): string {
  return String(value).replace(/['\u2018\u2019\u201A\u201B]/g, quote => quote + quote)
}

interface RawProcessOutput { stdout: Buffer; stderr: Buffer; exitCode: number; extraError: string }

/** 启动子进程并收集原始字节；永不拒绝：超时 124、取消 130、无法启动 1 */
function collectProcessOutput(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RawProcessOutput> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (exitCode: number, extraError = '') => {
      if (settled) return
      settled = true
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, extraError })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (err) {
      finish(1, err instanceof Error ? err.message : String(err))
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程可能已退出；结果仍按超时（124）报告
      }
      finish(124, `命令执行超时（${timeoutMs} ms）`)
    }, timeoutMs)

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          try {
            child.kill()
          } catch {
            // 进程可能已退出；结果仍按取消（130）报告
          }
          finish(130, '命令已取消')
        },
        { once: true }
      )
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout.push(Buffer.from(chunk)) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr.push(Buffer.from(chunk)) })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish(1, err.message)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code ?? 0)
    })
  })
}

/** 系统 OEM 代码页（仅 Windows）：首次执行命令时与命令并行探测一次，结果缓存 */
const probeSystemOemCodePage = createOemCodePageProbe(async () => {
  const res = await collectProcessOutput('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], 5_000)
  // 这一行只含 ASCII（值名、类型与数字），按 latin1 读即可，不依赖尚未确定的代码页
  return { stdout: res.stdout.toString('latin1'), exitCode: res.exitCode }
})

export async function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // 与命令并行探测，只在第一次执行时可能多等 reg 的几十毫秒；探测失败退回按界面语言解码
  const codePagePromise = process.platform === 'win32' ? probeSystemOemCodePage() : Promise.resolve(undefined)
  const raw = await collectProcessOutput(command, args, timeoutMs, signal)
  const codePage = await codePagePromise
  const errorText = decodeCommandOutput(raw.stderr, codePage).trim()
  return {
    stdout: decodeCommandOutput(raw.stdout, codePage).trim(),
    stderr: [errorText, raw.extraError].filter(Boolean).join('\n'),
    exitCode: raw.exitCode
  }
}

/** PowerShell 执行失败（非零退出、超时、取消、无法启动）：带退出码与错误输出，不能当成“没有结果” */
export class PowerShellError extends Error {
  constructor(readonly exitCode: number, readonly stderr: string) {
    super(exitCode === 124 ? `PowerShell 执行超时${stderr ? `：${stderr}` : ''}`
      : exitCode === 130 ? 'PowerShell 执行已取消'
        : `PowerShell 执行失败（退出码 ${exitCode}）${stderr ? `：${stderr.slice(0, 500)}` : ''}`)
    this.name = 'PowerShellError'
  }
}

/**
 * 每段 PowerShell 脚本前加的输出编码设置：Windows PowerShell 5.1 重定向 stdout 时按 OEM 代码页输出，
 * 代码页外的字符（中文系统里的日文文件名、西文系统里的中文网卡名等）在源头就变成 ?，解码端无法还原。
 * 先把控制台输出与管道编码固定为不带 BOM 的 UTF-8，输出再按 decodeCommandOutput 的 UTF-8 分支解码。
 * 设置失败（极少见）时错误写到 stderr、脚本继续执行，输出仍是 OEM 代码页，由解码端按代码页回退。
 * 注意：脚本内捕获原生命令（netsh、reg 等）的输出时 PowerShell 也按这个编码解读，而原生命令仍按 OEM 代码页输出，
 * 非 ASCII 字符会乱；原生命令请直接用 runCommand 执行，不要包在 PowerShell 脚本里取输出。
 */
export const POWERSHELL_UTF8_OUTPUT_PREFIX =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding\n'

/** param() / [CmdletBinding()] / using 必须位于脚本开头，前面加了编码设置会变成语法错误 */
const POWERSHELL_LEADING_ONLY_STATEMENT = /^(?:\s|#[^\n]*(?:\n|$)|<#[\s\S]*?#>)*(?:param\s*\(|\[\s*CmdletBinding\b|using\s+(?:namespace|assembly|module)\b)/i

/** 生成 powershell.exe 的参数：脚本加上 UTF-8 输出前缀后按 UTF-16LE 编码给 -EncodedCommand */
export function buildPowerShellArgs(script: string): string[] {
  if (POWERSHELL_LEADING_ONLY_STATEMENT.test(script)) {
    throw new Error('PowerShell 脚本以 param()、[CmdletBinding()] 或 using 开头，无法在前面设置 UTF-8 输出；-EncodedCommand 也无法传参，请去掉 param 块')
  }
  const encoded = Buffer.from(POWERSHELL_UTF8_OUTPUT_PREFIX + script, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
}

/**
 * 执行 PowerShell 脚本，退出码非 0 抛 PowerShellError。注意 -EncodedCommand 的退出码取最后一条语句的 $?：
 * 以 -ErrorAction SilentlyContinue 的命令结尾、且该命令写过非终止错误时，退出码也是 1。
 * 确认这类错误可以忽略的脚本要在末尾显式 exit 0，不能让可忽略的错误变成整体失败。
 */
export async function runPowerShell(script: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') {
    return ''
  }
  const { stdout, stderr, exitCode } = await runCommand('powershell.exe', buildPowerShellArgs(script), timeoutMs, signal)
  if (exitCode !== 0) throw new PowerShellError(exitCode, stderr)
  return stdout
}

/**
 * 内置处理器访问系统的入口（执行命令、PowerShell）。生产代码默认用真实实现；
 * 测试只能通过处理器构造参数注入替身，插件调用参数无法切换它，因此插件不能伪造宿主结果。
 */
export interface HostSystemCommands {
  runCommand: typeof runCommand
  runPowerShell: typeof runPowerShell
}

export function resolveHostSystemCommands(overrides: Partial<HostSystemCommands> = {}): HostSystemCommands {
  return { runCommand: overrides.runCommand ?? runCommand, runPowerShell: overrides.runPowerShell ?? runPowerShell }
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
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
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
    const escapedPath = escapePsSingleQuoted(outputPath)
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
    const escapedSrc = escapePsSingleQuoted(srcPath)
    const escapedOut = escapePsSingleQuoted(outPath)
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
