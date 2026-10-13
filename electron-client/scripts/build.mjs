import { spawnSync } from 'node:child_process'
import { readNativeHostManifest } from './native-host-manifest.mjs'
import { buildRuntimeCapabilityPromptPreload, buildSandboxPreload } from './build-sandbox-preload.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

run(['run', 'build'], frontendRoot, { ZTOOLS_BUILD_TARGET: 'electron', ZTOOLS_SKIP_LEGACY_BIN_DEPLOY: '1' })
run(['exec', '--', 'tsc', '-p', 'tsconfig.json'], root)
buildSandboxPreload()
buildRuntimeCapabilityPromptPreload()

if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
  throw new Error(`Frontend 生产构建缺少 index.html: ${frontendDist}`)
}

fs.cpSync(frontendDist, rendererOutput, { recursive: true, force: true })
console.log(`Frontend 生产产物已复制到 ${rendererOutput}`)

// Generate the same bounded trust anchor for development and packaging.
if (process.platform === 'win32') {
  const nativeRoot = path.join(root, 'out', 'native')
  fs.mkdirSync(nativeRoot, { recursive: true })
  fs.writeFileSync(path.join(nativeRoot, '.ztools-native-host.xml'), readNativeHostManifest(root), 'utf8')
}
