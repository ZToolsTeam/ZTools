param(
  [string]$OutputDirectory = '',
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $root
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $root 'out\debug-service'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
$serviceSource = Join-Path $root 'out\native\service-win32-ia32\ZToolsService.exe'
$manifestTest = Join-Path $root 'out\native\build-win32\service-manifest-test-win32-ia32\ZToolsServiceManifestTest.exe'
$manifestSource = Join-Path $root 'resources\service\privileged-dlls-v1.xml'
$pluginSource = Join-Path $repositoryRoot 'bin\Data\Plugins\context-menu\lib'
$pluginFiles = @(
  @{ Name = 'ContextMenuPlugin.dll'; Machine = 0x014c },
  @{ Name = 'ContextMenuScanner.exe'; Machine = 0x8664 },
  @{ Name = 'ContextMenuScanner32.exe'; Machine = 0x014c }
)
$allowedFunctions = @(
  'CheckAdmin',
  'ScanMenuItems',
  'EnableMenuItem',
  'DisableMenuItem',
  'DeleteMenuItem',
  'AddCustomMenuItem',
  'InspectMenuItems',
  'RefreshExplorer'
)
$utf8NoBom = [Text.UTF8Encoding]::new($false)

function Require-File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description not found: $Path"
  }
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Require-PeMachine {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description,
    [Parameter(Mandatory = $true)][int]$Machine
  )
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 64) { throw "$Description is too small" }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or $peOffset + 6 -gt $stream.Length) {
      throw "$Description has an invalid PE header"
    }
    $stream.Position = $peOffset
    $actualMachine = if ($reader.ReadUInt32() -eq 0x00004550) {
      $reader.ReadUInt16()
    } else {
      -1
    }
    if ($actualMachine -ne $Machine) {
      throw ('{0} has unexpected PE machine 0x{1:x4}; expected 0x{2:x4}: {3}' -f `
        $Description, $actualMachine, $Machine, $Path)
    }
  } finally {
    $reader.Dispose()
  }
}

Require-File $serviceSource 'ZToolsService debug executable'
Require-File $manifestSource 'ZToolsService production privileged manifest'
Require-PeMachine $serviceSource 'ZToolsService debug executable' 0x014c
foreach ($file in $pluginFiles) {
  $source = Join-Path $pluginSource $file.Name
  Require-File $source "Context menu runtime file $($file.Name)"
  Require-PeMachine $source "Context menu runtime file $($file.Name)" $file.Machine
}
if (Test-Path -LiteralPath $output) {
  throw "Debug Service output already exists; archive it before regenerating: $output"
}

$dataRoot = Join-Path $output 'Data'
$serviceRoot = Join-Path $dataRoot 'Service'
$dllRoot = Join-Path $dataRoot 'Plugins\context-menu\lib'
New-Item -ItemType Directory -Path $serviceRoot | Out-Null
New-Item -ItemType Directory -Path $dllRoot | Out-Null
Copy-Item -LiteralPath $serviceSource -Destination (Join-Path $output 'ZToolsService.exe')
foreach ($file in $pluginFiles) {
  Copy-Item -LiteralPath (Join-Path $pluginSource $file.Name) -Destination (Join-Path $dllRoot $file.Name)
}

$secret = [byte[]]::new(32)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($secret)
} finally {
  $random.Dispose()
}
if (-not ($secret | Where-Object { $_ -ne 0 })) {
  throw 'Generated Service secret is invalid'
}
$secretPath = Join-Path $serviceRoot 'auth-v1.key'
[IO.File]::WriteAllBytes($secretPath, $secret)
[Array]::Clear($secret, 0, $secret.Length)

$dllPath = Join-Path $dllRoot 'ContextMenuPlugin.dll'
$dllDigest = Get-Sha256Hex $dllPath
$functionXml = $allowedFunctions |
  ForEach-Object { "      <function name=`"$_`"/>" }
$manifestLines = @(
  '<?xml version="1.0" encoding="utf-8"?>',
  '<privilegedDllManifest version="1">',
  '  <plugin id="context-menu">',
  "    <dll id=`"ContextMenuPlugin`" path=`"lib/ContextMenuPlugin.dll`" sha256=`"$dllDigest`" arch=`"x86`">"
) + $functionXml + @(
  '    </dll>',
  '  </plugin>',
  '</privilegedDllManifest>',
  ''
)
$manifestPath = Join-Path $serviceRoot 'privileged-dlls-v1.xml'
$expectedManifest = $manifestLines -join "`n"
if ([IO.File]::ReadAllText($manifestSource) -cne $expectedManifest) {
  throw 'Production privileged manifest does not match the current DLL or function allowlist'
}
Copy-Item -LiteralPath $manifestSource -Destination $manifestPath
$manifestDigest = Get-Sha256Hex $manifestPath
[IO.File]::WriteAllText(
  (Join-Path $output 'PrivilegedManifestSha256.txt'),
  "$manifestDigest`n",
  $utf8NoBom
)

$registryLines = @(
  'Windows Registry Editor Version 5.00',
  '',
  '[HKEY_LOCAL_MACHINE\SOFTWARE\ZTools\Service]',
  "`"PrivilegedManifestSha256`"=`"$manifestDigest`"",
  ''
)
[IO.File]::WriteAllText(
  (Join-Path $output 'PrivilegedManifestSha256.reg'),
  ($registryLines -join "`n"),
  $utf8NoBom
)

$metadata = [ordered]@{
  version = 1
  generatedAt = [DateTimeOffset]::UtcNow.ToString('O')
  serviceExecutable = 'ZToolsService.exe'
  dataRoot = 'Data'
  secret = [ordered]@{
    path = 'Data/Service/auth-v1.key'
    bytes = 32
    sha256 = Get-Sha256Hex $secretPath
  }
  privilegedManifest = [ordered]@{
    path = 'Data/Service/privileged-dlls-v1.xml'
    sha256 = $manifestDigest
    registry = 'HKLM64/SOFTWARE/ZTools/Service/PrivilegedManifestSha256'
  }
  dll = [ordered]@{
    pluginId = 'context-menu'
    dllId = 'ContextMenuPlugin'
    path = 'Data/Plugins/context-menu/lib/ContextMenuPlugin.dll'
    sha256 = $dllDigest
    functions = $allowedFunctions
  }
  runtimeTargets = [ordered]@{
    secret = '%APPDATA%/ZTools/Data/Service/auth-v1.key'
    manifest = '%APPDATA%/ZTools/Data/Service/privileged-dlls-v1.xml'
    plugin = '%APPDATA%/ZTools/Data/Plugins/context-menu/lib/ContextMenuPlugin.dll'
  }
}
[IO.File]::WriteAllText(
  (Join-Path $output 'debug-service.json'),
  (($metadata | ConvertTo-Json -Depth 8) + "`n"),
  $utf8NoBom
)

if ($Verify) {
  Require-File $manifestTest 'ZToolsService manifest test executable'
  $resolve = & $manifestTest '--resolve' $dataRoot $manifestDigest 'context-menu' 'ContextMenuPlugin' 'CheckAdmin'
  if ($LASTEXITCODE -ne 0) { throw "Manifest resolve verification failed: $resolve" }
  $resolveResult = $resolve | ConvertFrom-Json
  if (-not $resolveResult.success -or -not $resolveResult.handle -or -not $resolveResult.locked) {
    throw "Manifest resolve verification failed: $resolve"
  }
  $load = & $manifestTest '--load' $dataRoot $manifestDigest 'context-menu' 'ContextMenuPlugin' 'CheckAdmin'
  if ($LASTEXITCODE -ne 0) { throw "DLL load verification failed: $load" }
  $loadResult = $load | ConvertFrom-Json
  if (-not $loadResult.success -or -not $loadResult.module -or -not $loadResult.systemOnly) {
    throw "DLL load verification failed: $load"
  }
}

Write-Output ([ordered]@{
  success = $true
  output = $output
  manifestSha256 = $manifestDigest
  dllSha256 = $dllDigest
  verified = [bool]$Verify
} | ConvertTo-Json -Compress)
