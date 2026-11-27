import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'

const execFileAsync = promisify(execFile)
const AUTHENTICODE_TIMEOUT_MS = 30_000

/**
 * 固定 PowerShell Authenticode 查询脚本（目标路径经环境变量传入，避免任何命令行注入）。
 * 与 installer/platform/windows/src/windows_platform.cpp 对齐离线吊销策略：
 * - 优先使用 WinVerifyTrust + WTD_CACHE_ONLY_URL_RETRIEVAL（仅查本地缓存 CRL/OCSP，不阻塞网络）；
 * - 仅当返回 CERT_E_REVOCATION_FAILURE (0x800B010E) 或 CRYPT_E_REVOCATION_OFFLINE (0x80092013) 时以 WTD_REVOKE_NONE 离线重试一次；
 * - 若受限 PowerShell 环境禁止 Add-Type，则自动回退到 Get-AuthenticodeSignature。
 */
const AUTHENTICODE_QUERY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$target = $env:ZTOOLS_AUTH_TARGET_PATH',
  'if ([string]::IsNullOrWhiteSpace($target)) { throw "Missing target path" }',
  '$status = ""',
  '$statusMessage = ""',
  '$subject = ""',
  '$thumbprint = ""',
  '$usedWinTrust = $false',
  'try {',
  '  Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ZToolsWinTrust {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  struct WINTRUST_FILE_INFO {',
  '    public uint cbStruct;',
  '    public string pcwszFilePath;',
  '    public IntPtr hFile;',
  '    public IntPtr pgKnownSubject;',
  '  }',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  struct WINTRUST_DATA {',
  '    public uint cbStruct;',
  '    public IntPtr pPolicyCallbackData;',
  '    public IntPtr pSIPClientData;',
  '    public uint dwUIChoice;',
  '    public uint fdwRevocationChecks;',
  '    public uint dwUnionChoice;',
  '    public IntPtr pFile;',
  '    public uint dwStateAction;',
  '    public IntPtr hWVTStateData;',
  '    public string pwszURLReference;',
  '    public uint dwProvFlags;',
  '    public uint dwUIContext;',
  '    public IntPtr pSignatureSettings;',
  '  }',
  '  [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = false, CharSet = CharSet.Unicode)]',
  '  static extern uint WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID, ref WINTRUST_DATA pWVTData);',
  '  static uint RunVerify(string path, uint revocationChecks, uint provFlags) {',
  '    var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");',
  '    var fileInfo = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = path, hFile = IntPtr.Zero, pgKnownSubject = IntPtr.Zero };',
  '    IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));',
  '    try {',
  '      Marshal.StructureToPtr(fileInfo, pFile, false);',
  '      var data = new WINTRUST_DATA {',
  '        cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),',
  '        dwUIChoice = 2,',
  '        fdwRevocationChecks = revocationChecks,',
  '        dwUnionChoice = 1,',
  '        pFile = pFile,',
  '        dwStateAction = 1,',
  '        dwProvFlags = provFlags',
  '      };',
  '      uint res = WinVerifyTrust(IntPtr.Zero, action, ref data);',
  '      data.dwStateAction = 2;',
  '      WinVerifyTrust(IntPtr.Zero, action, ref data);',
  '      return res;',
  '    } finally {',
  '      Marshal.DestroyStructure(pFile, typeof(WINTRUST_FILE_INFO));',
  '      Marshal.FreeHGlobal(pFile);',
  '    }',
  '  }',
  '  public static uint VerifyWithOfflineFallback(string path) {',
  '    uint status = RunVerify(path, 1, 0x00000400u | 0x00001000u);',
  '    if (status == 0x800B010Eu || status == 0x80092013u) {',
  '      status = RunVerify(path, 0, 0x00000400u);',
  '    }',
  '    return status;',
  '  }',
  '}',
  '"@ -ErrorAction Stop | Out-Null',
  '  $code = [ZToolsWinTrust]::VerifyWithOfflineFallback($target)',
  '  $hexCode = ("0x{0:X8}" -f $code)',
  '  $usedWinTrust = $true',
  '  if ($hexCode -eq "0x00000000") {',
  '    $status = "Valid"',
  '    $statusMessage = "Signature verified"',
  '    try {',
  '      $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2([System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($target))',
  '      $subject = [string]$cert.Subject',
  '      $thumbprint = [string]$cert.Thumbprint',
  '    } catch {',
  '      $subject = ""',
  '      $thumbprint = ""',
  '    }',
  '  } elseif ($hexCode -eq "0x800B0100") {',
  '    $status = "NotSigned"',
  '    $statusMessage = "WinVerifyTrust failed (0x800B0100)"',
  '  } elseif ($hexCode -eq "0x80096010") {',
  '    $status = "HashMismatch"',
  '    $statusMessage = "WinVerifyTrust failed (0x80096010)"',
  '  } else {',
  '    $status = "UnknownError"',
  '    $statusMessage = ("WinVerifyTrust failed ({0})" -f $hexCode)',
  '  }',
  '} catch {',
  '  $usedWinTrust = $false',
  '}',
  'if (-not $usedWinTrust) {',
  '  $sig = Get-AuthenticodeSignature -LiteralPath $target',
  '  $status = [string]$sig.Status',
  '  $statusMessage = [string]$sig.StatusMessage',
  '  $subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { "" }',
  '  $thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { "" }',
  '}',
  '[pscustomobject]@{',
  '  Status = $status',
  '  StatusMessage = $statusMessage',
  '  Subject = $subject',
  '  Thumbprint = $thumbprint',
  '} | ConvertTo-Json -Compress'
].join('\n')

