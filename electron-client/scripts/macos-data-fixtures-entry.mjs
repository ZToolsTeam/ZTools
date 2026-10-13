import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMacDataFixtures, verifyMacDataFixtures } from './macos-data-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
try {
  const { values } = parseArgs({ options: { output: { type: 'string' }, verify: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('npm run test:mac:fixtures:data -- --output <new absolute directory> | --verify <owned synthetic directory>')
  else {
    if (!!values.output === !!values.verify || !path.isAbsolute(values.output ?? values.verify)) throw new Error('INVALID_DATA_FIXTURE_ARGS')
    const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { cwd: root, stdio: 'inherit', shell: false })
    if (compiled.error || compiled.status !== 0) throw new Error('DATA_FIXTURE_SOURCE_BUILD_FAILED')
    console.log(JSON.stringify(values.output ? await createMacDataFixtures(values.output) : await verifyMacDataFixtures(values.verify)))
  }
} catch { console.error('MAC_DATA_FIXTURE_OPERATION_FAILED'); process.exitCode = 1 }
