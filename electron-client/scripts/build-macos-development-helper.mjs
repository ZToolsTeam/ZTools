import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 开发环境缺少工具链时保留可用宿主；发行构建仍强制构建全部原生组件。 */
export function buildDevelopmentHelper({ root, directory, name, sources, build }) {
  if (process.platform !== 'darwin') return
  const destination = path.join(root, 'out', directory), executable = path.join(destination, 'native', name)
  const stamp = path.join(destination, 'source.sha256'), hash = createHash('sha256')
  for (const file of [...sources, fileURLToPath(import.meta.url), fileURLToPath(new URL('./build-macos-universal-helper.mjs', import.meta.url))]) hash.update(fs.readFileSync(file))
  const signature = hash.digest('hex')
  if (fs.existsSync(executable) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === signature) return
  if (spawnSync('/usr/bin/xcrun', ['--find', 'clang++'], { stdio: 'ignore' }).status !== 0) {
    console.warn(`未安装 Xcode 命令行工具：${name} 未构建。`); return
  }
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(root, 'out', '.native-build-'))
  try {
    const built = build({ outputRoot: path.join(temporary, 'build'), minimumOs: '13.0' })
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    const pending = path.join(temporary, `${name}.pending`)
    fs.copyFileSync(built.executable, pending); fs.chmodSync(pending, 0o755)
    fs.renameSync(pending, executable); fs.writeFileSync(stamp, signature)
    console.log(`${name} 已构建（arm64 / x86_64）`)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
