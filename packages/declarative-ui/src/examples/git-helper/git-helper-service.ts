import type { CommitTypeItem, GitEmergencyItem, GitignoreStackTemplate } from './types.js'

export const GIT_EMERGENCY_DATABASE: GitEmergencyItem[] = [
  {
    id: 'undo-last-commit-keep-changes',
    title: '刚 commit 了，但想撤销这次提交并保留修改在工作区继续改',
    category: 'commit',
    categoryLabel: '提交后悔药',
    tags: ['撤销提交', '撤销commit', '保留代码', 'reset soft'],
    pinyinKeywords: ['chexiao', 'chexiaotijiao', 'huitui', 'huigun'],
    safetyLevel: '安全无损',
    difficulty: '小白推荐',
    primaryCommand: 'git reset --soft HEAD~1',
    steps: [
      {
        title: '撤销最近一次 commit，所有改动退回暂存区（Staged）',
        cmd: 'git reset --soft HEAD~1',
        explain: '工作区与暂存区代码 100% 完好保留，仅回退分支 HEAD 指针到上一个版本'
      },
      {
        title: '若想同时取消 git add 退回未暂存状态（可选）',
        cmd: 'git reset HEAD~1',
        explain: '默认 --mixed 模式，代码依然保留在本地磁盘，绝不丢失'
      }
    ],
    principle:
      '--soft 参数只移动 HEAD 引用指针，不触碰 Index 暂存区和 Working Tree 工作树，是最安全的后悔药。',
    minGitVersion: 'Git 2.0+'
  },
  {
    id: 'amend-missing-file-or-message',
    title: '刚 commit 完发现漏提了一个文件，或者提交备注写错了',
    category: 'commit',
    categoryLabel: '提交后悔药',
    tags: ['漏提文件', '修改提交备注', 'amend', '追加文件'],
    pinyinKeywords: ['loutiwangjian', 'xiugaibeizhu', 'amend', 'zhuijia'],
    safetyLevel: '安全无损',
    difficulty: '小白推荐',
    primaryCommand: 'git add <遗漏文件> && git commit --amend --no-edit',
    steps: [
      {
        title: '把遗漏的文件加入暂存区并合并进上一次提交（不改备注）',
        cmd: 'git add . && git commit --amend --no-edit',
        explain: '不会产生多余的 "fix typo" 脏提交节点，保持 Git 历史干净'
      },
      {
        title: '如果只想重写上一次的中文提交备注',
        cmd: 'git commit --amend -m "fix: 修正后的中文提交说明"',
        explain: '直接替换最近一次 Commit 的 Message'
      }
    ],
    principle: 'amend 会用一个新的 Commit 对象替换当前分支顶端的旧 Commit（仅限尚未 push 到公共分支时使用）。'
  },
  {
    id: 'recover-deleted-branch-or-hard-reset',
    title: '手滑执行了 git reset --hard 或误删了本地未合并分支，想找回代码',
    category: 'reset',
    categoryLabel: '绝境抢救',
    tags: ['恢复误删分支', '找回代码', 'reflog', 'reset hard恢复'],
    pinyinKeywords: ['huifufenzhi', 'wushanfenzhi', 'zhaohuidaima', 'reflog'],
    safetyLevel: '安全无损',
    difficulty: '中等',
    primaryCommand: 'git reflog',
    steps: [
      {
        title: '第一步：查看本地所有 HEAD 历史移动轨迹，找到翻车前的短哈希（如 a1b2c3d）',
        cmd: 'git reflog -n 20',
        explain: '即便分支被删或 reset --hard，Git 本地仍会在 reflog 中保留对象至少 30~90 天'
      },
      {
        title: '第二步：基于翻车前的 commit 哈希新建或恢复分支',
        cmd: 'git checkout -b recovered-branch HEAD@{1}',
        explain: '也可将 HEAD@{1} 替换为你在 reflog 里看到的具体哈希值'
      }
    ],
    principle:
      'Git 的提交对象一旦生成就是不可变的，只要未触发过期 GC，reflog 就是时光机黑匣子。'
  },
  {
    id: 'committed-to-wrong-branch',
    title: '本来应该在新分支开发，结果不小心直接 commit 到了 main/master 分支',
    category: 'branch',
    categoryLabel: '分支纠错',
    tags: ['提交错分支', '移花接木', '挪移提交', 'master误提交'],
    pinyinKeywords: ['tijiaocuofenzhi', 'fenzhicuowu', 'nuoyitijiao'],
    safetyLevel: '注意检查',
    difficulty: '中等',
    primaryCommand: 'git branch feat/new-work && git reset --hard HEAD~1 && git checkout feat/new-work',
    steps: [
      {
        title: '第一步：在当前位置原地创建一个新分支保留这笔提交',
        cmd: 'git branch feat/new-work',
        explain: '此时 feat/new-work 已经安全指向了包含新代码的提交'
      },
      {
        title: '第二步：将当前 main 分支回退 1 个版本（务必确认工作区无未提交脏改动）',
        cmd: 'git reset --hard HEAD~1',
        explain: '让 main 分支恢复干净状态'
      },
      {
        title: '第三步：切换到刚才创建的新特性分支继续工作',
        cmd: 'git checkout feat/new-work',
        explain: '代码已完好迁移至新分支'
      }
    ],
    principle: '因为分支本质上只是一个 41 字节的哈希指针文件，先建指针再退旧指针即可实现零成本移花接木。'
  },
  {
    id: 'undo-messy-git-pull-merge',
    title: '刚执行了 git pull 或 merge 结果冲突一团糟，想立即回到合并前状态',
    category: 'merge',
    categoryLabel: '冲突拆弹',
    tags: ['撤销pull', '放弃合并', 'merge abort', '冲突回退'],
    pinyinKeywords: ['chexiaopull', 'fangqihebing', 'chongtu'],
    safetyLevel: '安全无损',
    difficulty: '小白推荐',
    primaryCommand: 'git merge --abort',
    steps: [
      {
        title: '若正处于合并冲突中断状态，一键中止合并',
        cmd: 'git merge --abort',
        explain: '如果是 git rebase 冲突，则执行 git rebase --abort'
      },
      {
        title: '若 pull 已经自动合并完成但想退回 pull 之前的版本',
        cmd: 'git reset --hard ORIG_HEAD',
        explain: 'Git 在执行危险合并前会自动把旧位置保存在 ORIG_HEAD 中'
      }
    ],
    principle: 'ORIG_HEAD 是 Git 在执行 merge / pull / reset 等大跨度操作前自动留存的安全锚点。'
  },
  {
    id: 'revert-pushed-public-commit',
    title: '错误代码已经 push 到了远程公共分支，需要安全回滚且不破坏团队历史',
    category: 'commit',
    categoryLabel: '线上回滚',
    tags: ['远程回滚', 'revert', '线上回退', '反向提交'],
    pinyinKeywords: ['yuanchenghuigun', 'xianshanghuigun', 'revert'],
    safetyLevel: '安全无损',
    difficulty: '小白推荐',
    primaryCommand: 'git revert HEAD --no-edit && git push',
    steps: [
      {
        title: '生成一笔反向抵消提交（不动历史时间线）',
        cmd: 'git revert HEAD --no-edit',
        explain: '如果回滚的是一个 Merge Commit，需加 -m 1 指定主线父节点：git revert -m 1 <hash>'
      },
      {
        title: '正常推送到远端仓库（无需危险的 --force）',
        cmd: 'git push origin main',
        explain: '团队其他成员只需正常 git pull，不会产生历史分叉冲突'
      }
    ],
    principle: '公共分支严禁 git reset --hard 后强推（force push），使用 git revert 新增反向补丁才是工程规范。'
  }
]

