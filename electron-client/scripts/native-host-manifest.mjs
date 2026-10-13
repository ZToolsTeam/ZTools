import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertPeMachine, PE_MACHINE_X86 } from './windows-pe-architecture.mjs'

// This build-time allowlist is independent from untrusted plugin manifests.
export function createNativeHostManifest(clientRoot, declarations) {
  const seen = new Set()
  const plugins = declarations.map((declaration) => {
    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
    if (!identifier.test(declaration.pluginId) || !identifier.test(declaration.dllId) ||
        !/^lib\/[A-Za-z_][A-Za-z0-9_.-]{0,127}\.dll$/.test(declaration.path) ||
        !['bin', 'plugins'].includes(declaration.source) ||
        !Array.isArray(declaration.functions) || declaration.functions.length === 0 ||
        declaration.functions.some((name) => !identifier.test(name)) ||
        new Set(declaration.functions).size !== declaration.functions.length ||
        seen.has(declaration.pluginId)) {
      throw new Error('NativeHost32 构建信任声明无效')
    }
    seen.add(declaration.pluginId)
    const pluginRoot = path.resolve(clientRoot, '..', ...(declaration.source === 'bin'
      ? ['bin', 'Data', 'Plugins'] : ['plugins', 'create-plugin', 'src', 'plugins']))
    const dllPath = path.join(pluginRoot, declaration.pluginId, ...declaration.path.split('/'))
    const stats = fs.lstatSync(dllPath)
    const relative = path.relative(fs.realpathSync(pluginRoot), fs.realpathSync(dllPath))
    if (!stats.isFile() || stats.isSymbolicLink() || relative.startsWith(`..${path.sep}`) ||
        relative === '..' || path.isAbsolute(relative)) {
      throw new Error('NativeHost32 构建 DLL 必须是源目录内普通文件')
    }
    assertPeMachine(dllPath, PE_MACHINE_X86, 'NativeHost32 受信 DLL')
    const sha256 = createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex')
    return [
      `  <plugin id="${declaration.pluginId}">`,
      `    <dll id="${declaration.dllId}" path="${declaration.path}" sha256="${sha256}" arch="x86">`,
      ...declaration.functions.map((name) => `      <function name="${name}"/>`),
      '    </dll>',
      '  </plugin>'
    ].join('\n')
  }).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<nativeHostManifest version="1">\n${plugins}\n</nativeHostManifest>\n`
}

export function readNativeHostManifest(clientRoot) {
  const declarations = JSON.parse(fs.readFileSync(
    path.join(clientRoot, 'resources', 'native', 'native-host-dlls.json'), 'utf8'))
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new Error('NativeHost32 构建信任声明不能为空')
  }
  return createNativeHostManifest(clientRoot, declarations)
}
