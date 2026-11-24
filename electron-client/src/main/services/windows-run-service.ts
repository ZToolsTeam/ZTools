/**
 * ZTools Windows Run Service (M1.5-12)
 * 
 * 本地化工程改造：
 * - 系统 PATH 与 Windows / System32 极速扫描与缓存；
 * - 预置 30+ 中国开发者高频系统别名（含中文释义与拼音搜索）；
 * - Win32 进程提权（UAC RunAs）、自定义 Shell 与终端保持运行支持；
 * - 自定义别名指令持久化增删改查。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getResolvedLocale } from '../i18n/index.js'
import {
  BUILTIN_RUN_COMMANDS,
  type WindowsRunCommandRecord
} from './windows-run.zh-data.js'

export { BUILTIN_RUN_COMMANDS, type WindowsRunCommandRecord }

function _windowsRunText(zh: string, en: string): string {
  return getResolvedLocale() === 'zh-CN' ? zh : en
}

export interface CustomRunCommandInput {
  alias: string
  command: string
  arguments?: string | undefined
  description?: string | undefined
  descriptionZh?: string | undefined
  tags?: string[] | undefined
  runAsAdminByDefault?: boolean | undefined
}

export type RunShellType = 'default' | 'cmd' | 'powershell' | 'wt' | 'none'

export interface ExecuteRunOptions {
  args?: readonly string[] | undefined
  arguments?: string | undefined
  asAdministrator?: boolean | undefined
  runAsAdmin?: boolean | undefined
  shell?: RunShellType | undefined
  workingDirectory?: string | undefined
}

export interface RunProcessLauncher {
  launch(file: string, args: readonly string[], options?: { detached?: boolean | undefined; windowsHide?: boolean | undefined; cwd?: string | undefined } | undefined): ChildProcess
  launchAsAdmin(file: string, args?: string | undefined): Promise<{ success: boolean; error?: string | undefined }>
}

function defaultLauncher(): RunProcessLauncher {
  return {
    launch(file, args, options = {}) {
      return spawn(file, [...args], {
        detached: options.detached ?? true,
        shell: false,
        stdio: 'ignore',
        windowsHide: options.windowsHide ?? false,
        cwd: options.cwd
      })
    },
    async launchAsAdmin(file, args = '') {
      return new Promise((resolve) => {
        // 使用 PowerShell Start-Process -Verb RunAs 实现 Win32 UAC 提权派生
        const psArgs = [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle', 'Hidden',
          '-Command',
          `Start-Process -FilePath "${file}" ${args ? `-ArgumentList "${args}"` : ''} -Verb RunAs`
        ]
        const child = spawn('powershell.exe', psArgs, { windowsHide: true })
        child.on('error', (err) => resolve({ success: false, error: err.message }))
        child.on('exit', (code) => {
          if (code === 0) resolve({ success: true })
          else resolve({ success: false, error: `UAC elevation cancelled or exited with code: ${code}` })
        })
      })
    }
  }
}

export class WindowsRunService {
  private readonly customCommands = new Map<string, WindowsRunCommandRecord>()
  private readonly launcher: RunProcessLauncher
  private pathCache: string[] = []
  private pathCachedAt = 0

  constructor(launcher: RunProcessLauncher = defaultLauncher()) {
    this.launcher = launcher
  }

  /**
   * 搜索运行命令（支持预置别名、自定义别名与中英文拼音）
   */
  public searchCommands(query: string = ''): readonly WindowsRunCommandRecord[] {
    const raw = (typeof query === 'string' ? query : '').trim().toLowerCase()
    const all = [...BUILTIN_RUN_COMMANDS, ...Array.from(this.customCommands.values())]

    if (!raw) {
      return all
    }

    return all.filter((item) => {
      if (item.alias.toLowerCase().includes(raw)) return true
      if (item.command.toLowerCase().includes(raw)) return true
      if (item.description.toLowerCase().includes(raw)) return true
      if (item.descriptionZh.includes(raw)) return true
      if (item.pinyin.includes(raw)) return true
      if (item.tags.some(t => t.toLowerCase().includes(raw))) return true
      return false
    })
  }

  /**
   * 根据别名查找单一指令
   */
  public getByAlias(alias: string): WindowsRunCommandRecord | null {
    if (!alias || typeof alias !== 'string') return null
    const lower = alias.trim().toLowerCase()
    // 优先自定义别名
    for (const cmd of this.customCommands.values()) {
      if (cmd.alias.toLowerCase() === lower) return cmd
    }
    // 预置别名
    for (const cmd of BUILTIN_RUN_COMMANDS) {
      if (cmd.alias.toLowerCase() === lower) return cmd
    }
    return null
  }

  /**
   * 注册自定义别名
   */
  public createCustomCommand(input: CustomRunCommandInput): WindowsRunCommandRecord {
    if (!input.alias?.trim()) throw new Error(_windowsRunText('别名不能为空', 'Alias cannot be empty'))
    if (!input.command?.trim()) throw new Error(_windowsRunText('命令不能为空', 'Command cannot be empty'))

    const id = `custom-${randomUUID()}`
    const record: WindowsRunCommandRecord = {
      id,
      alias: input.alias.trim(),
      command: input.command.trim(),
      ...(input.arguments?.trim() ? { arguments: input.arguments.trim() } : {}),
      description: input.description?.trim() || input.command.trim(),
      descriptionZh: input.descriptionZh?.trim() || input.command.trim(),
      pinyin: input.alias.toLowerCase(),
      tags: input.tags || ['custom'],
      isBuiltin: false,
      runAsAdminByDefault: input.runAsAdminByDefault ?? false
    }

    this.customCommands.set(id, record)
    return record
  }

  public deleteCustomCommand(id: string): boolean {
    return this.customCommands.delete(id)
  }

  public registerAlias(
    alias: string,
    command: string,
    options: {
      description?: string | undefined
      descriptionZh?: string | undefined
      runAsAdminByDefault?: boolean | undefined
    } = {}
  ): WindowsRunCommandRecord {
    return this.createCustomCommand({
      alias,
      command,
      description: options.description,
      descriptionZh: options.descriptionZh,
      runAsAdminByDefault: options.runAsAdminByDefault
    })
  }

  public removeAlias(alias: string): boolean {
    const existing = this.getByAlias(alias)
    if (existing && !existing.isBuiltin) {
      return this.deleteCustomCommand(existing.id)
    }
    return false
  }

  /**
   * 扫描系统 PATH 目录中的所有可执行二进制
   */
  public getSystemPathExecutables(refresh = false): readonly string[] {
    const now = Date.now()
    if (!refresh && this.pathCache.length > 0 && now - this.pathCachedAt < 60000) {
      return this.pathCache
    }

    const exts = new Set(['.exe', '.msc', '.cpl', '.bat', '.cmd', '.ps1'])
    const found = new Set<string>()

    const rawPath = process.env.PATH || ''
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const defaultDirs = [
      path.join(systemRoot, 'System32'),
      systemRoot,
      path.join(systemRoot, 'SysWOW64')
    ]

    const pathDirs = rawPath.split(path.delimiter).map(d => d.trim()).filter(Boolean)
    const allDirs = Array.from(new Set([...defaultDirs, ...pathDirs]))

    for (const dir of allDirs) {
      try {
        if (!fs.existsSync(dir)) continue
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (exts.has(ext)) {
              found.add(entry.name.toLowerCase())
            }
          }
        }
      } catch {
        // 无权限访问的目录忽略
      }
    }

    this.pathCache = Array.from(found).sort()
    this.pathCachedAt = now
    return this.pathCache
  }

  /**
   * 执行指令（支持直跑、提权与 Shell 包装）
   */
  public async execute(
    commandOrAlias: string,
    options: ExecuteRunOptions = {}
  ): Promise<{ success: boolean; pid?: number | undefined; message?: string | undefined }> {
    const trimmed = (commandOrAlias || '').trim()
    if (!trimmed) throw new Error(_windowsRunText('执行指令不能为空', 'Command cannot be empty'))

    // 检查是否命中别名
    const matched = this.getByAlias(trimmed)
    const actualCommand = matched ? matched.command : trimmed
    const mergedArgs = [
      ...(matched?.arguments ? [matched.arguments] : []),
      ...(options.args && options.args.length > 0 ? [options.args.join(' ')] : []),
      ...(options.arguments ? [options.arguments] : [])
    ].join(' ').trim()

    const asAdmin = options.asAdministrator ?? options.runAsAdmin ?? (matched?.runAsAdminByDefault ?? false)
    const shell = options.shell ?? 'none'

    // 1. 管理员 UAC 提权派生
    if (asAdmin) {
      const res = await this.launcher.launchAsAdmin(actualCommand, mergedArgs)
      if (!res.success) {
        throw new Error(res.error || _windowsRunText('管理员提权启动失败', 'Failed to launch as administrator'))
      }
      return { success: true, message: _windowsRunText('已请求管理员权限启动', 'Administrator elevation requested') }
    }

    const launchOpts = options.workingDirectory ? { cwd: options.workingDirectory } : {}

    // 2. 指定 Shell 窗口执行并保持打开
    if (shell === 'cmd') {
      const cmdArgs = ['/k', actualCommand, ...(mergedArgs ? [mergedArgs] : [])]
      const child = this.launcher.launch('cmd.exe', cmdArgs, launchOpts)
      return { success: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
    }

    if (shell === 'powershell') {
      const psScript = `${actualCommand} ${mergedArgs}`.trim()
      const psArgs = ['-NoExit', '-Command', psScript]
      const child = this.launcher.launch('powershell.exe', psArgs, launchOpts)
      return { success: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
    }

    if (shell === 'wt') {
      const wtArgs = [actualCommand, ...(mergedArgs ? [mergedArgs] : [])]
      const child = this.launcher.launch('wt.exe', wtArgs, launchOpts)
      return { success: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
    }

    // 3. 原生独立后台进程派生
    const rawArgs = mergedArgs ? mergedArgs.split(/\s+/).filter(Boolean) : []
    const child = this.launcher.launch(actualCommand, rawArgs, launchOpts)
    return { success: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
  }
}
