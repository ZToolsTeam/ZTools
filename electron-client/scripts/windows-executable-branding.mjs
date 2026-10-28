import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resedit } from '@electron/packager/resedit'

export function readWindowsExecutableBranding(file) {
  const literal = `'${path.resolve(file).replaceAll("'", "''")}'`
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Drawing',
    `$icon=[Drawing.Icon]::ExtractAssociatedIcon(${literal})`,
    "if($null -eq $icon){throw '无法读取图标'}",
    '$bitmap=$null;$stream=$null;$sha=$null',
    'try {',
    '$bitmap=$icon.ToBitmap()',
    '$stream=[IO.MemoryStream]::new()',
    '$sha=[Security.Cryptography.SHA256]::Create()',
    '$bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)',
    '$fingerprint=[BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace("-","")',
    `$version=[Diagnostics.FileVersionInfo]::GetVersionInfo(${literal})`,
    '[pscustomobject]@{iconFingerprint=$fingerprint;fileVersion=$version.FileVersion;productVersion=$version.ProductVersion;productName=$version.ProductName} | ConvertTo-Json -Compress',
    '} finally {if($sha){$sha.Dispose()};if($stream){$stream.Dispose()};if($bitmap){$bitmap.Dispose()};$icon.Dispose()}'
  ].join(';')
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  }).trim())
}

export function assertWindowsExecutableBranding(file, { icon, version }) {
  const actual = readWindowsExecutableBranding(file)
  const expected = readWindowsExecutableBranding(icon)
  if (actual.iconFingerprint !== expected.iconFingerprint) {
    throw new Error(`WINDOWS_ICON_MISMATCH: 程序图标与当前客户端图标不一致: ${file}`)
  }
  if (actual.fileVersion !== version || actual.productVersion !== version || actual.productName !== 'ZTools') {
    throw new Error(`WINDOWS_VERSION_MISMATCH: 程序版本信息与 ${version} 不一致: ${file}`)
  }
  return actual
}

export async function applyWindowsExecutableBranding(file, { icon, version }) {
  await resedit(file, {
    iconPath: icon,
    fileVersion: version,
    productVersion: version,
    productName: 'ZTools',
    win32Metadata: { CompanyName: 'ZTools Team', FileDescription: 'ZTools' }
  })
  return assertWindowsExecutableBranding(file, { icon, version })
}
