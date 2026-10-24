import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'

/** Maintained helper wrappers supply trusted compiler inputs; no Renderer/compiler argv passthrough. */
export function buildMacUniversalHelper({ name, sources, compilerArgs = [], outputRoot, minimumOs,
  platform = process.platform, exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  if (platform !== 'darwin') throw new Error('DARWIN_REQUIRED')
  compareOsVersions(minimumOs, minimumOs)
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('ABSOLUTE_OUTPUT_REQUIRED')
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) || !Array.isArray(sources) || !sources.length || sources.some(source =>
    typeof source !== 'string' || !path.isAbsolute(source) || !fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink())) throw new Error('HELPER_SOURCE_INVALID')
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
  fs.mkdirSync(outputRoot) // Fresh output only, including after failed builds.
  const run = (tool, argv) => exec(tool, argv, { shell: false, timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  for (const arch of ['arm64', 'x86_64']) {
    run('/usr/bin/xcrun', ['clang++', '-std=c++17', ...compilerArgs, '-arch', arch,
      `-mmacosx-version-min=${minimumOs}`, ...sources, '-o', path.join(outputRoot, arch)])
  }
  const nativeRoot = path.join(outputRoot, 'native')
  fs.mkdirSync(nativeRoot)
  const executable = path.join(nativeRoot, name)
  run('/usr/bin/lipo', ['-create', path.join(outputRoot, 'arm64'), path.join(outputRoot, 'x86_64'), '-output', executable])
  const architectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/).sort()
  if (JSON.stringify(architectures) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_REQUIRED')
  for (const arch of architectures) if (compareOsVersions(inspectDeployment(executable, arch), minimumOs) > 0) throw new Error('NATIVE_MINIMUM_OS_MISMATCH')
  const stat = fs.lstatSync(executable)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('HELPER_OUTPUT_INVALID')
  fs.chmodSync(executable, 0o755)
  return { nativeRoot, executable, minimumOs, architectures }
}
