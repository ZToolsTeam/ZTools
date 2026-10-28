import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const nativeDir = path.join(rootDir, 'native')
const outputBinDir = path.join(rootDir, 'out', 'native', 'win32-x64', 'bin')
const outputBuildDir = path.join(rootDir, 'out', 'native', 'win32-x64', 'build-sidecars')

function assertCommandSucceeded(result, description) {
  if (!result.error && !result.signal && result.status === 0) return
  if (result.stdout) console.error(result.stdout)
  if (result.stderr) console.error(result.stderr)
  const reason = result.error?.message || (result.signal
    ? `terminated by ${result.signal}`
    : `exited with ${result.status ?? 'no exit status'}`)
  throw new Error(`${description}: ${reason}`, result.error ? { cause: result.error } : undefined)
}

export function findCmake() {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const resolver = path.join(__dirname, 'resolve-cmake.ps1').replaceAll("'", "''")
  const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); . '${resolver}'; Resolve-ZToolsCMake`
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text',
    '-Command', command
  ], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 })
  assertCommandSucceeded(result, 'CMake discovery failed')
  return result.stdout.trim()
}

export function buildSidecar(name, sourceDir, options = {}) {
  const cmake = options.cmake || findCmake()
  const run = options.run ?? spawnSync
  const buildDir = path.join(outputBuildDir, name)
  fs.mkdirSync(buildDir, { recursive: true })
  fs.mkdirSync(outputBinDir, { recursive: true })

  console.log(`[build-sidecars] Configuring ${name}...`)
  const configRes = run(cmake, [
    '-S', sourceDir,
    '-B', buildDir,
    '-G', 'Visual Studio 17 2022',
    '-A', 'x64',
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${outputBinDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${outputBinDir}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: process.env
  })

  assertCommandSucceeded(configRes, `Failed to configure ${name} (${cmake})`)

  console.log(`[build-sidecars] Building ${name} (Release)...`)
  const buildRes = run(cmake, [
    '--build', buildDir,
    '--config', 'Release',
    '--target', name
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: process.env
  })

  assertCommandSucceeded(buildRes, `Failed to build ${name} (${cmake})`)

  const exePath = path.join(outputBinDir, `${name}.exe`)
  if (!fs.existsSync(exePath)) {
    throw new Error(`Output binary missing: ${exePath}`)
  }

  assertPeMachine(exePath, PE_MACHINE_X64)
  const sha256 = createHash('sha256').update(fs.readFileSync(exePath)).digest('hex')
  console.log(`[build-sidecars] Successfully built ${name}.exe (${sha256.slice(0, 12)}...)`)
  return { name, exePath, sha256 }
}

export function buildMacosIndexerSidecar(sourceDir = path.join(nativeDir, 'ztools-indexer')) {
  const macBinDir = path.join(rootDir, 'out', 'native', `darwin-${process.arch}`, 'bin')
  fs.mkdirSync(macBinDir, { recursive: true })
  const outBinary = path.join(macBinDir, 'ztools-indexer')
  const mainCpp = path.join(sourceDir, 'main.cpp')
  const sharedDir = path.join(nativeDir, 'shared')

  console.log('[build-sidecars] Building ztools-indexer for macOS (clang++)...')
  const buildRes = spawnSync('clang++', [
    '-std=c++20',
    '-O3',
    '-pthread',
    '-I', sourceDir,
    '-I', sharedDir,
    mainCpp,
    '-o', outBinary
  ], {
    encoding: 'utf8',
    env: process.env
  })

  if (buildRes.status !== 0) {
    console.error(buildRes.stdout)
    console.error(buildRes.stderr)
    throw new Error(`Failed to build ztools-indexer on macOS: clang++ exited with ${buildRes.status}`)
  }

  fs.chmodSync(outBinary, 0o755)
  const sha256 = createHash('sha256').update(fs.readFileSync(outBinary)).digest('hex')
  console.log(`[build-sidecars] Successfully built ztools-indexer (${sha256.slice(0, 12)}...)`)
  return { name: 'ztools-indexer', exePath: outBinary, sha256 }
}

export function buildAllSidecars() {
  const uiaccessDir = path.join(nativeDir, 'ztools-uiaccess')
  const indexerDir = path.join(nativeDir, 'ztools-indexer')

  if (process.platform === 'darwin') {
    const indexerRes = buildMacosIndexerSidecar(indexerDir)
    return { indexer: indexerRes }
  }

  console.log('[build-sidecars] Starting native sidecar build...')
  const uiaccessRes = buildSidecar('ztools-uiaccess', uiaccessDir)
  const uiaccessStandardRes = buildSidecar('ztools-uiaccess-standard', uiaccessDir)
  const indexerRes = buildSidecar('ztools-indexer', indexerDir)

  return {
    uiaccess: uiaccessRes,
    uiaccessStandard: uiaccessStandardRes,
    indexer: indexerRes
  }
}

/** 编译安全文件操作组件（批量改名等依赖），产物位置即打包与开发运行时的查找位置。 */
export function buildPathAccessBroker() {
  return buildSidecar('ZToolsPathAccessBroker', path.join(nativeDir, 'ZToolsPathAccess'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const res = process.argv.includes('--path-access-broker') ? buildPathAccessBroker() : buildAllSidecars()
    console.log('[build-sidecars] All sidecars built successfully:', JSON.stringify(res, null, 2))
    process.exit(0)
  } catch (err) {
    console.error('[build-sidecars] Build failed:', err)
    process.exit(1)
  }
}
