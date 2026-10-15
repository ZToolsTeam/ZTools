#!/usr/bin/env node

/**
 * create-plugin.mjs
 * ZTools 官方一键插件脚手架生成工具
 *
 * 功能：
 * 1. 规范化校验插件 ID 与参数合法性；
 * 2. 检查目录冲突保护，严防意外覆盖；
 * 3. 自动生成符合 packages/ztools-plugins-spec 规约的标准工程；
 * 4. 采用现代声明式 UI 体系（零 DOM / 零 CSS / 语义化组件）；
 * 5. 支持命令行快速调用与交互式问答模式。
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

export const PLUGIN_ID_REGEX = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 校验插件 ID 是否合法
 * @param {string} pluginId
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePluginId(pluginId) {
  if (!pluginId || typeof pluginId !== 'string') {
    return { valid: false, error: '插件 ID 不能为空，且必须为字符串' }
  }
  const trimmed = pluginId.trim()
  if (trimmed !== pluginId) {
    return { valid: false, error: '插件 ID 首尾不能包含空格' }
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return { valid: false, error: '插件 ID 不能包含路径分隔符或上级目录引用 (..)' }
  }
  if (!PLUGIN_ID_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: `插件 ID 格式不符合规范: "${trimmed}"（必须以小写字母开头，仅允许小写字母、数字、短横线与下划线，长度 2-64 字符，例如: 'quick-notes'）`
    }
  }
  return { valid: true }
}

/**
 * 核心创建插件工程函数
 * @param {object} options
 * @param {string} options.pluginId - 插件唯一 ID
 * @param {string} [options.title] - 插件显示名称
 * @param {string} [options.description] - 插件功能描述
 * @param {string} [options.targetDir] - 插件放置根目录（默认 'plugins'）
 * @param {boolean} [options.force] - 是否覆盖已存在的目录
 * @returns {Promise<{ success: boolean, pluginDir: string, createdFiles: string[] }>}
 */
export async function createPlugin({
  pluginId,
  title,
  description,
  targetDir = 'plugins',
  force = false
}) {
  // 1. 校验 ID
  const idCheck = validatePluginId(pluginId)
  if (!idCheck.valid) {
    throw new Error(idCheck.error)
  }

  const normalizedTitle = (title && typeof title === 'string' && title.trim())
    ? title.trim()
    : pluginId
  const normalizedDesc = (description && typeof description === 'string' && description.trim())
    ? description.trim()
    : '基于 ZTools 声明式 UI 架构构建的极速效率插件，纯语义化零 CSS 零 DOM 操作'

  // 2. 目标路径与冲突保护
  const absTargetDir = path.isAbsolute(targetDir) ? targetDir : path.resolve(rootDir, targetDir)
  const pluginDir = path.join(absTargetDir, pluginId)

  if (fs.existsSync(pluginDir)) {
    if (!force) {
      throw new Error(`目标插件目录已存在: "${pluginDir}"。若要强制覆盖，请指定 --force 标志。`)
    }
  }

  // 3. 递归创建目录
  fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'tests'), { recursive: true })

  const createdFiles = []

  function writeFileLf(relPath, content) {
    const fullPath = path.join(pluginDir, relPath)
    // 强制转换为 LF 换行符
    const lfContent = content.replace(/\r\n/g, '\n')
    fs.writeFileSync(fullPath, lfContent, 'utf8')
    createdFiles.push(relPath)
  }

  // 4. 生成 plugin.json
  const manifest = {
    id: pluginId,
    name: normalizedTitle,
    version: '1.0.0',
    description: normalizedDesc,
    author: 'ZTools Developer',
    entry: 'dist/index.js',
    icon: 'icon.svg',
    permissions: ['clipboard'],
    commands: [
      {
        name: 'index',
        title: normalizedTitle,
        description: normalizedDesc,
        mode: 'view'
      }
    ]
  }
  writeFileLf('plugin.json', JSON.stringify(manifest, null, 2) + '\n')

  // 5. 生成 package.json
  const pkgJson = {
    name: pluginId,
    version: '1.0.0',
    description: normalizedDesc,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
      test: 'node --test tests/*.test.mjs'
    },
    dependencies: {
      '@ztools/declarative-ui': '^1.0.0'
    },
    devDependencies: {
      typescript: '^5.8.0'
    }
  }
  writeFileLf('package.json', JSON.stringify(pkgJson, null, 2) + '\n')

  // 6. 生成 tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      jsx: 'react',
      jsxFactory: 'React.createElement',
      jsxFragmentFactory: 'React.Fragment',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: './dist',
      rootDir: './src',
      paths: {
        '@ztools/declarative-ui': ['../../packages/declarative-ui/dist/index.d.ts']
      }
    },
    include: ['src/**/*']
  }
  writeFileLf('tsconfig.json', JSON.stringify(tsconfig, null, 2) + '\n')

  // 7. 生成 icon.svg
  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#3B82F6" />
      <stop offset="100%" stop-color="#1D4ED8" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#grad)" />
  <path d="M20 22h24v4L28 38h16v4H20v-4l16-12H20v-4z" fill="#FFFFFF" />
