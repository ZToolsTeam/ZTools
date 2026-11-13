import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export function runNativeClipboardTests({ executable, architecture, platform = process.platform, exec = execFileSync }) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED' }
  if (!['arm64', 'x64'].includes(architecture) || !path.isAbsolute(executable)) throw new Error('INVALID_NATIVE_TEST_ARGUMENTS')
  if (!fs.lstatSync(executable).isFile()) throw new Error('INVALID_NATIVE_EXECUTABLE')
  const result = JSON.parse(exec('/usr/bin/arch', [architecture === 'x64' ? '-x86_64' : '-arm64', executable, '--self-test'],
    { shell: false, timeout: 15000, encoding: 'utf8', maxBuffer: 128 * 1024 }))
  if (result.version !== 1 || result.success !== true || result.architecture !== architecture ||
      result.scope !== 'clipboard-native-validation' || result.cases !== 11) throw new Error('NATIVE_TEST_CONTRACT_MISMATCH')
  return { status: 'PASS', ...result }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' },
      executable: { type: 'string' }, arch: { type: 'string' } } })
    if (values.help) { console.log('npm run test:native:mac:clipboard -- --executable <absolute helper> --arch <arm64|x64>'); return 0 }
    const result = runNativeClipboardTests({ executable: values.executable, architecture: values.arch })
    console.log(JSON.stringify(result))
    return result.status === 'PASS' ? 0 : 1
  } catch { console.error('MAC_CLIPBOARD_NATIVE_TEST_FAILED'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
