import type { HttpStatusItem, LinuxCommandItem, PortItem } from './types.js'

export const LINUX_COMMANDS_DICT: LinuxCommandItem[] = [
  {
    id: 'cmd-tar',
    name: 'tar',
    group: 'file',
    groupLabel: '文件与归档',
    description: '归档打包与解压 .tar / .tar.gz / .tar.bz2 / .tar.xz 归档文件',
    aliases: ['解压', '打包', '压缩', 'tgz', 'tar.gz'],
    stars: '5/5 高频必背',
    package: 'tar',
    params: [
      { flag: '-x', desc: '解压提取归档内容 (Extract)' },
      { flag: '-c', desc: '创建新的归档包 (Create)' },
      { flag: '-z', desc: '通过 gzip 压缩或解压 (.tar.gz)' },
      { flag: '-j', desc: '通过 bzip2 压缩或解压 (.tar.bz2)' },
      { flag: '-v', desc: '显示详细处理文件列表 (Verbose)' },
      { flag: '-f', desc: '指定归档文件名（必须放在参数末尾）' },
      { flag: '-C', desc: '解压到指定的目标目录' }
    ],
    examples: [
      {
        title: '解压 .tar.gz 压缩包到当前目录',
        cmd: 'tar -zxvf archive.tar.gz',
        note: '最常用解压组合：-z(gzip) -x(解压) -v(显示过程) -f(文件)'
      },
      {
        title: '解压 .tar.gz 到指定目录 /opt/app',
        cmd: 'tar -zxvf archive.tar.gz -C /opt/app'
      },
      {
        title: '将目录打包压缩为 .tar.gz 并排除 node_modules',
        cmd: 'tar --exclude="node_modules" -zcvf project-backup.tar.gz ./project'
      }
    ]
  },
  {
    id: 'cmd-unzip',
    name: 'unzip',
    group: 'file',
    groupLabel: '文件与归档',
    description: '解压 .zip 格式压缩包并支持指定字符集防中文乱码',
    aliases: ['解压', 'zip解压', '解压缩'],
    stars: '5/5 高频必背',
    package: 'unzip',
    params: [
      { flag: '-d <dir>', desc: '指定解压输出目录' },
      { flag: '-l', desc: '仅列出压缩包内文件清单而不解压' },
      { flag: '-O CP936', desc: '指定 GBK 编码解压 Windows 打包的中文 ZIP' }
    ],
    examples: [
      {
        title: '解压 zip 文件到指定目录',
        cmd: 'unzip dist.zip -d /var/www/html'
      },
      {
        title: '解决 Windows 上传的中文 zip 解压文件名乱码',
        cmd: 'unzip -O CP936 中文资料.zip'
      }
    ]
  },
  {
    id: 'cmd-find',
    name: 'find',
    group: 'file',
    groupLabel: '文件与归档',
    description: '按文件名、体积大小、修改时间递归检索文件并执行批量操作',
    aliases: ['查找文件', '搜索文件', '清理大文件', '清理过期日志'],
    stars: '5/5 高频必背',
    package: 'findutils',
    params: [
      { flag: '-name', desc: '按文件名通配符匹配（区分大小写）' },
      { flag: '-iname', desc: '按文件名通配符匹配（忽略大小写）' },
      { flag: '-size +100M', desc: '筛选体积大于 100MB 的大文件' },
      { flag: '-mtime +7', desc: '筛选修改时间在 7 天以前的文件' }
    ],
    examples: [
      {
        title: '查找 /var/log 下大于 100MB 的日志文件',
        cmd: 'find /var/log -type f -size +100M -exec ls -lh {} +'
      },
      {
        title: '自动删除 30 天前的过期 .log 日志文件',
        cmd: 'find /data/logs -type f -name "*.log" -mtime +30 -delete'
      }
    ]
  },
  {
    id: 'cmd-lsof',
    name: 'lsof',
    group: 'net',
    groupLabel: '网络与端口',
    description: '列出当前系统打开的文件句柄及监听指定端口的进程 PID',
    aliases: ['端口占用', '查端口', '谁占用了端口', '句柄占用'],
    stars: '5/5 高频必背',
    package: 'lsof',
    params: [
      { flag: '-i :<port>', desc: '查询占用指定网络端口的进程' },
      { flag: '-p <pid>', desc: '查看指定 PID 打开的所有文件句柄' },
      { flag: '+D <dir>', desc: '查看哪个进程占用了指定目录导致无法卸载' }
    ],
    examples: [
      {
        title: '查看 8080 端口被哪个进程占用',
        cmd: 'lsof -i :8080'
      },
      {
        title: '查出已删除但仍被进程句柄占用的幽灵大文件',
        cmd: 'lsof | grep deleted'
      }
    ]
  },
  {
    id: 'cmd-ss',
    name: 'ss',
    group: 'net',
    groupLabel: '网络与端口',
    description: '现代高性能 Socket 统计与监听端口排查工具（替代 netstat）',
    aliases: ['端口占用', '查看监听端口', 'netstat', '连接数统计'],
    stars: '5/5 高频必背',
    package: 'iproute2',
    params: [
      { flag: '-t', desc: '显示 TCP 连接' },
      { flag: '-u', desc: '显示 UDP 连接' },
      { flag: '-l', desc: '仅显示处于 LISTEN 监听状态的套接字' },
      { flag: '-p', desc: '显示监听该端口的进程名称与 PID' },
      { flag: '-n', desc: '直接显示数字 IP 与端口号（不解析域名）' }
    ],
    examples: [
      {
        title: '查看本机所有正在监听的 TCP/UDP 端口及对应进程',
        cmd: 'ss -tulpn'
      },
      {
        title: '过滤查询 6379 端口监听状态',
        cmd: 'ss -tulpn | grep :6379'
      }
    ]
  },
  {
    id: 'cmd-netstat',
    name: 'netstat',
    group: 'net',
    groupLabel: '网络与端口',
    description: '传统网络连接、路由表与端口占用状态查询工具',
    aliases: ['端口占用', '查端口', 'time_wait'],
    stars: '4/5 经典常用',
    package: 'net-tools',
    params: [
      { flag: '-tunlp', desc: '列出所有 TCP/UDP 数字监听端口与进程 PID' },
      { flag: '-an', desc: '列出所有活动连接状态（含 ESTABLISHED / TIME_WAIT）' }
    ],
    examples: [
      {
        title: '查看所有监听端口及所属程序',
        cmd: 'netstat -tunlp'
      },
      {
        title: '统计当前 TCP 各状态（ESTABLISHED/TIME_WAIT）连接数',
        cmd: "netstat -n | awk '/^tcp/ {++S[$NF]} END {for(a in S) print a, S[a]}'"
      }
    ]
  },
  {
    id: 'cmd-grep',
    name: 'grep',
    group: 'text',
    groupLabel: '文本与日志分析',
    description: '强大的正则表达式文本搜索与线上异常日志过滤工具',
    aliases: ['搜索文本', '查日志', '过滤日志', '查看进程'],
    stars: '5/5 高频必背',
    package: 'grep',
    params: [
      { flag: '-r / -R', desc: '递归搜索目录下的所有文件' },
      { flag: '-n', desc: '显示匹配行的行号' },
      { flag: '-i', desc: '忽略大小写匹配' },
      { flag: '-C 5', desc: '同时打印匹配行前后各 5 行上下文（排查堆栈必备）' },
      { flag: '-v', desc: '反向排除匹配的行' }
    ],
    examples: [
      {
        title: '在日志中查找 OutOfMemoryError 并打印前后 10 行堆栈上下文',
        cmd: 'grep -n -C 10 "OutOfMemoryError" /var/log/app/server.log'
      },
      {
        title: '在源码目录递归搜索关键字并排除 node_modules 与 .git',
        cmd: 'grep -rn --exclude-dir={node_modules,.git} "API_SECRET" ./src'
      }
    ]
  },
  {
    id: 'cmd-awk',
    name: 'awk',
    group: 'text',
    groupLabel: '文本与日志分析',
    description: '按列切分处理文本、Nginx 访问日志 IP 统计与数值聚合利器',
    aliases: ['截取列', '日志统计', 'nginx日志分析'],
    stars: '5/5 高频必背',
    package: 'gawk',
    params: [
      { flag: '-F ":"', desc: '指定列分隔符（默认为空格或 Tab）' },
      { flag: '$1 / $NF', desc: '代表第一列 / 最后一列' }
    ],
    examples: [
      {
        title: '统计 Nginx 访问日志中请求量最高的前 10 个客户端 IP',
        cmd: "awk '{print $1}' access.log | sort | uniq -c | sort -nr | head -n 10"
      },
      {
        title: '以冒号分隔打印 /etc/passwd 中的所有系统用户名与 UID',
        cmd: 'awk -F ":" \'{print $1, $3}\' /etc/passwd'
      }
    ]
  },
  {
    id: 'cmd-systemctl',
    name: 'systemctl',
    group: 'system',
    groupLabel: '系统与服务运维',
    description: '管理系统 Systemd 守护服务启停、开机自启与运行状态',
    aliases: ['服务管理', '重启服务', '开机自启', '查看进程'],
    stars: '5/5 高频必背',
    package: 'systemd',
    params: [
      { flag: 'status <svc>', desc: '查看服务运行状态与最近日志' },
      { flag: 'restart <svc>', desc: '重启指定系统服务' },
      { flag: 'enable --now', desc: '设为开机自启并立即启动服务' },
      { flag: 'daemon-reload', desc: '修改 .service 配置文件后重载配置' }
    ],
    examples: [
      {
        title: '重启 Nginx 服务并查看最新运行状态',
        cmd: 'systemctl restart nginx && systemctl status nginx'
      },
      {
        title: '设置 Docker 开机自启并立即启动',
        cmd: 'systemctl enable --now docker'
      }
    ]
  },
  {
    id: 'cmd-du-df',
    name: 'du / df',
    group: 'disk',
    groupLabel: '磁盘与空间排障',
    description: '排查磁盘分区满载告警与定位占用空间最大的目录',
    aliases: ['磁盘满', '空间占用', '查看磁盘', '大目录排查'],
    stars: '5/5 高频必背',
    package: 'coreutils',
    params: [
      { flag: 'df -h', desc: '以人类可读单位（GB/MB）查看挂载分区剩余容量' },
      { flag: 'df -i', desc: '查看分区 Inode 节点耗尽情况（小文件过多导致无法写盘）' },
      { flag: 'du -sh *', desc: '汇总统计当前目录下各子文件夹的总大小' }
    ],
    examples: [
      {
        title: '查看当前目录下各一级子目录体积并按从大到小排序',
        cmd: 'du -h --max-depth=1 | sort -hr'
      },
      {
        title: '排查各挂载分区磁盘空间与 Inode 使用率',
        cmd: 'df -h && df -i'
      }
    ]
  }
]

