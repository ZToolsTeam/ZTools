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

export interface WindowsRunCommandRecord {
  readonly id: string
  readonly alias: string
  readonly command: string
  readonly arguments?: string | undefined
  readonly description: string
  readonly descriptionZh: string
  readonly pinyin: string
  readonly tags: readonly string[]
  readonly isBuiltin: boolean
  readonly runAsAdminByDefault?: boolean | undefined
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

/**
 * 30+ 预置中文高频 Windows 运行指令与别名数据库
 */
export const BUILTIN_RUN_COMMANDS: readonly WindowsRunCommandRecord[] = [
  // 终端与命令行
  { id: 'run-cmd', alias: 'cmd', command: 'cmd.exe', description: 'Command Prompt', descriptionZh: '命令提示符 (CMD)', pinyin: 'minglingtishifu', tags: ['terminal', 'cli', 'cmd'], isBuiltin: true },
  { id: 'run-powershell', alias: 'powershell', command: 'powershell.exe', description: 'Windows PowerShell', descriptionZh: 'PowerShell 终端', pinyin: 'powershell', tags: ['terminal', 'ps', 'shell'], isBuiltin: true },
  { id: 'run-wt', alias: 'wt', command: 'wt.exe', description: 'Windows Terminal', descriptionZh: 'Windows 现代终端', pinyin: 'xiandaiterminal', tags: ['terminal', 'wt', 'console'], isBuiltin: true },

  // 系统核心配置与治理
  { id: 'run-regedit', alias: 'regedit', command: 'regedit.exe', description: 'Registry Editor', descriptionZh: '注册表编辑器', pinyin: 'zhuceshibianjiqi', tags: ['system', 'registry', 'admin'], isBuiltin: true, runAsAdminByDefault: true },
  { id: 'run-taskmgr', alias: 'taskmgr', command: 'taskmgr.exe', description: 'Task Manager', descriptionZh: '任务管理器', pinyin: 'renwuguanliqi', tags: ['system', 'process', 'performance'], isBuiltin: true },
  { id: 'run-control', alias: 'control', command: 'control.exe', description: 'Control Panel', descriptionZh: '传统控制面板', pinyin: 'kongzhimianban', tags: ['settings', 'control'], isBuiltin: true },
  { id: 'run-services', alias: 'services.msc', command: 'services.msc', description: 'Windows Services Management', descriptionZh: '系统后台服务管理', pinyin: 'xitongfuwuguanli', tags: ['services', 'msc', 'admin'], isBuiltin: true, runAsAdminByDefault: true },
  { id: 'run-gpedit', alias: 'gpedit.msc', command: 'gpedit.msc', description: 'Local Group Policy Editor', descriptionZh: '本地组策略编辑器', pinyin: 'zuceluebianjiqi', tags: ['policy', 'msc', 'admin'], isBuiltin: true, runAsAdminByDefault: true },
  { id: 'run-compmgmt', alias: 'compmgmt.msc', command: 'compmgmt.msc', description: 'Computer Management', descriptionZh: '计算机管理中枢', pinyin: 'jisuanjiguanli', tags: ['management', 'admin'], isBuiltin: true, runAsAdminByDefault: true },
  { id: 'run-devmgmt', alias: 'devmgmt.msc', command: 'devmgmt.msc', description: 'Device Manager', descriptionZh: '设备管理器 (驱动硬件)', pinyin: 'shebeiguanliqi', tags: ['device', 'hardware', 'driver'], isBuiltin: true },
  { id: 'run-diskmgmt', alias: 'diskmgmt.msc', command: 'diskmgmt.msc', description: 'Disk Management', descriptionZh: '磁盘管理 (分区格式化)', pinyin: 'cipanguanli', tags: ['disk', 'storage', 'partition'], isBuiltin: true, runAsAdminByDefault: true },
  { id: 'run-eventvwr', alias: 'eventvwr.msc', command: 'eventvwr.msc', description: 'Event Viewer', descriptionZh: '事件查看器 (系统日志)', pinyin: 'shijianchakanqi', tags: ['logs', 'diagnostics'], isBuiltin: true },
  { id: 'run-resmon', alias: 'resmon', command: 'resmon.exe', description: 'Resource Monitor', descriptionZh: '资源监视器 (内存网络IO)', pinyin: 'ziyuanjianshiqi', tags: ['perf', 'cpu', 'memory'], isBuiltin: true },
  { id: 'run-perfmon', alias: 'perfmon', command: 'perfmon.exe', description: 'Performance Monitor', descriptionZh: '性能监视器', pinyin: 'xingnengjianshiqi', tags: ['perf', 'monitor'], isBuiltin: true },
  { id: 'run-msconfig', alias: 'msconfig', command: 'msconfig.exe', description: 'System Configuration', descriptionZh: '系统配置引导与启动项', pinyin: 'xitongpeizhi', tags: ['boot', 'startup'], isBuiltin: true },
  { id: 'run-cleanmgr', alias: 'cleanmgr', command: 'cleanmgr.exe', description: 'Disk Cleanup', descriptionZh: '磁盘垃圾清理工具', pinyin: 'cipanqingli', tags: ['disk', 'clean', 'trash'], isBuiltin: true },
  { id: 'run-dxdiag', alias: 'dxdiag', command: 'dxdiag.exe', description: 'DirectX Diagnostic Tool', descriptionZh: 'DirectX 诊断硬件工具', pinyin: 'directxzhenduan', tags: ['directx', 'gpu', 'diagnostics'], isBuiltin: true },

  // 高频内置小工具
  { id: 'run-calc', alias: 'calc', command: 'calc.exe', description: 'Calculator', descriptionZh: '系统计算器', pinyin: 'jisuanqi', tags: ['calc', 'tool', 'math'], isBuiltin: true },
  { id: 'run-notepad', alias: 'notepad', command: 'notepad.exe', description: 'Notepad', descriptionZh: '系统记事本', pinyin: 'jishiben', tags: ['text', 'editor', 'notes'], isBuiltin: true },
  { id: 'run-mspaint', alias: 'mspaint', command: 'mspaint.exe', description: 'Paint', descriptionZh: '系统画图工具', pinyin: 'huatu', tags: ['paint', 'draw', 'image'], isBuiltin: true },
  { id: 'run-mstsc', alias: 'mstsc', command: 'mstsc.exe', description: 'Remote Desktop Connection', descriptionZh: '远程桌面连接 (RDP)', pinyin: 'yuanchengzhuomian', tags: ['remote', 'rdp', 'desktop'], isBuiltin: true },
  { id: 'run-snippingtool', alias: 'snippingtool', command: 'snippingtool.exe', description: 'Snipping Tool', descriptionZh: '截图工具', pinyin: 'jietugongju', tags: ['screenshot', 'capture'], isBuiltin: true },
  { id: 'run-charmap', alias: 'charmap', command: 'charmap.exe', description: 'Character Map', descriptionZh: '字符映射表 (特殊符号)', pinyin: 'zifuyingshe', tags: ['font', 'unicode', 'char'], isBuiltin: true },
  { id: 'run-magnify', alias: 'magnify', command: 'magnify.exe', description: 'Magnifier', descriptionZh: '屏幕放大镜', pinyin: 'pingmufangdajing', tags: ['accessibility', 'zoom'], isBuiltin: true },
  { id: 'run-osk', alias: 'osk', command: 'osk.exe', description: 'On-Screen Keyboard', descriptionZh: '屏幕虚拟键盘', pinyin: 'pingmujianpan', tags: ['accessibility', 'keyboard'], isBuiltin: true },

  // 控制面板 CPL 专向直达
  { id: 'run-ncpa', alias: 'ncpa.cpl', command: 'ncpa.cpl', description: 'Network Connections', descriptionZh: '网络适配器连接设置', pinyin: 'wangluoshipeiqi', tags: ['network', 'adapters', 'ip'], isBuiltin: true },
  { id: 'run-sysdm', alias: 'sysdm.cpl', command: 'sysdm.cpl', description: 'System Properties', descriptionZh: '系统属性与环境变量设置', pinyin: 'xitongshuxing', tags: ['environment', 'path', 'system'], isBuiltin: true },
  { id: 'run-appwiz', alias: 'appwiz.cpl', command: 'appwiz.cpl', description: 'Programs and Features', descriptionZh: '程序和功能 (卸载软件)', pinyin: 'chengxuhegongneng', tags: ['uninstall', 'programs', 'apps'], isBuiltin: true },
  { id: 'run-firewall', alias: 'firewall.cpl', command: 'firewall.cpl', description: 'Windows Defender Firewall', descriptionZh: 'Windows 防火墙设置', pinyin: 'fanghuoqiang', tags: ['security', 'firewall'], isBuiltin: true },
  { id: 'run-inetcpl', alias: 'inetcpl.cpl', command: 'inetcpl.cpl', description: 'Internet Properties', descriptionZh: 'Internet 选项 (代理配置)', pinyin: 'internetxuanxiang', tags: ['proxy', 'network', 'ie'], isBuiltin: true },
  { id: 'run-mmsys', alias: 'mmsys.cpl', command: 'mmsys.cpl', description: 'Sound Settings', descriptionZh: '声音与音频设备管理', pinyin: 'shengyinshebei', tags: ['audio', 'sound', 'mic'], isBuiltin: true }
]

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
          else resolve({ success: false, error: `UAC 授权取消或退出码: ${code}` })
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
    if (!input.alias?.trim()) throw new Error('别名不能为空')
    if (!input.command?.trim()) throw new Error('命令不能为空')

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
    if (!trimmed) throw new Error('执行指令不能为空')

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
        throw new Error(res.error || '管理员提权启动失败')
      }
      return { success: true, message: '已请求管理员权限启动' }
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
