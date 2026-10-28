import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const scriptsRoot = import.meta.dirname
const resolver = path.join(scriptsRoot, 'resolve-cmake.ps1')
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-cmake-'))
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('ztools-cmake-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const bin = path.join(root, 'tools')
  fs.mkdirSync(bin)
  // 只隔离工具探测输入，不读取测试机已经安装的 Visual Studio 或 CMake。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['path', 'programfiles', 'programfiles(x86)', 'programw6432'].includes(key.toLowerCase())))
  Object.assign(env, {
    PATH: bin,
    ProgramFiles: path.join(root, 'Program Files'),
    'ProgramFiles(x86)': path.join(root, 'Program Files (x86)'),
    ProgramW6432: path.join(root, 'Program Files'),
  })
  const write = (file, content = '') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return file
  }
  const sidecarScripts = path.join(root, "client's 测试", 'scripts')
  fs.mkdirSync(sidecarScripts, { recursive: true })
  for (const file of ['build-sidecars.mjs', 'resolve-cmake.ps1', 'windows-pe-architecture.mjs']) {
    fs.copyFileSync(path.join(scriptsRoot, file), path.join(sidecarScripts, file))
  }
  const sidecarModuleUrl = pathToFileURL(path.join(sidecarScripts, 'build-sidecars.mjs')).href
  const runSidecar = (script) => spawnSync(process.execPath, [
    '--input-type=module', '-e', `import { findCmake, buildPathAccessBroker } from ${JSON.stringify(sidecarModuleUrl)}; ${script}`,
  ], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 20000 })
  const invoke = (args) => spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  const run = (script = `. ${quote(resolver)}; Resolve-ZToolsCMake`) => invoke([
    '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64'),
  ])
  const runFile = (file) => invoke(['-File', file])
  const vswhere = (candidate, exitCode = 0) => {
    const escaped = candidate.replace(/[\^&|<>()]/g, '^$&')
    write(path.join(bin, 'vswhere.cmd'), `@echo off\r\necho ${escaped}\r\nexit /b ${exitCode}\r\n`)
  }
  return { root, bin, env, write, run, runFile, vswhere, runSidecar, sidecarModuleUrl, sidecarScripts }
}

function assertResolved(result, expected) {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), expected)
  assert.equal(result.stderr, '')
}

test('CMake 查找覆盖路径优先级、标准安装目录、VS Build Tools 和失败路径', {
  skip: process.platform !== 'win32',
}, async (t) => {
  await t.test('PATH 中的 CMake 优先于标准目录', (t) => {
    const f = fixture(t)
    const expected = f.write(path.join(f.bin, 'cmake.exe'))
    f.write(path.join(f.env.ProgramFiles, 'CMake', 'bin', 'cmake.exe'))
    assertResolved(f.run(), expected)
    assertResolved(f.runSidecar('console.log(findCmake())'), expected)
  })
  await t.test('PATH 未配置时识别标准目录及空格路径', (t) => {
    const f = fixture(t)
    const expected = f.write(path.join(f.env.ProgramFiles, 'CMake', 'bin', 'cmake.exe'))
    assertResolved(f.run(), expected)
    assertResolved(f.runSidecar('console.log(findCmake())'), expected)
  })
  await t.test('通过 vswhere 识别自定义位置的 Visual Studio CMake', (t) => {
    const f = fixture(t)
    const expected = f.write(path.join(f.root, 'VS Build Tools (custom)', 'cmake.exe'))
    f.vswhere(expected)
    assertResolved(f.run(), expected)
    assertResolved(f.runSidecar('console.log(findCmake())'), expected)
  })
  await t.test('Node 入口保留 CMake 路径中的中文和单引号', (context) => {
    const fixtureData = fixture(context)
    fixtureData.env.ProgramFiles = path.join(fixtureData.root, "CMake 工具's 安装")
    fixtureData.env.ProgramW6432 = fixtureData.env.ProgramFiles
    const expected = fixtureData.write(path.join(fixtureData.env.ProgramFiles, 'CMake', 'bin', 'cmake.exe'))
    assertResolved(fixtureData.runSidecar('console.log(findCmake())'), expected)
  })
  await t.test('PowerShell 无法启动时保留系统错误并且不创建构建目录', (context) => {
    const fixtureData = fixture(context)
    const result = fixtureData.runSidecar(`process.env.SystemRoot = ${JSON.stringify(path.join(fixtureData.root, 'missing-system'))}; buildPathAccessBroker()`)
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /CMake discovery failed.*ENOENT/)
    assert.equal(fs.existsSync(path.join(fixtureData.sidecarScripts, '..', 'out')), false)
  })
  for (const scenario of [
    { name: '未安装 CMake', message: /CMake not found/ },
    { name: 'vswhere 返回已不存在的路径', message: /CMake not found/, exitCode: 0 },
    { name: 'vswhere 执行失败', message: /discovery failed \(exit 7\)/, exitCode: 7 },
  ]) {
    await t.test(scenario.name, (t) => {
      const f = fixture(t)
      if (scenario.exitCode !== undefined) f.vswhere(path.join(f.root, 'missing.exe'), scenario.exitCode)
      const result = f.run()
      assert.ifError(result.error)
      assert.equal(result.status, 1)
      assert.match(result.stderr, scenario.message)
      assert.equal(result.stdout, '')
      const sidecarResult = f.runSidecar('buildPathAccessBroker()')
      assert.ifError(sidecarResult.error)
      assert.equal(sidecarResult.status, 1)
      assert.match(sidecarResult.stderr, scenario.message)
      assert.equal(sidecarResult.stdout, '')
      assert.equal(fs.existsSync(path.join(f.sidecarScripts, '..', 'out')), false)
    })
  }
  for (const entry of ['build-native-host32.ps1', 'build-ztools-service.ps1']) {
    await t.test(`${entry} 调用共同探测入口，并传播 CMake 配置失败`, (t) => {
      const f = fixture(t)
      const copiedScripts = path.join(f.root, 'client', 'scripts')
      fs.mkdirSync(copiedScripts, { recursive: true })
      for (const file of [entry, 'resolve-cmake.ps1']) {
        fs.copyFileSync(path.join(scriptsRoot, file), path.join(copiedScripts, file))
      }
      f.write(path.join(f.root, 'client', 'package.json'), JSON.stringify({ version: '1.2.3.4' }))
      // 用真实可执行文件在进程边界注入错误：Node 拒绝 CMake 的 -S 参数，退出码为 9。
      fs.copyFileSync(process.execPath, path.join(f.bin, 'cmake.exe'))
      const result = f.runFile(path.join(copiedScripts, entry))
      assert.ifError(result.error)
      assert.equal(result.status, 9, result.stdout + result.stderr)
      assert.match(result.stderr, /bad option: -S/)
      for (const output of ['win32-ia32/ZToolsNativeHost32.exe', 'service-win32-ia32/ZToolsService.exe']) {
        assert.equal(fs.existsSync(path.join(f.root, 'client', 'out', 'native', output)), false)
      }
    })
  }
  await t.test('辅助进程入口使用 VS CMake，并保留配置失败的退出码和输出', (context) => {
    const fixtureData = fixture(context)
    const cmake = fixtureData.write(path.join(fixtureData.root, 'VS Build Tools', 'cmake.exe'))
    fs.copyFileSync(process.execPath, cmake)
    fixtureData.vswhere(cmake)
    const result = fixtureData.runSidecar('buildPathAccessBroker()')
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /bad option: -S/)
    assert.match(result.stderr, /Failed to configure ZToolsPathAccessBroker.*exited with 9/)
    assert.doesNotMatch(result.stdout + result.stderr, /^undefined\r?$|exited with null|Successfully built|\[cause\]: undefined/m)
  })
})

