import { fileURLToPath } from 'node:url'
import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
const source = fileURLToPath(new URL('../native/ZToolsMacDisplay/main.mm', import.meta.url))
const headers = ['ddc_packet.hpp', 'change_policy.hpp'].map(name => fileURLToPath(new URL('../native/ZToolsMacDisplay/' + name, import.meta.url)))
export function buildMacDisplay(options) {
  const result = buildMacUniversalHelper({ ...options, name: 'ZToolsMacDisplay', sources: [source], compilerArgs: ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'IOKit'] })
  return { ...result, notice: fileURLToPath(new URL('../native/ZToolsMacDisplay/NOTICE.md', import.meta.url)) }
}
export function buildDevelopmentDisplay(root) {
  buildDevelopmentHelper({ root, directory: 'mac-display-native', name: 'ZToolsMacDisplay', sources: [source, ...headers, fileURLToPath(import.meta.url)], build: buildMacDisplay })
}
