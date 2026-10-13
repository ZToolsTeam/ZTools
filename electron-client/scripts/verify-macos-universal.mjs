import { compareOsVersions, inspectMacDeployment, inspectMacBundleMinimumOs } from './macos-minimum-os.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REQUIRED_ARCHITECTURES = Object.freeze(['arm64', 'x86_64'])
const MAC_NATIVE_LOAD_PROOF_UNAVAILABLE = 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'
const MAC_NATIVE_GROUP_INCOMPLETE = 'MAC_NATIVE_GROUP_INCOMPLETE_UNAVAILABLE'
const MAC_NATIVE_GROUP_INVALID_MODE = 'MAC_NATIVE_GROUP_MODE_INVALID'
const ARCHITECTURE_TOKEN = /^[A-Za-z0-9_]+$/
const FILE_TOOL_TIMEOUT_MS = 15_000
const FILE_TOOL_MAX_BUFFER = 1024 * 1024
const NATIVE_GROUP_FILENAMES = new Set([
  'ztoolsmacnativehost',
  'ztoolsmacnativeworker',
  'ztools-mac-native-policy.json'
])

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function displayPath(root, target) {
  const relative = path.relative(root, target)
  return relative || '.'
}

function isWithinDirectory(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function runTextTool(executable, args, exec = execFileSync) {
  let output
  try {
    output = exec(executable, args, {
      encoding: 'utf8',
      timeout: FILE_TOOL_TIMEOUT_MS,
      maxBuffer: FILE_TOOL_MAX_BUFFER,
      windowsHide: true,
      shell: false,
    })
  } catch (error) {
    throw new Error(`${executable} 执行失败: ${errorMessage(error)}`)
  }
  if (typeof output !== 'string') {
    throw new Error(`${executable} 输出不是 UTF-8 文本`)
  }
  return output
}

function parseArchitectureList(output) {
  const value = output.trim()
  // `lipo -archs <file>` on macOS returns one whitespace-separated line,
  // for example: `x86_64 arm64`. Reject diagnostics and multiline output.
  if (!value || !/^[A-Za-z0-9_]+(?:[ \t]+[A-Za-z0-9_]+)*$/.test(value)) return null
  return value.split(/[ \t]+/)
}

/**
 * Inspect one regular file using the macOS command-line tools.
 *
 * Tool contract: `file -b <absolute-path>` must produce a non-empty UTF-8 BSD
 * file description; a description containing the token `Mach-O` is treated as
 * Mach-O and all other file(1) descriptions as non-Mach-O. For Mach-O files,
 * `lipo -archs <absolute-path>` must produce exactly one line of architecture
 * tokens (for example `x86_64 arm64`); malformed/empty lipo output fails
 * closed. Paths are separate argv entries and are never passed through a shell.
 */
export function inspectMacosFile(filePath, { exec = execFileSync } = {}) {
  const fileDescription = runTextTool('file', ['-b', filePath], exec).trim()
  if (!fileDescription) throw new Error('file 输出为空')
  if (!/\bMach-O\b/.test(fileDescription)) return { kind: 'other' }

  const lipoOutput = runTextTool('lipo', ['-archs', filePath], exec)
  const architectures = parseArchitectureList(lipoOutput)
  if (!architectures) throw new Error('lipo -archs 输出格式无效')
  return { kind: 'macho', architectures }
}

function validateInspection(result, relativePath) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`检查器返回值无效: ${relativePath}`)
  }
  if (result.kind === 'other') return null
  if (result.kind !== 'macho' || !Array.isArray(result.architectures) || result.architectures.length === 0 ||
      !result.architectures.every((architecture) => typeof architecture === 'string' && ARCHITECTURE_TOKEN.test(architecture))) {
    throw new Error(`检查器返回了无法识别的文件类型或架构列表: ${relativePath}`)
  }
  return new Set(result.architectures)
}

