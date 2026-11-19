param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [switch]$SelfTest,
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$productVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$source = Join-Path $root 'native'
if (-not $OutputRoot) { $OutputRoot = Join-Path $root 'out\native' }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$build = Join-Path $OutputRoot 'build-win32'
$nativeHostOutput = Join-Path $OutputRoot 'win32-ia32'
$serviceOutput = Join-Path $OutputRoot 'service-win32-ia32'
. (Join-Path $PSScriptRoot 'resolve-cmake.ps1')
$cmake = Resolve-ZToolsCMake
$manifestTests = if ($SelfTest) { 'ON' } else { 'OFF' }

New-Item -ItemType Directory -Path $build -Force | Out-Null
New-Item -ItemType Directory -Path $serviceOutput -Force | Out-Null

& $cmake -S $source -B $build -G 'Visual Studio 17 2022' -A Win32 `
  "-DZTOOLS_NATIVE_OUTPUT_DIR=$($nativeHostOutput.Replace('\', '/'))" `
  "-DZTOOLS_SERVICE_OUTPUT_DIR=$($serviceOutput.Replace('\', '/'))" `
  '-DZTOOLS_BUILD_NATIVE_TEST_FIXTURE=OFF' `
  "-DZTOOLS_BUILD_SERVICE_MANIFEST_TESTS=$manifestTests"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$solutionDirectory = "$build\"
if ($SelfTest) {
  & $cmake --build $build --config $Configuration --target ZToolsServiceManifestTest ZToolsServiceBridgeTest -- "/p:SolutionDir=$solutionDirectory"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $cmake --build $build --config $Configuration --target ZToolsService -- "/p:SolutionDir=$solutionDirectory"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$executable = Join-Path $serviceOutput 'ZToolsService.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "ZToolsService output missing: $executable"
}

$stream = [IO.File]::Open($executable, 'Open', 'Read', 'ReadWrite')
$reader = $null
try {
  $reader = [IO.BinaryReader]::new($stream)
  if ($stream.Length -lt 64) {
    throw 'ZToolsService output is too small to be a PE file'
  }
  $stream.Position = 0x3c
  $peOffset = $reader.ReadInt32()
  if ($peOffset -lt 64 -or $peOffset + 6 -gt $stream.Length) {
    throw "ZToolsService has an invalid PE header offset: $peOffset"
  }
  $stream.Position = $peOffset
  if ($reader.ReadUInt32() -ne 0x00004550) {
    throw 'ZToolsService has an invalid PE signature'
  }
  $machine = $reader.ReadUInt16()
  if ($machine -ne 0x014c) {
    throw ('ZToolsService must be x86 (PE machine 0x014c), found 0x{0:x4}' -f $machine)
  }
} finally {
  if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
}

Write-Output $executable
$versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
if ($versionInfo.ProductVersion -ne $productVersion -or $versionInfo.FileVersion -ne $productVersion) {
  throw "ZToolsService file/product version must match main application: $productVersion"
}

