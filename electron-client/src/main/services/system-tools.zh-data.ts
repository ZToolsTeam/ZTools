/**
 * Windows 内置系统工具中文名称与描述静态元数据（纯静态领域词库，无业务或渲染逻辑）
 */

export interface SystemToolZhMeta {
  readonly name: string
  readonly description: string
}

export const SYSTEM_TOOLS_ZH_META: Readonly<Record<string, SystemToolZhMeta>> = {
  control_panel: { name: '控制面板', description: '打开经典控制面板' },
  settings: { name: 'Windows 设置', description: '打开 Windows 设置主页' },
  this_pc: { name: '此电脑', description: '打开此电脑' },
  file_explorer: { name: '文件资源管理器', description: '打开文件资源管理器' },
  powershell: { name: 'Windows PowerShell', description: '打开 Windows PowerShell' },
  command_prompt: { name: '命令提示符', description: '打开命令提示符' },
  windows_terminal: { name: 'Windows 终端', description: '优先打开 Windows 终端，未安装时回退 PowerShell' },
  registry_editor: { name: '注册表编辑器', description: '打开注册表编辑器，Windows 可能请求提升权限' },
  task_manager: { name: '任务管理器', description: '打开任务管理器' },
  computer_management: { name: '计算机管理', description: '打开计算机管理控制台' },
  device_manager: { name: '设备管理器', description: '打开设备管理器' },
  disk_management: { name: '磁盘管理', description: '打开磁盘管理' },
  services: { name: '服务', description: '打开 Windows 服务管理器' },
  event_viewer: { name: '事件查看器', description: '打开事件查看器' },
  task_scheduler: { name: '任务计划程序', description: '打开任务计划程序' },
  system_information: { name: '系统信息', description: '打开系统信息' },
  resource_monitor: { name: '资源监视器', description: '打开资源监视器' },
  performance_monitor: { name: '性能监视器', description: '打开性能监视器' },
  system_properties: { name: '系统属性', description: '打开系统属性' },
  advanced_system_properties: { name: '高级系统属性', description: '打开系统属性的高级页' },
  environment_variables: { name: '环境变量', description: '打开环境变量编辑器' },
  programs_features: { name: '程序和功能', description: '打开经典程序和功能' },
  optional_features: { name: 'Windows 功能', description: '打开启用或关闭 Windows 功能' },
  network_connections: { name: '网络连接', description: '打开网络适配器连接列表' },
  firewall: { name: 'Windows 防火墙', description: '打开经典 Windows 防火墙' },
  power_options: { name: '电源选项', description: '打开经典电源选项' },
  sound: { name: '声音', description: '打开经典声音设置' },
  display: { name: '显示设置', description: '打开显示设置' },
  bluetooth: { name: '蓝牙和设备', description: '打开蓝牙和设备设置' },
  printers: { name: '打印机和扫描仪', description: '打开打印机和扫描仪设置' },
  date_time: { name: '日期和时间', description: '打开日期和时间设置' },
  region_language: { name: '区域和语言', description: '打开区域和语言设置' },
  user_accounts: { name: '用户账户', description: '打开账户信息设置' },
  apps: { name: '应用和功能', description: '打开已安装应用设置' },
  default_apps: { name: '默认应用', description: '打开默认应用设置' },
  windows_update: { name: 'Windows 更新', description: '打开 Windows 更新' },
  windows_security: { name: 'Windows 安全中心', description: '打开 Windows 安全中心设置' },
  notifications: { name: '通知', description: '打开通知设置' },
  storage: { name: '存储', description: '打开存储设置' },
  troubleshoot: { name: '疑难解答', description: '打开疑难解答设置' },
  remote_desktop: { name: '远程桌面', description: '打开远程桌面设置' },
  recovery: { name: '恢复', description: '打开系统恢复设置' }
}
