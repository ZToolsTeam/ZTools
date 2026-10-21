import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyChangedPlugins, compareVersions, renderSummary } from '../scripts/verify-changed-plugins.mjs'

/**
 * 在临时目录搭一个与公开插件仓库（ZTools-extensions）同结构的真实 git 仓库：
 * base 分支是线上状态，PR 分支做改动，真实运行安全扫描、tsc 编译与插件自带测试。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realTsc = path.join(repoRoot, 'node_modules/.bin/tsc')
const realNodeTypes = [
  path.join(repoRoot, 'node_modules/@types/node'),
  path.join(repoRoot, 'electron-client/node_modules/@types/node'),
  path.join(repoRoot, 'frontend/node_modules/@types/node')
].find((p) => fs.existsSync(p))

const TARGETS = [
  { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' },
  { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
]

function manifest(id, version, extra = {}) {
  return {
    id,
    name: `插件 ${id}`,
    version,
    description: '测试插件',
    author: 'ztools-team',
    entry: 'dist/index.js',
    icon: 'icon.svg',
    permissions: [],
    targets: TARGETS,
    nativeComponents: [],
    ...extra
  }
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ES2022', strict: true, skipLibCheck: true, outDir: 'dist', rootDir: 'src' },
  include: ['src/**/*']
})

function write(root, rel, content) {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}

