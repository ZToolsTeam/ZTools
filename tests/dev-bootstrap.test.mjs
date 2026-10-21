import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveNpmRunner,
  ensureSubprojectDependencies,
  startCrossPlatformDev,
  getLatestSourceMtimeMs,
  shouldRebuildProject,
  shouldUseWindowsDesktopEscape,
  launchDetachedOnWindowsDefaultDesktop
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

function populateInstalledProbes(tmpRoot) {
  fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc'), '')
  fs.mkdirSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '')
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
    populateInstalledProbes(tmpRoot)

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
    populateInstalledProbes(tmpRoot)
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
      assert.equal(out.rebuilt, true)
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

  it('6. [增量构建命中] 当构建产物已就绪且新于业务源码时，跳过 40s 重复构建并忽略测试文件变更', () => {
    const tmpRoot = createFakeWorkspace()
    populateInstalledProbes(tmpRoot)

    const srcDir = path.join(tmpRoot, 'frontend', 'src')
    const mainSrcDir = path.join(tmpRoot, 'electron-client', 'src')
    const mainOutDir = path.join(tmpRoot, 'electron-client', 'out', 'main')
    const webOutDir = path.join(tmpRoot, 'electron-client', 'out', 'assets', 'web')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(mainSrcDir, { recursive: true })
    fs.mkdirSync(mainOutDir, { recursive: true })
    fs.mkdirSync(webOutDir, { recursive: true })

    const pastDate = new Date(Date.now() - 60_000)
    const nowDate = new Date()
    const futureTestDate = new Date(Date.now() + 60_000)

    const appVue = path.join(srcDir, 'App.vue')
    const mainTs = path.join(mainSrcDir, 'bootstrap.ts')
    const specFile = path.join(srcDir, 'app.spec.js')
    const mainArtifact = path.join(mainOutDir, 'bootstrap.js')
    const webArtifact = path.join(webOutDir, 'index.html')

    fs.writeFileSync(appVue, '<template></template>')
    fs.writeFileSync(mainTs, 'export {}')
    fs.writeFileSync(specFile, '// test file')
    fs.writeFileSync(mainArtifact, '// built main')
    fs.writeFileSync(webArtifact, '<html></html>')

    fs.utimesSync(appVue, pastDate, pastDate)
    fs.utimesSync(mainTs, pastDate, pastDate)
    fs.utimesSync(specFile, futureTestDate, futureTestDate)
    fs.utimesSync(mainArtifact, nowDate, nowDate)
    fs.utimesSync(webArtifact, nowDate, nowDate)

    const executedSteps = []
    try {
      const decision = shouldRebuildProject(tmpRoot)
      assert.deepEqual(decision, { rebuild: false, reason: 'up-to-date' })

      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: {},
        log: () => {},
        warn: () => {},
        runner: (_cmd, args) => {
          executedSteps.push(args.join(' '))
          return { status: 0 }
        }
      })
      assert.equal(out.rebuilt, false)
      assert.equal(executedSteps.some((s) => s.includes('run build')), false)
      assert.ok(executedSteps.some((s) => s.includes('electron .')))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('7. [增量构建触发] 当业务源码修改晚于产物或传入 forceBuild 时，触发重新构建并刷新锚点时间戳', () => {
    const tmpRoot = createFakeWorkspace()
    populateInstalledProbes(tmpRoot)

    const srcDir = path.join(tmpRoot, 'frontend', 'src')
    const mainOutDir = path.join(tmpRoot, 'electron-client', 'out', 'main')
    const webOutDir = path.join(tmpRoot, 'electron-client', 'out', 'assets', 'web')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(mainOutDir, { recursive: true })
    fs.mkdirSync(webOutDir, { recursive: true })

    const pastDate = new Date(Date.now() - 120_000)
    const newerDate = new Date(Date.now() - 10_000)

    const appVue = path.join(srcDir, 'App.vue')
    const mainArtifact = path.join(mainOutDir, 'bootstrap.js')
    const webArtifact = path.join(webOutDir, 'index.html')

    fs.writeFileSync(appVue, '<template>updated</template>')
    fs.writeFileSync(mainArtifact, '// old main')
    fs.writeFileSync(webArtifact, '<html>old</html>')

    fs.utimesSync(mainArtifact, pastDate, pastDate)
    fs.utimesSync(webArtifact, pastDate, pastDate)
    fs.utimesSync(appVue, newerDate, newerDate)

    try {
      const decision = shouldRebuildProject(tmpRoot)
      assert.deepEqual(decision, { rebuild: true, reason: 'frontend-source-modified' })

      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: {},
        log: () => {},
        warn: () => {},
        runner: () => ({ status: 0 })
      })
      assert.equal(out.rebuilt, true)
      // 构建完成后锚点产物时间戳已被刷新，再次检测应为 up-to-date
      assert.deepEqual(shouldRebuildProject(tmpRoot), { rebuild: false, reason: 'up-to-date' })
      // 强制构建参数覆盖缓存
      assert.deepEqual(shouldRebuildProject(tmpRoot, { forceBuild: true }), {
        rebuild: true,
        reason: 'force-build'
      })
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('8. [参数与状态异常边界] 缺失构建产物时使用 --no-build 必须抛错阻断；非法路径安全返回 0', () => {
    const tmpRoot = createFakeWorkspace()
    populateInstalledProbes(tmpRoot)
    try {
      assert.equal(getLatestSourceMtimeMs(''), 0)
      assert.equal(getLatestSourceMtimeMs(path.join(tmpRoot, 'not-exist-dir')), 0)

      assert.throws(
        () => shouldRebuildProject(tmpRoot, { noBuild: true }),
        /构建产物缺失.*无法使用 --no-build 跳过构建/
      )
      assert.throws(
        () =>
          startCrossPlatformDev({
            rootDir: tmpRoot,
            platform: 'win32',
            env: {},
            noBuild: true,
            log: () => {},
            warn: () => {}
          }),
        /构建产物缺失.*无法使用 --no-build 跳过构建/
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('9. [Windows 沙盒桌面穿透拉起] 检测到 ANTIGRAVITY_AGENT 或 exebox 隔离桌面时，通过桌面宿主独立拉起并立即返回', () => {
    const tmpRoot = createFakeWorkspace()
    populateInstalledProbes(tmpRoot)

    const clientDir = path.join(tmpRoot, 'electron-client')
    const electronExe = path.join(clientDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    const mainOutDir = path.join(clientDir, 'out', 'main')
    const webOutDir = path.join(clientDir, 'out', 'assets', 'web')
    fs.mkdirSync(path.dirname(electronExe), { recursive: true })
    fs.mkdirSync(mainOutDir, { recursive: true })
    fs.mkdirSync(webOutDir, { recursive: true })
    fs.writeFileSync(electronExe, 'mock-binary')
    fs.writeFileSync(path.join(mainOutDir, 'bootstrap.js'), '// main')
    fs.writeFileSync(path.join(webOutDir, 'index.html'), '<html></html>')

    const commands = []
    try {
      assert.equal(
        shouldUseWindowsDesktopEscape({
          platform: 'win32',
          env: { ANTIGRAVITY_AGENT: '1' },
          electronExe
        }),
        true
      )
      assert.equal(
        shouldUseWindowsDesktopEscape({
          platform: 'win32',
          env: { ZTOOLS_DESKTOP_NAME: 'exebox-PAYFOL4ANLW4' },
          electronExe
        }),
        true
      )
      assert.equal(
        shouldUseWindowsDesktopEscape({
          platform: 'win32',
          env: { ZTOOLS_DESKTOP_NAME: 'Default' },
          electronExe
        }),
        false
      )

      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: { ANTIGRAVITY_AGENT: '1' },
        log: () => {},
        warn: () => {},
        runner: (cmd, args, opts) => {
          commands.push({ cmd, args, env: opts.env })
          return { status: 0 }
        }
      })
      assert.equal(out.detached, true)
      assert.equal(out.rebuilt, false)
      assert.equal(commands.length, 1)
      assert.equal(commands[0].cmd, 'powershell.exe')
      assert.equal(commands[0].env.ZTOOLS_ELECTRON_EXE, electronExe)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('10. [沙盒桌面穿透异常与降级] 桌面宿主拉起失败时自动降级到子进程启动；缺失 electron.exe 时明确抛错', () => {
    const tmpRoot = createFakeWorkspace()
    populateInstalledProbes(tmpRoot)

    const clientDir = path.join(tmpRoot, 'electron-client')
    const mainOutDir = path.join(clientDir, 'out', 'main')
    const webOutDir = path.join(clientDir, 'out', 'assets', 'web')
    fs.mkdirSync(mainOutDir, { recursive: true })
    fs.mkdirSync(webOutDir, { recursive: true })
    fs.writeFileSync(path.join(mainOutDir, 'bootstrap.js'), '// main')
    fs.writeFileSync(path.join(webOutDir, 'index.html'), '<html></html>')

    try {
      // electron.exe 缺失时直接调用 launchDetachedOnWindowsDefaultDesktop 应抛错
      assert.throws(
        () => launchDetachedOnWindowsDefaultDesktop(clientDir),
        /未找到 Electron 可执行文件/
      )

      // 创建 electron.exe 后模拟 PowerShell 桌面宿主返回非 0 退出码，验证自动降级到 electron .
      const electronExe = path.join(clientDir, 'node_modules', 'electron', 'dist', 'electron.exe')
      fs.mkdirSync(path.dirname(electronExe), { recursive: true })
      fs.writeFileSync(electronExe, 'mock-binary')

      const warnings = []
      const executedCmds = []
      const out = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: { ANTIGRAVITY_AGENT: '1' },
        log: () => {},
        warn: (msg) => warnings.push(msg),
        runner: (cmd, args) => {
          executedCmds.push({ cmd, args: args.join(' ') })
          if (cmd === 'powershell.exe') {
            return { status: 1 }
          }
          return { status: 0 }
        }
      })
      assert.equal(out.detached, false)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /主桌面穿透拉起返回非零状态.*自动回退/)
      assert.ok(executedCmds.some((c) => c.args.includes('electron .')))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

