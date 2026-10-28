import { buildDevelopmentHelper } from './build-macos-development-helper.mjs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { inspectMacDeployment } from './macos-minimum-os.mjs'
import { buildMacUniversalHelper } from './build-macos-universal-helper.mjs'

const source = fileURLToPath(new URL('../native/ZToolsMacAudio/main.mm', import.meta.url))
export function buildMacAudio({ outputRoot, minimumOs, platform = process.platform,
  exec = execFileSync, inspectDeployment = inspectMacDeployment }) {
  return buildMacUniversalHelper({ name: 'ZToolsMacAudio', sources: [source],
    compilerArgs: ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreAudio'],
    outputRoot, minimumOs, platform, exec, inspectDeployment })
}

export function buildDevelopmentAudio(root) {
  buildDevelopmentHelper({ root, directory: 'mac-audio-native', name: 'ZToolsMacAudio',
    sources: [source, fileURLToPath(import.meta.url)], build: buildMacAudio })
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { output: { type: 'string' }, 'minimum-os': { type: 'string' } } })
    console.log(JSON.stringify(buildMacAudio({ outputRoot: values.output, minimumOs: values['minimum-os'] })))
    return 0
  } catch (error) { console.error(error.message); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
