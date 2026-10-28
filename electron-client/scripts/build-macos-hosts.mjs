import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../native/ZToolsMacHosts/main.mm', import.meta.url))
export function buildMacHosts(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsMacHosts', sources: [source], compilerArgs: ['-fobjc-arc', '-framework', 'Foundation'] })
}
export function buildDevelopmentHosts(root) {
  buildDevelopmentHelper({ root, directory: 'mac-hosts-native', name: 'ZToolsMacHosts', sources: [source, fileURLToPath(import.meta.url)], build: buildMacHosts })
}