/** 预编码的 UTF-16LE Base64 脚本，供 powershell.exe -EncodedCommand 执行 */
export const AUTHENTICODE_ENCODED_COMMAND = Buffer.from(AUTHENTICODE_QUERY_SCRIPT, 'utf16le').toString('base64')

export interface AuthenticodeSignatureInfo {
  readonly status: string
  readonly statusMessage?: string | undefined
  readonly subject?: string | undefined
  readonly thumbprint?: string | undefined
}

export type AuthenticodeCommandRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined; timeoutMs: number }
) => Promise<{ stdout: string; stderr: string }>

export interface WindowsInstallerVerifyOptions {
  /** 当前运行中宿主可执行文件路径（默认 process.execPath） */
  readonly hostExecutablePath?: string | undefined
  /** 是否为打包态生产环境；未传时默认按 true 严格验签（Fail-Closed） */
  readonly isPackaged?: boolean | undefined
  /** 开发态下是否强制执行验签 */
  readonly enforceInDev?: boolean | undefined
  /** 可中止信号 */
  readonly signal?: AbortSignal | undefined
  /** 注入底层命令行执行器，便于单测 */
  readonly runCommand?: AuthenticodeCommandRunner | undefined
  /** 注入签名查询实现，便于单测 */
  readonly querySignature?: ((filePath: string, signal?: AbortSignal) => Promise<AuthenticodeSignatureInfo>) | undefined
}

const defaultCommandRunner: AuthenticodeCommandRunner = (file, args, options) =>
  execFileAsync(file, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {})
  })

function normalizeThumbprint(value: string | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : ''
}

function normalizeSubject(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 解析 PowerShell Get-AuthenticodeSignature 的 JSON 输出 */
export function parseAuthenticodeOutput(stdout: string): AuthenticodeSignatureInfo {
  const trimmed = stdout.replace(/^\uFEFF/, '').trim()
  if (!trimmed) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Authenticode signature verification returned empty output')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Authenticode signature verification returned malformed JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Authenticode signature verification returned invalid payload')
  }
  const record = parsed as Record<string, unknown>
  const status = typeof record.Status === 'string' ? record.Status.trim() : ''
  if (!status) {
    throw new ZToolsError(errorCodes.dataCorrupt, 'Authenticode signature status is missing')
  }
  const statusMessage = typeof record.StatusMessage === 'string' ? record.StatusMessage.trim() : undefined
  const subject = typeof record.Subject === 'string' ? record.Subject.trim() : undefined
  const thumbprint = typeof record.Thumbprint === 'string' ? record.Thumbprint.trim() : undefined
  return {
    status,
    ...(statusMessage ? { statusMessage } : {}),
    ...(subject ? { subject } : {}),
    ...(thumbprint ? { thumbprint } : {})
  }
}

