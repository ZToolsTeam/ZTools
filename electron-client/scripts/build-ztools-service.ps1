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
$cmake = 'D:\Program Files\CMake\bin\cmake.exe'
$manifestTests = if ($SelfTest) { 'ON' } else { 'OFF' }

if (-not (Test-Path -LiteralPath $cmake -PathType Leaf)) {
  throw "CMake not found: $cmake"
}

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
  & $cmake --build $build --config $Configuration --target ZToolsServiceManifestTest -- "/p:SolutionDir=$solutionDirectory"
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

  $manifestTestExecutable = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceManifestTest.exe'
  if (-not (Test-Path -LiteralPath $manifestTestExecutable -PathType Leaf)) {
    throw "ZToolsService manifest test output missing: $manifestTestExecutable"
  }
  $fixtureId = 'service-manifest-{0}-{1}' -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $fixtureRoot = Join-Path $root "out-test\$fixtureId"
  $fixtureDllSource = Join-Path $root '..\plugins\create-plugin\src\plugins\batch-rename\lib\BatchRenamePlugin.dll'
  if (-not (Test-Path -LiteralPath $fixtureDllSource -PathType Leaf)) {
    throw "Privileged manifest test DLL missing: $fixtureDllSource"
  }
  $contextMenuDllSource = Join-Path $root '..\plugins\create-plugin\src\plugins\context-menu\lib\ContextMenuPlugin.dll'
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
    param([string]$Mode, [string]$DataRoot, [string]$PluginId, [string]$DllId, [string]$FunctionName)
    $probeOutput = & $manifestTestExecutable $Mode $DataRoot $PluginId $DllId $FunctionName
    if ($LASTEXITCODE -ne 0) { throw "DLL probe failed ($Mode, exit $LASTEXITCODE): $probeOutput" }
    return $probeOutput | ConvertFrom-Json
  }
  $validRoot = New-DllFixture 'legacy' 'batch-rename' 'BatchRenamePlugin' $fixtureDllSource
  $valid = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList'
  if (-not $valid.success -or -not $valid.handle -or -not $valid.locked) { throw 'Legacy DLL resolution failed' }
  $loaded = Invoke-DllProbe '--load' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList'
  if (-not $loaded.success -or -not $loaded.module -or -not $loaded.systemOnly) { throw 'Legacy DLL load failed' }
  $unlisted = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'notInMetadata'
  if (-not $unlisted.success) { throw 'Function list still restricts resolution' }
  # Obsolete trust documents must have no effect on installed plugins.
  $serviceRoot = Join-Path $validRoot 'Service'
  New-Item -ItemType Directory -Path $serviceRoot -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $serviceRoot 'privileged-dlls-v1.xml'), 'obsolete invalid XML')
  $dllTarget = Join-Path $validRoot 'Plugins\batch-rename\lib\BatchRenamePlugin.dll'
  $stream = [IO.File]::Open($dllTarget, 'Append', 'Write', 'Read')
  try { $stream.WriteByte(0x5a) } finally { $stream.Dispose() }
  $updated = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList'
  if (-not $updated.success) { throw 'Updated legacy DLL was rejected' }
  $missing = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'MissingDll' 'getFileList'
  $invalid = Invoke-DllProbe '--resolve' $validRoot '../batch-rename' 'BatchRenamePlugin' 'getFileList'
  if ($missing.success -or $missing.code -ne 'DLL_UNAVAILABLE' -or $invalid.success -or $invalid.code -ne 'INVALID_REQUEST') { throw 'DLL path validation failed' }
  $wrongRoot = New-DllFixture 'wrong-image' 'batch-rename' 'BatchRenamePlugin' $executable
  $wrong = Invoke-DllProbe '--resolve' $wrongRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList'
  if ($wrong.success -or $wrong.code -ne 'DLL_ARCH_INVALID') { throw 'Invalid DLL image accepted' }
  $contextRoot = New-DllFixture 'context-menu' 'context-menu' 'ContextMenuPlugin' $contextMenuDllSource
  $commands = Invoke-DllProbe '--command-self-test' $contextRoot 'context-menu' 'ContextMenuPlugin' 'CheckAdmin'
  if (-not $commands.success -or $commands.cases -ne 13) { throw 'Service command regression failed' }
  $sessionSource = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceSessionFixture.dll'
  $sessionRoot = New-DllFixture 'session' 'session-plugin' 'ZToolsServiceSessionFixture' $sessionSource
  $otherRoot = Join-Path $sessionRoot 'Plugins\other-plugin\lib'
  New-Item -ItemType Directory -Path $otherRoot -Force | Out-Null
  Copy-Item -LiteralPath $sessionSource -Destination $otherRoot
  $sessions = Invoke-DllProbe '--session-self-test' $sessionRoot 'session-plugin' 'ZToolsServiceSessionFixture' 'GetSearchResults'
  if (-not $sessions.success -or $sessions.cases -ne 8) { throw 'DLL session lifecycle regression' }
  $privateRoot = New-DllFixture 'private' 'private-fixture' 'ZToolsServicePrivateConsumer' $privateConsumerSource
  Copy-Item -LiteralPath $privateDependencySource -Destination (Join-Path $privateRoot 'Plugins\private-fixture\lib')
  $private = Invoke-DllProbe '--load' $privateRoot 'private-fixture' 'ZToolsServicePrivateConsumer' 'PrivateConsumerProbe'
  if ($private.success -or $private.code -ne 'DLL_LOAD_FAILED' -or -not $private.systemOnly) { throw 'Dependency policy regression' }
  Write-Output 'DLL directory resolution and command regression passed'

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
