import { buildDevelopmentStartup } from './build-macos-startup.mjs'
import { buildDevelopmentNetwork } from './build-macos-network.mjs'
import { buildDevelopmentHotkeys } from './build-macos-hotkeys.mjs'
import { buildDevelopmentHosts } from './build-macos-hosts.mjs'
import { buildDevelopmentPathAccess } from './build-macos-path-access.mjs'
import { buildDevelopmentVision } from './build-macos-vision.mjs'
import { buildDevelopmentAudio } from './build-macos-audio.mjs'
import { buildDevelopmentDisplay } from './build-macos-display.mjs'
import { buildDevelopmentDns } from './build-macos-dns.mjs'
import { buildDevelopmentInputLock } from './build-macos-input-lock.mjs'
import { buildDevelopmentClipboard } from './build-macos-clipboard.mjs'
import { spawnSync } from 'node:child_process'
import { readNativeHostManifest } from './native-host-manifest.mjs'
import { buildRuntimeCapabilityPromptPreload, buildSandboxPreload } from './build-sandbox-preload.mjs'
import { hasCommercialMainSource, minifyCommercialMainOutput, removeStaleEditionOutputs } from './edition-output.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontendRoot = path.resolve(root, '..', 'frontend')
const frontendDist = path.join(frontendRoot, 'dist')
const rendererOutput = path.join(root, 'out', 'assets', 'web')
const npmCli = process.env.npm_execpath

function run(args, cwd, extraEnvironment = {}) {
  if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error('无法定位 npm CLI，请通过 npm run build 执行构建')
  }
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnvironment }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}`)
  }
}

if (!fs.existsSync(path.join(frontendRoot, 'package.json'))) {
  throw new Error(`未找到父仓库 Frontend: ${frontendRoot}`)
}

// tsc 只写不删：没有闭源主进程源码时先删掉旧的 out/main/commercial，否则加载器仍会选中旧的官方版
for (const removed of removeStaleEditionOutputs(root)) {
  console.log(`已删除源码不存在的旧版本产物: ${removed}`)
}

// 先编译主进程，构建期后台地址解析复用编译后的 runtime/build-config.js，保证与运行时校验规则一致
run(['exec', '--', 'tsc', '-p', 'tsconfig.json'], root)
buildDevelopmentAudio(root)
buildDevelopmentDisplay(root)
buildDevelopmentInputLock(root)
buildDevelopmentClipboard(root)
buildDevelopmentDns(root)
buildDevelopmentHosts(root)
buildDevelopmentStartup(root)
buildDevelopmentNetwork(root)
buildDevelopmentHotkeys(root)
buildDevelopmentVision(root)
buildDevelopmentPathAccess(root)

// 官方构建：闭源主进程产物原地压缩并去掉注释与源码映射，发行包不带可直接阅读的闭源源码
if (hasCommercialMainSource(root)) {
  const esbuild = createRequire(path.join(frontendRoot, 'package.json'))('esbuild')
  const minified = minifyCommercialMainOutput(root, esbuild)
  console.log(`闭源主进程产物已压缩: ${minified.files.length} 个文件，删除源码映射 ${minified.removedMaps.length} 个`)
}
const buildConfig = createRequire(import.meta.url)(path.join(root, 'out', 'main', 'runtime', 'build-config.js'))
const frontendEnvProductionPath = path.join(frontendRoot, '.env.production')
// 后台地址来源：ZTOOLS_API_BASE 环境变量 > 界面层 .env.production（内部仓库才有，不随开源导出）> 空（离线构建）
const resolvedApiBase = buildConfig.resolveBuildApiBase({
  env: process.env,
  frontendEnvProduction: fs.existsSync(frontendEnvProductionPath)
    ? fs.readFileSync(frontendEnvProductionPath, 'utf8')
    : undefined
})
const frontendEnvironment = { ZTOOLS_BUILD_TARGET: 'electron', ZTOOLS_SKIP_LEGACY_BIN_DEPLOY: '1' }
// 通过环境变量显式指定后台时，界面层同步使用同一地址（未指定时界面层仍按自己的 .env 文件）。
// 显式设为空（强制离线）也要同步给界面层，否则内部仓库的 .env.production 会让界面层仍按在线构建，
// 出现「主进程离线、界面层联网」的不一致版本
if (resolvedApiBase.source === 'env') {
  frontendEnvironment.VITE_API_BASE_URL = resolvedApiBase.apiBase
}

run(['run', 'build'], frontendRoot, frontendEnvironment)
buildSandboxPreload()
buildRuntimeCapabilityPromptPreload()

if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
  throw new Error(`Frontend 生产构建缺少 index.html: ${frontendDist}`)
}

// 先清空旧的界面层产物：带哈希的旧分块不会被覆盖，会一直累积进安装包（包括切换版本前的旧代码）
fs.rmSync(rendererOutput, { recursive: true, force: true })
fs.cpSync(frontendDist, rendererOutput, { recursive: true, force: true })
console.log(`Frontend 生产产物已复制到 ${rendererOutput}`)

// 托盘图标：macOS 菜单栏模板图 + Windows 多尺寸 ICO，放进 out/assets 随安装包分发（resources/ 不进安装包）
const trayOutput = path.join(root, 'out', 'assets', 'tray')
fs.rmSync(trayOutput, { recursive: true, force: true })
fs.mkdirSync(trayOutput, { recursive: true })
for (const file of fs.readdirSync(path.join(root, 'resources', 'app', 'tray'))) {
  fs.copyFileSync(path.join(root, 'resources', 'app', 'tray', file), path.join(trayOutput, file))
}
fs.copyFileSync(path.join(root, 'resources', 'app', 'LOGO.ico'), path.join(trayOutput, 'tray.ico'))

// 写入构建期运行配置。开源版不使用其中的后台地址（不连接任何后台）；
// 其他版本实现（见 src/main/edition.ts）在空地址时同样按单机离线运行
fs.writeFileSync(
  path.join(root, 'out', 'main', buildConfig.BUILD_CONFIG_FILE_NAME),
  buildConfig.serializeBuildConfig({ apiBase: resolvedApiBase.apiBase }),
  'utf8'
)
console.log(resolvedApiBase.apiBase === ''
  ? '构建配置：未配置官方后台地址（不连接任何后台）'
  : `构建配置：官方后台地址已注入（来源 ${resolvedApiBase.source}）`)

// Generate the same bounded trust anchor for development and packaging.
if (process.platform === 'win32') {
  const nativeRoot = path.join(root, 'out', 'native')
  fs.mkdirSync(nativeRoot, { recursive: true })
  fs.writeFileSync(path.join(nativeRoot, '.ztools-native-host.xml'), readNativeHostManifest(root), 'utf8')
}
