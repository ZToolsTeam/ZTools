import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectMacDeployment } from './macos-minimum-os.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'
import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'

const source = fileURLToPath(new URL('../native/ZToolsMacClipboard/main.mm', import.meta.url))
const pasteSource = fileURLToPath(new URL('../native/ZToolsMacClipboard/paste_session.mm', import.meta.url))

export function buildMacClipboard({ outputRoot, minimumOs, platform = process.platform,
  exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  return buildMacUniversalHelper({ name: 'ZToolsMacClipboard', sources: [source, pasteSource],
    compilerArgs: ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'Foundation', '-framework', 'CoreFoundation', '-framework', 'ApplicationServices', '-framework', 'Carbon'],
    outputRoot, minimumOs, platform, exec, inspectDeployment })
}

export function buildDevelopmentClipboard(root) {
  const headers = ['paste_session.h', 'validation.hpp'].map(name =>
    fileURLToPath(new URL(`../native/ZToolsMacClipboard/${name}`, import.meta.url)))
  buildDevelopmentHelper({ root, directory: 'mac-clipboard-native', name: 'ZToolsMacClipboard',
    sources: [source, pasteSource, ...headers, fileURLToPath(import.meta.url)], build: buildMacClipboard })
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      help: { type: 'boolean' }, output: { type: 'string' }, 'minimum-os': { type: 'string' }
    } })
    if (values.help) { console.log('npm run build:native:mac:clipboard -- --output <fresh absolute directory> --minimum-os <approved major.minor[.patch]>'); return 0 }
    console.log(JSON.stringify(buildMacClipboard({ outputRoot: values.output, minimumOs: values['minimum-os'] })))
    return 0
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'MAC_CLIPBOARD_BUILD_FAILED'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
