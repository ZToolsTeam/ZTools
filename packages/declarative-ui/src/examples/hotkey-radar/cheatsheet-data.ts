import type { CheatsheetShortcutItem, HotkeyProbePreset } from './types.js'

export const HIGH_CONFLICT_HOTKEY_PRESETS: readonly HotkeyProbePreset[] = Object.freeze([
  {
    id: 'hk-ctrl-alt-a',
    keyCombo: 'Ctrl+Alt+A',
    commonVictim: 'VS Code / Photoshop 选区与多行选中',
    typicalCulprit: '微信 / QQ / 钉钉全局截图',
    modifyGuide: '打开微信/QQ -> 设置 -> 快捷键 -> 截取屏幕，修改或清空热键'
  },
  {
    id: 'hk-ctrl-alt-s',
    keyCombo: 'Ctrl+Alt+S',
    commonVictim: 'JetBrains IDEA 打开 Settings 设置面板',
    typicalCulprit: 'QQ 录屏 / 网易云音乐全局热键',
    modifyGuide: '打开 QQ 或网易云音乐设置 -> 快捷键 -> 取消全局热键勾选'
  },
  {
    id: 'hk-ctrl-shift-f',
    keyCombo: 'Ctrl+Shift+F',
    commonVictim: 'VS Code / IDEA 全工程代码搜索与格式化',
    typicalCulprit: '微软拼音 / 搜狗输入法简繁切换',
    modifyGuide: '系统设置 -> 时间和语言 -> 输入 -> 微软拼音按键 -> 关闭 Ctrl+Shift+F 简繁切换'
  },
  {
    id: 'hk-alt-z',
    keyCombo: 'Alt+Z',
    commonVictim: 'VS Code 自动折行 (Toggle Word Wrap)',
    typicalCulprit: 'NVIDIA GeForce Experience 游戏内覆盖',
    modifyGuide: '打开 NVIDIA App -> 设置 -> 关闭游戏内覆盖 (In-Game Overlay)'
  },
  {
    id: 'hk-alt-r',
    keyCombo: 'Alt+R',
    commonVictim: 'IDE 正则表达式搜索开关',
    typicalCulprit: 'NVIDIA 性能图层 / AMD Radeon Adrenalin 驱动面板',
    modifyGuide: '打开显卡驱动控制面板 -> 热键 -> 修改或关闭性能监控快捷键'
  },
  {
    id: 'hk-ctrl-alt-p',
    keyCombo: 'Ctrl+Alt+P',
    commonVictim: '开发者工具命令面板扩展快捷键',
    typicalCulprit: '网易云音乐 / QQ音乐播放暂停全局键',
    modifyGuide: '打开音乐软件设置 -> 快捷键 -> 关闭全局快捷键'
  },
  {
    id: 'hk-ctrl-alt-d',
    keyCombo: 'Ctrl+Alt+D',
    commonVictim: '办公文档大纲视图切换',
    typicalCulprit: '网易云桌面歌词 / 欧路词典划词翻译',
    modifyGuide: '打开音乐或词典软件设置 -> 快捷键 -> 关闭桌面歌词/全局取词热键'
  },
  {
    id: 'hk-ctrl-alt-w',
    keyCombo: 'Ctrl+Alt+W',
    commonVictim: '多标签编辑器批量关闭窗口',
    typicalCulprit: '微信主窗口全局呼出热键',
    modifyGuide: '微信设置 -> 快捷键 -> 打开微信'
  },
  {
    id: 'hk-ctrl-alt-z',
    keyCombo: 'Ctrl+Alt+Z',
    commonVictim: 'Photoshop 多步历史撤回 (Step Backward)',
    typicalCulprit: 'QQ 提取未读消息全局热键',
    modifyGuide: 'QQ 设置 -> 热键 -> 设置热键 -> 提取消息'
  },
  {
    id: 'hk-ctrl-space',
    keyCombo: 'Ctrl+Space',
    commonVictim: 'VS Code / IDEA 触发智能代码补全 (IntelliSense)',
    typicalCulprit: '系统输入法中英文切换热键',
    modifyGuide: '系统输入法设置 -> 按键 -> 取消 Ctrl+Space 切换输入法'
  },
  {
    id: 'hk-ctrl-alt-up',
    keyCombo: 'Ctrl+Alt+Up',
    commonVictim: 'VS Code 向上添加多行光标',
    typicalCulprit: 'Intel 核显控制面板屏幕旋转 180°',
    modifyGuide: '打开 Intel 显卡控制中心 -> 系统 -> 热键 -> 禁用显示方向旋转热键'
  },
  {
    id: 'hk-ctrl-alt-down',
    keyCombo: 'Ctrl+Alt+Down',
    commonVictim: 'VS Code 向下添加多行光标',
    typicalCulprit: 'Intel 核显控制面板屏幕翻转 / 网易云音量减小',
    modifyGuide: '关闭 Intel 核显热键或音乐软件全局音量调节热键'
  },
  {
    id: 'hk-f1',
    keyCombo: 'F1',
    commonVictim: '浏览器 / 办公软件帮助与重命名辅助',
    typicalCulprit: 'Snipaste / PixPin 截图触发键',
    modifyGuide: '托盘右键 Snipaste / PixPin -> 首选项 -> 热键'
  },
  {
    id: 'hk-win-l',
    keyCombo: 'Win+L',
    commonVictim: '自定义窗口居右分屏热键',
    typicalCulprit: 'Windows 系统锁定屏幕保留热键',
    modifyGuide: '操作系统内核级保留热键，不支持第三方软件覆盖'
  }
])

