<p align="center">
  <img src="assets/ztools-logo.png" width="96" alt="ZTools Logo">
</p>

<h1 align="center">ZTools Extensions</h1>

<p align="center">ZTools 插件源码与开发工具</p>

<p align="center">
  <a href="https://www.ztools.cn">官网</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools/releases">下载 ZTools</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools">客户端源码</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools-extensions/issues">插件问题</a>
</p>

本仓库维护 ZTools 声明式插件源码，并提供开发所需的 SDK、脚手架与构建检查工具。插件通过 `List`、`Detail`、`Form`、`ActionPanel` 等组件描述界面，由 ZTools 客户端负责渲染和提供宿主能力。

**安装使用**：先从 [ZTools Releases](https://github.com/ZToolsTeam/ZTools/releases) 获取客户端，再通过客户端插件市场选择可安装的插件。**开发或贡献**：按下方步骤克隆本仓库，从源码构建和检查。

## 浏览插件

插件源码位于 [`extensions/`](extensions/)。例如：

| 插件 | 源码 |
| --- | --- |
| 计算器 | [`calculator`](extensions/calculator/) |
| JSON 格式化 | [`json-format`](extensions/json-format/) |
| 文本对比 | [`file-compare`](extensions/file-compare/) |
| 时间戳转换 | [`timestamp`](extensions/timestamp/) |
| 单位换算器 | [`unit-converter`](extensions/unit-converter/) |
| UUID 生成器 | [`uuid-generator`](extensions/uuid-generator/) |

每个插件的运行条件由其清单与源码共同决定，常用清单字段如下：

| 字段 | 含义 |
| --- | --- |
| `id` / `version` | 插件标识与版本 |
| `entry` | 构建后的加载入口，常见为 `dist/index.js` |
| `targets` | 声明的平台、宿主运行时与 CPU 架构 |
| `permissions` | 插件声明使用的权限 |
| `revoked` | 为 `true` 时表示已下架；仓库可保留相应目录与清单 |

`targets` 是兼容性声明，`permissions` 是权限声明；实际可用性还取决于客户端实现、系统授权和外部组件。系统操作、媒体处理等插件应同时查看对应目录的说明与源码。仓库中存在某个目录、源码能够编译或测试通过，都不表示该插件已在当前客户端市场发布；可安装版本以客户端市场为准。

## 开发插件

准备 Node.js 24（与本仓库 CI 一致）及 Git；验证宿主交互时还需要支持相应 API 的 ZTools 客户端。

### 1. 安装依赖

```bash
git clone https://github.com/ZToolsTeam/ZTools-extensions.git
cd ZTools-extensions
npm ci --ignore-scripts
```

在仓库根目录安装依赖，SDK 通过本仓库的 npm workspace 解析。`npm ci --ignore-scripts` 按锁文件安装依赖，和 PR 检查使用同一命令。

### 2. 创建插件

```bash
npm run create-plugin -- my-tool "我的工具" "一个声明式插件" --target-dir extensions --platform cross
```

此命令生成 `extensions/my-tool/`，包括清单、`src/`、图标、TypeScript 配置与测试。请保留 `--target-dir extensions`：脚手架默认目录为 `plugins/`，而本仓库的构建与检查工具读取 `extensions/`。

为兼容脚手架与构建器，插件 ID 使用 2–64 个小写英文字母、数字或连字符，以字母开头，例如 `my-tool`。`--platform` 可选 `cross`、`windows` 或 `macos`，只负责生成对应的 `targets`；应按实际验证结果选择平台，并按功能调整生成的 `permissions`。

### 3. 编译和检查

以下命令均在仓库根目录运行：

```bash
# 编译指定插件到 extensions/my-tool/dist/
node scripts/build-declarative.mjs my-tool

# 校验清单并扫描该插件的源码
node scripts/scan-plugin-security.mjs extensions/my-tool

# 运行脚手架生成的测试
node --test extensions/my-tool/tests/index.test.mjs
```

构建会生成 `extensions/my-tool/dist/`；清单扫描需要入口文件已经存在，所以按上述顺序执行。构建前会清理该插件已有的 `dist/`，源码修改应放在 `src/`。

已有插件请把 `my-tool` 和测试文件路径替换为对应目录。脚手架测试检查清单、入口导出及视图描述符；涉及剪贴板、文件、网络或系统操作时，还需在声明支持的平台上使用真实 ZTools 客户端验证成功、空结果和失败场景。命令行构建不会启动客户端或打开预览窗口。

### 4. 提交贡献

阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，完成本地验证后提交 Pull Request。已有插件的版本规则、改动检查范围和平台要求见贡献指南。

`npm test` 根据 `origin/main` 与当前 **HEAD 的已提交差异**选择检查范围，未提交改动可能被漏检。开发中先执行上面的单插件命令；提交前后的完整检查流程及 Fork 仓库基线设置见贡献指南。PR 合并与插件发布是两个步骤，上架状态以客户端市场为准。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| [`extensions/`](extensions/) | 插件清单、源码、图标与测试 |
| [`extensions/shared/`](extensions/shared/) | 插件共用源码；插件中的副本需与此处一致 |
| [`packages/declarative-ui/`](packages/declarative-ui/) | 用于编译和测试的 SDK 类型与运行时代码；用户端由客户端提供运行时 |
| [`packages/ztools-plugins-spec/`](packages/ztools-plugins-spec/) | 插件清单 Schema 与校验器 |
| [`scripts/`](scripts/) | 脚手架、构建与检查工具 |

## 问题反馈

插件或本仓库开发工具的问题请提交到[本仓库 Issues](https://github.com/ZToolsTeam/ZTools-extensions/issues)，注明插件 ID 与版本、客户端版本、操作系统及架构、复现步骤和错误信息；源码构建问题请附 Node.js 版本与执行命令。日志和截图请先去除个人信息与凭据。客户端本身的问题请提交到 [ZTools Issues](https://github.com/ZToolsTeam/ZTools/issues)。

## 许可证

本仓库使用 [MIT License](LICENSE)。