</svg>
`
  writeFileLf('icon.svg', iconSvg)

  // 8. 生成 src/index.tsx (教科书级声明式代码)
  const indexTsx = `import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useState,
  React
} from "@ztools/declarative-ui";

interface FeatureItem {
  id: string;
  title: string;
  subtitle: string;
  accessory: string;
  icon: string;
}

const INITIAL_FEATURES: FeatureItem[] = [
  {
    id: "feature-declarative",
    title: "纯声明式架构",
    subtitle: "零原生 DOM / 零 CSS，由宿主统一渲染沉浸式 Fluent / Mica 亚克力视觉",
    accessory: "核心哲学",
    icon: Icon.Star
  },
  {
    id: "feature-keyboard",
    title: "纯粹键盘优先交互",
    subtitle: "方向键聚焦，Enter 激活首要动作，Ctrl+K 唤起 ActionPanel 动作面板",
    accessory: "极客规范",
    icon: Icon.Key
  },
  {
    id: "feature-native",
    title: "硬件级毫秒响应",
    subtitle: "依托高性能 Native 侧车与 SQLite WAL 强缓存，冷出窗严格 <100ms",
    accessory: "SLA < 100ms",
    icon: Icon.CheckCircle
  }
];

export default function Command() {
  const [searchText, setSearchText] = useState<string>("");

  const filteredItems = INITIAL_FEATURES.filter((item) =>
    item.title.toLowerCase().includes(searchText.toLowerCase()) ||
    item.subtitle.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleCopy = async (content: string, label: string) => {
    await Clipboard.copy(content);
    await showToast(Toast.Style.Success, \`已复制 \${label}: \${content}\`);
  };

  return (
    <List
      navigationTitle="${normalizedTitle}"
      searchBarPlaceholder="搜索特性或输入关键字过滤..."
      searchText={searchText}
      onSearchTextChange={setSearchText}
    >
      <List.Section title={\`特性概览 (\${filteredItems.length})\`}>
        {filteredItems.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.subtitle}
            icon={item.icon}
            accessories={[{ text: item.accessory }]}
            actions={
              <ActionPanel title="操作面板">
                <Action
                  title="复制特性描述"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(item.subtitle, item.title)}
                />
                <Action
                  title="清空搜索栏"
                  icon={Icon.Trash}
                  onAction={() => setSearchText("")}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
`
  writeFileLf('src/index.tsx', indexTsx)

  // 9. 生成 dist/index.js (开箱即用的构建产物，满足清单校验与直接运行)
  const distIndexJs = `import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useState,
  React
} from "@ztools/declarative-ui";

const INITIAL_FEATURES = [
  {
    id: "feature-declarative",
    title: "纯声明式架构",
    subtitle: "零原生 DOM / 零 CSS，由宿主统一渲染沉浸式 Fluent / Mica 亚克力视觉",
    accessory: "核心哲学",
    icon: Icon.Star
  },
  {
    id: "feature-keyboard",
    title: "纯粹键盘优先交互",
    subtitle: "方向键聚焦，Enter 激活首要动作，Ctrl+K 唤起 ActionPanel 动作面板",
    accessory: "极客规范",
    icon: Icon.Key
  },
  {
    id: "feature-native",
    title: "硬件级毫秒响应",
    subtitle: "依托高性能 Native 侧车与 SQLite WAL 强缓存，冷出窗严格 <100ms",
    accessory: "SLA < 100ms",
    icon: Icon.CheckCircle
  }
];

export default function Command() {
  const [searchText, setSearchText] = useState("");

  const filteredItems = INITIAL_FEATURES.filter((item) =>
    item.title.toLowerCase().includes(searchText.toLowerCase()) ||
    item.subtitle.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleCopy = async (content, label) => {
    await Clipboard.copy(content);
    await showToast(Toast.Style.Success, \`已复制 \${label}: \${content}\`);
  };

  return List(
    {
      navigationTitle: "${normalizedTitle}",
      searchBarPlaceholder: "搜索特性或输入关键字过滤...",
      searchText,
      onSearchTextChange: (text) => setSearchText(text)
    },
    [
      List.Section(
        { title: \`特性概览 (\${filteredItems.length})\` },
        filteredItems.map((item) =>
          List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
            accessories: [{ text: item.accessory }],
            actions: ActionPanel({ title: "操作面板" }, [
              Action({
                title: "复制特性描述",
                icon: Icon.CopyClipboard,
                onAction: () => handleCopy(item.subtitle, item.title)
              }),
              Action({
                title: "清空搜索栏",
                icon: Icon.Trash,
                onAction: () => setSearchText("")
              })
            ])
          })
        )
      )
    ]
  );
}
`
  writeFileLf('dist/index.js', distIndexJs)

  // 10. 生成 tests/index.test.mjs (开箱即用的自动化测试)
  const testIndexMjs = `import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDeclarativeRoot } from "@ztools/declarative-ui";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, "..");

describe("插件自动化验证: ${pluginId}", () => {
  test("1. plugin.json 清单结构与规范校验", () => {
    const manifestPath = path.join(pluginDir, "plugin.json");
    assert.ok(fs.existsSync(manifestPath), "plugin.json 必须存在");

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.id, "${pluginId}");
    assert.equal(manifest.name, "${normalizedTitle}");
    assert.equal(manifest.version, "1.0.0");
    assert.ok(manifest.description, "description 不能为空");
    assert.equal(manifest.entry, "dist/index.js");
    assert.equal(manifest.icon, "icon.svg");
    assert.ok(Array.isArray(manifest.permissions), "permissions 必须为数组");

    assert.ok(fs.existsSync(path.join(pluginDir, manifest.icon)), "声明的 icon 文件必须存在");
    assert.ok(fs.existsSync(path.join(pluginDir, manifest.entry)), "声明的 entry 入口文件必须存在");
  });

  test("2. 声明式规范与无原生 DOM/CSS 审计", () => {
    const srcFile = path.join(pluginDir, "src", "index.tsx");
    assert.ok(fs.existsSync(srcFile), "src/index.tsx 源码文件必须存在");

    const srcCode = fs.readFileSync(srcFile, "utf8");
    assert.doesNotMatch(srcCode, /\\beval\\s*\\(/, "严禁包含动态 eval");
    assert.doesNotMatch(srcCode, /<style\\b/i, "严禁书写原生 <style> 标签");
    assert.doesNotMatch(srcCode, /document\\.createElement\\s*\\(['"]style['"]\\)/, "严禁动态注入样式");
    assert.doesNotMatch(srcCode, /\\.style\\.[a-zA-Z]/, "严禁直接操纵 DOM style 属性");
  });

  test("3. 声明式组件挂载与视图描述符渲染验证", async () => {
    const entryPath = path.join(pluginDir, "dist", "index.js");
    const mod = await import(\`file://\${entryPath.replace(/\\\\/g, "/")}\`);
    const Command = mod.default;

    assert.equal(typeof Command, "function", "默认导出必须为一个渲染函数");

    const root = renderDeclarativeRoot(Command);
    const desc = root.getLatest();

    assert.ok(desc, "渲染结果不能为空");
    assert.equal(desc.type, "List", "顶层组件必须为 List 描述符");
    assert.equal(desc.props.navigationTitle, "${normalizedTitle}");
    assert.ok(desc.children.length > 0, "List 下必须包含子节点 (如 List.Section)");

    root.unmount();
  });
});
`
  writeFileLf('tests/index.test.mjs', testIndexMjs)

  // 11. 生成 README.md
  const readmeMd = `# ${normalizedTitle} (\`${pluginId}\`)

> ${normalizedDesc}

---

## 核心设计哲学 (声明式 UI 规范)
1. **纯声明式 UI**：严禁直接编写原生 HTML 标签与 CSS 样式。所有界面均基于 \`@ztools/declarative-ui\` 提供的语义化组件（\`<List>\`, \`<Detail>\`, \`<Form>\`, \`<ActionPanel>\`, \`<Action>\`），由宿主统一呈现沉浸式 Fluent / Mica 亚克力亚态视觉；
2. **纯粹键盘优先**：上下键浏览切换、\`Enter\` 触发首要动作、\`Ctrl+K\` 呼出动作面板、\`Esc\` 返回上级栈；
3. **安全与轻量**：严格通过 AST 静态语法树门禁，严禁代码混淆、动态 \`eval\` 与越权访问。

---

## 目录结构
\`\`\`text
${pluginId}/
├── plugin.json         # 插件清单（声明权限、图标、入口及指令）
├── package.json        # 依赖与编译脚本
├── tsconfig.json       # TypeScript 编译配置
├── icon.svg            # 矢量图标
├── src/
│   └── index.tsx       # 声明式 UI 核心源码
├── dist/
│   └── index.js        # 编译后标准 ES 模块入口
├── tests/
│   └── index.test.mjs  # 自动化集成测试
└── README.md           # 开发说明文档
\`\`\`

---

## 常用命令

### 1. 运行测试
\`\`\`bash
npm test
\`\`\`

### 2. 编译 TypeScript
\`\`\`bash
npm run build
\`\`\`

### 3. 监听模式开发 (热重载)
\`\`\`bash
npm run dev
\`\`\`

### 4. AST 静态安全门禁自测
在 ZTools 根目录下执行：
\`\`\`bash
npm run scan-plugins plugins/${pluginId}
\`\`\`
`
  writeFileLf('README.md', readmeMd)

  return {
    success: true,
    pluginDir,
    createdFiles
  }
}

/**
 * CLI 命令行交互与执行入口
 */
async function runCli() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🚀 ZTools 官方插件一键脚手架工具

用法:
  node scripts/create-plugin.mjs <plugin-id> [title] [description] [选项]

参数:
  <plugin-id>       插件唯一标识符 (小写字母开头，仅允许小写字母、数字、短横线与下划线，2-64位)
  [title]           插件显示名称 (可选，默认为插件 ID)
  [description]     插件功能描述 (可选)

选项:
  --force, -f       若目标插件目录已存在，强制覆盖
  --target-dir <dir> 指定生成的父级目录 (默认: "plugins")
  --help, -h        显示此帮助信息

示例:
  node scripts/create-plugin.mjs quick-notes "极速便签" "随时记录灵感的极简便签"
  npm run create-plugin timestamp-tool "时间转换"
    `.trim())
    process.exit(0)
  }

  const force = args.includes('--force') || args.includes('-f')

  let targetDir = 'plugins'
  const targetDirIndex = args.indexOf('--target-dir')
  if (targetDirIndex !== -1 && args[targetDirIndex + 1]) {
    targetDir = args[targetDirIndex + 1]
  }

  const positionalArgs = args.filter(
    (arg, i) =>
      !arg.startsWith('-') &&
      (targetDirIndex === -1 || (i !== targetDirIndex && i !== targetDirIndex + 1))
  )

  let pluginId = positionalArgs[0]
  let title = positionalArgs[1]
  let description = positionalArgs[2]

  // 如果没有参数且处于终端交互环境下，启用交互式提示
  if (!pluginId) {
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })

      console.log('\n✨ 欢迎使用 ZTools 插件脚手架向导！\n')
      try {
        const idInput = await rl.question('? 请输入插件 ID (如 my-tool, 必填): ')
        pluginId = idInput.trim()

        const titleInput = await rl.question('? 请输入插件显示名称 (留空则默认为 ID): ')
        title = titleInput.trim() || pluginId

        const descInput = await rl.question('? 请输入插件描述 (留空则使用默认): ')
        description = descInput.trim()
      } finally {
        rl.close()
      }
    } else {
      console.error('❌ 错误: 缺少必填参数 <plugin-id>！')
      console.error('用法: node scripts/create-plugin.mjs <plugin-id> [title] [description]')
      console.error('查看帮助: node scripts/create-plugin.mjs --help\n')
      process.exit(1)
    }
  }

  try {
    console.log(`\n⏳ 正在生成插件工程: "${pluginId}"...`)
    const result = await createPlugin({
      pluginId,
      title,
      description,
      targetDir,
      force
    })

    console.log(`\n🎉 插件工程创建成功！`)
    console.log(`📂 目录路径: ${result.pluginDir}`)
    console.log(`📄 生成文件:`)
    for (const f of result.createdFiles) {
      console.log(`   - ${f}`)
    }
    console.log('\n💡 下一步快速指引:')
    console.log(`   1. cd ${path.relative(rootDir, result.pluginDir) || result.pluginDir}`)
    console.log(`   2. npm test                          # 运行自动化测试`)
    console.log(`   3. npm run dev                       # 启动 TypeScript 监听开发`)
    console.log(`   4. npm run scan-plugins              # 在根目录验证 AST 安全门禁\n`)
    process.exit(0)
  } catch (err) {
    console.error(`\n❌ 创建插件失败: ${err.message}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli()
}