export const CHEATSHEET_SHORTCUTS: readonly CheatsheetShortcutItem[] = Object.freeze([
  // Windows / macOS 系统级
  {
    id: 'os-clipboard-history',
    category: 'os',
    categoryLabel: 'Windows 系统',
    keyCombo: 'Win+V',
    macKeyCombo: 'Cmd+Shift+V',
    title: '呼出系统剪贴板历史记录',
    subtitle: '查看最近复制的多条文本与截图历史并粘贴',
    keywords: ['剪贴板', '历史复制', '多次复制', 'clipboard']
  },
  {
    id: 'os-virtual-desktop-new',
    category: 'os',
    categoryLabel: 'Windows 系统',
    keyCombo: 'Win+Ctrl+D',
    macKeyCombo: 'Ctrl+Up',
    title: '新建虚拟桌面 (工作区隔离)',
    subtitle: '配合 Win+Ctrl+Left/Right 左右秒切不同工作桌面',
    keywords: ['虚拟桌面', '新建桌面', '分身', '摸鱼', 'desktop']
  },
  {
    id: 'os-snap-layout',
    category: 'os',
    categoryLabel: 'Windows 系统',
    keyCombo: 'Win+Z',
    title: '呼出窗口贴靠分屏布局网格',
    subtitle: '一键将当前窗口二分屏、三分屏或四宫格排列',
    keywords: ['分屏', '窗口布局', '左右分屏', 'snap']
  },
  {
    id: 'os-task-manager',
    category: 'os',
    categoryLabel: 'Windows 系统',
    keyCombo: 'Ctrl+Shift+Esc',
    macKeyCombo: 'Cmd+Option+Esc',
    title: '直接打开任务管理器 (免按 Ctrl+Alt+Del)',
    subtitle: '秒开进程管理器强杀未响应软件',
    keywords: ['任务管理器', '强杀进程', '卡死', 'taskmgr']
  },
  {
    id: 'os-snipping-tool',
    category: 'os',
    categoryLabel: 'Windows 系统',
    keyCombo: 'Win+Shift+S',
    macKeyCombo: 'Cmd+Shift+4',
    title: '系统原生区域截图与长截图',
    subtitle: '框选屏幕任意区域复制到剪贴板',
    keywords: ['截图', '截屏', '框选截图', 'screenshot']
  },
  // VS Code 极客开发
  {
    id: 'vsc-command-palette',
    category: 'vscode',
    categoryLabel: 'VS Code',
    keyCombo: 'Ctrl+Shift+P',
    macKeyCombo: 'Cmd+Shift+P',
    title: '打开命令面板 (Command Palette)',
    subtitle: '执行所有 VS Code 内置与扩展命令的总入口',
    keywords: ['命令面板', '设置', 'vscode', 'palette']
  },
  {
    id: 'vsc-multi-cursor',
    category: 'vscode',
    categoryLabel: 'VS Code',
    keyCombo: 'Ctrl+D',
    macKeyCombo: 'Cmd+D',
    title: '选中下一个相同词汇并添加多光标',
    subtitle: '批量重构修改当前函数内同名变量的最高频神器',
    keywords: ['多光标', '批量修改', '同时编辑', '同名变量']
  },
  {
    id: 'vsc-quick-open',
    category: 'vscode',
    categoryLabel: 'VS Code',
    keyCombo: 'Ctrl+P',
    macKeyCombo: 'Cmd+P',
    title: '按文件名极速跳转打开文件',
    subtitle: '输入 @ 可跳符号函数，输入 : 可跳指定行号',
    keywords: ['搜索文件', '打开文件', '跳转行号', 'quick open']
  },
  {
    id: 'vsc-global-symbol',
    category: 'vscode',
    categoryLabel: 'VS Code',
    keyCombo: 'Ctrl+T',
    macKeyCombo: 'Cmd+T',
    title: '跨文件全局搜索函数名与类名符号',
    subtitle: '直接按 AST 符号定位整个工作区中的类或方法定义',
    keywords: ['搜索函数', '全局符号', '找类', 'symbol']
  },
  {
    id: 'vsc-split-editor',
    category: 'vscode',
    categoryLabel: 'VS Code',
    keyCombo: 'Ctrl+\\',
    macKeyCombo: 'Cmd+\\',
    title: '左右拆分当前代码编辑器分栏',
    subtitle: '同屏对照阅读两个源码文件或同一个文件的上下部分',
    keywords: ['分屏', '左右对照', '拆分编辑器', 'split']
  },
  // Excel 职场办公
  {
    id: 'xls-abs-ref',
    category: 'excel',
    categoryLabel: 'Excel 表格',
    keyCombo: 'F4',
    macKeyCombo: 'Cmd+T',
    title: '切换公式单元格绝对引用 ($A$1) / 相对引用',
    subtitle: '在编辑公式时按 F4 自动加上美元符号锁定行列，或重复上一步操作',
    keywords: ['绝对引用', '锁定单元格', '美元符号', '冻结公式', 'excel']
  },
  {
    id: 'xls-flash-fill',
    category: 'excel',
    categoryLabel: 'Excel 表格',
    keyCombo: 'Ctrl+E',
    title: '智能快速填充 (Flash Fill 自动提取拆分列)',
    subtitle: '无需写公式！输入一行示例后按 Ctrl+E 自动按规律批量提取手机号、姓名或省市',
    keywords: ['快速填充', '智能填充', '拆分列', '提取文本', 'excel']
  },
  {
    id: 'xls-auto-sum',
    category: 'excel',
    categoryLabel: 'Excel 表格',
    keyCombo: 'Alt+=',
    title: '一键自动求和 (AutoSum 生成 SUM 公式)',
    subtitle: '选中数据区底部或右侧空白行，1秒插入全列/全行求和公式',
    keywords: ['求和', '自动汇总', '合计', 'sum', 'excel']
  },
  {
    id: 'xls-freeze-panes',
    category: 'excel',
    categoryLabel: 'Excel 表格',
    keyCombo: 'Alt+W+F+F',
    title: '冻结首行与首列窗格 (Freeze Panes)',
    subtitle: '滚动大表格时保持顶部表头和左侧序号列固定不动',
    keywords: ['冻结窗格', '固定表头', '锁定首行', 'freeze', 'excel']
  },
  {
    id: 'xls-filter-toggle',
    category: 'excel',
    categoryLabel: 'Excel 表格',
    keyCombo: 'Ctrl+Shift+L',
    title: '一键开启或关闭表头自动筛选下拉箭头',
    subtitle: '快速为数据表添加列筛选与排序漏斗',
    keywords: ['筛选', '自动筛选', '漏斗', 'filter', 'excel']
  },
  // Photoshop 设计
  {
    id: 'ps-free-transform',
    category: 'ps',
    categoryLabel: 'Photoshop',
    keyCombo: 'Ctrl+T',
    macKeyCombo: 'Cmd+T',
    title: '自由变换图层大小、旋转与透视',
    subtitle: '调整选中图层尺寸比例与角度，回车确认应用',
    keywords: ['自由变换', '缩放图层', '旋转图片', 'ps']
  },
  {
    id: 'ps-merge-visible',
    category: 'ps',
    categoryLabel: 'Photoshop',
    keyCombo: 'Ctrl+Shift+Alt+E',
    macKeyCombo: 'Cmd+Shift+Option+E',
    title: '盖印可见图层 (合并生成新图层且保留原图层)',
    subtitle: '在不破坏下方原始分层的前提下生成一张合并后的完整图层',
    keywords: ['盖印图层', '合并图层', '保留原图层', 'ps']
  },
  // Chrome / Edge 浏览器
  {
    id: 'web-reopen-tab',
    category: 'browser',
    categoryLabel: 'Chrome / Edge',
    keyCombo: 'Ctrl+Shift+T',
    macKeyCombo: 'Cmd+Shift+T',
    title: '恢复刚刚误关闭的浏览器标签页',
    subtitle: '可连续按多次依次找回最近关闭的网页乃至整个窗口',
    keywords: ['恢复标签页', '误关网页', '找回网页', '重新打开', 'browser']
  },
  {
    id: 'web-clear-cache-reload',
    category: 'browser',
    categoryLabel: 'Chrome / Edge',
    keyCombo: 'Ctrl+F5',
    macKeyCombo: 'Cmd+Shift+R',
    title: '忽略本地缓存强制硬刷新当前网页',
    subtitle: '解决前端发版后网页样式或 JS 仍为旧缓存的问题',
    keywords: ['强制刷新', '清缓存刷新', '硬刷新', 'reload', 'browser']
  },
  {
    id: 'web-incognito',
    category: 'browser',
    categoryLabel: 'Chrome / Edge',
    keyCombo: 'Ctrl+Shift+N',
    macKeyCombo: 'Cmd+Shift+N',
    title: '打开无痕/隐私浏览窗口 (Incognito)',
    subtitle: '不保存浏览历史、Cookie 与登录状态的干净测试窗口',
    keywords: ['无痕模式', '隐私窗口', '小号登录', 'incognito', 'browser']
  }
])