export const HTTP_STATUS_DICT: HttpStatusItem[] = [
  {
    code: 200,
    phrase: 'OK',
    meaning: '请求成功，服务端已正常返回响应载荷',
    rfc: 'RFC 9110 §15.3.1',
    isRetryable: true,
    causes: ['标准 GET/POST/PUT 请求正常处理完毕'],
    troubleshooting: [
      { step: '业务码核验', action: '若前端仍报错，检查响应体 JSON 内部业务状态码（如 code !== 0）' }
    ],
    architectureNotes: 'RESTful 标准成功响应，GET 请求默认可按 Cache-Control 策略缓存。'
  },
  {
    code: 301,
    phrase: 'Moved Permanently',
    meaning: '永久重定向，请求的资源已被永久分配到新 URI',
    rfc: 'RFC 9110 §15.4.2',
    isRetryable: false,
    causes: ['HTTP 强制跳转 HTTPS', '老域名迁移至新域名'],
    troubleshooting: [
      { step: '浏览器强缓存排查', action: '301 会被浏览器持久缓存，调试阶段改回配置后需清除浏览器缓存或使用无痕窗口验证' }
    ],
    architectureNotes: '注意 POST 请求遇到 301 时往往会被浏览器改写为 GET 请求并丢失请求体（需保方法请用 308）。'
  },
  {
    code: 304,
    phrase: 'Not Modified',
    meaning: '协商缓存命中，客户端本地缓存仍为最新，无需重传正文',
    rfc: 'RFC 9110 §15.4.5',
    isRetryable: true,
    causes: ['请求头 If-None-Match 与服务端 ETag 一致', 'If-Modified-Since 未过期'],
    troubleshooting: [
      { step: '强制刷新验证', action: '若前端静态资源未更新，按 Ctrl+Shift+R 发送 Cache-Control: no-cache 绕过协商缓存' }
    ],
    architectureNotes: '显著节省 CDN 与网关下行带宽，响应体必须为空。'
  },
  {
    code: 400,
    phrase: 'Bad Request',
    meaning: '客户端请求语法错误、参数校验失败或 JSON 反序列化异常',
    rfc: 'RFC 9110 §15.5.1',
    isRetryable: false,
    causes: [
      '前端传入的 JSON 语法损坏或字段类型不匹配（如 String 传给 Integer）',
      '缺少必填 Query / Header 参数',
      '请求头 Cookie 过大超出 Nginx client_header_buffer_size'
    ],
    troubleshooting: [
      { step: '核对请求载荷', action: '在 Network 面板对比 Request Payload 与后端 DTO 字段类型及 @Valid 注解约束' },
      { step: '检查请求头体积', action: '若未进业务代码即报 400，检查 Cookie 或自定义 Header 是否超过网关限制' }
    ],
    architectureNotes: '切勿盲目重试，必须修正请求参数或编码格式。'
  },
  {
    code: 401,
    phrase: 'Unauthorized',
    meaning: '未认证或登录态已过期，请求缺失有效的身份凭据',
    rfc: 'RFC 9110 §15.5.2',
    isRetryable: false,
    causes: [
      '未携带 Authorization: Bearer <token> 请求头',
      'JWT Token 已超过 exp 过期时间或签名密钥不匹配'
    ],
    troubleshooting: [
      { step: '检查 Authorization 头', action: '确认请求拦截器是否正确注入了最新 Token，注意 Bearer 后需有空格' },
      { step: '刷新令牌闭环', action: '触发 Refresh Token 换取新 Access Token 或引导用户重新登录' }
    ],
    architectureNotes: '401 代表“你是谁我不知道（未登录）”，而 403 代表“我知道你是谁但你没权限”。'
  },
  {
    code: 403,
    phrase: 'Forbidden',
    meaning: '身份已识别但权限不足，或被 WAF / 跨域 / 防盗链策略拦截',
    rfc: 'RFC 9110 §15.5.4',
    isRetryable: false,
    causes: [
      '当前登录角色缺少 RBAC 接口访问权限',
      'OSS / CDN Referer 防盗链拦截或 IP 黑名单封禁',
      'Nginx 目录缺少 index 文件且未开启 autoindex'
    ],
    troubleshooting: [
      { step: '区分网关拦截与业务鉴权', action: '查看 Response Server 头：若来自 cloudflare/aliyun-oss 则为 WAF/防盗链；若为业务 JSON 则检查 RBAC 权限表' }
    ],
    architectureNotes: '敏感管理接口应在网关层与业务层双重校验权限。'
  },
  {
    code: 404,
    phrase: 'Not Found',
    meaning: '服务器未找到与请求 URI 匹配的目标路由或静态资源',
    rfc: 'RFC 9110 §15.5.5',
    isRetryable: false,
    causes: [
      '前端请求 URL 拼写错误或未配置反向代理前缀 strip',
      'Vue / React History 路由刷新页面时 Nginx 未配置 try_files $uri /index.html'
    ],
    troubleshooting: [
      { step: '核对 Nginx location 规则', action: '检查 proxy_pass 结尾是否漏写斜杠导致前缀被原样拼接到后端' },
      { step: 'SPA 路由兜底', action: '前端单页应用刷新 404 时，在 Nginx 中添加 try_files $uri $uri/ /index.html;' }
    ],
    architectureNotes: '对外隐藏内部路由结构时，有时也会用 404 替代 403。'
  },
  {
    code: 429,
    phrase: 'Too Many Requests',
    meaning: '触发接口限流（Rate Limit），客户端在单位时间内发送了过多请求',
    rfc: 'RFC 6585 §4',
    isRetryable: true,
    causes: ['前端死循环重复发起请求', '超过 API 网关令牌桶/漏桶 QPS 配额'],
    troubleshooting: [
      { step: '读取 Retry-After 响应头', action: '按响应头指示的秒数执行指数退避（Exponential Backoff）延迟重试' },
      { step: '排查前端 useEffect 依赖', action: '检查是否存在未加防抖的高频请求或组件重渲染死循环' }
    ],
    architectureNotes: '推荐在客户端实现请求合并与防抖节流。'
  },
  {
    code: 499,
    phrase: 'Client Closed Request (Nginx)',
    meaning: 'Nginx 扩展状态码：上游后端处理太慢，客户端等不及主动断开了连接',
    rfc: 'Nginx Non-Standard',
    isRetryable: false,
    causes: [
      '后端接口耗时超过前端 axios timeout（如 5s），前端主动 abort()',
      '用户在页面加载完成前快速关闭了标签页或切换了路由'
    ],
    troubleshooting: [
      { step: '定位慢 SQL 与下游阻塞', action: '结合 APM 链路追踪排查对应接口为何耗时超过客户端超时阈值' }
    ],
    architectureNotes: '大量 499 往往是后端雪崩的前兆，说明线程池正被慢请求占满。'
  },
  {
    code: 500,
    phrase: 'Internal Server Error',
    meaning: '服务端内部未捕获异常（空指针、数据库连接崩溃、代码抛错）',
    rfc: 'RFC 9110 §15.6.1',
    isRetryable: false,
    causes: ['后端业务代码抛出 NullPointerException / TypeError 未被全局异常处理器捕获', '数据库死锁或连接池耗尽'],
    troubleshooting: [
      { step: '检索 traceId 错误堆栈', action: '拿响应头中的 X-Request-Id 或 traceId 到服务端 error.log 搜索完整异常堆栈' }
    ],
    architectureNotes: '生产环境严禁直接将原始 SQL 错误或代码堆栈裸露在 500 响应体中。'
  },
  {
    code: 502,
    phrase: 'Bad Gateway',
    meaning: '网关或反向代理（Nginx）从上游后端服务器收到了无效响应或连接被拒绝',
    rfc: 'RFC 9110 §15.6.3',
    isRetryable: true,
    causes: [
      '上游服务进程（Node / Go / Java / PHP-FPM）已崩溃退出或正在重启，端口未处于监听状态',
      '上游服务触发 OOM Killer 被内核强制杀死',
      'Nginx fastcgi_buffers / proxy_buffer_size 过小，上游返回的响应头过大'
    ],
    troubleshooting: [
      { step: '检查上游服务存活与端口监听', action: '登录服务器执行 ss -tulpn 或 systemctl status 检查后端进程与 PHP-FPM 是否存活' },
      { step: '查看 Nginx error.log', action: '检查是否报 connect() failed (111: Connection refused) 或 upstream prematurely closed connection' },
      { step: '排查容器 OOM', action: '执行 dmesg -T | grep -i oom 检查后端进程是否因内存超限被杀' }
    ],
    architectureNotes: '502 代表“连不上后端或后端话没说完就挂了”；504 代表“连上了但后端一直不回话超时了”。'
  },
  {
    code: 503,
    phrase: 'Service Unavailable',
    meaning: '服务暂时不可用（过载保护熔断、限流降级或停机维护中）',
    rfc: 'RFC 9110 §15.6.4',
    isRetryable: true,
    causes: ['Kubernetes Pod 正在滚动发布尚未通过 Readiness 探针', '触发 Sentinel / Hystrix 熔断降级'],
    troubleshooting: [
      { step: '检查 K8s Endpoints 与就绪探针', action: '执行 kubectl get pods,ep 检查是否有健康的后端实例挂载在 Service 下' }
    ],
    architectureNotes: '发版期间出现短暂 503 需检查优雅停机（Graceful Shutdown）是否配置到位。'
  },
  {
    code: 504,
    phrase: 'Gateway Timeout',
    meaning: '网关等待上游服务器响应超时（上游处理太慢超过 proxy_read_timeout）',
    rfc: 'RFC 9110 §15.6.5',
    isRetryable: false,
    causes: [
      '后端执行全表扫描慢 SQL、大文件同步导出或调用第三方外部接口卡死',
      'Nginx proxy_read_timeout（默认 60s）小于后端实际处理耗时'
    ],
    troubleshooting: [
      { step: '优化慢查询或改异步任务', action: '耗时超过 10s 的报表导出或批量操作应改为异步任务队列 + 轮询进度' },
      { step: '按需调大网关超时', action: '对于 AI 流式推理等长耗时路由，单独配置 proxy_read_timeout 300s;' }
    ],
    architectureNotes: '非幂等接口（如扣款下单）遇到 504 严禁盲目自动重试，需先查单核实状态。'
  }
]

