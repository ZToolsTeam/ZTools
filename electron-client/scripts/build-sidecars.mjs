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

  const exePath = path.join(outputBinDir, `${name}.exe`)
  const staleExePath = path.join(outputBinDir, `${name}.old.exe`)
  const isExpectedLockError = (err) => {
    const code = err && typeof err === 'object' ? err.code : undefined
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'
  }
  try {
    if (fs.existsSync(staleExePath)) fs.unlinkSync(staleExePath)
  } catch (err) {
    if (!isExpectedLockError(err)) {
      console.warn(`[build-sidecars] Unexpected error removing stale binary ${staleExePath}:`, err)
    }
  }
  if (fs.existsSync(exePath)) {
    try {
      fs.unlinkSync(exePath)
    } catch (unlinkErr) {
      if (!isExpectedLockError(unlinkErr)) {
        console.warn(`[build-sidecars] Unexpected error unlinking ${exePath}:`, unlinkErr)
      }
      try {
        fs.renameSync(exePath, staleExePath)
      } catch (renameErr) {
        if (!isExpectedLockError(renameErr)) {
          console.warn(`[build-sidecars] Unexpected error renaming locked binary ${exePath}:`, renameErr)
        }
      }
    }
  }

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

function computeSidecarSourceSignature(sourceFiles) {
  const hash = createHash('sha256')
  const scriptPath = fileURLToPath(import.meta.url)
  for (const file of [...sourceFiles, scriptPath]) {
    if (!fs.existsSync(file)) continue
    hash.update(path.relative(rootDir, file).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function getWindowsSidecarSpecs() {
  const sharedRpc = path.join(nativeDir, 'shared', 'json_rpc.hpp')
  const uiaccessDir = path.join(nativeDir, 'ztools-uiaccess')
  const indexerDir = path.join(nativeDir, 'ztools-indexer')
  const uiaccessSources = ['CMakeLists.txt', 'main.cpp', 'uiaccess_worker.hpp', 'app.manifest', 'uiaccess.rc']
    .map(file => path.join(uiaccessDir, file))
    .concat(sharedRpc)
  const indexerSources = ['CMakeLists.txt', 'main.cpp', 'file_scanner.hpp', 'flat_trie.hpp', 'pinyin.hpp']
    .map(file => path.join(indexerDir, file))
    .concat(sharedRpc)

  return [
    { name: 'ztools-uiaccess', sourceDir: uiaccessDir, sources: uiaccessSources },
    { name: 'ztools-uiaccess-standard', sourceDir: uiaccessDir, sources: uiaccessSources },
    { name: 'ztools-indexer', sourceDir: indexerDir, sources: indexerSources }
  ]
}

export function buildAllSidecars() {
  const indexerDir = path.join(nativeDir, 'ztools-indexer')

  if (process.platform === 'darwin') {
    const indexerRes = buildMacosIndexerSidecar(indexerDir)
    return { indexer: indexerRes }
  }

  console.log('[build-sidecars] Starting native sidecar build...')
  const specs = getWindowsSidecarSpecs()
  const cmake = findCmake()
  const results = {}
  for (const spec of specs) {
    const built = buildSidecar(spec.name, spec.sourceDir, { cmake })
    fs.mkdirSync(outputBuildDir, { recursive: true })
    const stampPath = path.join(outputBuildDir, `${spec.name}.source.sha256`)
    fs.writeFileSync(stampPath, computeSidecarSourceSignature(spec.sources), 'utf8')
    results[spec.name] = built
  }

  return {
    uiaccess: results['ztools-uiaccess'],
    uiaccessStandard: results['ztools-uiaccess-standard'],
    indexer: results['ztools-indexer']
  }
}

/**
 * Windows 开发态增量保鲜：当 C++ 侧车源码或共享 RPC 协议变化、或产物缺失时自动重编，
 * 避免 npm run build / start 静默加载数周前的旧版 ztools-indexer.exe。
 */
export function buildDevelopmentWindowsSidecars() {
  if (process.platform !== 'win32') return
  const specs = getWindowsSidecarSpecs()
  const staleSpecs = []
  for (const spec of specs) {
    const exePath = path.join(outputBinDir, `${spec.name}.exe`)
    const stampPath = path.join(outputBuildDir, `${spec.name}.source.sha256`)
    const expectedSig = computeSidecarSourceSignature(spec.sources)
    const upToDate = fs.existsSync(exePath) &&
      fs.existsSync(stampPath) &&
      fs.readFileSync(stampPath, 'utf8').trim() === expectedSig
    if (!upToDate) {
      staleSpecs.push({ ...spec, expectedSig, stampPath })
    }
  }
  if (staleSpecs.length === 0) return

  let cmake
  try {
    cmake = findCmake()
  } catch (err) {
    console.warn(`[build-sidecars] 未找到 CMake/VS 工具链，跳过开发态侧车增量重编（${staleSpecs.map(s => s.name).join(', ')}）:`, err instanceof Error ? err.message : String(err))
    return
  }

  fs.mkdirSync(outputBuildDir, { recursive: true })
  for (const spec of staleSpecs) {
    buildSidecar(spec.name, spec.sourceDir, { cmake })
    fs.writeFileSync(spec.stampPath, spec.expectedSig, 'utf8')
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
