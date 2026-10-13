import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.includes('--help')) {
  console.log('test:reference:zip — 第一期共享ZIP provider/SDK注入测试（Windows/macOS Node >=22.12）；不代表生产SDK2或native grant/App验收。无需参数，报告写入全新out-test/reference-zip/<runId>/。')
} else if (process.argv.length > 2) {
  console.error('未知参数；使用 --help 查看入口'); process.exitCode = 1
} else {
  const runId = randomUUID(), startedAt = new Date().toISOString(), directory = path.join(root, 'out-test', 'reference-zip', runId)
  await mkdir(path.dirname(directory), { recursive: true }); await mkdir(directory)
  const env = { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory }
  const major = Number(process.versions.node.split('.')[0]), minor = Number(process.versions.node.split('.')[1])
  let status = 'FAIL', tests = 0, stage = 'preflight'
  try {
    if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node >=22.12 required')
    for (const [name, args] of [
      ['compile', [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.test.json'), '--outDir', path.join(directory, 'compiled')]],
      ['tests', ['--test', '--test-reporter=tap', path.join(directory, 'compiled/tests/unit/reference-zip-service.test.js'), path.join(directory, 'compiled/tests/unit/reference-zip-compression.test.js'), path.join(directory, 'compiled/tests/unit/reference-zip-extraction.test.js')]]
    ]) {
      stage = name; console.log('[开始] ' + name)
      const child = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
      const output = (child.stdout ?? '') + (child.stderr ?? '')
      await writeFile(path.join(directory, name + '.log'), output)
      if (child.error || child.status !== 0) throw new Error(name + ' failed; see owned log')
      if (name === 'tests') {
        tests = Number(/# tests (\d+)/.exec(output)?.[1] ?? 0)
        if (!tests) throw new Error('test count missing')
      }
      console.log('[通过] ' + name)
    }
    status = 'PASS'
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ runId, phase: 'phase1', scope: 'zip-provider-library-and-sdk-injection', status, stage, tests, platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, startedAt, endedAt: new Date().toISOString(), productionSdk2Acceptance: false, nativeGrantIo: false, macAppAcceptance: 'NOT_RUN' }, null, 2) + String.fromCharCode(10))
  console.log('报告: ' + path.join(directory, 'report.json'))
}
