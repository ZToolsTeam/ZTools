import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../native/ZToolsMacHotkeys/main.mm', import.meta.url))
export function buildMacHotkeys(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsMacHotkeys', sources: [source], compilerArgs: ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Carbon'] })
}
export function buildDevelopmentHotkeys(root) {
  buildDevelopmentHelper({ root, directory: 'mac-hotkeys-native', name: 'ZToolsMacHotkeys', sources: [source, fileURLToPath(import.meta.url)], build: buildMacHotkeys })
}
