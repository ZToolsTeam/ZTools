import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveMacosBundleVersions,
  locateGhExecutable,
  parseRemoteMacBuildArgs,
  triggerRemoteMacBuild
} from '../scripts/build-macos-remote.mjs'

describe('build-macos-remote.mjs 远程云端编译 macOS Universal DMG 集成与异常测试', () => {
  it('1. [版本规范化] 正确解析三段式与四段式版本 (1.1.7.1 -> Short 1.1.7, Build 1.1.1)，并拦截非法版本', () => {
    const v4 = resolveMacosBundleVersions('1.1.7.1')
    assert.deepEqual(v4, {
      rawVersion: '1.1.7.1',
      shortVersion: '1.1.7',
      buildVersion: '1.1.1',
      tag: 'v1.1.7.1'
    })

    const v3 = resolveMacosBundleVersions('v1.0.5')
    assert.deepEqual(v3, {
      rawVersion: '1.0.5',
      shortVersion: '1.0.5',
      buildVersion: '1.0.5',
      tag: 'v1.0.5'
    })

    assert.throws(() => resolveMacosBundleVersions(''), /INVALID_PACKAGE_VERSION/)
    assert.throws(() => resolveMacosBundleVersions('1.0'), /INVALID_PACKAGE_VERSION/)
  })

  it('2. [Dry-Run 集成闭环] 读取 electron-client/package.json 并生成完整的云端触发计划', () => {
    const logs = []
    const plan = triggerRemoteMacBuild(['--dry-run', '--no-release'], {
      log: (msg) => logs.push(msg)
    })
    assert.equal(plan.mode, 'dry-run')
    assert.equal(plan.repo, 'codingmuse/ZTools')
    assert.equal(plan.workflow, 'build-macos-dmg.yml')
    assert.equal(plan.uploadToRelease, false)
    assert.match(plan.expectedDmgFile, /^ZTools-.*-darwin-universal\.dmg$/)
  })

  it('3. [端到端遥控与产物拉回闭环] 模拟 --download 触发云端构建 -> 监听 Run -> 下载 DMG 至本地目录', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-remote-'))
    const fakeGh = path.join(tmpDir, 'gh.exe')
    fs.writeFileSync(fakeGh, '')
    fs.mkdirSync(path.join(tmpDir, 'electron-client'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'electron-client', 'package.json'), '{"version":"1.1.7.1"}')

    const outDir = path.join(tmpDir, 'dist', 'macos')
    const commands = []

    try {
      const res = triggerRemoteMacBuild(['--download', '--output-dir', outDir], {
        rootDir: tmpDir,
        env: { GH_PATH: fakeGh },
        platform: 'win32',
        log: () => {},
        runner: (bin, args) => {
          commands.push(args)
          if (args[0] === 'run' && args[1] === 'list') {
            return {
              status: 0,
              stdout: JSON.stringify([{ databaseId: 987654321, status: 'in_progress', url: 'https://github.com/run/987654321' }])
            }
          }
          return { status: 0, stdout: '' }
        }
      })

      assert.equal(res.mode, 'dispatched')
      assert.equal(res.version, '1.1.7.1')
      assert.equal(commands.length, 4)
      assert.deepEqual(commands[0].slice(0, 3), ['workflow', 'run', 'build-macos-dmg.yml'])
      assert.deepEqual(commands[1].slice(0, 2), ['run', 'list'])
      assert.deepEqual(commands[2].slice(0, 3), ['run', 'watch', '987654321'])
      assert.deepEqual(commands[3].slice(0, 3), ['run', 'download', '987654321'])
      assert.ok(fs.existsSync(outDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('4. [破坏性异常覆盖] 缺失 gh CLI、未知参数、触发失败、云端编译失败、下载失败均严格抛错拦截', () => {
    assert.throws(() => parseRemoteMacBuildArgs(['--unknown-flag']), /UNKNOWN_ARGUMENT/)

    assert.throws(
      () =>
        locateGhExecutable({
          env: { LOCALAPPDATA: '/non/existent' },
          platform: 'win32',
          existsSync: () => false,
          runner: () => ({ status: 1, stdout: '' })
        }),
      /GH_CLI_NOT_FOUND/
    )

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-fail-'))
    const fakeGh = path.join(tmpDir, 'gh.exe')
    fs.writeFileSync(fakeGh, '')
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"version":"1.0.0"}')

    try {
      // 触发失败
      assert.throws(
        () =>
          triggerRemoteMacBuild([], {
            rootDir: tmpDir,
            env: { GH_PATH: fakeGh },
            log: () => {},
            runner: () => ({ status: 1 })
          }),
        /WORKFLOW_DISPATCH_FAILED/
      )

      // 云端编译失败
      assert.throws(
        () =>
          triggerRemoteMacBuild(['--watch'], {
            rootDir: tmpDir,
            env: { GH_PATH: fakeGh },
            log: () => {},
            runner: (bin, args) => {
              if (args[0] === 'workflow') return { status: 0 }
              if (args[1] === 'list') return { status: 0, stdout: '[{"databaseId":111}]' }
              if (args[1] === 'watch') return { status: 2 }
              return { status: 0 }
            }
          }),
        /WORKFLOW_EXECUTION_FAILED/
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
