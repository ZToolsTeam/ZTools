import { partitionMacContractScripts } from './macos-contract-tests.mjs'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readTestConcurrency } from './test-run-options.mjs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspace = path.resolve(root, '..')
const pluginProject = path.join(workspace, 'plugins', 'create-plugin')
const profile = process.argv[2]
const npmCli = process.env.npm_execpath

if (!npmCli || !fs.existsSync(npmCli)) {
  throw new Error('无法定位 npm CLI，请通过 npm run test:* 执行测试流程')
}

const nodePhase = (id, name, script, args = [], options = {}) => ({
  id,
  name,
  command: process.execPath,
  args: [path.join(root, script), ...args],
  cwd: root,
  dependencies: [],
  ...options
})

const npmPhase = (id, name, args, options = {}) => ({
  id,
  name,
  command: process.execPath,
  args: [npmCli, ...args],
  cwd: root,
  dependencies: [],
  ...options
})

// 公开源码不含内部同级项目（插件工程、安装器）与内部专用脚本：
// 阶段的 requires 中任一路径不存在时记为 NOT_RUN（不执行、不算失败），内部仓库路径齐全时行为不变
const installerProject = path.join(workspace, 'installer')
const macContracts = partitionMacContractScripts(root)

const profiles = {
  'mac-contracts': [
    npmPhase('lint', 'TypeScript 与源码边界检查', ['run', 'lint']),
    npmPhase('unit', 'Electron 单元与契约测试', ['test']),
    {
      id: 'mac-scripts', name: '第一期 Mac 源码/工具注入/合成夹具契约',
      command: process.execPath,
      args: ['--experimental-sqlite', '--test', '--test-concurrency=1', ...macContracts.runnable.map(script => path.join(root, script))],
      cwd: root, dependencies: [],
      notRunEntries: macContracts.notRun
    }
  ],
  quick: [
    npmPhase('lint', 'TypeScript 与源码边界检查', ['run', 'lint']),
    npmPhase('unit', 'Electron 单元与契约测试', ['test']),
    npmPhase('portable-contract', '多平台路径、能力与逻辑数据契约', ['run', 'test:portable-contract'])
  ],
  plugins: [
    nodePhase('runtime-matrix', '运行目录三类插件清单与资源预检', 'scripts/verify-plugin-test-matrix.mjs', [], {
      requires: [path.join(root, 'scripts', 'verify-plugin-test-matrix.mjs')]
    }),
    npmPhase('todo-unit', '纯 JS 代表插件业务测试', ['run', 'test:unit:plugin', '--', 'todo'], { cwd: pluginProject, requires: [pluginProject] }),
    npmPhase('standard-unit', '普通权限代表插件业务测试', ['run', 'test:unit:plugin', '--', 'clipboard-manager'], { cwd: pluginProject, requires: [pluginProject] }),
    npmPhase('privileged-unit', '管理员权限代表插件业务测试', ['run', 'test:unit:plugin', '--', 'context-menu'], { cwd: pluginProject, requires: [pluginProject] }),
    npmPhase(
      'plugin-build',
      '三类代表插件独立生产构建',
      ['run', 'build:single', '--', 'todo', 'clipboard-manager', 'context-menu'],
      { cwd: pluginProject, requires: [pluginProject] }
    ),
    nodePhase(
      'built-matrix',
      '三类代表插件构建产物预检',
      'scripts/verify-plugin-test-matrix.mjs',
      ['--plugin-root=../plugins/create-plugin/dist'],
      { dependencies: ['plugin-build'], requires: [path.join(root, 'scripts', 'verify-plugin-test-matrix.mjs')] }
    ),
    npmPhase('electron-build', 'Frontend 与 Electron 真实生产构建', ['run', 'build']),
    nodePhase(
      'renderer-e2e',
      '真实 Electron 三类插件页面加载与 SDK 使用',
      'scripts/test-plugin-renderers.mjs',
      [],
      { dependencies: ['plugin-build', 'electron-build'] }
    ),
    npmPhase('standard-native', '普通权限 DLL 的 NativeHost32 加载与调用', ['run', 'test:native-host32'], {
      requires: [path.join(root, 'scripts', 'build-native-test-plugins.ps1')]
    }),
    npmPhase('privileged-native', '管理员权限 DLL 的 Service 加载、调用与拒绝路径', ['run', 'test:ztools-service'])
  ],
  full: [
    npmPhase('lint', 'TypeScript 与源码边界检查', ['run', 'lint']),
    npmPhase('unit', 'Electron 单元与契约测试', ['test']),
    npmPhase('portable-contract', '多平台路径、能力与逻辑数据契约', ['run', 'test:portable-contract']),
    npmPhase('plugins', '三类插件完整测试流程', ['run', 'test:plugins'])
  ],
  release: [
    npmPhase('full', '完整开发门禁', ['run', 'test:full']),
    npmPhase('package', 'Windows x64 候选包构建', ['run', 'package:win32:x64'], {
      dependencies: ['full'], requires: [installerProject, path.join(root, 'scripts', 'package-installer.mjs')]
    }),
    npmPhase('artifacts', '候选包架构、内容与签名验证', ['run', 'verify:artifacts'], {
      dependencies: ['package'], requires: [path.join(root, 'scripts', 'verify-artifacts.mjs')]
    })
  ]
}

