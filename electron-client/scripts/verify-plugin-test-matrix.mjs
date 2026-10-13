import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const matrixPath = path.join(root, 'tests', 'plugin-test-matrix.json')
const defaultPluginRoot = path.join(workspace, 'out', 'runtime', 'Data', 'Plugins')
const pluginSourceRoot = path.join(workspace, 'plugins', 'create-plugin', 'src', 'plugins')
const nativeSourceRoot = path.join(workspace, 'DLLPlugins')
const idPattern = /^[a-z][a-z0-9-]{0,63}$/
const dllIdPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/

function option(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function readJson(file) {
  let value
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`JSON 读取失败: ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`JSON 根节点必须是对象: ${file}`)
  }
  return value
}

function requireOrdinaryFile(file, label) {
  let stats
  try {
    stats = fs.lstatSync(file)
  } catch {
    throw new Error(`${label}不存在: ${file}`)
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label}必须是普通文件: ${file}`)
  }
}

function resolveRelativeFile(directory, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label}必须是非空相对路径`)
  }
  const normalized = relativePath.replaceAll('/', path.sep)
  const target = path.resolve(directory, normalized)
  const relative = path.relative(directory, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label}越出插件目录: ${relativePath}`)
  }
  requireOrdinaryFile(target, label)
  return target
}

function classifyManifest(manifest, file) {
  const hasDll = typeof manifest.dllloader === 'string' && manifest.dllloader.trim() !== ''
  if (manifest.requireAdmin !== undefined && typeof manifest.requireAdmin !== 'boolean') {
    throw new Error(`requireAdmin 必须是布尔值: ${file}`)
  }
  if (!hasDll) return 'pure-js'
  return manifest.requireAdmin === true ? 'privileged-dll' : 'standard-dll'
}