export const COMMON_PORTS_DICT: PortItem[] = [
  {
    port: 22,
    protocol: 'TCP',
    service: 'SSH / SFTP',
    category: '远程管理',
    description: 'Linux 安全外壳远程终端登录与加密文件传输默认端口',
    securityNotice: '公网服务器强烈建议禁用密码登录、仅允许 Ed25519 密钥并配置 Fail2ban'
  },
  {
    port: 53,
    protocol: 'TCP/UDP',
    service: 'DNS',
    category: '网络基础',
    description: '域名系统解析服务（常规查询使用 UDP 53，区域传送或超长响应使用 TCP 53）',
    securityNotice: '谨防开放递归 DNS 被黑客利用发起 DNS 放大 DDoS 攻击'
  },
  {
    port: 80,
    protocol: 'TCP',
    service: 'HTTP',
    category: 'Web 服务',
    description: '超文本传输协议明文默认端口（Nginx / Apache / Caddy）',
    securityNotice: '生产环境建议配置 301 强制跳转至 443 HTTPS'
  },
  {
    port: 443,
    protocol: 'TCP/UDP',
    service: 'HTTPS / HTTP3(QUIC)',
    category: 'Web 服务',
    description: 'TLS 加密 Web 传输端口（HTTP/3 使用 UDP 443）',
    securityNotice: '建议使用 TLS 1.3 并开启 HSTS 响应头'
  },
  {
    port: 3306,
    protocol: 'TCP',
    service: 'MySQL / MariaDB',
    category: '关系型数据库',
    description: 'MySQL 与 MariaDB 关系型数据库默认通信端口',
    securityNotice: '严禁直接向公网 0.0.0.0/0 暴露 3306，仅限内网或通过 SSH 隧道访问'
  },
  {
    port: 5432,
    protocol: 'TCP',
    service: 'PostgreSQL',
    category: '关系型数据库',
    description: 'PostgreSQL 企业级开源关系型数据库默认端口',
    securityNotice: '在 pg_hba.conf 中严格限制允许连接的客户端 CIDR 网段与 scram-sha-256 认证'
  },
  {
    port: 6379,
    protocol: 'TCP',
    service: 'Redis',
    category: '缓存与内存库',
    description: 'Redis 高性能内存键值数据库默认端口',
    securityNotice: '高危预警：必须绑定内网 IP (bind 127.0.0.1) 并设置强密码 requirepass，防未授权写入公钥挖矿'
  },
  {
    port: 8080,
    protocol: 'TCP',
    service: 'HTTP Alternate (Spring Boot / Tomcat)',
    category: '应用容器',
    description: 'Java Spring Boot、Tomcat、Jenkins 及本地开发调试最常用 HTTP 端口',
    securityNotice: '生产环境建议前置 Nginx 反向代理，不直接对公网暴露应用容器端口'
  },
  {
    port: 8848,
    protocol: 'TCP',
    service: 'Nacos',
    category: '微服务注册中心',
    description: 'Alibaba Nacos 服务发现与配置中心默认端口（同时使用 9848/9849 gRPC 端口）',
    securityNotice: '务必开启 nacos.core.auth.enabled=true 鉴权，严禁裸奔暴露公网'
  },
  {
    port: 9092,
    protocol: 'TCP',
    service: 'Apache Kafka',
    category: '消息队列',
    description: 'Kafka 分布式流处理平台 Broker 默认通信端口',
    securityNotice: '生产集群建议配置 SASL/SCRAM 认证与 VPC 内网隔离'
  },
  {
    port: 9200,
    protocol: 'TCP',
    service: 'Elasticsearch',
    category: '搜索引擎',
    description: 'Elasticsearch RESTful HTTP 接口端口（节点间集群通信为 9300）',
    securityNotice: '开启 X-Pack Security 认证，防止索引数据被勒索篡改'
  },
  {
    port: 27017,
    protocol: 'TCP',
    service: 'MongoDB',
    category: 'NoSQL 数据库',
    description: 'MongoDB 文档型数据库默认连接端口',
    securityNotice: '必须启用 security.authorization: enabled，防止公网无密拖库'
  }
]