function inspectNativeHostGroup(fsApi, root, entries, machoFiles) {
  const hostPath = path.join('Contents', 'Resources', 'native', 'ZToolsMacNativeHost')
  const workerPath = path.join('Contents', 'Resources', 'native', 'ZToolsMacNativeWorker')
  const policyPath = path.join('Contents', 'Resources', 'native', 'ztools-mac-native-policy.json')
  const expectedPaths = [hostPath, workerPath, policyPath]
  const namedArtifacts = [...entries.keys()].filter((relativePath) =>
    NATIVE_GROUP_FILENAMES.has(path.basename(relativePath).toLowerCase()))
  const versionsPath = path.join('Contents', 'Resources', 'ztools-bundle-versions.json')
  let declaredMode
  if (entries.has(versionsPath)) {
    const versionsEntry = entries.get(versionsPath)
    if (!versionsEntry.isFile || versionsEntry.isSymbolicLink) throw codedError(MAC_NATIVE_GROUP_INVALID_MODE)
    let versions
    try {
      const source = fsApi.readFileSync(path.join(root, versionsPath), 'utf8')
      versions = JSON.parse(Buffer.isBuffer(source) ? source.toString('utf8') : source)
    } catch {
      throw codedError(MAC_NATIVE_GROUP_INVALID_MODE)
    }
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
      throw codedError(MAC_NATIVE_GROUP_INVALID_MODE)
    }
    if (Object.hasOwn(versions, 'nativeHostMode')) {
      if (versions.nativeHostMode !== 'disabled' && versions.nativeHostMode !== 'enabled') {
        throw codedError(MAC_NATIVE_GROUP_INVALID_MODE)
      }
      declaredMode = versions.nativeHostMode
    }
  }

  const anyNativeGroup = namedArtifacts.length > 0 || declaredMode === 'enabled'
  if (!anyNativeGroup) return { mode: 'disabled', available: false }

  if (namedArtifacts.some((relativePath) => !expectedPaths.includes(relativePath)) ||
      expectedPaths.some((relativePath) => {
        const entry = entries.get(relativePath)
        return !entry?.isFile || entry.isSymbolicLink
      }) || !machoFiles.includes(hostPath) || !machoFiles.includes(workerPath)) {
    throw codedError(MAC_NATIVE_GROUP_INCOMPLETE)
  }

  // The current loader cannot prove object identity before dlopen runs initializers.
  // A complete bundle is still unsafe to release, so audit must fail closed.
  throw codedError(MAC_NATIVE_LOAD_PROOF_UNAVAILABLE)
}

/**
 * Read-only, injectable bundle verifier. `inspectFile` must return
 * `{ kind: 'other' }` or `{ kind: 'macho', architectures: string[] }`.
 * Filesystem methods use the synchronous Node fs contract so callers can
 * provide a deterministic in-memory filesystem in tests.
 */
