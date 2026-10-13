import fs from 'node:fs'
import path from 'node:path'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const BROKER_RELATIVE_PATH = path.join('out', 'native', 'win32-x64', 'bin', 'ZToolsPathAccessBroker.exe')

function lstatOrMissing(fileSystem, target) {
  try { return { stats: fileSystem.lstatSync(target) } }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { missing: true }
    throw error
  }
}

function requireRealDirectory(fileSystem, target) {
  const result = lstatOrMissing(fileSystem, target)
  if (result.missing) return false
  if (!result.stats.isDirectory() || result.stats.isSymbolicLink()) {
    throw new Error(`Windows PathAccessBroker 目录不是普通目录: ${target}`)
  }
  const canonical = path.resolve(fileSystem.realpathSync(target))
  const requested = path.resolve(target)
  if (process.platform === 'win32' ? canonical.toLowerCase() !== requested.toLowerCase() : canonical !== requested) {
    throw new Error(`Windows PathAccessBroker 目录经过链接: ${target}`)
  }
  return true
}

/** Copy only the builder's fixed x64 output into the packaged application's native resource directory. */
export function stageWindowsPathAccessBroker({ clientRoot, resourcesNativeDirectory, fsApi = fs }) {
  if (typeof clientRoot !== 'string' || !path.isAbsolute(clientRoot) ||
      typeof resourcesNativeDirectory !== 'string' || !path.isAbsolute(resourcesNativeDirectory)) {
    throw new Error('PATH_ACCESS_PACKAGE_ROOT_INVALID')
  }
  const root = path.resolve(clientRoot)
  const outputDirectories = [
    root,
    path.join(root, 'out'),
    path.join(root, 'out', 'native'),
    path.join(root, 'out', 'native', 'win32-x64'),
    path.join(root, 'out', 'native', 'win32-x64', 'bin')
  ]
  for (const directory of outputDirectories) {
    if (!requireRealDirectory(fsApi, directory)) return undefined
  }

  const source = path.resolve(root, BROKER_RELATIVE_PATH)
  const sourceEntry = lstatOrMissing(fsApi, source)
  if (sourceEntry.missing) return undefined
  if (!sourceEntry.stats.isFile() || sourceEntry.stats.isSymbolicLink() || path.basename(source) !== 'ZToolsPathAccessBroker.exe') {
    throw new Error(`Windows PathAccessBroker 不是受控普通文件: ${source}`)
  }
  const canonicalSource = path.resolve(fsApi.realpathSync(source))
  if (process.platform === 'win32' ? canonicalSource.toLowerCase() !== source.toLowerCase() : canonicalSource !== source) {
    throw new Error(`Windows PathAccessBroker 文件经过链接: ${source}`)
  }
  assertPeMachine(source, PE_MACHINE_X64, 'ZToolsPathAccessBroker')

  const destinationDirectory = path.resolve(resourcesNativeDirectory)
  if (!requireRealDirectory(fsApi, destinationDirectory)) {
    throw new Error(`Windows native 资源目录不存在: ${destinationDirectory}`)
  }
  const destination = path.join(destinationDirectory, 'ZToolsPathAccessBroker.exe')
  fsApi.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  return destination
}