function sanitizeSearchQuery(rawQuery: string): string {
  return String(rawQuery ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 120)
}

export function searchLinuxCommands(query: string): LinuxCommandItem[] {
  const q = sanitizeSearchQuery(query)
  if (!q) return LINUX_COMMANDS_DICT
  return LINUX_COMMANDS_DICT.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.groupLabel.toLowerCase().includes(q) ||
      item.aliases.some((a) => a.toLowerCase().includes(q)) ||
      item.examples.some((e) => e.title.toLowerCase().includes(q) || e.cmd.toLowerCase().includes(q))
  )
}

export function searchHttpStatus(query: string): HttpStatusItem[] {
  const q = sanitizeSearchQuery(query)
  if (!q) return HTTP_STATUS_DICT
  return HTTP_STATUS_DICT.filter(
    (item) =>
      String(item.code).includes(q) ||
      item.phrase.toLowerCase().includes(q) ||
      item.meaning.toLowerCase().includes(q) ||
      item.causes.some((c) => c.toLowerCase().includes(q)) ||
      item.troubleshooting.some((t) => t.step.toLowerCase().includes(q) || t.action.toLowerCase().includes(q))
  )
}

export function searchCommonPorts(query: string): PortItem[] {
  const q = sanitizeSearchQuery(query)
  if (!q) return COMMON_PORTS_DICT
  return COMMON_PORTS_DICT.filter(
    (item) =>
      String(item.port).includes(q) ||
      item.service.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q)
  )
}
