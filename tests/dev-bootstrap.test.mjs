import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveNpmRunner,
  ensureSubprojectDependencies,
  startCrossPlatformDev
} from '../scripts/dev-bootstrap.mjs'

function createFakeWorkspace() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-bootstrap-test-'))
  fs.mkdirSync(path.join(tmpRoot, 'electron-client'), { recursive: true })
  fs.mkdirSync(path.join(tmpRoot, 'frontend'), { recursive: true })
  fs.mkdirSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist'), { recursive: true })

  fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'package.json'), '{"name":"client"}')
  fs.writeFileSync(path.join(tmpRoot, 'frontend', 'package.json'), '{"name":"frontend"}')
  fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'package.json'), '{"name":"@ztools/declarative-ui"}')
  fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist', 'index.js'), 'export {}')
  fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist', 'index.d.ts'), 'export {}')
  return tmpRoot
}

describe('dev-bootstrap.mjs 跨平台零门槛安装与启动引导集成与异常测试', () => {
  it('1. [依赖自动补齐] 当 electron-client 与 frontend 缺少 node_modules 时自动执行 npm install', () => {
    const tmpRoot = createFakeWorkspace()
    const calls = []
    try {
      const res = ensureSubprojectDependencies({
        rootDir: tmpRoot,
        platform: 'darwin',
        env: {},
        log: () => {},
        runner: (cmd, args, opts) => {
          calls.push({ cmd, args, cwd: opts.cwd })
          return { status: 0 }
        }
      })
      assert.deepEqual(res.installed, ['electron-client', 'frontend'])
      assert.equal(calls.length, 2)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('2. [macOS 启动闭环] darwin 平台自动派发 start:mac', () => {
    const tmpRoot = createFakeWorkspace()
    // 模拟已安装 node_modules
    fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc'), '')
    fs.mkdirSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '')

    const runArgs = []
    try {
      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'darwin',
        env: {},
        log: () => {},
        warn: () => {},
        runner: (cmd, args) => {
          runArgs.push(args)
          return { status: 0 }
        }
      })
      assert.equal(out.platform, 'darwin')
      assert.ok(runArgs.some((a) => a.includes('start:mac')))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('3. [破坏性异常容错] Windows 下无 CMake/VS2022 C++ 环境导致 build:native-host32 失败时，自动降级跳过并继续启动 Electron', () => {
    const tmpRoot = createFakeWorkspace()
    fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc'), '')
    fs.mkdirSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '')
    fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'native'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'native', 'CMakeLists.txt'), '# mock cmake')

    const executedSteps = []
    const warnings = []
    try {
      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: {},
        log: () => {},
        warn: (msg) => warnings.push(msg),
        runner: (cmd, args) => {
          const step = args.join(' ')
          executedSteps.push(step)
          if (step.includes('build:native-host32')) {
            return { status: 1 } // 模拟无 CMake / VS2022 报错
          }
          return { status: 0 }
        }
      })
      assert.equal(out.platform, 'win32')
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /已自动跳过可选的 32 位 NativeHost32 编译/)
      assert.ok(executedSteps.some((s) => s.includes('run build')))
      assert.ok(executedSteps.some((s) => s.includes('electron .')))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('4. [破坏性异常拦截] 子工程 npm install 失败或核心 TS 编译失败时必须明确抛错阻断', () => {
    const tmpRoot = createFakeWorkspace()
    try {
      assert.throws(
        () =>
          ensureSubprojectDependencies({
            rootDir: tmpRoot,
            platform: 'win32',
            env: {},
            log: () => {},
            runner: () => ({ status: 127 })
          }),
        /electron-client 依赖安装失败（退出码 127）/
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('5. [环境探测] resolveNpmRunner 优先复用合法的 npm_execpath，不存在时回退平台 npm 命令', () => {
    const fallbackWin = resolveNpmRunner({ npm_execpath: '/non/existent/npm-cli.js' }, 'win32')
    assert.equal(fallbackWin.command, 'npm.cmd')
    assert.equal(fallbackWin.shell, true)

    const fallbackMac = resolveNpmRunner({}, 'darwin')
    assert.equal(fallbackMac.command, 'npm')
    assert.equal(fallbackMac.shell, false)
  })
})
