import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../native/ZToolsMacDns/main.mm', import.meta.url))
export function buildMacDns(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsMacDns', sources: [source],
    compilerArgs: ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'SystemConfiguration', '-framework', 'Security'] })
}
export function buildDevelopmentDns(root) {
  buildDevelopmentHelper({ root, directory: 'mac-dns-native', name: 'ZToolsMacDns',
    sources: [source, fileURLToPath(import.meta.url)], build: buildMacDns })
}
