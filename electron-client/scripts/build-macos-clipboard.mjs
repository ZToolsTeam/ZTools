import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectMacDeployment } from './macos-minimum-os.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'

export function buildMacClipboard({ outputRoot, minimumOs, platform = process.platform,
  exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  const source = fileURLToPath(new URL('../native/ZToolsMacClipboard/main.mm', import.meta.url))
  return buildMacUniversalHelper({ name: 'ZToolsMacClipboard', sources: [source],
    compilerArgs: ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'Foundation', '-framework', 'CoreFoundation'],
    outputRoot, minimumOs, platform, exec, inspectDeployment })
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