if ($SelfTest) {
  $selfTestOutput = & $executable '--self-test'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $diagnostics = $selfTestOutput | ConvertFrom-Json
  if ($diagnostics.service -ne 'ZToolsService' -or
      $diagnostics.productVersion -ne $productVersion -or
      $diagnostics.protocolVersion -ne 1 -or
      $diagnostics.transport -ne 'named-pipe' -or
      $diagnostics.acl -ne 'system+service+user' -or
      $diagnostics.auth -ne 'hmac-sha256' -or
      $diagnostics.replay -ne 'strict' -or
      $diagnostics.dllResolution -ne 'plugin-directory' -or
      $diagnostics.dependencies -ne 'system32-only' -or
      $diagnostics.commandPolicy -ne 'single-owner' -or
      $diagnostics.clientPid -le 0 -or
      $diagnostics.clientSessionId -le 0 -or
      $diagnostics.state -ne 'stopped') {
    throw "Unexpected ZToolsService self-test output: $selfTestOutput"
  }
  Write-Output $selfTestOutput

  $bridgeTestExecutable = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceBridgeTest.exe'
  if (-not (Test-Path -LiteralPath $bridgeTestExecutable -PathType Leaf)) {
    throw "ZToolsService bridge test output missing: $bridgeTestExecutable"
  }
  $bridgeTestOutput = & $bridgeTestExecutable
  if ($LASTEXITCODE -ne 0) { throw "ZToolsService bridge regression failed (exit ${LASTEXITCODE}): $bridgeTestOutput" }
  $bridgeDiagnostics = $bridgeTestOutput | ConvertFrom-Json
  if ($bridgeDiagnostics.test -ne 'client-bridge' -or $bridgeDiagnostics.state -ne 'passed' -or
      ($bridgeDiagnostics.cases -isnot [int] -and $bridgeDiagnostics.cases -isnot [long]) -or
      $bridgeDiagnostics.cases -lt 20) {
    throw "Unexpected ZToolsService bridge test output: $bridgeTestOutput"
  }
  Write-Output $bridgeTestOutput

  $manifestTestExecutable = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceManifestTest.exe'
  if (-not (Test-Path -LiteralPath $manifestTestExecutable -PathType Leaf)) {
    throw "ZToolsService manifest test output missing: $manifestTestExecutable"
  }
  $fixtureId = 'ztools-service-manifest-{0}' -f [Guid]::NewGuid().ToString('N')
  $fixtureTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $fixtureRoot = Join-Path $fixtureTempRoot $fixtureId
  $fixtureDllSource = Join-Path $root '..\DLLPlugins\outputs\batch-rename\lib\BatchRenamePlugin.dll'
  if (-not (Test-Path -LiteralPath $fixtureDllSource -PathType Leaf)) {
    throw "Privileged manifest test DLL missing: $fixtureDllSource"
  }
  $contextMenuDllSource = Join-Path $root '..\DLLPlugins\outputs\context-menu\lib\ContextMenuPlugin.dll'
  if (-not (Test-Path -LiteralPath $contextMenuDllSource -PathType Leaf)) {
    throw "Context menu Service test DLL missing: $contextMenuDllSource"
  }
  $privateConsumerSource = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServicePrivateConsumer.dll'
  $privateDependencySource = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServicePrivateDependency.dll'
  if (-not (Test-Path -LiteralPath $privateConsumerSource -PathType Leaf) -or
      -not (Test-Path -LiteralPath $privateDependencySource -PathType Leaf)) {
    throw 'System32-only dependency policy fixtures are missing'
  }
  function New-DllFixture {
    param([string]$Name, [string]$PluginId, [string]$DllId, [string]$Source)
    $dataRoot = Join-Path $fixtureRoot $Name
    $dllRoot = Join-Path $dataRoot "Plugins\$PluginId\lib"
    New-Item -ItemType Directory -Path $dllRoot -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination (Join-Path $dllRoot "$DllId.dll")
    return $dataRoot
  }
  function Invoke-DllProbe {
    param([string]$Mode, [string]$DataRoot, [string]$PluginId, [string]$DllId, [string]$FunctionName, [string]$ManifestSha256 = '')
    $probeArgs = @($Mode, $DataRoot)
    if ($ManifestSha256) { $probeArgs += $ManifestSha256 }
    $probeArgs += @($PluginId, $DllId, $FunctionName)
    $probeOutput = & $manifestTestExecutable @probeArgs
    if ($LASTEXITCODE -ne 0) { throw "DLL probe failed ($Mode, exit $LASTEXITCODE): $probeOutput" }
    return $probeOutput | ConvertFrom-Json
  }
  function Get-Sha256Hex {
    param([string]$Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    $stream = $null
    try {
      $stream = [IO.File]::OpenRead($Path)
      return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
      $hash.Dispose()
    }
  }
  function Write-DllManifest {
    param([string]$DataRoot, [object[]]$Entries)
    $plugins = foreach ($entry in $Entries) {
      $pluginId = [Security.SecurityElement]::Escape($entry.PluginId)
      $dllId = [Security.SecurityElement]::Escape($entry.DllId)
      $dllPath = Join-Path $DataRoot "Plugins\$($entry.PluginId)\lib\$($entry.DllId).dll"
      $digest = Get-Sha256Hex $dllPath
      $functions = foreach ($functionName in $entry.Functions) {
        '      <function name="{0}"/>' -f [Security.SecurityElement]::Escape($functionName)
      }
      @"
  <plugin id="$pluginId">
    <dll id="$dllId" path="lib/$dllId.dll" sha256="$digest" arch="x86">
$($functions -join "`n")
    </dll>
  </plugin>
"@
    }
    $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<privilegedDllManifest version="1">
$($plugins -join "`n")
</privilegedDllManifest>
"@
    $serviceRoot = Join-Path $DataRoot 'Service'
    New-Item -ItemType Directory -Path $serviceRoot -Force | Out-Null
    $manifestPath = Join-Path $serviceRoot 'privileged-dlls-v1.xml'
    [IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
    return Get-Sha256Hex $manifestPath
  }
  function Assert-DllRejected {
    param($Result, [string]$Code, [string]$CaseName)
    if ($Result.success -or $Result.code -ne $Code -or $Result.handle -or $Result.module -or $Result.locked) {
      throw "$CaseName must fail closed with ${Code}: $($Result | ConvertTo-Json -Compress)"
    }
  }
  New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
  try {
    $batchEntries = @(@{ PluginId = 'batch-rename'; DllId = 'BatchRenamePlugin'; Functions = @('getFileList') })
    $validRoot = New-DllFixture 'trusted' 'batch-rename' 'BatchRenamePlugin' $fixtureDllSource
    $validDigest = Write-DllManifest $validRoot $batchEntries
    foreach ($mode in @('--resolve', '--load')) {
      $untrusted = Invoke-DllProbe $mode $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList'
      Assert-DllRejected $untrusted 'MANIFEST_UNTRUSTED' "Missing trust ($mode)"
    }
    $badTrust = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' ('0' * 64)
    Assert-DllRejected $badTrust 'MANIFEST_INTEGRITY' 'Wrong trusted manifest digest'
    $valid = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $validDigest
    if (-not $valid.success -or -not $valid.handle -or -not $valid.locked) { throw 'Trusted DLL resolution failed' }
    $loaded = Invoke-DllProbe '--load' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $validDigest
    if (-not $loaded.success -or -not $loaded.module -or -not $loaded.systemOnly) { throw 'Trusted DLL load failed' }
    $unlisted = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'notInManifest' $validDigest
    Assert-DllRejected $unlisted 'FUNCTION_NOT_ALLOWED' 'Unlisted function'
    $unauthorized = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'MissingDll' 'getFileList' $validDigest
    Assert-DllRejected $unauthorized 'DLL_NOT_ALLOWED' 'Unlisted DLL'
    $invalid = Invoke-DllProbe '--resolve' $validRoot '../batch-rename' 'BatchRenamePlugin' 'getFileList' $validDigest
    Assert-DllRejected $invalid 'INVALID_REQUEST' 'Invalid plugin path'

    $manifestPath = Join-Path $validRoot 'Service\privileged-dlls-v1.xml'
    [IO.File]::AppendAllText($manifestPath, "`n", [Text.UTF8Encoding]::new($false))
    $changedManifest = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $validDigest
    Assert-DllRejected $changedManifest 'MANIFEST_INTEGRITY' 'Changed manifest bytes'
    [IO.File]::WriteAllText($manifestPath, 'invalid XML', [Text.UTF8Encoding]::new($false))
    $invalidDigest = Get-Sha256Hex $manifestPath
    $invalidManifest = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $invalidDigest
    Assert-DllRejected $invalidManifest 'MANIFEST_INVALID' 'Malformed trusted manifest'
    $validDigest = Write-DllManifest $validRoot $batchEntries
    $dllTarget = Join-Path $validRoot 'Plugins\batch-rename\lib\BatchRenamePlugin.dll'
    $stream = [IO.File]::Open($dllTarget, 'Append', 'Write', 'Read')
    try { $stream.WriteByte(0x5a) } finally { $stream.Dispose() }
    $updated = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $validDigest
    Assert-DllRejected $updated 'DLL_INTEGRITY' 'Changed DLL bytes'

    $missingRoot = New-DllFixture 'missing' 'batch-rename' 'BatchRenamePlugin' $fixtureDllSource
    $missingDigest = Write-DllManifest $missingRoot $batchEntries
    [IO.File]::Delete((Join-Path $missingRoot 'Plugins\batch-rename\lib\BatchRenamePlugin.dll'))
    $missing = Invoke-DllProbe '--resolve' $missingRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $missingDigest
    Assert-DllRejected $missing 'DLL_PATH_INVALID' 'Missing listed DLL'
    $wrongRoot = New-DllFixture 'wrong-image' 'batch-rename' 'BatchRenamePlugin' $executable
    $wrongDigest = Write-DllManifest $wrongRoot $batchEntries
    $wrong = Invoke-DllProbe '--resolve' $wrongRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $wrongDigest
    Assert-DllRejected $wrong 'DLL_ARCH_INVALID' 'Invalid DLL image'

    $contextRoot = New-DllFixture 'context-menu' 'context-menu' 'ContextMenuPlugin' $contextMenuDllSource
    $contextDigest = Write-DllManifest $contextRoot @(
      @{ PluginId = 'context-menu'; DllId = 'ContextMenuPlugin'; Functions = @('CheckAdmin', 'deleteEverything') }
    )
    $commands = Invoke-DllProbe '--command-self-test' $contextRoot 'context-menu' 'ContextMenuPlugin' 'CheckAdmin' $contextDigest
    if (-not $commands.success -or $commands.cases -ne 14) { throw 'Service command regression failed' }
    $sessionSource = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceSessionFixture.dll'
    $sessionRoot = New-DllFixture 'session' 'session-plugin' 'ZToolsServiceSessionFixture' $sessionSource
    $otherRoot = Join-Path $sessionRoot 'Plugins\other-plugin\lib'
    New-Item -ItemType Directory -Path $otherRoot -Force | Out-Null
    Copy-Item -LiteralPath $sessionSource -Destination $otherRoot
    $sessionFunctions = @('GetSearchResults', 'SearchAsync', 'StartMonitoring', 'GetTrafficStats')
    $sessionDigest = Write-DllManifest $sessionRoot @(
      @{ PluginId = 'session-plugin'; DllId = 'ZToolsServiceSessionFixture'; Functions = $sessionFunctions },
      @{ PluginId = 'other-plugin'; DllId = 'ZToolsServiceSessionFixture'; Functions = $sessionFunctions }
    )
    $sessions = Invoke-DllProbe '--session-self-test' $sessionRoot 'session-plugin' 'ZToolsServiceSessionFixture' 'GetSearchResults' $sessionDigest
    if (-not $sessions.success -or $sessions.cases -ne 8) { throw 'DLL session lifecycle regression' }
    $privateRoot = New-DllFixture 'private' 'private-fixture' 'ZToolsServicePrivateConsumer' $privateConsumerSource
    Copy-Item -LiteralPath $privateDependencySource -Destination (Join-Path $privateRoot 'Plugins\private-fixture\lib')
    $privateDigest = Write-DllManifest $privateRoot @(
      @{ PluginId = 'private-fixture'; DllId = 'ZToolsServicePrivateConsumer'; Functions = @('PrivateConsumerProbe') }
    )
    $private = Invoke-DllProbe '--load' $privateRoot 'private-fixture' 'ZToolsServicePrivateConsumer' 'PrivateConsumerProbe' $privateDigest
    Assert-DllRejected $private 'DLL_LOAD_FAILED' 'Private dependency'
    if (-not $private.systemOnly) { throw 'System32-only dependency policy is unavailable' }
    Write-Output 'Trusted DLL manifest, command and session regression passed'
  } finally {
    $resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
    if ([IO.Path]::GetDirectoryName($resolvedFixtureRoot) -ne $fixtureTempRoot.TrimEnd('\', '/') -or
        [IO.Path]::GetFileName($resolvedFixtureRoot) -ne $fixtureId) {
      throw 'Refusing to clean a fixture outside its owned temporary directory'
    }
    if (Test-Path -LiteralPath $resolvedFixtureRoot -PathType Container) {
      Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
    }
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executable
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  try {
    $serviceModeOutput = $process.StandardOutput.ReadToEnd()
    $serviceModeError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $serviceModeExitCode = $process.ExitCode
  } finally {
    $process.Dispose()
  }
  if ($serviceModeExitCode -ne 3 -or $serviceModeError -notmatch '1063') {
    throw "ZToolsService must fail closed outside SCM: $serviceModeOutput $serviceModeError"
  }
}
