import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { createNetworkBundle, NETWORK_HELPER_NAME } from './macos-network-bundle.mjs'

const source = fileURLToPath(new URL('../native/ZToolsMacNetwork/main.mm', import.meta.url))
export function buildMacNetwork(options) {
  return buildMacUniversalHelper({ ...options, name: NETWORK_HELPER_NAME, sources: [source],
    compilerArgs: ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security'] })
}

export function buildDevelopmentNetwork(root) {
  if (process.platform !== 'darwin') return
  buildDevelopmentHelper({ root, directory: 'mac-network-native', name: NETWORK_HELPER_NAME,
    sources: [source, path.join(path.dirname(source), 'neighbors.hpp'), fileURLToPath(import.meta.url)], build: buildMacNetwork })
  const directory = path.join(root, 'out', 'mac-network-native'), executable = path.join(directory, 'native', NETWORK_HELPER_NAME)
  if (!fs.existsSync(executable)) return
  // 开发构建只生成无受限权限的副本；macOS 27 上应提示需要正式签名权限。
  const temporary = fs.mkdtempSync(path.join(directory, '.bundle-'))
  try {
    const built = createNetworkBundle({ executable, bundlePath: path.join(temporary, `${NETWORK_HELPER_NAME}.app`),
      bundleId: 'cn.ztools.development.network-topology', minimumOs: '13.0' })
    const destination = path.join(directory, `${NETWORK_HELPER_NAME}.app`)
    // 每次替换整份开发产物，不能留下旧签名或旧描述文件。
    fs.rmSync(destination, { recursive: true, force: true })
    fs.renameSync(built.bundlePath, destination)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