export const COMMIT_TYPES: CommitTypeItem[] = [
  {
    type: 'feat',
    chineseMeaning: '新增业务功能或特性',
    description: '面向用户或下游模块新增的业务能力',
    examples: ['feat(auth): 新增企业微信扫码登录与多端会话同步', 'feat(plugin): 新增 SQL 格式化与 DDL 实体生成插件']
  },
  {
    type: 'fix',
    chineseMeaning: '修复 Bug 或生产异常',
    description: '修复边界崩溃、逻辑缺陷、空指针或协议解析异常',
    examples: ['fix(network): 修复 DNS 并发测速超时未释放 Socket 句柄问题', 'fix(ui): 修复深色模式下详情栏表格边框对比度不足']
  },
  {
    type: 'refactor',
    chineseMeaning: '代码重构（不改变外部行为）',
    description: '内聚公共底座、消除重复代码、优化模块边界',
    examples: ['refactor(host): 收敛内置插件特权 IPC 路由至单一咽喉底座']
  },
  {
    type: 'perf',
    chineseMeaning: '性能与内存优化',
    description: '降低唤醒延迟、优化算法复杂度、减少渲染重绘与常驻内存',
    examples: ['perf(indexer): 将 MFT 增量索引过滤耗时从 45ms 降至 4ms']
  },
  {
    type: 'test',
    chineseMeaning: '新增或完善集成与异常测试',
    description: '补充端到端集成测试、边界极值与失败回滚用例',
    examples: ['test(plugins): 补齐 41 款标杆插件全链路集成与异常拦截测试套件']
  },
  {
    type: 'docs',
    chineseMeaning: '技术文档与注释更新',
    description: '修改架构设计文档、API 手册或 README',
    examples: ['docs(specs): 更新 41 款插件独立开发文档与实机渲染截图']
  },
  {
    type: 'chore',
    chineseMeaning: '构建脚本、依赖升级或工程杂务',
    description: 'CI/CD 流水线、脚手架、打包配置与版本例行维护',
    examples: ['chore(release): 升级 Electron 构建门禁与 AST 安全扫描规则']
  }
]

