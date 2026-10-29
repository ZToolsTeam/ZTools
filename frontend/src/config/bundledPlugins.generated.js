// 由 scripts/sync-bundled-plugins.mjs 生成，请勿手改；修改内置插件名单请编辑 bundledPlugins.json 后重新运行脚本
export default {
  "ids": [
    "json-format",
    "timestamp",
    "calculator",
    "qr-code",
    "file-compare",
    "crypto-tool",
    "color-picker",
    "memo",
    "todo"
  ],
  "unreleasedOfficialIds": [
    "ai-image",
    "ai-video",
    "batch-text-convert",
    "batch-video",
    "browser-history",
    "chinese-number-converter",
    "data-recovery",
    "hosts",
    "image-editor",
    "image-tool",
    "multi-download",
    "pdf",
    "port-manager",
    "super-markdown",
    "unit-converter",
    "uuid-generator",
    "video-downloader",
    "wechat-multi",
    "world-clock"
  ],
  "storeOfficialIds": [
    "archive-manager",
    "audio-device",
    "base64image",
    "batch-audio",
    "batch-image",
    "batch-rename",
    "boost",
    "browser-bookmarks",
    "caffeine",
    "calendar",
    "chmod-cidr-calc",
    "clean-keyboard",
    "cleaner",
    "clipboard-manager",
    "context-menu",
    "curl-http",
    "disk-analyzer",
    "dns-benchmark",
    "docker-manager",
    "downloads-manager",
    "env-manager",
    "everything-file-search",
    "file-inspector",
    "file-unlock",
    "flow-guard",
    "folder-sync",
    "font-manager",
    "git-helper",
    "google-auth",
    "hardware-info",
    "hosts-switcher",
    "hotkey-radar",
    "id-watermark",
    "invoice-assistant",
    "jwt-url-codec",
    "kill-process",
    "lan-scanner",
    "lan-share",
    "linux-http-dict",
    "md-to-office",
    "media-metadata",
    "mock-data",
    "monitor-control",
    "mover",
    "network-adapter",
    "network-rescue",
    "ocr",
    "office-slim",
    "password-vault",
    "paste-stack",
    "pomodoro-focus",
    "process-monitor",
    "qq-cleaner",
    "quick-folders",
    "quicklinks",
    "record",
    "regex-cron",
    "screen-color-picker",
    "screenshot",
    "shredder",
    "shutdown-timer",
    "snippets",
    "software-manager",
    "speedtest",
    "sql-helper",
    "sqlite-plugin",
    "ssh-proxy-helper",
    "ssl-domain-check",
    "startup-manager",
    "svg-icon-studio",
    "system-backup",
    "system-tools",
    "table-converter",
    "text-formatter",
    "translator",
    "vscode-projects",
    "wechat-cleaner",
    "wifi-password-reveal",
    "window-manager"
  ],
  "storePlugins": [
    {
      "id": "archive-manager",
      "name": "解压与压缩",
      "description": "不解压就能查看本机 ZIP 压缩包里的文件，可整包解压或只提取勾选的文件；只支持 ZIP，不提供压缩打包",
      "category": [
        "文件管理",
        "办公效率"
      ]
    },
    {
      "id": "audio-device",
      "name": "音频设备切换",
      "description": "秒级切换系统默认扬声器、耳机与麦克风，支持音量调节、快速静音，可按蓝牙、USB、显示器等连接方式搜索设备",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "base64image",
      "name": "图片 Base64",
      "description": "图片文件或截图与 Base64 编码双向互转，支持一键复制 Data URL 或还原预览图片",
      "category": [
        "开发工具"
      ]
    },
    {
      "id": "batch-audio",
      "name": "音频转换",
      "description": "支持 MP3/FLAC/WAV/AAC 批量格式转换、音量均衡调节、静音片段裁剪与多段音频合并",
      "category": [
        "图像媒体",
        "办公效率"
      ]
    },
    {
      "id": "batch-image",
      "name": "图片压缩",
      "description": "批量压缩与转换 PNG/JPG/WebP/BMP 图片：三档画质重新编码、限制最长边、转 JPG/PNG、扫描件转灰度，报销附件场景会标出仍超过 300KB 的图片；结果另存为原图同目录的 *_opt 文件，不覆盖原图",
      "category": [
        "图像媒体",
        "办公效率"
      ]
    },
    {
      "id": "batch-rename",
      "name": "批量重命名",
      "description": "批量修改文件夹里的文件名：查找替换、加前缀 / 后缀 / 当天日期前缀、追加序号、去括号、下划线或全小写规范，执行前预览并确认，本次打开期间可撤销",
      "category": "utility"
    },
    {
      "id": "boost",
      "name": "开机启动项",
      "description": "列出内存占用最高的进程、“启动”文件夹里的开机启动项和临时文件，勾选并确认后结束进程，或把启动项和临时文件移入回收站",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "browser-bookmarks",
      "name": "网页书签",
      "description": "只读聚合本机浏览器的多个配置，支持中文、拼音、网址与文件夹检索，打开或复制书签；无法读取的来源会明确提示",
      "category": [
        "效率工具",
        "网络工具"
      ]
    },
    {
      "id": "caffeine",
      "name": "防休眠常亮",
      "description": "阻止系统自动休眠与息屏，支持定时倒计时自动恢复与一键常亮切换",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "calendar",
      "name": "日程日历",
      "description": "在本机记录和查看日程，用浏览器打开日程里的视频会议链接，可新建、删除日程并导出 ICS 日历文件",
      "category": []
    },
    {
      "id": "chmod-cidr-calc",
      "name": "网段与权限计算",
      "description": "IPv4 CIDR 子网掩码/可用地址池/32 位二进制掩码计算与 Linux chmod 八进制/符号权限位双向推演工具",
      "category": []
    },
    {
      "id": "clean-keyboard",
      "name": "键盘清洁锁",
      "description": "Mac 系统键盘清洁锁，可同时拦截鼠标，支持 5～300 秒倒计时、紧急解锁与失联自动解除",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "cleaner",
      "name": "垃圾清理",
      "description": "扫描临时文件、浏览器缓存、开发工具缓存与崩溃转储等位置，把勾选的文件移入回收站，也可以清空回收站",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "clipboard-manager",
      "name": "剪贴板历史",
      "description": "查看客户端记录的剪贴板历史（文本、图片、文件），支持搜索、置顶、编辑，并粘贴回前台应用",
      "category": "system"
    },
    {
      "id": "context-menu",
      "name": "右键菜单管理",
      "description": "列出文件、文件夹和文件夹空白处右键菜单里的命令项（注册表 shell 子键），可逐项启用或禁用，并可切换 Windows 11 经典右键菜单；暂不包含外壳扩展（shellex）",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "curl-http",
      "name": "轻量接口调试",
      "description": "解析 cURL 命令（bash / cmd 写法）或网址，由客户端发起 HTTP 请求查看响应，并生成 Fetch、Axios、Python、Go 请求代码",
      "category": []
    },
    {
      "id": "disk-analyzer",
      "name": "磁盘空间分析",
      "description": "快速分析各磁盘分区空间占用，按文件夹大小与大文件排行直观找出占满硬盘的文件",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "dns-benchmark",
      "name": "DNS测速",
      "description": "测试公共 DNS 地址的响应情况，切换当前网络 DNS；Mac 支持真实域名解析、配置备份与恢复",
      "category": [
        "网络工具",
        "系统工具"
      ]
    },
    {
      "id": "docker-manager",
      "name": "容器管控",
      "description": "查看本机 Docker 容器、端口和资源采样，支持启停、日志与确认后清理停止容器；需已安装并启动 Docker 环境",
      "category": []
    },
    {
      "id": "downloads-manager",
      "name": "下载管理",
      "description": "聚合已识别的系统下载、网盘与接收目录，支持自定义目录、筛选、打开和安全回收；扫描不完整时明确提示",
      "category": [
        "效率工具",
        "系统工具"
      ]
    },
    {
      "id": "env-manager",
      "name": "环境变量",
      "description": "管理 Windows 注册表环境与 macOS 终端变量，查看只读进程快照，预览 PATH 清理，修改前保留可恢复备份",
      "category": []
    },
    {
      "id": "everything-file-search",
      "name": "文件秒搜",
      "description": "按文件名或扩展名搜索本机文件和文件夹，可打开、定位、预览、复制路径或移入回收站",
      "category": []
    },
    {
      "id": "file-inspector",
      "name": "文件透视与转码",
      "description": "按文件头识别真实格式并修正错误的扩展名；检查文本文件的编码与换行符，可另存为 UTF-8-BOM，解决 Excel 打开 CSV 乱码",
      "category": []
    },
    {
      "id": "file-unlock",
      "name": "文件解锁",
      "description": "检测文件、文件夹和外接磁盘的真实进程占用，确认后结束进程，支持不覆盖改名，或移入回收站 / 废纸篓以便恢复",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "flow-guard",
      "name": "流量监控",
      "description": "查看本机各进程的 TCP / UDP 连接和监听端口，按公网、局域网、本机回环分类，可强制结束正在联网的进程",
      "category": [
        "系统工具",
        "网络工具"
      ]
    },
    {
      "id": "folder-sync",
      "name": "目录同步",
      "description": "比对普通文件内容后增量或双向同步，覆盖前保留校验备份；macOS 另支持镜像模式，把目标独有文件移入废纸篓（单文件最大 2 GiB）",
      "category": [
        "文件管理",
        "效率工具"
      ]
    },
    {
      "id": "font-manager",
      "name": "字体管理",
      "description": "检索本机已安装字体，输入文字查看真实字形，查看字体文件附带的许可与版权说明。",
      "category": []
    },
    {
      "id": "git-helper",
      "name": "Git救命锦囊",
      "description": "大白话场景检索Git回滚自救命令、交互式规范提交(Conventional Commits)生成器与多语言.gitignore模板合成",
      "category": []
    },
    {
      "id": "google-auth",
      "name": "2FA 验证码",
      "description": "桌面端两步验证动态口令（TOTP）管理工具，支持秒级复制 6 位验证码，密钥加密保存在本机",
      "category": [
        "效率工具"
      ]
    },
    {
      "id": "hardware-info",
      "name": "硬件信息",
      "description": "查看电脑 CPU、内存、磁盘容量、显示器与电源状态，支持导出硬件配置报告",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "hosts-switcher",
      "name": "域名映射",
      "description": "保存并切换多套 Hosts 方案；Mac 写入前预览、校验和备份，通过系统授权应用并支持恢复",
      "category": []
    },
    {
      "id": "hotkey-radar",
      "name": "热键侦测",
      "description": "检测全局快捷键注册情况，离线查询系统与常用软件快捷键；Mac 区分 ⌘ 与 ⌃，不推测占用进程",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "id-watermark",
      "name": "防盗水印",
      "description": "本地为 JPG、PNG、WebP 图片添加斜向文字水印，保留原图，另存 PNG 新副本或复制图片",
      "category": []
    },
    {
      "id": "invoice-assistant",
      "name": "发票助手",
      "description": "扫描下载、桌面、文档目录中的 PDF/XML 电子发票，识别发票号码、开票日期、销售方、购买方与金额（识别不到的字段需手动补全后才能导出），支持发票号查重、个人抬头提示、按模板复制规范命名的发票副本、导出报销明细 CSV 与复制表格文本",
      "category": [
        "办公效率",
        "文档处理"
      ]
    },
    {
      "id": "jwt-url-codec",
      "name": "JWT与URL解析",
      "description": "离线解析 JWT Token（Header/Payload/生命周期倒计时/HMAC-SHA256 验签与签发）与深度 URL Query 参数拆解重组工具",
      "category": []
    },
    {
      "id": "kill-process",
      "name": "结束进程",
      "description": "按内存或 CPU 占用列出正在运行的进程，确认后结束单个进程或整个进程树，可用于关闭无响应的程序",
      "category": []
    },
    {
      "id": "lan-scanner",
      "name": "局域网扫描",
      "description": "探测局域网设备与常见 TCP 端口，支持 MAC 收藏及 Wake-on-LAN 广播唤醒；每次分段扫描最多 256 个地址",
      "category": []
    },
    {
      "id": "lan-share",
      "name": "局域网传文件",
      "description": "选择电脑上的文件开启局域网共享，同一网络的手机或电脑用浏览器打开本机地址或扫码即可下载；共享不需要密码，只支持从电脑下载，不支持从手机上传",
      "category": [
        "网络工具",
        "办公效率"
      ]
    },
    {
      "id": "linux-http-dict",
      "name": "命令与状态码",
      "description": "离线速查 Linux 常用命令示例、常见 HTTP 状态码含义与排查步骤、常用服务默认端口",
      "category": []
    },
    {
      "id": "md-to-office",
      "name": "AI文档转Word",
      "description": "本地将 Markdown 文本或文件转换为 Word 新副本，保留标题、列表、表格和代码块，支持公文、商务和学术排版及富文本复制",
      "category": []
    },
    {
      "id": "media-metadata",
      "name": "EXIF隐私抹除",
      "description": "本地读取照片与音视频元数据，清理照片定位及拍摄信息，校验图像数据后另存新副本",
      "category": []
    },
    {
      "id": "mock-data",
      "name": "测试数据生成",
      "description": "一键生成符合国家校验位算法的虚拟测试用18位身份证号、手机号、统一社会信用代码、银行卡号及批量JSON测试数据",
      "category": []
    },
    {
      "id": "monitor-control",
      "name": "屏幕亮度与控制",
      "description": "读取显示器真实硬件状态，调节受支持的亮度与对比度；支持多屏统一亮度与系统熄屏命令",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "mover",
      "name": "C盘搬家",
      "description": "把 C 盘用户目录下的微信与 QQ 文件、下载、文档、视频和 npm / pip / NuGet 缓存复制到其他分区，并在原位置建立目录联接，软件仍按原路径访问",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "network-adapter",
      "name": "网卡管理",
      "description": "查看本机网卡的 IPv4 地址、子网掩码、MAC 地址、网关与 DNS，可刷新 DNS 缓存，或把网卡 DNS 设为 223.5.5.5、恢复自动获取（修改 DNS 需要管理员权限）",
      "category": "system"
    },
    {
      "id": "network-rescue",
      "name": "网络修复",
      "description": "一键检测断网原因，支持刷新 DNS 缓存、重置网络配置与清除异常代理，快速恢复正常上网",
      "category": "system"
    },
    {
      "id": "ocr",
      "name": "图片识字",
      "description": "用 Windows 系统文字识别在本机识别图片和屏幕截图中的简体中文、英文、日文、韩文文字，结果可复制到剪贴板或导出为文本文件",
      "category": [
        "办公效率",
        "AI工具"
      ]
    },
    {
      "id": "office-slim",
      "name": "办公文档瘦身",
      "description": "本地重新压缩 Word、PPT、Excel 文档，保留图片原字节，可移除作者属性与批注、导出原图 ZIP；只另存新副本",
      "category": [
        "办公工具",
        "效率工具"
      ]
    },
    {
      "id": "password-vault",
      "name": "密码保险箱",
      "description": "在本机用主密码加密保存账号密码、API Key、服务器密码与软件激活码（AES-256-GCM），复制密码 30 秒后自动清除剪贴板",
      "category": [
        "安全隐私",
        "效率工具"
      ]
    },
    {
      "id": "paste-stack",
      "name": "纯文本与粘贴栈",
      "description": "一键清除剪贴板富文本脏格式转为纯文本；支持多项连续复制入栈、跨窗口依次顺序或倒序自动上屏粘贴",
      "category": [
        "效率工具",
        "办公工具"
      ]
    },
    {
      "id": "pomodoro-focus",
      "name": "番茄倒数",
      "description": "25 分钟番茄专注与短长休息，离页继续计时、重启恢复状态；本地保存重要日程倒数日并发送系统通知",
      "category": []
    },
    {
      "id": "process-monitor",
      "name": "进程监控",
      "description": "查看本机进程的 CPU 与内存占用、查询本地端口被哪个进程占用，可定位程序文件，确认后结束进程",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "qq-cleaner",
      "name": "QQ 清理",
      "description": "扫描电脑端 QQ、TIM 的日志、缓存、聊天图片与视频、接收文件等，把勾选的文件移入回收站，聊天记录数据库不会被清理",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "quick-folders",
      "name": "常用文件夹",
      "description": "一键打开桌面、下载、文档、AppData 与系统临时目录等高频文件夹，免去层层翻找",
      "category": "system"
    },
    {
      "id": "quicklinks",
      "name": "网页快开",
      "description": "聚合多平台快捷搜索与工作流网址组批量打开，支持自定义 {query} 变量与热键直达",
      "category": []
    },
    {
      "id": "record",
      "name": "屏幕录制",
      "description": "录制整个桌面（所有显示器）为 MP4 视频或 GIF 动图，可选帧率；不录制声音，需要本机已安装 ffmpeg",
      "category": [
        "图像媒体"
      ]
    },
    {
      "id": "regex-cron",
      "name": "正则与Cron",
      "description": "中国本土常用正则速查与实时测试高亮，支持Cron表达式中文语义解析与未来5次执行时间推算",
      "category": []
    },
    {
      "id": "screen-color-picker",
      "name": "屏幕取色",
      "description": "鼠标跟随像素级放大镜取色器，一键拾取屏幕任意位置颜色并复制 HEX / RGB / HSL 色值",
      "category": [
        "开发工具",
        "图像媒体"
      ]
    },
    {
      "id": "screenshot",
      "name": "截图历史",
      "description": "截取全部屏幕，浏览本机截图历史，支持复制、回贴、列表置顶与批量清理",
      "category": [
        "办公效率",
        "图像媒体"
      ]
    },
    {
      "id": "shredder",
      "name": "文件粉碎",
      "description": "列出临时文件夹与崩溃转储目录里的文件，勾选并确认后多次覆写文件内容再删除",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "shutdown-timer",
      "name": "定时关机",
      "description": "按预设倒计时（10、30、60、120 分钟）自动关机，或立即锁屏、睡眠，设定关机前会先确认；插件不能取消已设定的关机，可复制取消命令自行运行",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "snippets",
      "name": "快捷短语",
      "description": "管理常用开票税号、收件地址、客服话术与常用模板，支持动态日期/时间/剪贴板宏变量，一键穿透上屏或复制",
      "category": [
        "效率工具",
        "办公工具"
      ]
    },
    {
      "id": "software-manager",
      "name": "软件卸载",
      "description": "列出系统登记的已安装软件与占用体积，确认后启动软件自带的卸载程序，并只读列出 AppData 目录占用",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "speedtest",
      "name": "网络测速",
      "description": "测量上下行吞吐量，检测默认网关与国内、国际节点连接；Mac 使用系统网络测速工具",
      "category": [
        "网络工具",
        "系统工具"
      ]
    },
    {
      "id": "sql-helper",
      "name": "SQL格式化转换",
      "description": "SQL美化与精简、MyBatis日志参数核对、CREATE TABLE转TypeScript/Go/Java模型；支持多行编辑与剪贴板输入",
      "category": []
    },
    {
      "id": "sqlite-plugin",
      "name": "SQLite 查看器",
      "description": "查找 AppData 下的 SQLite 数据库文件，只读查看表结构与每张表前 50 行记录，并把记录导出为 CSV / JSON / SQL INSERT 文本",
      "category": [
        "开发工具"
      ]
    },
    {
      "id": "ssh-proxy-helper",
      "name": "主机与代理",
      "description": "管理 SSH 主机连接、端口转发及 Git、NPM 和新终端的本地代理配置",
      "category": []
    },
    {
      "id": "ssl-domain-check",
      "name": "域名与SSL诊断",
      "description": "查询域名真实 TLS 证书、信任与名称匹配状态、有效期和证书链，并查看 DNS 解析记录",
      "category": []
    },
    {
      "id": "startup-manager",
      "name": "启动管理",
      "description": "查看启动应用、后台服务与计划任务，管理自启状态；Mac 修改前保留可恢复的配置记录",
      "category": [
        "系统工具",
        "效率工具"
      ]
    },
    {
      "id": "svg-icon-studio",
      "name": "SVG预览与压缩",
      "description": "静态 SVG 校验、清理与代码预览，保留文字和数值精度，导出 React TSX / Vue 3 SFC / Data URI",
      "category": []
    },
    {
      "id": "system-backup",
      "name": "系统备份",
      "description": "一键打包备份 Hosts、环境变量、SSH 密钥、终端与开发配置，换机或重装系统后秒级还原",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "system-tools",
      "name": "系统工具",
      "description": "把锁屏、睡眠、休眠、重启、关机、注销、系统音量与静音、显示隐藏文件、清空回收站、防止熄屏等系统操作集中在一个列表里，回车执行，重启、关机、注销和清空回收站执行前会确认",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "table-converter",
      "name": "表格互转",
      "description": "离线转换 Excel 复制文本/TSV/CSV、JSON 数组、Markdown、HTML 文字表格与 SQLite INSERT，保留长数字和 JSON 类型，回车复制",
      "category": []
    },
    {
      "id": "text-formatter",
      "name": "文本排版",
      "description": "中英文混排自动加空格、中英标点互转、全半角转换、大小写转换与清除多余空行空白",
      "category": []
    },
    {
      "id": "translator",
      "name": "划词翻译",
      "description": "中英互译常用词与办公短语（只查客户端内置的离线词库，收录有限），并把英文转成 camelCase / snake_case 变量名",
      "category": [
        "办公效率",
        "文本工具"
      ]
    },
    {
      "id": "vscode-projects",
      "name": "最近项目",
      "description": "聚合检索 VS Code、Cursor、Trae、Windsurf 与 JetBrains 的本地最近项目，查看 Git 分支并打开编辑器或终端",
      "category": []
    },
    {
      "id": "wechat-cleaner",
      "name": "微信清理",
      "description": "扫描微信电脑版的缓存、日志、聊天视频与图片、接收文件等，把勾选的文件移入回收站，聊天记录数据库不会被清理",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "wifi-password-reveal",
      "name": "Wi-Fi 密码查看",
      "description": "查看本机已保存的无线网络，按需读取密码，并生成手机连网二维码",
      "category": [
        "网络工具",
        "系统工具"
      ]
    },
    {
      "id": "window-manager",
      "name": "窗口管理",
      "description": "快速管理桌面活动窗口，支持左右分屏贴靠、一键窗口置顶、透明度调节与尺寸居中",
      "category": [
        "系统工具",
        "办公效率"
      ]
    }
  ],
  "plugins": [
    {
      "id": "json-format",
      "name": "JSON 格式化",
      "description": "JSON 语法校验、高亮美化与压缩转义，支持一键生成 TypeScript / Go / Rust 数据结构定义",
      "version": "2.1.5",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "开发工具"
      ],
      "keywords": [
        "json",
        "格式化",
        "format",
        "minify",
        "压缩",
        "校验",
        "json转ts"
      ],
      "alias": "json",
      "features": [
        {
          "code": "json-beautify",
          "explain": "JSON 美化与语法校验",
          "mode": "view",
          "cmds": [
            "json格式化",
            "json美化",
            "json校验",
            "json"
          ]
        },
        {
          "code": "json-codegen",
          "explain": "JSON 生成 TypeScript / Go / Rust 类型",
          "mode": "view",
          "cmds": [
            "json转ts",
            "json转go",
            "生成类型",
            "interface生成"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 55174
    },
    {
      "id": "timestamp",
      "name": "时间戳转换",
      "description": "秒与毫秒时间戳、日期格式实时互转，支持全球城市世界时钟与多时区时差换算",
      "version": "1.1.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "开发工具"
      ],
      "keywords": [
        "timestamp",
        "时间戳",
        "unix",
        "date",
        "日期",
        "时间",
        "时区",
        "世界时钟"
      ],
      "alias": "ts",
      "features": [
        {
          "code": "tz-convert",
          "explain": "Unix 秒/毫秒时间戳与日期互转",
          "mode": "view",
          "cmds": [
            "时间戳",
            "时间戳转换",
            "unix时间",
            "毫秒转日期"
          ]
        },
        {
          "code": "tz-world",
          "explain": "UTC 与全球时区时间对照",
          "mode": "view",
          "cmds": [
            "世界时钟",
            "时区转换",
            "utc时间",
            "全球时间"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 24212
    },
    {
      "id": "calculator",
      "name": "计算器",
      "description": "输入算式即时计算，内置科学函数、单位换算、每日汇率、人民币大写金额转换与日期推算",
      "version": "2.1.6",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具"
      ],
      "keywords": [
        "calc",
        "计算",
        "计算器",
        "换算",
        "单位",
        "汇率",
        "大写金额"
      ],
      "alias": "calc",
      "features": [
        {
          "code": "calc-unit",
          "explain": "长度/重量/存储/温度单位换算",
          "mode": "view",
          "cmds": [
            "单位换算",
            "长度换算",
            "重量换算",
            "存储换算",
            "温度换算"
          ]
        },
        {
          "code": "calc-currency",
          "explain": "每日多币种汇率换算",
          "mode": "view",
          "cmds": [
            "汇率换算",
            "汇率",
            "美元人民币",
            "外币换算"
          ]
        },
        {
          "code": "calc-rmb",
          "explain": "财务人民币大写金额转换",
          "mode": "view",
          "cmds": [
            "大写金额",
            "人民币大写",
            "财务大写",
            "数字转大写"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 72891
    },
    {
      "id": "qr-code",
      "name": "二维码生成",
      "description": "输入网址或文本实时生成高清二维码，支持生成 Wi-Fi 连网二维码、复制图片与导出 PNG",
      "version": "2.1.7",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具"
      ],
      "keywords": [
        "qr",
        "qrcode",
        "二维码",
        "wifi"
      ],
      "alias": "qr",
      "features": [
        {
          "code": "qr-text",
          "explain": "文本与链接生成二维码",
          "mode": "view",
          "cmds": [
            "二维码",
            "生成二维码",
            "网址转二维码",
            "qrcode"
          ]
        },
        {
          "code": "qr-wifi",
          "explain": "生成 Wi-Fi 扫码连网二维码",
          "mode": "view",
          "cmds": [
            "wifi二维码",
            "连wifi二维码",
            "无线网二维码"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 40363
    },
    {
      "id": "file-compare",
      "name": "文本对比",
      "description": "逐行对比两段文本、代码或配置文件，逐处列出增删的行，支持忽略空白与复制 unified diff 差异报告",
      "version": "2.0.8",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "开发工具"
      ],
      "keywords": [
        "diff",
        "对比",
        "比较",
        "compare",
        "差异"
      ],
      "alias": "",
      "features": [],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 31595
    },
    {
      "id": "crypto-tool",
      "name": "编码与加密",
      "description": "支持 Base64 / URL / Unicode / Hex 编码互转、MD5 / SHA 哈希计算、AES 加解密、HMAC 计算与 UUID 批量生成",
      "version": "1.1.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "开发工具"
      ],
      "keywords": [
        "md5",
        "sha",
        "sha256",
        "hash",
        "哈希",
        "aes",
        "hmac",
        "加密",
        "解密",
        "base64",
        "url编码",
        "编码转换",
        "unicode",
        "uuid",
        "guid"
      ],
      "alias": "enc",
      "features": [
        {
          "code": "codec-base64",
          "explain": "Base64 编码与解码",
          "mode": "view",
          "cmds": [
            "base64",
            "base64解码",
            "base64编码",
            "编码转换",
            "文本转码"
          ]
        },
        {
          "code": "codec-url",
          "explain": "URL 组件编码与解码 (encodeURIComponent)",
          "mode": "view",
          "cmds": [
            "url编码",
            "url解码",
            "urlencode",
            "urldecode",
            "转义"
          ]
        },
        {
          "code": "hash-digest",
          "explain": "计算 MD5 / SHA-1 / SHA-256 / SHA-512 散列",
          "mode": "view",
          "cmds": [
            "md5",
            "sha1",
            "sha256",
            "sha512",
            "哈希",
            "散列",
            "摘要",
            "hash"
          ]
        },
        {
          "code": "cipher-aes",
          "explain": "AES 对称加密与解密",
          "mode": "view",
          "cmds": [
            "aes",
            "aes加密",
            "aes解密",
            "加密解密"
          ]
        },
        {
          "code": "cipher-hmac",
          "explain": "HMAC 计算（SHA-256 / SHA-512 / SHA-1 / MD5）",
          "mode": "view",
          "cmds": [
            "hmac",
            "hmac计算",
            "hmac-sha256"
          ]
        },
        {
          "code": "codec-unicode",
          "explain": "Unicode 编码与解码",
          "mode": "view",
          "cmds": [
            "unicode编码",
            "unicode解码"
          ]
        },
        {
          "code": "codec-hex",
          "explain": "UTF-8 Hex 编码与解码",
          "mode": "view",
          "cmds": [
            "hex编码",
            "hex解码"
          ]
        },
        {
          "code": "gen-uuid",
          "explain": "UUID v4 批量生成",
          "mode": "view",
          "cmds": [
            "uuid",
            "guid",
            "生成uuid"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 46505
    },
    {
      "id": "color-picker",
      "name": "取色与配色",
      "description": "支持 HEX / RGB / HSL / CMYK 色值实时互转、WCAG 无障碍对比度检测与常用色板收藏",
      "version": "2.1.6",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "设计工具"
      ],
      "keywords": [
        "color",
        "颜色",
        "hex",
        "rgb",
        "hsl",
        "oklch",
        "调色板"
      ],
      "alias": "clr",
      "features": [
        {
          "code": "convert-color",
          "explain": "HEX / RGB / HSL / OKLCH 色值互转",
          "mode": "view",
          "cmds": [
            "色值转换",
            "颜色转换",
            "hex转rgb",
            "rgb转hex",
            "oklch",
            "cmyk"
          ]
        },
        {
          "code": "contrast-check",
          "explain": "前景色与背景色的 WCAG 无障碍对比度检测",
          "mode": "view",
          "cmds": [
            "对比度",
            "无障碍对比度",
            "wcag",
            "配色方案"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 38769
    },
    {
      "id": "memo",
      "name": "便签",
      "description": "轻量随手记便签，正文支持 Markdown，可加标签，按标题、正文或标签搜索",
      "version": "1.0.7",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具"
      ],
      "keywords": [
        "memo",
        "note",
        "便签",
        "笔记",
        "备忘"
      ],
      "alias": "",
      "features": [],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 22968
    },
    {
      "id": "todo",
      "name": "待办清单",
      "description": "极简任务待办清单，回车快速添加任务，支持高优标记与完成状态筛选",
      "version": "1.0.6",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具"
      ],
      "keywords": [
        "todo",
        "待办",
        "任务",
        "清单"
      ],
      "alias": "",
      "features": [],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        },
        {
          "id": "macos-electron-any",
          "platform": "macos",
          "runtime": "electron",
          "arch": "any"
        }
      ],
      "size": 24410
    }
  ]
}
