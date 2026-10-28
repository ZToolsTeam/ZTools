import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('../native/ZToolsMacInputLock/main.mm', import.meta.url))
const policy = fileURLToPath(new URL('../native/ZToolsMacInputLock/lock_policy.hpp', import.meta.url))
export function buildMacInputLock(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsMacInputLock', sources: [source],
    compilerArgs: ['-fobjc-arc', '-framework', 'ApplicationServices', '-framework', 'Carbon'] })
}
export function buildDevelopmentInputLock(root) {
  buildDevelopmentHelper({ root, directory: 'mac-input-lock-native', name: 'ZToolsMacInputLock',
    sources: [source, policy, fileURLToPath(import.meta.url)], build: buildMacInputLock })
}
