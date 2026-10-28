import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dockerRecord } from '../../contracts/docker-manager.js'
export interface DockerOutput { stdout: string; stderr: string }
export type DockerCommand = (file: string, args: readonly string[], signal: AbortSignal, env: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<DockerOutput>
export const runDockerCommand: DockerCommand = (file, args, signal, env, timeoutMs = 15000) => new Promise((resolve, reject) => {
  signal.throwIfAborted()
  const child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let size = 0, failure: Error | undefined
  const abort = () => { failure ??= new Error('Docker 请求已取消，操作结果请刷新确认'); child.kill('SIGKILL') }
  const timer = setTimeout(() => { failure ??= new Error('Docker 请求超时，操作结果请刷新确认'); child.kill('SIGKILL') }, timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const receive = (chunks: Buffer[], chunk: Buffer) => {
    size += chunk.length
    if (size > 4 * 1024 * 1024) { failure ??= new Error('Docker 输出超过 4 MiB，请缩小操作范围'); child.kill('SIGKILL'); return }
    chunks.push(chunk)
  }
  child.stdout.on('data', chunk => receive(stdout, chunk)); child.stderr.on('data', chunk => receive(stderr, chunk))
  child.on('error', error => { failure ??= error })
  child.once('close', (code, exitSignal) => {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
    if (failure) reject(failure)
    else if (code !== 0 || exitSignal) {
      const reason = result.stderr.trim()
      reject(new Error(/cannot connect to the docker daemon|failed to connect to the docker API/i.test(reason) ?
        '无法连接本机 Docker 引擎。请启动 Docker Desktop、Colima 或 OrbStack，再点击刷新' : `Docker 执行失败：${reason.slice(0, 1500) || exitSignal || code}`))
    }
    else resolve(result)
  })
})
export async function findDockerExecutable(env = process.env, platform = process.platform, home = os.homedir()): Promise<string> {
  const name = platform === 'win32' ? 'docker.exe' : 'docker'
  const directories = (env.PATH || '').split(path.delimiter).filter(p => p && path.isAbsolute(p))
  const candidates = [...directories.map(p => path.join(p, name)), path.join(home, '.docker', 'bin', name)]
  if (platform === 'darwin') candidates.push('/Applications/Docker.app/Contents/Resources/bin/docker', '/Applications/OrbStack.app/Contents/MacOS/xbin/docker', '/opt/homebrew/bin/docker', '/usr/local/bin/docker')
  if (platform === 'win32' && env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin', name))
  for (const file of new Set(candidates)) {
    try { await fs.access(file, constants.X_OK); if ((await fs.stat(file)).isFile()) return file }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error }
  }
  throw new Error('未找到 Docker 命令行。请安装并启动 Docker Desktop，或配置已有的 Colima / OrbStack Docker 环境后重试')
}
export interface DockerConnection { executable: string; endpoint: string; context: string }
export class DockerCli {
  constructor(private readonly command: DockerCommand = runDockerCommand, private readonly locate = findDockerExecutable, private readonly environment = process.env, private readonly platform = process.platform) {}
  #env(pinned = false) {
    const env: NodeJS.ProcessEnv = { ...this.environment, LANG: 'C', LC_ALL: 'C' }
    if (pinned) for (const name of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[name]
    return env
  }
  async connect(signal: AbortSignal): Promise<DockerConnection> {
    const executable = await this.locate(), env = this.#env()
    let endpoint = env.DOCKER_HOST, context = 'DOCKER_HOST'
    if (!endpoint || env.DOCKER_CONTEXT) {
      context = (await this.command(executable, ['context', 'show'], signal, env)).stdout.trim()
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(context)) throw new Error('Docker 当前上下文无效')
      const raw: unknown = JSON.parse((await this.command(executable, ['context', 'inspect', context], signal, env)).stdout)
      if (!Array.isArray(raw) || raw.length !== 1 || !dockerRecord(raw[0]) || !dockerRecord(raw[0].Endpoints) || !dockerRecord(raw[0].Endpoints.docker) || typeof raw[0].Endpoints.docker.Host !== 'string') throw new Error('无法读取 Docker 上下文连接地址')
      endpoint = raw[0].Endpoints.docker.Host
    }
    const localUnix = endpoint.startsWith('unix:///') && !/[\r\n\0]/.test(endpoint) && path.posix.isAbsolute(endpoint.slice(7))
    const localPipe = this.platform === 'win32' && /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(endpoint)
    if (!localUnix && !localPipe) throw new Error(`当前 Docker 上下文 ${context} 不是本机连接；请在 Docker 中切换到本机上下文后刷新`)
    return { executable, endpoint, context }
  }
  run(connection: DockerConnection, args: readonly string[], signal: AbortSignal, timeoutMs?: number) {
    return this.command(connection.executable, ['--host', connection.endpoint, ...args], signal, this.#env(true), timeoutMs)
  }
}
