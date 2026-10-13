#!/usr/bin/env node

/**
 * prepare-extensions-repo.mjs
 * 构建独立的 ZTools 插件生态大仓 (ZTools-extensions)
 *
 * 规范：
 * 1. 独立 MIT License，彻底消除外部贡献者的法律担忧；
 * 2. 抽取 34 款核心开源通用插件进 extensions/ 目录；
 * 3. 根目录集成 create-plugin 脚手架与 scan-plugin-security 安全扫描器；
 * 4. 包含完善的 CONTRIBUTING.md 贡献指南与 5 分钟上手开发文档。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '..')
const targetRoot = path.resolve(srcRoot, '..', 'ZTools-extensions')

console.log('========================================================')
console.log('     ZTools 插件生态大仓 (ZTools-extensions) 构建工具')
console.log('========================================================')
console.log(`源工程目录:   ${srcRoot}`)
console.log(`插件大仓目录: ${targetRoot}\n`)

if (fs.existsSync(targetRoot)) {
  fs.rmSync(targetRoot, { recursive: true, force: true })
}
fs.mkdirSync(targetRoot, { recursive: true })
fs.mkdirSync(path.join(targetRoot, 'extensions'), { recursive: true })
fs.mkdirSync(path.join(targetRoot, 'scripts'), { recursive: true })

// 1. 生成 MIT LICENSE
const mitLicense = `MIT License

Copyright (c) 2026 ZTools Authors and Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
fs.writeFileSync(path.join(targetRoot, 'LICENSE'), mitLicense, 'utf8')
console.log('✔ 已生成 MIT LICENSE')

// 2. 生成 package.json
const packageJson = {
  name: '@ztools/extensions',
  version: '1.0.0',
  description: 'ZTools 官方开源插件与生态扩展大仓 | Raycast 声明式 UI 标准、一键脚手架与 GitOps 自动化分发',
  private: false,
  license: 'MIT',
  scripts: {
    'create-plugin': 'node scripts/create-plugin.mjs',
    'test': 'node scripts/scan-plugin-security.mjs extensions',
    'scan': 'node scripts/scan-plugin-security.mjs extensions'
  },
  devDependencies: {
    '@ztools/raycast-compat': '^1.0.0',
    '@ztools/ztools-plugins-spec': '^1.0.0'
  }
}
fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8')
console.log('✔ 已生成 package.json (内置脚手架与安全扫描命令)')

// 3. 复制脚本 (脚手架与安全扫描器)
fs.copyFileSync(
  path.join(srcRoot, 'scripts', 'create-plugin.mjs'),
  path.join(targetRoot, 'scripts', 'create-plugin.mjs')
)
fs.copyFileSync(
  path.join(srcRoot, 'scripts', 'scan-plugin-security.mjs'),
  path.join(targetRoot, 'scripts', 'scan-plugin-security.mjs')
)
console.log('✔ 已植入脚手架 (create-plugin.mjs) 与安全扫描器 (scan-plugin-security.mjs)')

// 3.1 复制 plugins-spec 规范包以支持独立 AST 扫描
const specSrc = path.join(srcRoot, 'packages', 'ztools-plugins-spec')
const specDest = path.join(targetRoot, 'packages', 'ztools-plugins-spec')
fs.mkdirSync(path.join(targetRoot, 'packages'), { recursive: true })
fs.cpSync(specSrc, specDest, { recursive: true, filter: (src) => !src.includes('node_modules') })
console.log('✔ 已植入插件规范校验包 (packages/ztools-plugins-spec)')

// 4. 生成 .gitignore
const gitignore = `node_modules/
dist/
*.log
.DS_Store
*.tmp
.env*
`
fs.writeFileSync(path.join(targetRoot, '.gitignore'), gitignore, 'utf8')
console.log('✔ 已生成 .gitignore')

// 5. 复制 34 款开源通用插件进 extensions/
const pluginsSrc = path.join(srcRoot, 'plugins')
if (fs.existsSync(pluginsSrc)) {
  const pluginDirs = fs.readdirSync(pluginsSrc, { withFileTypes: true })
  let count = 0
  for (const dirent of pluginDirs) {
    if (!dirent.isDirectory()) continue
    if (['node_modules', '.git', 'dist'].includes(dirent.name)) continue
    
    // 检查是否包含 plugin.json
    const pJsonPath = path.join(pluginsSrc, dirent.name, 'plugin.json')
    if (!fs.existsSync(pJsonPath)) continue

    const srcDir = path.join(pluginsSrc, dirent.name)
    const destDir = path.join(targetRoot, 'extensions', dirent.name)
    
    fs.cpSync(srcDir, destDir, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('dist') && !src.endsWith('.log')
    })
    count++
  }
  console.log(`✔ 已迁移 ${count} 款开源基础通用插件至 extensions/`)
}

// 6. 生成 README.md 与 CONTRIBUTING.md
const readme = `# ZTools Extensions (插件生态大仓)

> 欢迎来到 **ZTools** 官方开源扩展生态大仓！在这里，你可以为 Windows & macOS 双端效率神器 ZTools 贡献你的奇思妙想。

---

## ⚡ 5 分钟贡献你的首款插件

写插件无需克隆庞大的客户端主程序，全流程只需 **3 步**：

### 1. 克隆本仓库

\`\`\`bash
git clone https://github.com/codingmuse/ZTools-extensions.git
cd ZTools-extensions
\`\`\`

### 2. 一行命令生成插件工程

\`\`\`bash
# 格式: npm run create-plugin <plugin-id> [title] [description]
npm run create-plugin my-tool "我的效率工具" "基于声明式 UI 的日常好帮手"
\`\`\`

脚手架将在 \`extensions/my-tool/\` 自动生成符合规范的标准工程。

### 3. 编写代码与本地实时预览

1. 打开电脑上安装好的 **ZTools 客户端**；
2. 进入「设置」->「开发者」面板，点击「加载本地开发插件」，选择刚才生成的 \`extensions/my-tool\` 目录；
3. 打开 VS Code 编写代码，保存后 ZTools 客户端将**毫秒级实时热重载**展示效果！

### 4. 提交 PR 审核上架

\`\`\`bash
# 本地运行安全语法预检
npm test

# 提交代码并发起 PR
git checkout -b feat/my-tool
git add .
git commit -m "feat(extension): add my-tool plugin"
git push origin feat/my-tool
\`\`\`

在 GitHub 上提交 PR 后，CI 自动化流水线将自动验证插件 AST 安全性。官方审核合并后，插件将自动发布至全网插件市场！

---

## 🎨 核心规范（Raycast 声明式 UI 对齐）

- **彻底封杀原生 DOM/CSS 自由发挥**：严禁直接操作 HTML DOM，严禁手写自定义 CSS；
- **纯语义化组件**：统一使用 \`<List>\`, \`<Detail>\`, \`<Form>\`, \`<ActionPanel>\`, \`<Action>\`，由宿主统一样式与主题呈现；
- **键盘优先**：方向键聚焦，\`Enter\` 执行主动作，\`Ctrl+K\` 打开动作面板。

---

## 📄 开源协议 (License)

本项目遵循宽松的 [MIT License](LICENSE)，充分尊重并保障生态贡献者的自由度与知识产权。
`

fs.writeFileSync(path.join(targetRoot, 'README.md'), readme, 'utf8')
fs.writeFileSync(path.join(targetRoot, 'CONTRIBUTING.md'), readme, 'utf8')
console.log('✔ 已生成面向开发者的 README.md 与 CONTRIBUTING.md')

console.log('\n========================================================')
console.log(`插件大仓准备完毕，位于: ${targetRoot}`)
console.log('========================================================\n')
