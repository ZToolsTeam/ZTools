param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [switch]$BuildTestFixture
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native'
$build = Join-Path $root 'out\native\build-win32'
$output = Join-Path $root 'out\native\win32-ia32'
$serviceOutput = Join-Path $root 'out\native\service-win32-ia32'
$testOutput = Join-Path $root 'out\native\test-win32-ia32'
$cmake = 'D:\Program Files\CMake\bin\cmake.exe'

if (-not (Test-Path -LiteralPath $cmake -PathType Leaf)) {
  throw "CMake not found: $cmake"
}

New-Item -ItemType Directory -Path $build -Force | Out-Null
New-Item -ItemType Directory -Path $output -Force | Out-Null
if ($BuildTestFixture) {
  New-Item -ItemType Directory -Path $testOutput -Force | Out-Null
}

$buildTests = if ($BuildTestFixture) { 'ON' } else { 'OFF' }
& $cmake -S $source -B $build -G 'Visual Studio 17 2022' -A Win32 `
  "-DZTOOLS_NATIVE_OUTPUT_DIR=$($output.Replace('\', '/'))" `
  "-DZTOOLS_SERVICE_OUTPUT_DIR=$($serviceOutput.Replace('\', '/'))" `
  "-DZTOOLS_BUILD_NATIVE_TEST_FIXTURE=$buildTests" `
  "-DZTOOLS_NATIVE_TEST_OUTPUT_DIR=$($testOutput.Replace('\', '/'))"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$solutionDirectory = "$build\"
& $cmake --build $build --config $Configuration --target ZToolsNativeHost32 -- "/p:SolutionDir=$solutionDirectory"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($BuildTestFixture) {
  & $cmake --build $build --config $Configuration --target ZToolsNativeTestPlugin -- "/p:SolutionDir=$solutionDirectory"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $cmake --build $build --config $Configuration --target ZToolsNativeAbiRejectionFixture -- "/p:SolutionDir=$solutionDirectory"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $cmake --build $build --config $Configuration --target ZToolsDllCancelTest -- "/p:SolutionDir=$solutionDirectory"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $testOutput 'ZToolsDllCancelTest.exe')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$executable = Join-Path $output 'ZToolsNativeHost32.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "NativeHost32 output missing: $executable"
}

Write-Output $executable

if ($BuildTestFixture) {
  $fixture = Join-Path $testOutput 'ZToolsNativeTestPlugin.dll'
  if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) {
    throw "NativeHost32 test fixture missing: $fixture"
  }
  Write-Output $fixture

  $abiRejectionFixture = Join-Path $testOutput 'ZToolsNativeAbiRejectionFixture.dll'
  if (-not (Test-Path -LiteralPath $abiRejectionFixture -PathType Leaf)) {
    throw "NativeHost32 ABI rejection fixture missing: $abiRejectionFixture"
  }
  Write-Output $abiRejectionFixture
}
