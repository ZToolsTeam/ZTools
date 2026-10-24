function Resolve-ZToolsCMake {
  $command = Get-Command cmake -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return $command.Source
  }

  $programRoots = @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
    Where-Object { $_ } | Select-Object -Unique
  foreach ($programRoot in $programRoots) {
    $candidate = Join-Path $programRoot 'CMake\bin\cmake.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  $vswhereCommand = Get-Command vswhere -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $vswhere = if ($vswhereCommand) { $vswhereCommand.Source } else { $null }
  if (-not $vswhere) {
    foreach ($programRoot in $programRoots) {
      $candidate = Join-Path $programRoot 'Microsoft Visual Studio\Installer\vswhere.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $vswhere = $candidate
        break
      }
    }
  }
  if ($vswhere) {
    $candidates = & $vswhere -latest -products '*' -version '[17.0,18.0)' `
      -requires Microsoft.VisualStudio.Component.VC.CMake.Project `
      -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
    if ($LASTEXITCODE -ne 0) { throw "Visual Studio CMake discovery failed (exit $LASTEXITCODE)." }
    foreach ($candidate in $candidates) {
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
  }

  throw 'CMake not found. Install Visual Studio 2022 Build Tools with C++ CMake tools, MSVC x86/x64 and Windows SDK, or add cmake.exe to PATH.'
}
