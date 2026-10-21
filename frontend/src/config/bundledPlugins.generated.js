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
    "todo"
  ],
  "unreleasedOfficialIds": [],
  "storeOfficialIds": [
    "ai-image",
    "ai-video",
    "batch-audio",
    "batch-rename",
    "batch-text-convert",
    "batch-video",
    "boost",
    "calendar",
    "chinese-number-converter",
    "cleaner",
    "clipboard-manager",
    "context-menu",
    "data-recovery",
    "disk-analyzer",
    "everything-file-search",
    "flow-guard",
    "hardware-info",
    "kill-process",
    "lan-share",
    "mover",
    "multi-download",
    "network-adapter",
    "network-rescue",
    "ocr",
    "pdf",
    "port-manager",
    "process-monitor",
    "qq-cleaner",
    "quick-folders",
    "record",
    "screen-color-picker",
    "screenshot",
    "shredder",
    "shutdown-timer",
    "software-manager",
    "sqlite-plugin",
    "system-backup",
    "system-tools",
    "text-formatter",
    "unit-converter",
    "uuid-generator",
    "video-downloader",
    "wechat-cleaner",
    "wechat-multi",
    "window-manager",
    "world-clock"
  ],
  "plugins": [
    {
      "id": "json-format",
      "name": "JSON 格式化",
      "description": "校验 JSON 并定位错误，一键美化、压缩，生成 TypeScript / Go / Rust 类型；长整数不丢精度",
      "version": "2.0.0",
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
        "校验"
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
      "description": "秒 / 毫秒时间戳与日期互转，显示本地时间、UTC 与相对时间",
      "version": "1.0.0",
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
        "时间"
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
      "description": "输入算式即时出结果，支持常用函数、单位换算、日期推算与计算历史",
      "version": "2.0.0",
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
        "单位"
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
      "description": "输入文字实时生成二维码，可复制图片或保存 PNG，支持 Wi-Fi 二维码与历史记录",
      "version": "2.0.0",
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
      "name": "Base64 图片转换",
      "description": "图片文件或截图转 Base64 / Data URL，也能把 Base64 还原成图片预览",
      "version": "1.0.0",
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
      "description": "对比两段文本或两个文件的逐行差异，支持忽略空白与复制差异报告",
      "version": "2.0.0",
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
      "name": "加解密与散列",
      "description": "实时计算 MD5 / SHA-1 / SHA-256 / SHA-512 与 Base64、URL 编码，支持 AES 加解密与 HMAC",
      "version": "1.0.0",
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
        "base64"
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
      "description": "两步验证动态口令（TOTP），支持粘贴 otpauth 链接添加，密钥保存在本机",
      "version": "1.0.0",
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
      "name": "颜色转换",
      "description": "HEX / RGB / HSL / OKLCH / CMYK 互转，显示无障碍对比度，可收藏常用颜色",
      "version": "2.0.0",
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
      "description": "随手记，支持 Markdown 与标签，按标题或正文搜索",
      "version": "1.0.0",
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
      "description": "输入即添加待办，支持优先级、完成状态筛选",
      "version": "1.0.0",
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
