import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../native/ZToolsMacStartup/main.mm', import.meta.url))
export function buildMacStartup(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsMacStartup', sources: [source], compilerArgs: ['-fobjc-arc', '-framework', 'Foundation'] })
}
export function buildDevelopmentStartup(root) {
  buildDevelopmentHelper({ root, directory: 'mac-startup-native', name: 'ZToolsMacStartup', sources: [source, fileURLToPath(import.meta.url)], build: buildMacStartup })
}