const phases = profiles[profile]
if (!phases) throw new Error(`未知测试流程: ${String(profile)}`)

const concurrency = readTestConcurrency()
const runId = `${profile}-${Date.now()}-${randomUUID()}`
const reportDirectory = path.join(root, 'out-test', 'test-reports')
const runDirectory = path.join(reportDirectory, runId)
fs.mkdirSync(runDirectory, { recursive: true })
// LevelDB's Windows native file APIs still require short paths for deeply nested fixtures.
const temporaryDirectory = path.join(root, 'out-test', 'tmp', randomUUID())
const npmCacheDirectory = path.join(runDirectory, 'npm-cache')
fs.mkdirSync(temporaryDirectory, { recursive: true })
fs.mkdirSync(npmCacheDirectory)
const phaseEnvironment = { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory,
  TMPDIR: temporaryDirectory, npm_config_cache: npmCacheDirectory }
const report = {
  runId,
  temporaryDirectory,
  concurrency,
  version: 1,
  profile,
  ...(profile === 'mac-contracts' ? { phase: 1, scope: 'source-and-injected-contracts', macScriptsConcurrency: 1 } : {}),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  success: false,
  phases: []
}
const statusById = new Map()

for (const phase of phases) {
  const missingRequirement = (phase.requires ?? []).find((requirement) => !fs.existsSync(requirement))
  const notRunDependency = phase.dependencies.find((dependency) => statusById.get(dependency) === 'not_run')
  if (missingRequirement || notRunDependency) {
    const reason = missingRequirement
      ? `缺少内部项目或脚本（公开源码不含）: ${missingRequirement}`
      : `依赖阶段未运行: ${notRunDependency}`
    statusById.set(phase.id, 'not_run')
    report.phases.push({ id: phase.id, name: phase.name, status: 'not_run', reason, durationMs: 0 })
    console.log(`\n[NOT_RUN] ${phase.name}: ${reason}`)
    continue
  }
  const failedDependency = phase.dependencies.find((dependency) => statusById.get(dependency) !== 'passed')
  if (failedDependency) {
    statusById.set(phase.id, 'skipped')
    report.phases.push({
      id: phase.id,
      name: phase.name,
      status: 'skipped',
      reason: `依赖阶段未通过: ${failedDependency}`,
      durationMs: 0
    })
    console.error(`\n[跳过] ${phase.name}: 依赖阶段未通过 (${failedDependency})`)
    continue
  }

  console.log(`\n[开始] ${phase.name}`)
  for (const entry of phase.notRunEntries ?? []) console.log(`[NOT_RUN] ${entry.script}: ${entry.reason}`)
  const started = Date.now()
  const logPath = path.join(runDirectory, `${phase.id}.log`)
  const logFd = fs.openSync(logPath, 'wx')
  let result
  try {
    result = spawnSync(phase.command, phase.args, {
    cwd: phase.cwd,
    env: phaseEnvironment,
    stdio: ['inherit', logFd, logFd],
    windowsHide: true
    })
  } finally {
    fs.closeSync(logFd)
  }
  console.log(`阶段完整日志: ${logPath}`)
  const durationMs = Date.now() - started
  const passed = result.status === 0 && !result.error
  const status = passed ? 'passed' : 'failed'
  statusById.set(phase.id, status)
  report.phases.push({
    id: phase.id,
    name: phase.name,
    status,
    durationMs,
    logPath,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    ...(phase.notRunEntries?.length ? { notRun: phase.notRunEntries } : {})
  })
  console[passed ? 'log' : 'error'](`[${passed ? '通过' : '失败'}] ${phase.name} (${durationMs} ms)`)
}

report.finishedAt = new Date().toISOString()
// NOT_RUN 不算失败，但会在报告与控制台单独列出
report.success = report.phases.every((phase) => phase.status === 'passed' || phase.status === 'not_run')
fs.writeFileSync(path.join(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
const reportFile = path.join(reportDirectory, `${profile}-latest.json`)
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const notRunPhases = report.phases.filter((phase) => phase.status === 'not_run').length
const notRunEntries = report.phases.reduce((count, phase) => count + (phase.notRun?.length ?? 0), 0)
if (notRunPhases + notRunEntries > 0) {
  console.log(`\nNOT_RUN: ${notRunPhases} 个阶段、${notRunEntries} 个测试脚本因缺少内部项目未运行（见报告）`)
}
console.log(`\n测试报告: ${reportFile}`)
console.log(`结果: ${report.success ? '通过' : '失败'}`)
process.exitCode = report.success ? 0 : 1
