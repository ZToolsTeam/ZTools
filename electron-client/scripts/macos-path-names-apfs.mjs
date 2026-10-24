import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { withMacApfsFixtures, verifyOwnedApfsVolume } from './macos-apfs-fixtures.mjs'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'

const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const scope = 'native-pinned-name-apfs-matrix'
function inspectNative(file, minimumOs) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)) throw new Error('NATIVE_NAMES_EXECUTABLE_REQUIRED')
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', file], {
    shell: false, encoding: 'utf8', timeout: 15000, maxBuffer: 65536
  }).trim().split(/\s+/).sort()
  if (JSON.stringify(architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_REQUIRED')
  const deployment = architectures.map(arch => ({ arch, minimumOs: inspectMacDeployment(file, arch) }))
  if (deployment.some(slice => compareOsVersions(slice.minimumOs, minimumOs) > 0)) throw new Error('MINIMUM_OS_MISMATCH')
  return { sha256: hashFile(file), architectures, deployment }
}
function executeNative({ executable, sha256, fixtureRoot, processArch }) {
  if (hashFile(executable) !== sha256) throw new Error('NATIVE_NAMES_BINARY_CHANGED')
  // This maintained C++ test has no child-process/system-command calls on either OS.
  const args = [processArch === 'x64' ? '-x86_64' : '-arm64', executable, fixtureRoot]
  const result = spawnSync('/usr/bin/arch', args, { shell: false, encoding: 'utf8',
    timeout: 60000, maxBuffer: 1024 * 1024, killSignal: 'SIGTERM' })
  fs.writeFileSync(path.join(path.dirname(fixtureRoot), 'native-names-execution.json'), JSON.stringify({
    executable, sha256, processArch, exitCode: result.status, signal: result.signal,
    errorCode: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr
  }, null, 2) + '\n', { flag: 'wx' })
  if (result.error || result.status !== 0 || hashFile(executable) !== sha256) throw new Error('NATIVE_NAMES_EXECUTION_FAILED')
  return JSON.parse(result.stdout)
}
export function validateNativeNameResult(result, caseSensitive) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).some(key => !['status', 'scope', 'tests', 'caseSensitive', 'unicodeNormalizationAlias'].includes(key)) ||
      result.status !== 'PASS' || result.scope !== 'native-pinned-name-contract' || result.tests !== 26 + (caseSensitive ? 0 : 2) + (result.unicodeNormalizationAlias ? 2 : 0) ||
      result.caseSensitive !== caseSensitive || typeof result.unicodeNormalizationAlias !== 'boolean') throw new Error('NATIVE_NAMES_RESULT_MISMATCH')
  return result
}

export async function runMacPathNamesApfs(options, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', phase: 2, scope }
  try {
    if (!options || typeof options.output !== 'string' || !path.isAbsolute(options.output) ||
        typeof options['native-test'] !== 'string' || !path.isAbsolute(options['native-test']) ||
        !['arm64', 'x64'].includes(options['expect-process-arch'])) throw new Error('APFS_NATIVE_PARAMETERS_REQUIRED')
    compareOsVersions(options['minimum-os'], options['minimum-os'])
    const executable = options['native-test'], minimumOs = options['minimum-os'], processArch = options['expect-process-arch']
    const native = await (dependencies.inspectNative ?? inspectNative)(executable, minimumOs)
    if (!/^[a-f0-9]{64}$/.test(native.sha256) || JSON.stringify(native.architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_REQUIRED')
    const apfs = await (dependencies.withFixtures ?? withMacApfsFixtures)(options.output, async (volumes, signal) => {
      if (volumes.length !== 2 || volumes[0].caseSensitive !== false || volumes[1].caseSensitive !== true) throw new Error('APFS_VOLUME_MATRIX_REQUIRED')
      const results = []
      for (const volume of volumes) {
        signal?.throwIfAborted()
        await (dependencies.verifyVolume ?? verifyOwnedApfsVolume)(volume)
        const result = await (dependencies.executeNative ?? executeNative)({ executable, sha256: native.sha256,
          fixtureRoot: path.join(volume.fixtures, 'native-names'), processArch })
        validateNativeNameResult(result, volume.caseSensitive)
        signal?.throwIfAborted()
        results.push({ caseSensitive: volume.caseSensitive, processArch, result })
      }
      return { status: 'PASS', scope, results }
    }, { signal: options.signal })
    const report = { ...apfs, phase: 2, scope, processArch, minimumOs, native, releaseAcceptance: false }
    if (apfs.root && fs.existsSync(apfs.root)) fs.writeFileSync(path.join(apfs.root, 'native-name-matrix.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    return report
  } catch (error) { return { status: 'FAIL', phase: 2, scope,
    code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'APFS_NATIVE_NAMES_FAILED', releaseAcceptance: false } }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, output: { type: 'string' },
    'native-test': { type: 'string' }, 'minimum-os': { type: 'string' }, 'expect-process-arch': { type: 'string' } } })
  if (values.help) {
    console.log('npm run test:mac:path-names:apfs -- --native-test <absolute Universal ZToolsPathAccessNamesTest from test:native:path-access output/bin> --minimum-os <approved version> --expect-process-arch arm64|x64 --output <fresh absolute directory>')
    return 0
  }
  const controller = new AbortController(), onStop = () => controller.abort(new Error('APFS_NATIVE_CANCELLED'))
  process.once('SIGINT', onStop); process.once('SIGTERM', onStop)
  try {
    const result = await runMacPathNamesApfs({ ...values, signal: controller.signal })
    console.log(JSON.stringify(result)); return result.status === 'PASS' ? 0 : 1
  } finally { process.off('SIGINT', onStop); process.off('SIGTERM', onStop) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main() }
  catch { console.error('APFS_NATIVE_ARGUMENTS_INVALID'); process.exitCode = 1 }
}
