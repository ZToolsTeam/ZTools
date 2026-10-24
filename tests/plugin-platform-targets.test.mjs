import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlatformTargets, getManifestPlatforms } from '../packages/ztools-plugins-spec/src/index.js'

/**
 * 插件规范（提交 / 打包时的校验）与客户端主进程安装校验必须对平台声明给出一致结论：
 * 声明支持哪个平台，那个平台就能装；没声明的平台，安装时必须被拒绝。
 * 依赖 electron-client 的测试编译产物（npm --prefix electron-client test 或 tsc -p electron-client/tsconfig.test.json）。
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resolverPath = path.join(rootDir, 'electron-client/out-test/src/main/services/plugin-runtime-target-resolver.js')
const { resolvePluginRuntimeTarget } = await import(resolverPath)

const RUNTIMES = {
  macos: { platform: 'darwin', runtime: 'electron', arch: 'arm64' },
  windows: { platform: 'win32', runtime: 'electron', arch: 'x64' }
}

function installable(manifest, platform) {
  try {
    resolvePluginRuntimeTarget(manifest, RUNTIMES[platform])
    return true
  } catch (error) {
    if (error?.code === 'NOT_SUPPORTED' || /不支持|兼容|无法确认/.test(String(error?.message))) return false
    throw error
  }
}

test('[集成] 脚手架生成的三种平台声明，主进程安装校验结论一致', () => {
  for (const platforms of [['windows', 'macos'], ['windows'], ['macos']]) {
    const manifest = { id: 'demo', targets: buildPlatformTargets(platforms), nativeComponents: [] }
    for (const platform of ['windows', 'macos']) {
      assert.equal(installable(manifest, platform), platforms.includes(platform), `${platforms} @ ${platform}`)
    }
  }
})

// 官方插件源码只在内部仓库的 plugins/ 子模块里，公开客户端仓库没有这个目录
const officialPluginsRoot = path.join(rootDir, 'plugins')

test('[集成] 官方插件仓库每个插件：声明的平台能安装，未声明的平台安装被拒', {
  skip: fs.existsSync(officialPluginsRoot) ? false : '缺少 plugins/ 目录（公开客户端仓库不含官方插件源码）'
}, () => {
  const pluginsRoot = officialPluginsRoot
  const ids = fs.readdirSync(pluginsRoot).filter((d) => fs.existsSync(path.join(pluginsRoot, d, 'plugin.json')))
  const summary = { both: 0, windows: 0, macos: 0 }
  for (const id of ids) {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginsRoot, id, 'plugin.json'), 'utf8'))
    const platforms = getManifestPlatforms(manifest)
    assert.ok(platforms.length > 0, `${id} 未声明平台`)
    for (const platform of ['windows', 'macos']) {
      assert.equal(installable(manifest, platform), platforms.includes(platform), `${id} @ ${platform}`)
    }
    summary[platforms.length === 2 ? 'both' : platforms[0]] += 1
  }
  assert.equal(summary.both + summary.windows + summary.macos, ids.length)
})

test('[破坏性] 平台声明被篡改为未知平台或去掉 electron 目标时，两端都拒绝安装', () => {
  const tampered = [
    { id: 'x', targets: [{ id: 'linux-electron-any', platform: 'linux', runtime: 'electron', arch: 'any' }], nativeComponents: [] },
    { id: 'x', targets: [], nativeComponents: [] },
    { id: 'x', targets: buildPlatformTargets(['macos']) }
  ]
  for (const manifest of tampered) {
    for (const platform of ['windows', 'macos']) {
      assert.throws(() => resolvePluginRuntimeTarget(manifest, RUNTIMES[platform]))
    }
  }
})
