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
    "translator"
  ],
  "unreleasedOfficialIds": [
    "batch-text-convert",
    "chinese-number-converter",
    "port-manager",
    "unit-converter",
    "uuid-generator",
    "world-clock"
  ],
  "storeOfficialIds": [
    "ai-image",
    "ai-video",
    "batch-audio",
    "batch-rename",
    "batch-video",
    "boost",
    "calendar",
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
    "video-downloader",
    "wechat-cleaner",
    "wechat-multi",
    "window-manager"
  ],
  "plugins": [
    {
      "id": "json-format",
      "name": "JSON 格式化",
      "description": "JSON 语法校验、高亮美化与压缩转义，支持一键生成 TypeScript / Go / Rust 数据结构定义",
      "version": "2.1.2",
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
      "version": "1.1.2",
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
      "version": "2.1.2",
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
      "version": "2.1.2",
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
      "version": "1.0.3",
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
      "description": "左右并排对比两段文本、代码或配置文件的逐行差异，支持忽略空白与一键复制差异报告",
      "version": "2.0.4",
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
      "version": "1.0.4",
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
      "version": "2.1.2",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "设计工具"
      ],
      "keywords": [
        "color",
        "颜色",
        "取色",
        "拾色器",
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
            "cmyk",
            "取色",
            "拾色器"
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
      "description": "轻量随手记便签，支持 Markdown 排版、分类标签筛选与全文快速搜索",
      "version": "1.0.3",
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
      "version": "1.0.3",
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
      "description": "批量无损压缩 PNG/JPG/WebP 图片体积，支持政务报销 300KB 限额压缩、格式转换、清除拍摄隐私与多图合并转 PDF",
      "version": "1.1.1",
      "author": "ZTools Team",
      "icon": "icon.svg",
      "category": [
        "图像媒体",
        "办公效率"
      ],
      "keywords": [
        "image",
        "compress",
        "tinypng",
        "png",
        "jpg",
        "webp",
        "exif",
        "图片压缩",
        "格式转换",
        "图片转PDF"
      ],
      "alias": "img",
      "features": [
        {
          "code": "preset-lossless",
          "explain": "图片智能无损压缩",
          "mode": "view",
          "cmds": [
            "图片压缩",
            "无损压缩",
            "tinypng",
            "压缩图片",
            "图片瘦身"
          ]
        },
        {
          "code": "preset-gov-limit",
          "explain": "政务/报销图片极限压缩 (≤300KB)",
          "mode": "view",
          "cmds": [
            "证件照压缩",
            "限制大小",
            "300kb",
            "政务上传",
            "报销附图"
          ]
        },
        {
          "code": "preset-to-jpg",
          "explain": "WebP/HEIC 批量转 JPG",
          "mode": "view",
          "cmds": [
            "图片格式转换",
            "webp转jpg",
            "heic转jpg",
            "png转jpg",
            "转jpg"
          ]
        },
        {
          "code": "preset-strip-exif",
          "explain": "清除图片 EXIF 隐私信息",
          "mode": "view",
          "cmds": [
            "去exif",
            "清除exif",
            "抹除定位",
            "图片脱敏",
            "拍摄信息"
          ]
        },
        {
          "code": "preset-merge-pdf",
          "explain": "多张图片合并转 PDF",
          "mode": "view",
          "cmds": [
            "图片转pdf",
            "多图转pdf",
            "合成pdf",
            "jpg转pdf"
          ]
        },
        {
          "code": "preset-doc-bw",
          "explain": "合同扫描件黑白高对比增强",
          "mode": "view",
          "cmds": [
            "扫描件增强",
            "合同去灰底",
            "黑白扫描",
            "票据增强"
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
      "description": "免解压直接预览压缩包内容、按需提取单个文件，支持 ZIP/7Z/RAR/TAR 智能解压与加密打包",
      "version": "1.1.1",
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
        "7z",
        "rar",
        "解压",
        "压缩包",
        "压缩包透视"
      ],
      "alias": "zip",
      "features": [
        {
          "code": "archive-inspect",
          "explain": "透视压缩包与免解压提取",
          "mode": "view",
          "cmds": [
            "解压",
            "压缩包",
            "透视压缩包",
            "zip",
            "7z",
            "rar",
            "查看压缩包"
          ]
        },
        {
          "code": "archive-docs",
          "explain": "提取压缩包内办公文档",
          "mode": "view",
          "cmds": [
            "提取文档",
            "压缩包文档",
            "提取合同",
            "提取标书"
          ]
        },
        {
          "code": "archive-verify",
          "explain": "压缩包密码检测与安全扫描",
          "mode": "view",
          "cmds": [
            "压缩包加密",
            "zip密码",
            "安全扫描",
            "校验压缩包"
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
      "description": "自动识别 PDF/XML 电子发票金额与税号，支持重复发票查重、抬头校验、批量规范重命名与导出报销明细表",
      "version": "1.1.1",
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
          "explain": "电子发票汇总与导出报销单",
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
          "explain": "电子发票批量规范重命名",
          "mode": "view",
          "cmds": [
            "发票重命名",
            "发票改名",
            "归档重命名"
          ]
        },
        {
          "code": "invoice-travel",
          "explain": "差旅交通与住宿票据筛选",
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
      "description": "支持中英日韩法德多语种互译、英汉词典释义、商务邮件润色与代码变量命名转换",
      "version": "1.1.1",
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
        "商务英语"
      ],
      "alias": "tr",
      "features": [
        {
          "code": "translate-standard",
          "explain": "中英日韩多语种互译",
          "mode": "view",
          "cmds": [
            "翻译",
            "划词翻译",
            "中英互译",
            "英文翻译",
            "日文翻译",
            "translate"
          ]
        },
        {
          "code": "translate-business",
          "explain": "外贸与商务邮件得体润色",
          "mode": "view",
          "cmds": [
            "商务英语",
            "邮件润色",
            "英文邮件",
            "外贸翻译",
            "商务翻译"
          ]
        },
        {
          "code": "translate-dict",
          "explain": "专业术语词典与词根拆解",
          "mode": "view",
          "cmds": [
            "词典",
            "查词",
            "单词",
            "术语拆解",
            "英汉词典",
            "dictionary"
          ]
        },
        {
          "code": "translate-naming",
          "explain": "代码变量命名翻译 (驼峰/下划线)",
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
    }
  ]
}
