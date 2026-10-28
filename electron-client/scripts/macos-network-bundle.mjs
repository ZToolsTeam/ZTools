import fs from 'node:fs'
import path from 'node:path'
import plist from 'plist'

export const NETWORK_HELPER_NAME = 'ZToolsMacNetwork'
export const NETWORK_HELPER_BUNDLE = `Contents/Helpers/${NETWORK_HELPER_NAME}.app`
export const NETWORK_HELPER_EXECUTABLE = `${NETWORK_HELPER_BUNDLE}/Contents/MacOS/${NETWORK_HELPER_NAME}`
export const NETWORK_ENTITLEMENT = 'com.apple.developer.networking.topology-observation'
export const networkBundleId = (parentId) => `${parentId}.network-topology`

/** 受限权限必须有独立的应用包来承载描述文件；只创建在调用方预留的构建目录。 */
export function createNetworkBundle({ executable, bundlePath, bundleId, minimumOs, fsApi = fs }) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error('NETWORK_BUNDLE_ID_INVALID')
  const stat = fsApi.lstatSync(executable)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NETWORK_HELPER_INVALID')
  const contents = path.join(bundlePath, 'Contents'), macos = path.join(contents, 'MacOS')
  fsApi.mkdirSync(macos, { recursive: true })
  const target = path.join(macos, NETWORK_HELPER_NAME)
  fsApi.copyFileSync(executable, target, fs.constants.COPYFILE_EXCL)
  fsApi.chmodSync(target, 0o755)
  fsApi.writeFileSync(path.join(contents, 'Info.plist'), plist.build({
    CFBundleIdentifier: bundleId, CFBundleExecutable: NETWORK_HELPER_NAME,
    CFBundleName: NETWORK_HELPER_NAME, CFBundlePackageType: 'APPL',
    CFBundleVersion: '1', CFBundleShortVersionString: '1.0',
    LSMinimumSystemVersion: minimumOs, LSUIElement: true
  }), { flag: 'wx' })
  return { bundlePath, executable: target }
}