export function verifyMacosUniversalBundle({ bundlePath, fsApi = fs, inspectFile = inspectMacosFile,
  minimumOs, inspectDeployment = inspectMacDeployment, inspectBundleMinimumOs = inspectMacBundleMinimumOs }) {
  if (minimumOs !== undefined) compareOsVersions(minimumOs, minimumOs)
  if (typeof bundlePath !== 'string' || bundlePath.trim() === '') {
    throw new Error('必须提供 .app bundle 路径')
  }
  const requestedRoot = path.resolve(bundlePath)
  if (path.extname(requestedRoot).toLowerCase() !== '.app') {
    throw new Error('输入路径必须以 .app 结尾')
  }

  let rootLstat
  try {
    rootLstat = fsApi.lstatSync(requestedRoot)
  } catch (error) {
    throw new Error(`.app bundle 不存在或不可访问: . (${errorMessage(error)})`)
  }
  if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
    throw new Error('.app bundle 路径必须是真实目录，不能是符号链接')
  }

  let root
  try {
    root = fsApi.realpathSync(requestedRoot)
    const rootStat = fsApi.statSync(root)
    if (!rootStat.isDirectory()) throw new Error('目标不是目录')
  } catch (error) {
    throw new Error(`无法解析 .app bundle 根目录: . (${errorMessage(error)})`)
  }

  if (minimumOs !== undefined && compareOsVersions(inspectBundleMinimumOs(root), minimumOs) !== 0) {
    throw new Error('App最低OS元数据与显式发布策略不一致')
  }
  const visitedDirectories = new Set()
  const inspectedFiles = new Set()
  const machoFiles = []
  const bundleEntries = new Map()
  let scannedRegularFiles = 0

  function visit(candidate) {
    const candidateRelative = displayPath(root, candidate)
    let linkStat
    try {
      linkStat = fsApi.lstatSync(candidate)
    } catch (error) {
      throw new Error(`无法读取 bundle 条目 ${candidateRelative}: ${errorMessage(error)}`)
    }
    bundleEntries.set(candidateRelative, {
      isFile: linkStat.isFile(),
      isSymbolicLink: linkStat.isSymbolicLink(),
      isDirectory: linkStat.isDirectory(),
    })

    let canonicalPath
    try {
      canonicalPath = fsApi.realpathSync(candidate)
    } catch (error) {
      const reason = linkStat.isSymbolicLink() ? '符号链接悬空或无法解析' : '路径无法解析'
      throw new Error(`${reason}: ${candidateRelative} (${errorMessage(error)})`)
    }
    if (!isWithinDirectory(root, canonicalPath)) {
      throw new Error(`符号链接越出 .app bundle: ${candidateRelative}`)
    }

    let targetStat
    try {
      targetStat = fsApi.statSync(canonicalPath)
    } catch (error) {
      throw new Error(`无法读取 bundle 目标 ${candidateRelative}: ${errorMessage(error)}`)
    }

    if (targetStat.isDirectory()) {
      if (visitedDirectories.has(canonicalPath)) return
      visitedDirectories.add(canonicalPath)
      let entries
      try {
        entries = fsApi.readdirSync(canonicalPath, { withFileTypes: true })
      } catch (error) {
        throw new Error(`无法枚举 bundle 目录 ${displayPath(root, canonicalPath)}: ${errorMessage(error)}`)
      }
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (typeof entry.name !== 'string' || entry.name === '' || entry.name === '.' || entry.name === '..' ||
            entry.name.includes(path.sep)) {
          throw new Error(`bundle 目录返回了无效条目名称: ${displayPath(root, canonicalPath)}`)
        }
        visit(path.join(canonicalPath, entry.name))
      }
      return
    }
    if (!targetStat.isFile() || inspectedFiles.has(canonicalPath)) return

    inspectedFiles.add(canonicalPath)
    scannedRegularFiles += 1
    const relativePath = displayPath(root, canonicalPath)
    let inspection
    try {
      inspection = inspectFile(canonicalPath)
    } catch (error) {
      throw new Error(`无法检查文件 ${relativePath}: ${errorMessage(error)}`)
    }
    const architectures = validateInspection(inspection, relativePath)
    if (!architectures) return

    const missing = REQUIRED_ARCHITECTURES.filter((architecture) => !architectures.has(architecture))
    if (missing.length > 0) {
      throw new Error(`Mach-O 缺少 Universal 架构切片 (${missing.join(', ')}): ${relativePath}`)
    }
    if (minimumOs !== undefined) {
      for (const architecture of REQUIRED_ARCHITECTURES) {
        const deploymentVersion = inspectDeployment(canonicalPath, architecture)
        if (compareOsVersions(deploymentVersion, minimumOs) > 0) {
          throw new Error(`Mach-O部署下限超过App最低OS (${architecture}, ${deploymentVersion} > ${minimumOs}): ${relativePath}`)
        }
      }
    }
    machoFiles.push(relativePath)
  }

  visitedDirectories.add(root)
  let rootEntries
  try {
    rootEntries = fsApi.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    throw new Error(`无法枚举 .app bundle 根目录: . (${errorMessage(error)})`)
  }
  rootEntries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of rootEntries) {
    if (typeof entry.name !== 'string' || entry.name === '' || entry.name === '.' || entry.name === '..' ||
        entry.name.includes(path.sep)) {
      throw new Error('bundle 根目录返回了无效条目名称: .')
    }
    visit(path.join(root, entry.name))
  }

  if (machoFiles.length === 0) {
    throw new Error('.app bundle 中没有发现 Mach-O 文件')
  }
  const nativeHost = inspectNativeHostGroup(fsApi, root, bundleEntries, machoFiles)
  return {
    bundlePath: root,
    scannedRegularFiles,
    machoFiles: [...machoFiles],
    architectures: [...REQUIRED_ARCHITECTURES],
    nativeHostMode: nativeHost.mode,
    nativeHostAvailable: nativeHost.available,
    ...(minimumOs === undefined ? {} : { minimumOs }),
  }
}

export function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  if (argv.length !== 1 && !(argv.length === 3 && argv[1] === '--minimum-os')) {
    stderr('用法: node scripts/verify-macos-universal.mjs <应用.app> [--minimum-os <已批准版本>]')
    return 2
  }
  try {
    const result = verifyMacosUniversalBundle({ bundlePath: argv[0], minimumOs: argv.length === 3 ? argv[2] : undefined })
    stdout(`Universal 检查通过: ${result.machoFiles.length} 个 Mach-O 均包含 arm64 与 x86_64 (${result.scannedRegularFiles} 个普通文件已扫描)`)
    return 0
  } catch (error) {
    stderr(`macOS Universal 检查失败: ${errorMessage(error)}`)
    return 1
  }
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = main()
}
