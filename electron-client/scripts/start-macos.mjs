import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

export function startMacos(argv = [], {
  platform = process.platform, npmCli = process.env.npm_execpath,
  resolveElectron = () => require('electron'), exists = fs.existsSync,
  run = spawnSync, stdout = console.log, stderr = console.error
} = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout('npm run start:mac -- [--remote-debugging-port=1024..65535]')
    return 0
  }
  if (argv.length > 1 || (argv.length === 1 && !/^--remote-debugging-port=\d+$/.test(argv[0]))) {
    stderr('start:mac 参数无效；使用 --help 查看允许参数')
    return 1
  }
  if (argv.length && (Number(argv[0].split('=')[1]) < 1024 || Number(argv[0].split('=')[1]) > 65535)) {
    stderr('调试端口必须为 1024..65535')
    return 1
  }
  if (platform !== 'darwin') {
    stderr('NOT_RUN: start:mac 要求 Darwin 宿主，未执行构建或启动')
    return 1
  }
  try {
    if (!npmCli || !exists(npmCli)) throw new Error('请通过 npm run start:mac 调用')
    const executable = resolveElectron()
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || !exists(executable)) {
      throw new Error('Electron 安装不完整')
    }
    const built = run(process.execPath, [npmCli, 'run', 'build'], {
      cwd: root, env: process.env, stdio: 'inherit', shell: false, timeout: 600_000
    })
    if (built.error || built.status !== 0) throw new Error('公共构建失败，未启动 Electron')
    const result = run(executable, ['.', ...argv], {
      cwd: root, env: process.env, stdio: 'inherit', shell: false
    })
    if (result.error) throw new Error('Electron 启动失败')
    return result.status ?? 1
  } catch (error) {
    stderr(error.message)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = startMacos(process.argv.slice(2))
}