test('辅助进程构建验证成功产物和进程失败边界', async (context) => {
  await context.test('配置与构建成功后校验 x64 产物及 SHA-256', async (context) => {
    const fixtureData = fixture(context)
    const { buildSidecar } = await import(fixtureData.sidecarModuleUrl)
    const binary = Buffer.alloc(128)
    binary.write('MZ')
    binary.writeUInt32LE(64, 0x3c)
    binary.write('PE\0\0', 64)
    binary.writeUInt16LE(0x8664, 68)
    const calls = []
    let outputDirectory
    const result = buildSidecar('ZToolsPathAccessBroker', fixtureData.root, {
      cmake: process.execPath,
      run: (executable, args, options) => {
        calls.push({ executable, args, options })
        if (args[0] === '--build') {
          fs.writeFileSync(path.join(outputDirectory, 'ZToolsPathAccessBroker.exe'), binary)
        } else {
          outputDirectory = args.find((argument) => argument.startsWith('-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=')).split('=').slice(1).join('=')
        }
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].args[calls[0].args.indexOf('-A') + 1], 'x64')
    assert.deepEqual(calls.map((call) => call.options.shell), [false, false])
    assert.equal(calls[1].args.at(-1), 'ZToolsPathAccessBroker')
    assert.equal(result.exePath, path.join(outputDirectory, 'ZToolsPathAccessBroker.exe'))
    assert.equal(result.sha256, createHash('sha256').update(binary).digest('hex'))
  })
  for (const stage of ['configure', 'build']) {
    for (const failure of [
      { name: '启动失败', result: { status: null, error: Object.assign(new Error('spawn cmake ENOENT'), { code: 'ENOENT' }) }, pattern: /ENOENT/ },
      { name: '非零退出', result: { status: 7, stdout: 'compiler output', stderr: 'compiler failure' }, pattern: /exited with 7/ },
      { name: '信号终止', result: { status: null, signal: 'SIGTERM' }, pattern: /terminated by SIGTERM/ },
      { name: '超时', result: { status: null, error: new Error('spawn cmake ETIMEDOUT') }, pattern: /ETIMEDOUT/ },
    ]) {
      await context.test(`${stage} ${failure.name} 不丢失错误且停止后续阶段`, async (context) => {
        const fixtureData = fixture(context)
        const { buildSidecar } = await import(fixtureData.sidecarModuleUrl)
        const errors = []
        context.mock.method(console, 'error', (message) => errors.push(message))
        let calls = 0
        assert.throws(() => buildSidecar('ZToolsPathAccessBroker', fixtureData.root, {
          cmake: process.execPath,
          run: () => {
            calls += 1
            return stage === 'build' && calls === 1 ? { status: 0 } : failure.result
          },
        }), (error) => {
          assert.match(error.message, new RegExp(`Failed to ${stage} ZToolsPathAccessBroker`))
          assert.match(error.message, failure.pattern)
          assert.equal(error.cause, failure.result.error)
          return true
        })
        assert.equal(calls, stage === 'configure' ? 1 : 2)
        assert.deepEqual(errors, [failure.result.stdout, failure.result.stderr].filter(Boolean))
        assert.equal(fs.existsSync(path.join(fixtureData.sidecarScripts, '..', 'out', 'native', 'win32-x64', 'bin', 'ZToolsPathAccessBroker.exe')), false)
      })
    }
  }
})
