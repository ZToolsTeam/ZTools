import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'native', 'ZToolsMacNative')

function requireRegularFile(filePath, code) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error(code)
  const info = fs.lstatSync(filePath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(code)
}

/** Builds the unsigned universal source targets; production signing and staging are separate gates. */
export function buildMacNativeHost({ outputRoot, minimumOs, processArchitecture, cmake,
  platform = process.platform, exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  if (platform !== 'darwin') throw new Error('DARWIN_REQUIRED')
  compareOsVersions(minimumOs, minimumOs)
  if (!['arm64', 'x64'].includes(processArchitecture)) throw new Error('MAC_PROCESS_ARCH_REQUIRED')
  requireRegularFile(cmake, 'CMAKE_REQUIRED')
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('ABSOLUTE_OUTPUT_REQUIRED')
  const cmakeLists = path.join(sourceRoot, 'CMakeLists.txt')
  requireRegularFile(cmakeLists, 'NATIVE_SOURCE_INVALID')
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
  fs.mkdirSync(outputRoot)

  const buildRoot = path.join(outputRoot, 'build')
  const run = (tool, args, timeout = 180_000) => exec(tool, args, {
    cwd: root,
    shell: false,
    timeout,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  })
  run(cmake, ['-S', sourceRoot, '-B', buildRoot,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minimumOs}`])
  run(cmake, ['--build', buildRoot, '--config', 'Release', '--target',
    'ZToolsMacNativeHost', 'ZToolsMacNativeWorker', 'ZToolsMacNativeTrustGateTest'], 300_000)

  const binRoot = path.join(buildRoot, 'bin')
  const hostPath = path.join(binRoot, 'ZToolsMacNativeHost')
  const workerPath = path.join(binRoot, 'ZToolsMacNativeWorker')
  const trustTestPath = path.join(binRoot, 'ZToolsMacNativeTrustGateTest')
  for (const filePath of [hostPath, workerPath, trustTestPath]) {
    requireRegularFile(filePath, 'NATIVE_OUTPUT_INVALID')
    const architectures = run('/usr/bin/lipo', ['-archs', filePath]).trim().split(/\s+/).sort()
    if (JSON.stringify(architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_REQUIRED')
    for (const architecture of architectures) {
      const actualMinimumOs = inspectDeployment(filePath, architecture)
      if (compareOsVersions(actualMinimumOs, minimumOs) > 0) throw new Error('NATIVE_MINIMUM_OS_MISMATCH')
    }
  }
  return Object.freeze({
    outputRoot,
    buildRoot,
    binRoot,
    hostPath,
    workerPath,
    trustTestPath,
    minimumOs,
    processArchitecture,
    architectures: Object.freeze(['arm64', 'x86_64']),
    signed: false
  })
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      help: { type: 'boolean' },
      cmake: { type: 'string' },
      output: { type: 'string' },
      'minimum-os': { type: 'string' },
      'expect-process-arch': { type: 'string' }
    } })
    if (values.help) {
      console.log('npm run build:native:mac:host -- --cmake <absolute CMake> --output <fresh absolute directory> --minimum-os <approved version> --expect-process-arch arm64|x64')
      return 0
    }
    const result = buildMacNativeHost({
      cmake: values.cmake,
      outputRoot: values.output,
      minimumOs: values['minimum-os'],
      processArchitecture: values['expect-process-arch']
    })
    console.log(JSON.stringify(result))
    return 0
  } catch (error) {
    const code = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : error?.code === 'EEXIST' ? 'OUTPUT_DIRECTORY_NOT_FRESH' : 'MAC_NATIVE_HOST_BUILD_FAILED'
    console.error(code)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
