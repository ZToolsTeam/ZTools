import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const sourceRoot = fileURLToPath(new URL('../native/ZToolsPathAccess', import.meta.url))
export function buildWindowsPathAccess({ cmake, outputRoot, platform = process.platform, run = spawnSync }) {
  if (platform !== 'win32') throw new Error('WINDOWS_REQUIRED')
  if (typeof cmake !== 'string' || !path.isAbsolute(cmake) || !fs.lstatSync(cmake).isFile() || fs.lstatSync(cmake).isSymbolicLink()) throw new Error('CMAKE_REQUIRED')
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || fs.existsSync(outputRoot)) throw new Error('FRESH_OUTPUT_REQUIRED')
  fs.mkdirSync(outputRoot, { recursive: true })
  const temporary = path.join(outputRoot, 'temporary'), bin = path.join(outputRoot, 'bin'), build = path.join(outputRoot, 'build')
  fs.mkdirSync(temporary)
  let stage = 0
  const execute = args => {
    const result = run(cmake, args, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } })
    fs.writeFileSync(path.join(outputRoot, `${++stage}-stage.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
    if (result.error || result.status !== 0) throw new Error('WINDOWS_PATH_ACCESS_BUILD_FAILED')
  }
  execute(['-S', sourceRoot, '-B', build, '-G', 'Visual Studio 17 2022', '-A', 'x64',
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${bin}`, `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${bin}`])
  execute(['--build', build, '--config', 'Release', '--target', 'ZToolsPathAccessBroker'])
  const helperPath = path.join(bin, 'ZToolsPathAccessBroker.exe'), stat = fs.lstatSync(helperPath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('HELPER_REQUIRED')
  assertPeMachine(helperPath, PE_MACHINE_X64)
  const result = { platform: 'win32', arch: 'x64', helperPath, sha256: createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex') }
  fs.writeFileSync(path.join(outputRoot, 'build-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  return result
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, cmake: { type: 'string' }, output: { type: 'string' } } })
    if (values.help) { console.log('npm run build:native:win:path-access -- --cmake <absolute executable> --output <fresh absolute directory> (x64 only; Main dev lookup uses <electron-client>/out/native/win32-x64)'); return 0 }
    console.log(JSON.stringify(buildWindowsPathAccess({ cmake: values.cmake, outputRoot: values.output }))); return 0
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'WINDOWS_PATH_ACCESS_BUILD_FAILED'); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
