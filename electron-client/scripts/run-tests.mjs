import fs from 'node:fs'
import { readTestConcurrency } from './test-run-options.mjs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = path.join(root, 'out-test/tests')
const concurrency = readTestConcurrency()
const filter = process.argv[2]?.trim() || ''
const tests = []

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(target)
    else if (entry.name.endsWith('.test.js')) tests.push(target)
  }
}

collect(testRoot)
const selectedTests = filter
  ? tests.filter((file) => file.toLowerCase().includes(filter.toLowerCase()))
  : tests
if (selectedTests.length === 0) {
  throw new Error(filter ? `没有匹配筛选条件的编译测试: ${filter}` : '未找到编译后的测试')
}
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...selectedTests], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
