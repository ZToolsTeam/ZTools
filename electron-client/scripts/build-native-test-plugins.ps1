param(
  [string]$MSBuildPath = 'D:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\amd64\MSBuild.exe',
  [string]$CMakePath = 'D:\Program Files\CMake\bin\cmake.exe',
  [string]$QtMsBuildPath = (Join-Path $env:LOCALAPPDATA 'QtMsBuild')
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $root
$pluginsRoot = Join-Path $workspace 'DLLPlugins'
$batchRenameRoot = Join-Path $pluginsRoot 'batch-rename'
$clipboardManagerRoot = Join-Path $pluginsRoot 'clipboard-manager'
$clipboardManagerBuild = Join-Path $root 'out\native\plugin-tests\clipboard-manager-build-win32'
$screenCaptureRoot = Join-Path $pluginsRoot 'screenshot'
$batchRenameSolution = Join-Path $batchRenameRoot 'BatchRenamePlugin.sln'
$screenCaptureSolution = Join-Path $screenCaptureRoot 'ScreenCapturePlugin.sln'
$abiTestSource = Join-Path $batchRenameRoot 'PluginTest'
$abiTestBuild = Join-Path $abiTestSource 'build'

foreach ($requiredFile in @(
  $MSBuildPath,
  $CMakePath,
  $batchRenameSolution,
  $screenCaptureSolution,
  (Join-Path $clipboardManagerRoot 'CMakeLists.txt')
)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required build input not found: $requiredFile"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $QtMsBuildPath 'qt.targets') -PathType Leaf)) {
  throw "QtMsBuild not found: $QtMsBuildPath"
}

function Invoke-PluginBuild {
  param(
    [string]$Solution,
    [string]$SolutionDirectory,
    [string[]]$ExtraProperties = @()
  )

  $arguments = @(
    $Solution,
    '/m',
    '/t:Build',
    '/p:Configuration=Release',
    '/p:Platform=x86',
    "/p:SolutionDir=$SolutionDirectory",
    '/p:PostBuildEventUseInBuild=false'
  ) + $ExtraProperties
  & $MSBuildPath @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Invoke-PluginBuild `
  -Solution $batchRenameSolution `
  -SolutionDirectory "$batchRenameRoot\"
Invoke-PluginBuild `
  -Solution $screenCaptureSolution `
  -SolutionDirectory "$screenCaptureRoot\" `
  -ExtraProperties @("/p:QtMsBuild=$QtMsBuildPath")

& $CMakePath `
  -S $clipboardManagerRoot `
  -B $clipboardManagerBuild `
  -G 'Visual Studio 17 2022' `
  -A Win32
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$clipboardManagerSolutionDirectory = "$clipboardManagerBuild\"
& $CMakePath `
  --build $clipboardManagerBuild `
  --config Release `
  --target ClipboardManagerPlugin `
  -- `
  "/p:SolutionDir=$clipboardManagerSolutionDirectory" `
  '/p:PostBuildEventUseInBuild=false'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $CMakePath -S $abiTestSource -B $abiTestBuild -G 'Visual Studio 17 2022' -A Win32
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$abiTestSolutionDirectory = "$abiTestBuild\"
& $CMakePath --build $abiTestBuild --config Release --target BatchRenamePluginTest -- "/p:SolutionDir=$abiTestSolutionDirectory"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outputs = @(
  (Join-Path $batchRenameRoot 'Release\BatchRenamePlugin.dll'),
  (Join-Path $clipboardManagerBuild 'Release\ClipboardManagerPlugin.dll'),
  (Join-Path $screenCaptureRoot 'Release\ScreenCapturePlugin.dll'),
  (Join-Path $screenCaptureRoot 'Release\ScreenCapturePlugin.exe'),
  (Join-Path $abiTestBuild 'bin\Release\BatchRenamePluginTest.exe')
)
foreach ($output in $outputs) {
  if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Production DLL test output missing: $output"
  }
  Write-Output $output
}
