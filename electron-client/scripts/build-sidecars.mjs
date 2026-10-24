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

function findCmake() {
  const candidates = [
    'D:\\Program Files\\CMake\\bin\\cmake.exe',
    'C:\\Program Files\\CMake\\bin\\cmake.exe',
    'C:\\Program Files (x86)\\CMake\\bin\\cmake.exe',
    'cmake'
  ]
  for (const c of candidates) {
    if (c === 'cmake') {
      const probe = spawnSync('where', ['cmake'], { encoding: 'utf8', shell: true })
      if (probe.status === 0 && probe.stdout) {
        const found = probe.stdout.trim().split(/\r?\n/)[0]
        if (found && fs.existsSync(found)) return found
      }
    } else if (fs.existsSync(c)) {
      return c
    }
  }
  return 'D:\\Program Files\\CMake\\bin\\cmake.exe'
}

export function buildSidecar(name, sourceDir, options = {}) {
  const cmake = options.cmake || findCmake()
  const buildDir = path.join(outputBuildDir, name)
  fs.mkdirSync(buildDir, { recursive: true })
  fs.mkdirSync(outputBinDir, { recursive: true })

  console.log(`[build-sidecars] Configuring ${name}...`)
  const configRes = spawnSync(cmake, [
    '-S', sourceDir,
    '-B', buildDir,
    '-G', 'Visual Studio 17 2022',
    '-A', 'x64',
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${outputBinDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${outputBinDir}`
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })

  if (configRes.status !== 0) {
    console.error(configRes.stdout)
    console.error(configRes.stderr)
    throw new Error(`Failed to configure ${name}: cmake exited with ${configRes.status}`)
  }

  console.log(`[build-sidecars] Building ${name} (Release)...`)
  const buildRes = spawnSync(cmake, [
    '--build', buildDir,
    '--config', 'Release',
    '--target', name
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })

  if (buildRes.status !== 0) {
    console.error(buildRes.stdout)
    console.error(buildRes.stderr)
    throw new Error(`Failed to build ${name}: cmake exited with ${buildRes.status}`)
  }

  const exePath = path.join(outputBinDir, `${name}.exe`)
  if (!fs.existsSync(exePath)) {
    throw new Error(`Output binary missing: ${exePath}`)
  }

  assertPeMachine(exePath, PE_MACHINE_X64)
  const sha256 = createHash('sha256').update(fs.readFileSync(exePath)).digest('hex')
  console.log(`[build-sidecars] Successfully built ${name}.exe (${sha256.slice(0, 12)}...)`)
  return { name, exePath, sha256 }
}

export function buildAllSidecars() {
  const uiaccessDir = path.join(nativeDir, 'ztools-uiaccess')
  const indexerDir = path.join(nativeDir, 'ztools-indexer')

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const res = buildAllSidecars()
    console.log('[build-sidecars] All sidecars built successfully:', JSON.stringify(res, null, 2))
    process.exit(0)
  } catch (err) {
    console.error('[build-sidecars] Build failed:', err)
    process.exit(1)
  }
}