function readPeMachine(file) {
  const bytes = fs.readFileSync(file)
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`DLL 不是有效 PE 文件: ${file}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 6 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`DLL PE 头无效: ${file}`)
  }
  return bytes.readUInt16LE(peOffset + 4)
}

function verifyHtmlAssets(pluginDirectory, entryFile) {
  const html = fs.readFileSync(entryFile, 'utf8')
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1])
    .filter((value) => value && !/^(?:[a-z]+:|\/\/|#)/i.test(value))
    .map((value) => value.split(/[?#]/, 1)[0])
    .filter(Boolean)
  if (references.length === 0) {
    throw new Error(`插件入口没有本地脚本或样式引用: ${entryFile}`)
  }
  for (const reference of references) {
    resolveRelativeFile(pluginDirectory, reference, '插件入口资源')
  }
}

function verifyRepresentative(representative, pluginRoot) {
  if (!representative || typeof representative !== 'object' || Array.isArray(representative)) {
    throw new Error('测试代表项必须是对象')
  }
  const { kind, pluginId, dllId, probeFunction, unitTests } = representative
  if (!['pure-js', 'standard-dll', 'privileged-dll'].includes(kind)) {
    throw new Error(`未知插件类型: ${String(kind)}`)
  }
  if (typeof pluginId !== 'string' || !idPattern.test(pluginId)) {
    throw new Error(`插件 ID 无效: ${String(pluginId)}`)
  }
  if (!Array.isArray(unitTests) || unitTests.length === 0 ||
      !unitTests.every((value) => typeof value === 'string' && value.endsWith('.test.ts'))) {
    throw new Error(`${pluginId} 的 unitTests 无效`)
  }

  const pluginDirectory = path.join(pluginRoot, pluginId)
  const manifestFile = path.join(pluginDirectory, 'plugin.json')
  requireOrdinaryFile(manifestFile, '插件清单')
  const manifest = readJson(manifestFile)
  if (manifest.id !== pluginId) throw new Error(`插件目录与清单 ID 不一致: ${manifestFile}`)
  const actualKind = classifyManifest(manifest, manifestFile)
  if (actualKind !== kind) {
    throw new Error(`${pluginId} 分类不一致: 期望 ${kind}，实际 ${actualKind}`)
  }
  const entryFile = resolveRelativeFile(pluginDirectory, manifest.entry, '插件入口')
  verifyHtmlAssets(pluginDirectory, entryFile)

  const sourceManifestFile = path.join(pluginSourceRoot, pluginId, 'plugin.json')
  requireOrdinaryFile(sourceManifestFile, '插件源码清单')
  const sourceManifest = readJson(sourceManifestFile)
  if (sourceManifest.id !== pluginId || classifyManifest(sourceManifest, sourceManifestFile) !== kind) {
    throw new Error(`${pluginId} 的源码清单与测试分类不一致`)
  }
  for (const unitTest of unitTests) {
    requireOrdinaryFile(path.join(workspace, 'plugins', 'create-plugin', unitTest), '插件单元测试')
  }

  let dllFile = null
  if (kind !== 'pure-js') {
    if (typeof dllId !== 'string' || !dllIdPattern.test(dllId) ||
        typeof probeFunction !== 'string' || !dllIdPattern.test(probeFunction)) {
      throw new Error(`${pluginId} 的 DLL 探针配置无效`)
    }
    dllFile = resolveRelativeFile(pluginDirectory, manifest.dllloader, '插件 DLL')
    if (path.parse(dllFile).name !== dllId) {
      throw new Error(`${pluginId} 的 dllId 与 dllloader 文件名不一致`)
    }
    if (readPeMachine(dllFile) !== 0x014c) {
      throw new Error(`${pluginId} 的 DLL 不是 x86 PE: ${dllFile}`)
    }
    const nativeManifestFile = path.join(nativeSourceRoot, pluginId, 'plugin.json')
    requireOrdinaryFile(nativeManifestFile, 'DLL 源码清单')
    const nativeManifest = readJson(nativeManifestFile)
    if (nativeManifest.id !== pluginId || nativeManifest.name !== dllId ||
        nativeManifest.requireAdmin !== (kind === 'privileged-dll')) {
      throw new Error(`${pluginId} 的 JS、DLL 权限分类不一致`)
    }
  }

  return {
    kind,
    pluginId,
    entry: path.relative(pluginRoot, entryFile).replaceAll(path.sep, '/'),
    dll: dllFile ? path.relative(pluginRoot, dllFile).replaceAll(path.sep, '/') : null,
    probeFunction: probeFunction ?? null,
    unitTestCount: unitTests.length
  }
}

function inventory(pluginRoot) {
  const counts = { 'pure-js': 0, 'standard-dll': 0, 'privileged-dll': 0 }
  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestFile = path.join(pluginRoot, entry.name, 'plugin.json')
    if (!fs.existsSync(manifestFile)) continue
    const kind = classifyManifest(readJson(manifestFile), manifestFile)
    counts[kind] += 1
  }
  for (const [kind, count] of Object.entries(counts)) {
    if (count === 0) throw new Error(`插件目录缺少 ${kind} 类型`)
  }
  return counts
}

const configuredRoot = option('plugin-root')
const pluginRoot = configuredRoot
  ? path.resolve(root, configuredRoot)
  : defaultPluginRoot
const matrix = readJson(matrixPath)
if (matrix.version !== 1 || !Array.isArray(matrix.representatives) || matrix.representatives.length !== 3) {
  throw new Error('插件测试矩阵必须恰好包含三个版本 1 代表项')
}
requireOrdinaryFile(path.join(pluginRoot, 'todo', 'plugin.json'), '插件根验证文件')

const results = matrix.representatives.map((item) => verifyRepresentative(item, pluginRoot))
const kinds = new Set(results.map((item) => item.kind))
if (kinds.size !== 3) throw new Error('插件测试矩阵未完整覆盖三类插件')
const counts = inventory(pluginRoot)

console.log(JSON.stringify({
  success: true,
  pluginRoot,
  inventory: counts,
  representatives: results
}, null, 2))