function addPlugin(root, dir, id, version, { code, extra, testCode } = {}) {
  write(root, `${dir}/plugin.json`, manifest(id, version, extra))
  write(root, `${dir}/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  write(root, `${dir}/tsconfig.json`, TSCONFIG)
  write(root, `${dir}/src/index.ts`, code ?? 'export default function Command(): string {\n  return "ok"\n}\n')
  if (testCode) write(root, `${dir}/tests/index.test.mjs`, testCode)
}

function sh(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-verify-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'ci@example.com')
  sh(root, 'config', 'user.name', 'ci')
  // 与公开仓库一致：构建脚本在根目录 scripts/，依赖在根目录 node_modules/
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(path.join(repoRoot, 'plugins/scripts/build-declarative.mjs'), path.join(root, 'scripts/build-declarative.mjs'))
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules/@types'), { recursive: true })
  fs.symlinkSync(fs.realpathSync(realTsc), path.join(root, 'node_modules/.bin/tsc'))
  fs.symlinkSync(realNodeTypes, path.join(root, 'node_modules/@types/node'))
  write(root, '.gitignore', 'node_modules/\ndist/\n')
  write(root, 'extensions/shared/hash.ts', 'export const H = 1\n')
  addPlugin(root, 'extensions/alpha', 'alpha', '1.0.0')
  addPlugin(root, 'extensions/beta', 'beta', '2.0.0')
  addPlugin(root, 'extensions/official/gamma', 'gamma', '1.0.0')
  addPlugin(root, 'extensions/uses-shared', 'uses-shared', '1.0.0')
  write(root, 'extensions/uses-shared/src/hash.ts', 'export const H = 1\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-qm', 'base')
  sh(root, 'checkout', '-qb', 'pr')
  return root
}

function commit(root) {
  sh(root, 'add', '-A')
  sh(root, 'commit', '-qm', 'pr change', '--allow-empty')
}

const resultOf = (report, dir) => report.results.find((r) => r.dir === dir)

test('插件 PR 合并前检查（真实 git 仓库 + 真实扫描/编译/测试）', { skip: !fs.existsSync(realTsc) || !realNodeTypes }, async (t) => {
  const repos = []
  t.after(() => repos.forEach((r) => fs.rmSync(r, { recursive: true, force: true })))
  const fresh = () => {
    const r = createRepo()
    repos.push(r)
    return r
  }

  await t.test('1. 改了插件且升了版本：通过，只检查这一个插件', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/alpha', 'alpha', '1.0.1', { code: 'export default function Command(): string {\n  return "v2"\n}\n' })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, true, JSON.stringify(report.results))
    assert.deepEqual(report.checked, ['extensions/alpha'])
    assert.ok(resultOf(report, 'extensions/alpha').notes.includes('版本 1.0.0 → 1.0.1'))
    assert.ok(fs.existsSync(path.join(root, 'extensions/alpha/dist/index.js')), '必须真的从源码编译出入口文件')
  })

  await t.test('2. 改了代码没升版本：拦截', async () => {
    const root = fresh()
    write(root, 'extensions/beta/src/index.ts', 'export default function Command(): string {\n  return "changed"\n}\n')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/beta').errors.join('\n'), /必须升版本号.*需大于 2\.0\.0/)
  })

  await t.test('3. 版本号反而降低或写成非法格式：拦截', async () => {
    for (const v of ['1.9.9', 'latest']) {
      const root = fresh()
      write(root, 'extensions/beta/plugin.json', manifest('beta', v))
      commit(root)
      const report = await verifyChangedPlugins({ root, base: 'main' })
      assert.equal(report.passed, false, v)
    }
  })

  await t.test('4. 新增插件：不要求升版本，照常扫描编译', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/delta', 'delta', '0.1.0')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, true, JSON.stringify(report.results))
    assert.ok(resultOf(report, 'extensions/delta').notes.includes('新插件'))
  })

  await t.test('5. [对抗] 源码里藏 eval / new Function：安全扫描拦截', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/alpha', 'alpha', '1.0.1', {
      code: 'const k = "ev" + "al"\nexport default function Command(): string {\n  return (globalThis as any)[k]("1") + new Function("return 2")()\n}\n'
    })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/alpha').errors.join('\n'), /BANNED_DYNAMIC_FUNCTION/)
  })

  await t.test('6. TypeScript 类型错误：编译失败即拦截', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/alpha', 'alpha', '1.0.1', { code: 'export default function Command(): number {\n  return "not a number"\n}\n' })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/alpha').errors.join('\n'), /从源码编译失败[\s\S]*TS2322/)
  })

  await t.test('7. 插件自带测试失败：拦截；--skip-tests 时不运行', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/alpha', 'alpha', '1.0.1', {
      testCode: "import test from 'node:test'\nimport assert from 'node:assert'\ntest('x', () => assert.equal(1, 2))\n"
    })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/alpha').errors.join('\n'), /插件自带测试未通过/)
    const skipped = await verifyChangedPlugins({ root, base: 'main', skipTests: true })
    assert.equal(skipped.passed, true)
  })

  await t.test('8. 直接删除插件目录：拦截并提示改用下架', async () => {
    const root = fresh()
    fs.rmSync(path.join(root, 'extensions/beta'), { recursive: true })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/beta').errors.join('\n'), /不能直接删除插件目录[\s\S]*revoked/)
  })

  await t.test('9. 下架（revoked: true）：不要求升版本，也不再扫描编译', async () => {
    const root = fresh()
    write(root, 'extensions/beta/plugin.json', manifest('beta', '2.0.0', { revoked: true, revokedReason: '安全问题' }))
    write(root, 'extensions/beta/src/index.ts', 'eval("x")\n')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, true, JSON.stringify(report.results))
    assert.ok(resultOf(report, 'extensions/beta').notes.includes('已下架'))
  })

  await t.test('10. 目录名与 id 不一致、两个插件 id 重复：拦截', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/epsilon', 'alpha', '1.0.0')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    const errs = resultOf(report, 'extensions/epsilon').errors.join('\n')
    assert.match(errs, /目录名 "epsilon" 与 plugin.json 的 id "alpha" 不一致/)
    assert.match(errs, /与 extensions\/alpha 重复/)
  })

  await t.test('11. 作者分组目录（official/<id>）能正确识别', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/official/gamma', 'gamma', '1.1.0')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, true, JSON.stringify(report.results))
    assert.deepEqual(report.checked, ['extensions/official/gamma'])
  })

  await t.test('12. 改了 shared/ 公共源码：复制了它的插件都要检查，副本没更新时编译前就拦截', async () => {
    const root = fresh()
    write(root, 'extensions/shared/hash.ts', 'export const H = 2\n')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.deepEqual(report.checked, ['extensions/uses-shared'])
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/uses-shared').errors.join('\n'), /与 shared\/hash\.ts 不一致/)
  })

  await t.test('13. 改了脚本等公共部分：全部插件都检查，但不要求它们升版本', async () => {
    const root = fresh()
    write(root, 'scripts/extra.mjs', 'export {}\n')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.infra, true)
    assert.equal(report.checked.length, 4)
    assert.equal(report.passed, true, JSON.stringify(report.results))
  })

  await t.test('14. 只改文档：不检查任何插件', async () => {
    const root = fresh()
    write(root, 'README.md', '# hi\n')
    write(root, 'extensions/alpha/README.md', '# alpha\n')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.deepEqual(report.checked, [])
    assert.equal(report.passed, true)
    assert.match(renderSummary(report), /没有涉及插件/)
  })

  await t.test('15. plugin.json 损坏：拦截不崩溃', async () => {
    const root = fresh()
    write(root, 'extensions/alpha/plugin.json', '{ "id": "alpha", ')
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main' })
    assert.equal(report.passed, false)
    assert.match(resultOf(report, 'extensions/alpha').errors.join('\n'), /不是合法 JSON/)
  })

  await t.test('17. 检查结果标注平台与草稿：跨平台 / 仅 Windows / 仅 macOS，草稿写明原因', async () => {
    const root = fresh()
    addPlugin(root, 'extensions/win-only', 'win-only', '1.0.0', { extra: { targets: [TARGETS[0]] } })
    addPlugin(root, 'extensions/mac-only', 'mac-only', '1.0.0', { extra: { targets: [TARGETS[1]], draft: true, draftReason: '只有示例数据' } })
    commit(root)
    const report = await verifyChangedPlugins({ root, base: 'main', skipTests: true })
    assert.equal(report.passed, true, JSON.stringify(report.results))
    assert.equal(resultOf(report, 'extensions/win-only').platform, '仅 Windows')
    assert.equal(resultOf(report, 'extensions/mac-only').platform, '仅 macOS')
    assert.ok(resultOf(report, 'extensions/mac-only').notes.some((n) => /草稿，不发布：只有示例数据/.test(n)))
    const summary = renderSummary(report)
    assert.match(summary, /\| 插件 \| 平台 \| 结果 \| 说明 \|/)
    assert.match(summary, /extensions\/win-only \| 仅 Windows \| 通过/)
    assert.match(summary, /extensions\/mac-only \| 仅 macOS \| 通过/)
  })

  await t.test('16. 缺少 --base 也没有 --all：明确报错', async () => {
    const root = fresh()
    await assert.rejects(() => verifyChangedPlugins({ root }), /需要 --base/)
  })
})

test('compareVersions 边界', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('1.2.0-beta', '1.2.0'), 0)
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
  assert.equal(compareVersions('abc', '1.0.0'), null)
  assert.equal(compareVersions(undefined, '1.0.0'), null)
})