export const GITIGNORE_STACK_TEMPLATES: GitignoreStackTemplate[] = [
  {
    id: 'Node',
    name: 'Node.js / TypeScript',
    category: '语言与运行时',
    rules: [
      'node_modules/',
      'dist/',
      'out/',
      'build/',
      '*.tsbuildinfo',
      'npm-debug.log*',
      'yarn-debug.log*',
      'pnpm-debug.log*',
      '.pnpm-store/',
      '.env',
      '.env.local',
      '.env.*.local',
      'coverage/'
    ]
  },
  {
    id: 'ReactVue',
    name: 'React / Vue / Next / Vite',
    category: '前端框架',
    rules: [
      '.next/',
      '.nuxt/',
      '.output/',
      '.vite/',
      '.cache/',
      'dist/',
      'dist-ssr/',
      '*.local'
    ]
  },
  {
    id: 'Python',
    name: 'Python / PyTorch / Poetry',
    category: '语言与运行时',
    rules: [
      '__pycache__/',
      '*.py[cod]',
      '*$py.class',
      '.venv/',
      'venv/',
      'ENV/',
      '.pytest_cache/',
      '.mypy_cache/',
      '*.egg-info/',
      'dist/',
      '.env'
    ]
  },
  {
    id: 'Java',
    name: 'Java / Maven / Gradle / Spring',
    category: '语言与运行时',
    rules: [
      'target/',
      'build/',
      '.gradle/',
      '*.class',
      '*.jar',
      '*.war',
      '*.ear',
      'hs_err_pid*',
      'replay_pid*'
    ]
  },
  {
    id: 'Go',
    name: 'Go (Golang)',
    category: '语言与运行时',
    rules: ['bin/', 'vendor/', '*.exe', '*.exe~', '*.dll', '*.so', '*.dylib', '*.test', '*.out', 'go.work']
  },
  {
    id: 'Rust',
    name: 'Rust / Cargo',
    category: '语言与运行时',
    rules: ['target/', 'Cargo.lock', '**/*.rs.bk', '*.pdb']
  },
  {
    id: 'macOS',
    name: 'macOS 系统隐藏文件',
    category: '操作系统',
    rules: ['.DS_Store', '.AppleDouble', '.LSOverride', '._*', '.Spotlight-V100', '.Trashes']
  },
  {
    id: 'Windows',
    name: 'Windows 系统缩略图与临时项',
    category: '操作系统',
    rules: ['Thumbs.db', 'Thumbs.db:encryptable', 'ehthumbs.db', 'Desktop.ini', '$RECYCLE.BIN/', '*.lnk']
  },
  {
    id: 'IDEs',
    name: 'VS Code / Cursor / JetBrains IDE',
    category: '编辑器与 IDE',
    rules: ['.vscode/*', '!.vscode/extensions.json', '!.vscode/settings.json', '.idea/', '*.iml', '*.iws', '.history/']
  }
]

