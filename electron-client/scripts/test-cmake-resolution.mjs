import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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
  return { root, bin, env, write, run, runFile, vswhere }
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
  })
  await t.test('PATH 未配置时识别标准目录及空格路径', (t) => {
    const f = fixture(t)
    const expected = f.write(path.join(f.env.ProgramFiles, 'CMake', 'bin', 'cmake.exe'))
    assertResolved(f.run(), expected)
  })
  await t.test('通过 vswhere 识别自定义位置的 Visual Studio CMake', (t) => {
    const f = fixture(t)
    const expected = f.write(path.join(f.root, 'VS Build Tools (custom)', 'cmake.exe'))
    f.vswhere(expected)
    assertResolved(f.run(), expected)
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
})
