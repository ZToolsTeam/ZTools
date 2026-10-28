import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'

export function buildMacPathAccess(options) {
  return buildMacUniversalHelper({ ...options, name: 'ZToolsPathAccessBroker',
    sources: ['path_access.cpp', 'broker.cpp', 'trash_mac.mm'].map(name => fileURLToPath(new URL(`../native/ZToolsPathAccess/${name}`, import.meta.url))),
    compilerArgs: ['-Wall', '-Wextra', '-Werror', '-fobjc-arc', '-framework', 'Foundation'] })
}

export function buildDevelopmentPathAccess(root) {
  buildDevelopmentHelper({ root, directory: 'native/darwin-universal/path-access', name: 'ZToolsPathAccessBroker',
    sources: ['path_access.cpp', 'path_access.hpp', 'broker.cpp', 'trash_mac.mm'].map(name => fileURLToPath(new URL('../native/ZToolsPathAccess/' + name, import.meta.url))).concat(fileURLToPath(import.meta.url)),
    build: buildMacPathAccess })
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, output: { type: 'string' }, 'minimum-os': { type: 'string' } } })
    if (values.help) { console.log('npm run build:native:mac:path-access -- --output <fresh absolute directory> --minimum-os <approved major.minor[.patch]> (Main dev lookup uses <electron-client>/out/native/darwin-universal/path-access)'); return 0 }
    console.log(JSON.stringify(buildMacPathAccess({ outputRoot: values.output, minimumOs: values['minimum-os'] })))
    return 0
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'MAC_PATH_ACCESS_BUILD_FAILED'); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
