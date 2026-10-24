import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'
export function runNativeVisionTests({ executable, architecture, minimumOs, platform = process.platform,
  exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED' }
  if (!['arm64', 'x64'].includes(architecture) || typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('INVALID_NATIVE_TEST_ARGUMENTS')
  compareOsVersions(minimumOs, minimumOs)
  const info = fs.lstatSync(executable)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('INVALID_NATIVE_EXECUTABLE')
  const options = { shell: false, timeout: 60000, encoding: 'utf8', maxBuffer: 128 * 1024 }
  if (compareOsVersions(exec('/usr/bin/sw_vers', ['-productVersion'], options).trim(), minimumOs) < 0) throw new Error('OS_BELOW_APPROVED_MINIMUM')
  const arch = architecture === 'x64' ? 'x86_64' : 'arm64'
  if (!exec('/usr/bin/lipo', ['-archs', executable], options).trim().split(/\s+/).includes(arch)) throw new Error('MISSING_NATIVE_SLICE')
  if (compareOsVersions(inspectDeployment(executable, arch), minimumOs) > 0) throw new Error('DEPLOYMENT_EXCEEDS_APPROVED_MINIMUM')
  const result = JSON.parse(exec('/usr/bin/arch', [arch === 'x86_64' ? '-x86_64' : '-arm64', executable, '--self-test'], options))
  if (result.version !== 1 || result.success !== true || result.architecture !== architecture || result.scope !== 'vision-local-native' || result.cases !== 9) throw new Error('NATIVE_TEST_CONTRACT_MISMATCH')
  return { status: 'PASS', minimumOs, ...result }
}
export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, executable: { type: 'string' }, arch: { type: 'string' }, 'minimum-os': { type: 'string' } } })
    if (values.help) { console.log('npm run test:native:mac:vision -- --executable <absolute helper> --arch <arm64|x64> --minimum-os <approved version>'); return 0 }
    const result = runNativeVisionTests({ executable: values.executable, architecture: values.arch, minimumOs: values['minimum-os'] })
    console.log(JSON.stringify(result)); return result.status === 'PASS' ? 0 : 1
  } catch { console.error('MAC_VISION_NATIVE_TEST_FAILED'); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
