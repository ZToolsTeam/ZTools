/**
 * Windows 运行常用命令中文别名与检索关键词静态词库（纯静态领域词库，无业务或渲染逻辑）
 */

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
