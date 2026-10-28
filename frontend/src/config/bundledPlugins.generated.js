// 由 scripts/sync-bundled-plugins.mjs 生成，请勿手改；修改内置插件名单请编辑 bundledPlugins.json 后重新运行脚本
export default {
  "ids": [
    "json-format",
    "timestamp",
    "calculator",
    "qr-code",
    "base64image",
    "file-compare",
    "crypto-tool",
    "google-auth",
    "color-picker",
    "memo",
    "todo",
    "batch-image",
    "archive-manager",
    "invoice-assistant",
    "translator",
    "downloads-manager"
  ],
  "unreleasedOfficialIds": [
    "ai-image",
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
    "ai-video",
    "batch-audio",
    "batch-rename",
    "boost",
    "cleaner",
    "clipboard-manager",
    "context-menu",
    "disk-analyzer",
    "flow-guard",
    "hardware-info",
    "kill-process",
    "lan-share",
    "mover",
    "network-adapter",
    "network-rescue",
    "ocr",
    "process-monitor",
    "qq-cleaner",
    "record",
    "screen-color-picker",
    "screenshot",
    "shredder",
    "software-manager",
    "sqlite-plugin",
    "system-backup",
    "system-tools",
    "wechat-cleaner",
    "window-manager"
  ],
  "storePlugins": [
    {
      "id": "ai-video",
      "name": "AI 视频增强",
      "description": "本地 AI 视频画质超清放大、60/120 帧流畅补帧与低清视频画质修复",
      "category": [
        "图像媒体",
        "AI工具"
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
      "id": "disk-analyzer",
      "name": "磁盘空间分析",
      "description": "快速分析各磁盘分区空间占用，按文件夹大小与大文件排行直观找出占满硬盘的文件",
      "category": [
        "系统工具"
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
      "id": "hardware-info",
      "name": "硬件信息",
      "description": "查看电脑 CPU、内存、磁盘容量、显示器与电源状态，支持导出硬件配置报告",
      "category": [
        "系统工具"
      ]
    },
    {
      "id": "kill-process",
      "name": "结束进程",
      "description": "按内存或 CPU 占用列出正在运行的进程，确认后结束单个进程或整个进程树，可用于关闭无响应的程序",
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
      "id": "record",
      "name": "屏幕录制",
      "description": "录制整个桌面（所有显示器）为 MP4 视频或 GIF 动图，可选帧率；不录制声音，需要本机已安装 ffmpeg",
      "category": [
        "图像媒体"
      ]
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
      "id": "software-manager",
      "name": "软件卸载",
      "description": "列出系统登记的已安装软件与占用体积，确认后启动软件自带的卸载程序，并只读列出 AppData 目录占用",
      "category": [
        "系统工具"
      ]
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
      "id": "wechat-cleaner",
      "name": "微信清理",
      "description": "扫描微信电脑版的缓存、日志、聊天视频与图片、接收文件等，把勾选的文件移入回收站，聊天记录数据库不会被清理",
      "category": [
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
      "version": "2.1.3",
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
      ]
    },
    {
      "id": "timestamp",
      "name": "时间戳转换",
      "description": "秒与毫秒时间戳、日期格式实时互转，支持全球城市世界时钟与多时区时差换算",
      "version": "1.1.3",
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
      ]
    },
    {
      "id": "calculator",
      "name": "计算器",
      "description": "输入算式即时计算，内置科学函数、单位换算、每日汇率、人民币大写金额转换与日期推算",
      "version": "2.1.5",
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
      ]
    },
    {
      "id": "qr-code",
      "name": "二维码生成",
      "description": "输入网址或文本实时生成高清二维码，支持生成 Wi-Fi 连网二维码、复制图片与导出 PNG",
      "version": "2.1.6",
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
      ]
    },
    {
      "id": "base64image",
      "name": "图片 Base64",
      "description": "图片文件或截图与 Base64 编码双向互转，支持一键复制 Data URL 或还原预览图片",
      "version": "1.0.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "开发工具"
      ],
      "keywords": [
        "base64",
        "图片",
        "image",
        "datauri",
        "编码",
        "解码"
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
      ]
    },
    {
      "id": "file-compare",
      "name": "文本对比",
      "description": "逐行对比两段文本、代码或配置文件，逐处列出增删的行，支持忽略空白与复制 unified diff 差异报告",
      "version": "2.0.5",
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
      ]
    },
    {
      "id": "crypto-tool",
      "name": "编码与加密",
      "description": "支持 Base64 / URL / Unicode / Hex 编码互转、MD5 / SHA 哈希计算、AES 加解密与 UUID 批量生成",
      "version": "1.1.2",
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
          "explain": "计算 MD5 / SHA256 哈希摘要",
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
            "hmac",
            "加密解密"
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
      ]
    },
    {
      "id": "google-auth",
      "name": "2FA 验证码",
      "description": "桌面端两步验证动态口令（TOTP）管理工具，支持秒级复制 6 位验证码，密钥加密保存在本机",
      "version": "1.0.6",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具"
      ],
      "keywords": [
        "2fa",
        "totp",
        "otp",
        "验证码",
        "动态口令",
        "authenticator"
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
      ]
    },
    {
      "id": "color-picker",
      "name": "取色与配色",
      "description": "支持 HEX / RGB / HSL / CMYK 色值实时互转、WCAG 无障碍对比度检测与常用色板收藏",
      "version": "2.1.5",
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
          "explain": "WCAG 无障碍颜色对比度检测",
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
      ]
    },
    {
      "id": "memo",
      "name": "便签",
      "description": "轻量随手记便签，正文支持 Markdown，可加标签，按标题、正文或标签搜索",
      "version": "1.0.6",
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
      ]
    },
    {
      "id": "todo",
      "name": "待办清单",
      "description": "极简任务待办清单，回车快速添加任务，支持高优标记与完成状态筛选",
      "version": "1.0.5",
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
      ]
    },
    {
      "id": "batch-image",
      "name": "图片压缩",
      "description": "批量压缩与转换 PNG/JPG/WebP/BMP 图片：三档画质重新编码、限制最长边、转 JPG/PNG、扫描件转灰度，报销附件场景会标出仍超过 300KB 的图片；结果另存为原图同目录的 *_opt 文件，不覆盖原图",
      "version": "1.1.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "图像媒体",
        "办公效率"
      ],
      "keywords": [
        "image",
        "compress",
        "png",
        "jpg",
        "webp",
        "图片压缩",
        "格式转换",
        "图片转jpg",
        "图片缩放"
      ],
      "alias": "img",
      "features": [
        {
          "code": "preset-lossless",
          "explain": "图片批量压缩",
          "mode": "view",
          "cmds": [
            "图片压缩",
            "压缩图片",
            "图片瘦身"
          ]
        },
        {
          "code": "preset-gov-limit",
          "explain": "报销/政务附件压缩（标出超过 300KB 的图片）",
          "mode": "view",
          "cmds": [
            "证件照压缩",
            "300kb",
            "政务上传",
            "报销附图"
          ]
        },
        {
          "code": "preset-to-jpg",
          "explain": "PNG/WebP/BMP 批量转 JPG",
          "mode": "view",
          "cmds": [
            "图片格式转换",
            "webp转jpg",
            "png转jpg",
            "转jpg"
          ]
        },
        {
          "code": "preset-doc-bw",
          "explain": "扫描件转灰度",
          "mode": "view",
          "cmds": [
            "扫描件转灰度",
            "图片转灰度",
            "黑白扫描件"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        }
      ]
    },
    {
      "id": "archive-manager",
      "name": "解压与压缩",
      "description": "不解压就能查看本机 ZIP 压缩包里的文件，可整包解压或只提取勾选的文件；只支持 ZIP，不提供压缩打包",
      "version": "1.1.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "文件管理",
        "办公效率"
      ],
      "keywords": [
        "zip",
        "archive",
        "unzip",
        "extract",
        "解压",
        "压缩包",
        "查看压缩包"
      ],
      "alias": "zip",
      "features": [
        {
          "code": "archive-inspect",
          "explain": "查看 ZIP 压缩包内容并解压或提取",
          "mode": "view",
          "cmds": [
            "解压",
            "压缩包",
            "查看压缩包",
            "zip",
            "校验压缩包"
          ]
        },
        {
          "code": "archive-docs",
          "explain": "提取压缩包内办公文档",
          "mode": "view",
          "cmds": [
            "提取文档",
            "压缩包文档"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        }
      ]
    },
    {
      "id": "invoice-assistant",
      "name": "发票助手",
      "description": "扫描下载、桌面、文档目录中的 PDF/XML 电子发票，识别发票号码、开票日期、销售方、购买方与金额（识别不到的字段需手动补全后才能导出），支持发票号查重、个人抬头提示、按模板复制规范命名的发票副本、导出报销明细 CSV 与复制表格文本",
      "version": "1.1.4",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "办公效率",
        "文档处理"
      ],
      "keywords": [
        "invoice",
        "fapiao",
        "reimbursement",
        "pdf",
        "csv",
        "excel",
        "发票",
        "报销",
        "电子发票",
        "数电票"
      ],
      "alias": "fp",
      "features": [
        {
          "code": "invoice-reimburse",
          "explain": "电子发票汇总与导出报销明细",
          "mode": "view",
          "cmds": [
            "发票报销",
            "报销台账",
            "发票汇总",
            "导出报销单",
            "数电票",
            "电子发票"
          ]
        },
        {
          "code": "invoice-rename",
          "explain": "按模板复制规范命名的电子发票副本",
          "mode": "view",
          "cmds": [
            "发票重命名",
            "发票改名",
            "归档重命名"
          ]
        },
        {
          "code": "invoice-travel",
          "explain": "差旅交通与住宿发票筛选",
          "mode": "view",
          "cmds": [
            "差旅发票",
            "打车票",
            "高铁票",
            "交通发票",
            "酒店发票"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        }
      ]
    },
    {
      "id": "translator",
      "name": "划词翻译",
      "description": "中英互译常用词与办公短语（只查客户端内置的离线词库，收录有限），并把英文转成 camelCase / snake_case 变量名",
      "version": "2.0.2",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "办公效率",
        "文本工具"
      ],
      "keywords": [
        "translate",
        "translator",
        "dictionary",
        "english",
        "chinese",
        "翻译",
        "划词翻译",
        "词典",
        "中英互译",
        "变量命名"
      ],
      "alias": "tr",
      "features": [
        {
          "code": "translate-standard",
          "explain": "中英互译（客户端离线词库，收录有限）",
          "mode": "view",
          "cmds": [
            "翻译",
            "划词翻译",
            "中英互译",
            "英文翻译",
            "translate"
          ]
        },
        {
          "code": "translate-dict",
          "explain": "查中英常用词的译文（客户端离线词库，收录有限）",
          "mode": "view",
          "cmds": [
            "词典",
            "查词",
            "单词",
            "dictionary"
          ]
        },
        {
          "code": "translate-naming",
          "explain": "中文翻译成英文变量名（camelCase / snake_case）",
          "mode": "view",
          "cmds": [
            "变量命名",
            "代码命名",
            "驼峰命名",
            "camelcase"
          ]
        }
      ],
      "targets": [
        {
          "id": "windows-electron-any",
          "platform": "windows",
          "runtime": "electron",
          "arch": "any"
        }
      ]
    },
    {
      "id": "downloads-manager",
      "name": "下载管理",
      "description": "聚合已识别的系统下载、网盘与接收目录，支持自定义目录、筛选、打开和安全回收；扫描不完整时明确提示",
      "version": "2.1.5",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "效率工具",
        "系统工具"
      ],
      "keywords": [],
      "alias": "",
      "features": [
        {
          "code": "downloads-all",
          "explain": "浏览和筛选已识别下载目录与自定义目录中的文件",
          "cmds": [
            "下载",
            "下载管理",
            "downloads",
            "dl",
            "最近下载",
            "接收文件"
          ]
        },
        {
          "code": "downloads-netdisk",
          "explain": "筛选已识别的网盘和下载器目录中的文件",
          "cmds": [
            "网盘下载",
            "百度网盘",
            "夸克下载",
            "迅雷下载",
            "netdisk"
          ]
        },
        {
          "code": "downloads-im",
          "explain": "筛选已识别的办公软件接收目录中的文件，未识别目录可自行添加",
          "cmds": [
            "微信文件",
            "微信接收",
            "QQ文件",
            "飞书文件",
            "钉钉文件"
          ]
        },
        {
          "code": "downloads-clean-installers",
          "explain": "筛选当前列出的安装包，经确认后将未保护项移入回收站",
          "cmds": [
            "清理安装包",
            "删除安装包",
            "installers"
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
      ]
    }
  ]
}
