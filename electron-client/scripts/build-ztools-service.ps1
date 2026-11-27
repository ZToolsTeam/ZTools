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
if ($SelfTest) {
  $build = Join-Path $OutputRoot 'build-win32-test'
  $nativeHostOutput = Join-Path $OutputRoot 'test-win32-ia32'
  $serviceOutput = Join-Path $OutputRoot 'test-win32-ia32'
  $testOutput = Join-Path $OutputRoot 'test-win32-ia32'
} else {
  $build = Join-Path $OutputRoot 'build-win32'
  $nativeHostOutput = Join-Path $OutputRoot 'win32-ia32'
  $serviceOutput = Join-Path $OutputRoot 'service-win32-ia32'
  $testOutput = Join-Path $OutputRoot 'test-win32-ia32'
}
. (Join-Path $PSScriptRoot 'resolve-cmake.ps1')
$cmake = Resolve-ZToolsCMake
$manifestTests = if ($SelfTest) { 'ON' } else { 'OFF' }
$signScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\sign-native-trust.mjs'))

New-Item -ItemType Directory -Path $build -Force | Out-Null
New-Item -ItemType Directory -Path $serviceOutput -Force | Out-Null

# 发布构建目录严格关闭两项测试开关；测试构建目录统一同时开启两项测试开关，避免两脚本交替覆写 CMakeCache
& $cmake -S $source -B $build -G 'Visual Studio 17 2022' -A Win32 `
  "-DZTOOLS_NATIVE_OUTPUT_DIR=$($nativeHostOutput.Replace('\', '/'))" `
  "-DZTOOLS_SERVICE_OUTPUT_DIR=$($serviceOutput.Replace('\', '/'))" `
  "-DZTOOLS_BUILD_NATIVE_TEST_FIXTURE=$manifestTests" `
  "-DZTOOLS_BUILD_SERVICE_MANIFEST_TESTS=$manifestTests" `
  "-DZTOOLS_NATIVE_TEST_OUTPUT_DIR=$($testOutput.Replace('\', '/'))"
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
  if (-not (Test-Path -LiteralPath $signScript -PathType Leaf)) {
    throw "Native trust signing script missing: $signScript"
  }
  $selfTestOutput = & $executable '--self-test'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $diagnostics = $selfTestOutput | ConvertFrom-Json
  $allowedDependenciesPolicies = @('system32+trusted-snapshot', 'system32-and-trusted-snapshot', 'trusted-snapshot')
  if ($diagnostics.service -ne 'ZToolsService' -or
      $diagnostics.productVersion -ne $productVersion -or
      $diagnostics.protocolVersion -ne 1 -or
      $diagnostics.transport -ne 'named-pipe' -or
      $diagnostics.acl -ne 'system+service+user' -or
      $diagnostics.auth -ne 'hmac-sha256' -or
      $diagnostics.replay -ne 'strict' -or
      $diagnostics.dllResolution -ne 'trusted-snapshot' -or
      ($allowedDependenciesPolicies -notcontains $diagnostics.dependencies) -or
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
  # 校验受保护快照目录 ACL 自检
  $aclSelfTestOutput = & $manifestTestExecutable '--acl-self-test'
  if ($LASTEXITCODE -ne 0) {
    throw "ZToolsService ACL self-test failed (exit ${LASTEXITCODE}): $aclSelfTestOutput"
  }
  $aclResult = $aclSelfTestOutput | ConvertFrom-Json
  if ($aclResult.ok -ne $true) {
    throw "Unexpected ZToolsService ACL self-test output: $aclSelfTestOutput"
  }
  Write-Output $aclSelfTestOutput
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
    throw 'Trusted snapshot dependency policy fixtures are missing'
  }

  function New-EphemeralTestKey {
    param(
      [string]$KeyDir,
      [string]$KeyId,
      [string]$Usage
    )
    New-Item -ItemType Directory -Path $KeyDir -Force | Out-Null
    $pemPath = Join-Path $KeyDir "$KeyId.private.pem"
    $pubJsonPath = Join-Path $KeyDir "$KeyId.public.json"
    $out = & node $signScript generate-keypair --key-id $KeyId --usage $Usage --out-private $pemPath --out-public-json $pubJsonPath
    if ($LASTEXITCODE -ne 0) { throw "Failed to generate ephemeral keypair ($KeyId): $out" }
    $pubList = Get-Content -LiteralPath $pubJsonPath -Raw | ConvertFrom-Json
    return @{
      KeyId = $KeyId
      PrivatePemPath = $pemPath
      PublicKeyHex = [string]$pubList[0].publicKeyHex
    }
  }

  function New-DllFixture {
    param([string]$Name, [string]$PluginId, [string]$DllId, [string]$Source)
    $dataRoot = Join-Path $fixtureRoot $Name
    $dllRoot = Join-Path $dataRoot "Plugins\$PluginId\lib"
    New-Item -ItemType Directory -Path $dllRoot -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination (Join-Path $dllRoot "$DllId.dll")
    return $dataRoot
  }

  function Sign-PluginFixture {
    param(
      [string]$DataRoot,
      [string]$PluginId,
      [string]$DllId,
      [string[]]$Functions,
      [string]$PluginVersion,
      [string]$PrivatePemPath,
      [string]$KeyId,
      [bool]$RequireAdmin = $true
    )
    $pluginDir = Join-Path $DataRoot "Plugins\$PluginId"
    $mainSpec = "lib/$DllId.dll:${DllId}:$($Functions -join ',')"
    $signArgs = @(
      $signScript, 'sign',
      '--dir', $pluginDir,
      '--plugin-id', $PluginId,
      '--plugin-version', $PluginVersion,
      '--main', $mainSpec,
      '--key-id', $KeyId,
      '--key', $PrivatePemPath
    )
    if ($RequireAdmin) { $signArgs += '--require-admin' }
    $out = & node @signArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to sign fixture ($PluginId): $out" }
  }

  function Invoke-DllProbe {
    param(
      [string]$Mode,
      [string]$DataRoot,
      [string]$PluginId,
      [string]$DllId,
      [string]$FunctionName,
      [string]$TestPrivPubKeyHex = '',
      [string]$SnapshotRoot = '',
      [string]$TrustStateFile = ''
    )
    $probeArgs = @($Mode, $DataRoot)
    if ($TestPrivPubKeyHex) { $probeArgs += $TestPrivPubKeyHex }
    $probeArgs += @($PluginId, $DllId, $FunctionName)
    if ($SnapshotRoot) { $probeArgs += @('--snapshot-root', $SnapshotRoot) }
    if ($TrustStateFile) { $probeArgs += @('--trust-state-file', $TrustStateFile) }
    $probeOutput = & $manifestTestExecutable @probeArgs
    if ($LASTEXITCODE -ne 0) { throw "DLL probe failed ($Mode, exit $LASTEXITCODE): $probeOutput" }
    return $probeOutput | ConvertFrom-Json
  }

  function Assert-DllRejected {
    param($Result, [string]$Code, [string]$CaseName)
    if ($Result.success -or $Result.code -ne $Code -or $Result.handle -or $Result.module -or $Result.locked) {
      throw "$CaseName must fail closed with ${Code}: $($Result | ConvertTo-Json -Compress)"
    }
  }

  New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
  try {
    $keysRoot = Join-Path $fixtureRoot '_keys'
    $privKey = New-EphemeralTestKey $keysRoot 'test-ephemeral-priv' 'native-privileged'
    $normalKey = New-EphemeralTestKey $keysRoot 'test-ephemeral' 'native'
    $snapshotRoot = Join-Path $fixtureRoot '_snapshots'
    $stateFile = Join-Path $fixtureRoot '_trust-state.json'
    New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null

    # 1. 基础正向与权限边界
    $validRoot = New-DllFixture 'trusted' 'batch-rename' 'BatchRenamePlugin' $fixtureDllSource
    Sign-PluginFixture -DataRoot $validRoot -PluginId 'batch-rename' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '2.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true

    # 未传入测试特权公钥时必须拒载
    foreach ($mode in @('--resolve', '--load')) {
      $untrusted = Invoke-DllProbe $mode $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' '' $snapshotRoot $stateFile
      Assert-DllRejected $untrusted 'MANIFEST_UNTRUSTED' "Missing trust ($mode)"
    }
    # 错误特权公钥必须拒载
    $badTrust = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' ('0' * 128) $snapshotRoot $stateFile
    Assert-DllRejected $badTrust 'MANIFEST_UNTRUSTED' 'Wrong privileged test public key'

    # 合法特权公钥验签 + 从受保护快照加载成功
    $valid = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $valid.success -or -not $valid.handle -or -not $valid.locked) { throw 'Trusted DLL resolution failed' }
    $loaded = Invoke-DllProbe '--load' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $loaded.success -or -not $loaded.module) { throw 'Trusted DLL load failed' }

    # 函数白名单保留验证（D2）
    $unlisted = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'notInManifest' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $unlisted 'FUNCTION_NOT_ALLOWED' 'Unlisted function'
    $unauthorized = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'MissingDll' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $unauthorized 'DLL_NOT_ALLOWED' 'Unlisted DLL'
    $invalid = Invoke-DllProbe '--resolve' $validRoot '../batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $invalid 'INVALID_REQUEST' 'Invalid plugin path'

    # 单调高水位防回滚（已加载 2.0.0 后降级 1.9.0 必须 MANIFEST_ROLLBACK）
    $rollbackRoot = New-DllFixture 'rollback' 'batch-rename' 'BatchRenamePlugin' $fixtureDllSource
    Sign-PluginFixture -DataRoot $rollbackRoot -PluginId 'batch-rename' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '1.9.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $rollback = Invoke-DllProbe '--resolve' $rollbackRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $rollback 'MANIFEST_ROLLBACK' 'Privileged downgrade below high-water mark'

    # requireAdmin: false 的合法签名送到 Service 必须拒绝（DLL_NOT_ALLOWED）
    $nonAdminRoot = New-DllFixture 'non-admin' 'non-admin-plugin' 'BatchRenamePlugin' $fixtureDllSource
    Sign-PluginFixture -DataRoot $nonAdminRoot -PluginId 'non-admin-plugin' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $false
    $nonAdminRes = Invoke-DllProbe '--resolve' $nonAdminRoot 'non-admin-plugin' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $nonAdminRes 'DLL_NOT_ALLOWED' 'requireAdmin=false rejected by Service'

    # 用普通 native 密钥签发的 requireAdmin=true 清单必须 MANIFEST_UNTRUSTED
    $wrongUsageRoot = New-DllFixture 'wrong-usage' 'wrong-usage-plugin' 'BatchRenamePlugin' $fixtureDllSource
    Sign-PluginFixture -DataRoot $wrongUsageRoot -PluginId 'wrong-usage-plugin' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '1.0.0' -PrivatePemPath $normalKey.PrivatePemPath `
      -KeyId $normalKey.KeyId -RequireAdmin $true
    $wrongUsageRes = Invoke-DllProbe '--resolve' $wrongUsageRoot 'wrong-usage-plugin' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $wrongUsageRes 'MANIFEST_UNTRUSTED' 'Normal key cannot authorize privileged plugin'

    # 旧版无签名特权插件走兼容分支：经受保护快照安全物化并锁定句柄
    $unsignedRoot = New-DllFixture 'unsigned' 'unsigned-priv' 'BatchRenamePlugin' $fixtureDllSource
    $unsignedRes = Invoke-DllProbe '--resolve' $unsignedRoot 'unsigned-priv' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $unsignedRes.success -or -not $unsignedRes.handle -or -not $unsignedRes.locked -or -not $unsignedRes.snapshotPath) {
      throw "Legacy unsigned privileged DLL must resolve via protected snapshot: $($unsignedRes | ConvertTo-Json -Compress)"
    }

    # 篡改 native-trust.json 字节 → MANIFEST_UNTRUSTED
    $manifestPath = Join-Path $validRoot 'Plugins\batch-rename\native-trust.json'
    [IO.File]::AppendAllText($manifestPath, "`n", [Text.UTF8Encoding]::new($false))
    $changedManifest = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $changedManifest 'MANIFEST_UNTRUSTED' 'Changed manifest bytes'

    # 仅存在 json 而删除 sig → MANIFEST_UNAVAILABLE
    $sigPath = Join-Path $validRoot 'Plugins\batch-rename\native-trust.sig'
    [IO.File]::Delete($sigPath)
    $missingSig = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $missingSig 'MANIFEST_UNAVAILABLE' 'Missing native-trust.sig'

    # 重新签名后篡改 DLL 字节 → DLL_INTEGRITY
    Sign-PluginFixture -DataRoot $validRoot -PluginId 'batch-rename' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '2.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $dllTarget = Join-Path $validRoot 'Plugins\batch-rename\lib\BatchRenamePlugin.dll'
    $dllStream = [IO.File]::Open($dllTarget, 'Append', 'Write', 'Read')
    try { $dllStream.WriteByte(0x5a) } finally { $dllStream.Dispose() }
    $updated = Invoke-DllProbe '--resolve' $validRoot 'batch-rename' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $updated 'DLL_INTEGRITY' 'Changed DLL bytes'

    # 缺失已签名 DLL → DLL_PATH_INVALID 或 DLL_UNAVAILABLE
    $missingRoot = New-DllFixture 'missing' 'missing-plugin' 'BatchRenamePlugin' $fixtureDllSource
    Sign-PluginFixture -DataRoot $missingRoot -PluginId 'missing-plugin' -DllId 'BatchRenamePlugin' `
      -Functions @('getFileList') -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    [IO.File]::Delete((Join-Path $missingRoot 'Plugins\missing-plugin\lib\BatchRenamePlugin.dll'))
    $missing = Invoke-DllProbe '--resolve' $missingRoot 'missing-plugin' 'BatchRenamePlugin' 'getFileList' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if ($missing.success -or ($missing.code -ne 'DLL_PATH_INVALID' -and $missing.code -ne 'DLL_UNAVAILABLE')) {
      throw "Missing listed DLL must fail closed: $($missing | ConvertTo-Json -Compress)"
    }

    # 命令与会话自检
    $contextRoot = New-DllFixture 'context-menu' 'context-menu' 'ContextMenuPlugin' $contextMenuDllSource
    Sign-PluginFixture -DataRoot $contextRoot -PluginId 'context-menu' -DllId 'ContextMenuPlugin' `
      -Functions @('CheckAdmin', 'deleteEverything') -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $commands = Invoke-DllProbe '--command-self-test' $contextRoot 'context-menu' 'ContextMenuPlugin' 'CheckAdmin' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $commands.success -or $commands.cases -ne 14) { throw 'Service command regression failed' }

    $sessionSource = Join-Path $build 'service-manifest-test-win32-ia32\ZToolsServiceSessionFixture.dll'
    $sessionRoot = New-DllFixture 'session' 'session-plugin' 'ZToolsServiceSessionFixture' $sessionSource
    $otherRoot = Join-Path $sessionRoot 'Plugins\other-plugin\lib'
    New-Item -ItemType Directory -Path $otherRoot -Force | Out-Null
    Copy-Item -LiteralPath $sessionSource -Destination $otherRoot
    $sessionFunctions = @('GetSearchResults', 'SearchAsync', 'StartMonitoring', 'GetTrafficStats')
    Sign-PluginFixture -DataRoot $sessionRoot -PluginId 'session-plugin' -DllId 'ZToolsServiceSessionFixture' `
      -Functions $sessionFunctions -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    Sign-PluginFixture -DataRoot $sessionRoot -PluginId 'other-plugin' -DllId 'ZToolsServiceSessionFixture' `
      -Functions $sessionFunctions -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $sessions = Invoke-DllProbe '--session-self-test' $sessionRoot 'session-plugin' 'ZToolsServiceSessionFixture' 'GetSearchResults' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $sessions.success -or $sessions.cases -ne 8) { throw 'DLL session lifecycle regression' }

    # 依赖策略测试 1：缺少伴生依赖 DLL 时加载必须失败（DLL_LOAD_FAILED）
    $unsignedDepRoot = New-DllFixture 'private-unsigned-dep' 'private-unsigned-fixture' 'ZToolsServicePrivateConsumer' $privateConsumerSource
    Sign-PluginFixture -DataRoot $unsignedDepRoot -PluginId 'private-unsigned-fixture' -DllId 'ZToolsServicePrivateConsumer' `
      -Functions @('PrivateConsumerProbe') -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $missingDep = Invoke-DllProbe '--load' $unsignedDepRoot 'private-unsigned-fixture' 'ZToolsServicePrivateConsumer' 'PrivateConsumerProbe' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $missingDep 'DLL_LOAD_FAILED' 'Missing private dependency must fail to load'
    # 依赖策略测试 2：签名后再塞入未声明的伴生依赖 DLL，受保护快照不复制该文件，从用户目录拒载（DLL_LOAD_FAILED）
    Copy-Item -LiteralPath $privateDependencySource -Destination (Join-Path $unsignedDepRoot 'Plugins\private-unsigned-fixture\lib')
    $unsignedDep = Invoke-DllProbe '--load' $unsignedDepRoot 'private-unsigned-fixture' 'ZToolsServicePrivateConsumer' 'PrivateConsumerProbe' $privKey.PublicKeyHex $snapshotRoot $stateFile
    Assert-DllRejected $unsignedDep 'DLL_LOAD_FAILED' 'Unsigned private dependency must not load from user directory'

    # 已签名伴生依赖随受保护快照复制后可以正常加载
    $signedDepRoot = New-DllFixture 'private-signed-dep' 'private-signed-fixture' 'ZToolsServicePrivateConsumer' $privateConsumerSource
    Copy-Item -LiteralPath $privateDependencySource -Destination (Join-Path $signedDepRoot 'Plugins\private-signed-fixture\lib')
    Sign-PluginFixture -DataRoot $signedDepRoot -PluginId 'private-signed-fixture' -DllId 'ZToolsServicePrivateConsumer' `
      -Functions @('PrivateConsumerProbe') -PluginVersion '1.0.0' -PrivatePemPath $privKey.PrivatePemPath `
      -KeyId $privKey.KeyId -RequireAdmin $true
    $signedDep = Invoke-DllProbe '--load' $signedDepRoot 'private-signed-fixture' 'ZToolsServicePrivateConsumer' 'PrivateConsumerProbe' $privKey.PublicKeyHex $snapshotRoot $stateFile
    if (-not $signedDep.success -or -not $signedDep.module) {
      throw "Signed dependency in trusted snapshot should load: $($signedDep | ConvertTo-Json -Compress)"
    }
    Write-Output 'Trusted DLL native-trust signature, snapshot, command and session regression passed'
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
