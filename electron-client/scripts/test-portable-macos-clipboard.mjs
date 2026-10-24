import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, cmake: { type: 'string' } } })
  if (values.help) console.log('npm run test:native:portable:clipboard -- --cmake <absolute installed cmake executable>')
  else {
    if (!values.cmake || !path.isAbsolute(values.cmake) || !fs.statSync(values.cmake).isFile()) throw new Error('CMAKE_EXECUTABLE_REQUIRED')
    const runId = randomUUID(), output = path.join(root, 'out-test', 'clipboard-core', runId)
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output)
    let stage = 0
    const run = (exe, args) => {
      const result = spawnSync(exe, args, { cwd: root, encoding: 'utf8', shell: false, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
      fs.writeFileSync(path.join(output, `${++stage}-stage.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
      if (result.error || result.status !== 0) throw new Error('PORTABLE_NATIVE_STAGE_FAILED')
      return result.stdout
    }
    const bin = path.join(output, 'bin')
    run(values.cmake, ['-S', path.join(root, 'native', 'ZToolsMacClipboard'), '-B', path.join(output, 'build'),
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${bin}`, `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${bin}`,
      ...(process.platform === 'win32' ? ['-G', 'Visual Studio 17 2022', '-A', 'x64'] : [])])
    run(values.cmake, ['--build', path.join(output, 'build'), '--config', 'Release'])
    const executable = path.join(bin, `ZToolsClipboardValidation${process.platform === 'win32' ? '.exe' : ''}`)
    const result = JSON.parse(run(executable, []))
    if (result.version !== 1 || result.status !== 'PASS' || result.scope !== 'portable-clipboard-validation-core' || result.cases !== 18) throw new Error('INVALID_PORTABLE_NATIVE_RESULT')
    const report = { schemaVersion: 1, phase: 1, runId, platform: process.platform, arch: process.arch, output, ...result,
      pending: 'AppKit/Foundation bridge and Universal native compilation require a Mac build host' }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(report))
  }
} catch { console.error('PORTABLE_CLIPBOARD_NATIVE_TEST_FAILED'); process.exitCode = 1 }