/**
 * 大白话 + 拼音缩写容错检索 Git 救命锦囊
 */
export function searchGitEmergencies(query: string): GitEmergencyItem[] {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return GIT_EMERGENCY_DATABASE

  return GIT_EMERGENCY_DATABASE.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.categoryLabel.toLowerCase().includes(q) ||
      item.primaryCommand.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q)) ||
      item.pinyinKeywords.some((p) => p.includes(q) || q.includes(p)) ||
      item.steps.some((s) => s.title.toLowerCase().includes(q) || s.cmd.toLowerCase().includes(q))
  )
}

/**
 * 安全转义 Shell 双引号参数中的特殊字符（`"`、`$`、`\n`、`` ` ``）
 */
export function escapeShellDoubleQuoted(raw: string): string {
  return String(raw ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .trim()
}

/**
 * 构建符合 Conventional Commits 规范的提交文本与可执行 git commit 命令
 */
export function buildConventionalCommit(options: {
  type: string
  scope?: string
  subject: string
  breaking?: boolean
}): {
  isValid: boolean
  message: string
  gitCommand: string
  validationHint?: string
} {
  const cleanType = String(options.type || 'feat').trim()
  const cleanScope = String(options.scope || '')
    .trim()
    .replace(/[()]/g, '')
  const rawSubject = String(options.subject || '').trim()
  const bang = options.breaking ? '!' : ''
  const scopePart = cleanScope ? `(${cleanScope})` : ''

  if (!rawSubject) {
    const placeholder = '请填写清晰明确的中文改动摘要'
    const msg = `${cleanType}${scopePart}${bang}: ${placeholder}`
    return {
      isValid: false,
      message: msg,
      gitCommand: `git commit -m "${msg}"`,
      validationHint: '提交说明不能为空，建议使用中文简述本次修改的具体目的'
    }
  }

  const normalizedSubject = rawSubject.replace(/\r?\n/g, ' ').trim()
  const message = `${cleanType}${scopePart}${bang}: ${normalizedSubject}`
  const escaped = escapeShellDoubleQuoted(message)

  return {
    isValid: true,
    message,
    gitCommand: `git commit -m "${escaped}"`
  }
}

/**
 * 组合多个技术栈生成去重后的标准 `.gitignore` 文件内容
 */
export function generateGitignoreContent(selectedStackIds: string[], customRules: string[] = []): {
  content: string
  totalUniqueRules: number
  selectedStacks: string[]
} {
  const effectiveIds =
    Array.isArray(selectedStackIds) && selectedStackIds.length > 0
      ? selectedStackIds
      : ['macOS', 'Windows']

  const seenRules = new Set<string>()
  const sections: string[] = [
    '# ========================================================',
    `# Generated by ZTools Git Helper (${effectiveIds.join(' + ')})`,
    '# ========================================================'
  ]

  for (const stackId of effectiveIds) {
    const tpl = GITIGNORE_STACK_TEMPLATES.find(
      (t) => t.id.toLowerCase() === stackId.toLowerCase() || t.name.toLowerCase().includes(stackId.toLowerCase())
    )
    if (!tpl) continue

    const uniqueForStack: string[] = []
    for (const rule of tpl.rules) {
      const trimmed = rule.trim()
      if (!trimmed || seenRules.has(trimmed)) continue
      seenRules.add(trimmed)
      uniqueForStack.push(trimmed)
    }

    if (uniqueForStack.length > 0) {
      sections.push(`\n### ${tpl.name} ###`)
      sections.push(...uniqueForStack)
    }
  }

  const cleanCustom = customRules.map((r) => r.trim()).filter((r) => r && !seenRules.has(r))
  if (cleanCustom.length > 0) {
    sections.push('\n### Custom Rules ###')
    for (const r of cleanCustom) {
      seenRules.add(r)
      sections.push(r)
    }
  }

  return {
    content: sections.join('\n') + '\n',
    totalUniqueRules: seenRules.size,
    selectedStacks: effectiveIds
  }
}