/** 调用 Windows PowerShell Get-AuthenticodeSignature 查询指定文件的数字签名信息 */
export async function queryAuthenticodeSignature(
  filePath: string,
  signal?: AbortSignal,
  runCommand: AuthenticodeCommandRunner = defaultCommandRunner
): Promise<AuthenticodeSignatureInfo> {
  if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid file path for Authenticode verification')
  }
  const resolvedPath = path.resolve(filePath)
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const powershellExe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const executable = process.platform === 'win32' ? powershellExe : 'powershell.exe'

  let output: { stdout: string; stderr: string }
  try {
    // 清除可能来自 PowerShell 7 的 PSModulePath，防止 Windows PowerShell 5.1 回退加载 Security 模块失败
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ZTOOLS_AUTH_TARGET_PATH: resolvedPath
    }
    delete childEnv.PSModulePath
    output = await runCommand(
      executable,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', AUTHENTICODE_ENCODED_COMMAND],
      {
        env: childEnv,
        signal,
        timeoutMs: AUTHENTICODE_TIMEOUT_MS
      }
    )
  } catch (error) {
    if (error instanceof ZToolsError) throw error
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new ZToolsError(errorCodes.cancelled, 'Authenticode verification was cancelled')
    }
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error)
    throw new ZToolsError(errorCodes.dataCorrupt, `Failed to verify Authenticode signature: ${detail}`)
  }
  return parseAuthenticodeOutput(output.stdout)
}

/**
 * 校验 Windows 更新安装包的 Authenticode 数字签名（Fail-Closed）。
 * - 打包态（或未显式传入 isPackaged 时默认按生产态严格校验）：
 *   1. 待安装包必须具备 Status === 'Valid' 且非空签名者证书；
 *   2. 若当前运行中的宿主自身具备有效 Authenticode 签名，则强制要求更新包的发布者 Subject 或证书 Thumbprint 与宿主一致，防范换签攻击。
 * - 开发态（isPackaged === false 且 enforceInDev !== true）：受控跳过并返回 null。
 */
export async function verifyWindowsInstallerSignature(
  installerPath: string,
  options: WindowsInstallerVerifyOptions = {}
): Promise<AuthenticodeSignatureInfo | null> {
  if (options.isPackaged === false && options.enforceInDev !== true) {
    return null
  }
  options.signal?.throwIfAborted()

  const query = options.querySignature
    ?? ((targetPath: string, signal?: AbortSignal) => queryAuthenticodeSignature(targetPath, signal, options.runCommand))

  const candidateSig = await query(installerPath, options.signal)
  const candidateSubject = normalizeSubject(candidateSig.subject)
  const candidateThumbprint = normalizeThumbprint(candidateSig.thumbprint)
  if (candidateSig.status !== 'Valid' || (!candidateSubject && !candidateThumbprint)) {
    const detail = candidateSig.statusMessage ? ` (${candidateSig.statusMessage})` : ''
    throw new ZToolsError(
      errorCodes.dataCorrupt,
      `Windows update package Authenticode signature is invalid: ${candidateSig.status}${detail}`
    )
  }

  // 若当前宿主可执行文件本身具备有效签名，强制要求安装包签名者与宿主一致（防换签）
  const hostPath = options.hostExecutablePath ?? process.execPath
  if (hostPath) {
    let hostExists = false
    if (options.querySignature) {
      hostExists = true
    } else {
      hostExists = await fs.stat(hostPath).then((stats) => stats.isFile(), () => false)
    }
    if (hostExists) {
      let hostSig: AuthenticodeSignatureInfo | null = null
      try {
        hostSig = await query(hostPath, options.signal)
      } catch {
        // 宿主路径无法查询签名时（如测试环境 mock 路径），仅当宿主自身明确有效签名时执行发布者绑定
        hostSig = null
      }
      if (hostSig && hostSig.status === 'Valid') {
        const hostSubject = normalizeSubject(hostSig.subject)
        const hostThumbprint = normalizeThumbprint(hostSig.thumbprint)
        const subjectMatched = Boolean(hostSubject && candidateSubject && candidateSubject === hostSubject)
        const thumbprintMatched = Boolean(hostThumbprint && candidateThumbprint && candidateThumbprint === hostThumbprint)
        if ((hostSubject || hostThumbprint) && !subjectMatched && !thumbprintMatched) {
          throw new ZToolsError(
            errorCodes.permissionDenied,
            'Windows update package publisher signature does not match current application'
          )
        }
      }
    }
  }

  return candidateSig
}
