<p align="center">
  <img src="assets/ztools-logo.png" width="96" alt="ZTools Logo">
</p>

<h1 align="center">ZTools</h1>

<p align="center">面向 Windows 与 macOS 的桌面启动器与插件工具箱</p>

<p align="center">
  <a href="https://www.ztools.cn">官网</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools/releases">版本下载</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools-extensions">插件源码</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools/issues">问题反馈</a>
</p>

ZTools 把应用搜索、快捷启动和插件工具放进同一个桌面入口：

- 两种界面：工作台与悬浮搜索条
- 全键盘操作，支持明暗主题
- 插件用声明式组件开发，由客户端统一渲染

本仓库是客户端源码（Electron + Vue）和插件 SDK，插件源码在 [ZTools Extensions](https://github.com/ZToolsTeam/ZTools-extensions)。

<p align="center">
  <img src="assets/screenshots/01-dashboard-workspace.png" width="860" alt="ZTools 工作台主界面">
  <br>
  <sub>工作台：已安装工具与热门推荐（macOS 官方版实拍）</sub>
</p>

<p align="center">
  <img src="assets/screenshots/02-geek-launcher-mode.png" width="680" alt="ZTools 悬浮搜索条">
  <br>
  <sub>悬浮搜索条：输入“计算”后的实际搜索结果（macOS 官方版实拍，⌥ Space 唤醒）</sub>
</p>

## 开源版与官方版

本仓库是 ZTools 的**开源版**。

| | 官方安装包（Releases） | 从源码构建 |
| --- | --- | --- |
| 搜索、启动、工作台与插件市场 | 有 | 有 |
| 账号登录、反馈建议、插件评论与评分 | 有 | 没有 |
| 云同步、使用统计、检查更新 | 有 | 没有 |

- 官方安装包用同一份源码构建，另外加入了不开源的账号与云服务组件。
- 从源码构建得到的是离线版：不连接官方后台，插件市场照常可用。
- 详细区别见 [开源版与官方版](docs/building.md#开源版与官方版)。

## 下载与使用

在 [GitHub Releases](https://github.com/ZToolsTeam/ZTools/releases) 选择版本，从 **Assets** 下载对应文件：

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `windows-x64.exe` 安装包，或 `windows-x64-portable.zip` 免安装包 |
| macOS（Intel / Apple Silicon） | `darwin-universal.dmg` |

- 每个文件都附有 `.sha256` 校验文件。
- **Source code** 压缩包只是源码，不能直接安装。

## 快速开始

需要 Node.js 24 和 Git，在 Windows 或 macOS 上执行：

```bash
git clone https://github.com/ZToolsTeam/ZTools.git
cd ZTools
npm install
npm run dev
```

- `npm run dev` 会先构建再启动客户端，不会监听文件变化，改完代码重新运行即可。
- 环境要求、打包与常见问题见 [从源码构建](docs/building.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [从源码构建](docs/building.md) | 环境要求、开发运行、macOS 打包 |
| [架构概览](docs/architecture.md) | 进程划分、IPC、插件模型与安全边界 |
| [测试](docs/testing.md) | 各模块的测试命令与用例要求 |
| [代码规范](docs/coding-standards.md) | 通用原则、各层规则、换行符与提交说明 |
| [贡献指南](CONTRIBUTING.md) | 反馈问题、提交 Pull Request、贡献授权 |
| [插件开发](https://github.com/ZToolsTeam/ZTools-extensions) | 创建、调试与投稿插件 |

## 许可证

- **客户端**：以 [GNU GPL v3.0](LICENSE)（GPL-3.0-only）发布，包括 `packages/ai-mcp`、`packages/sync-crypto`。
- **插件开发包**：`packages/declarative-ui`、`packages/api`、`packages/ztools-plugins-spec` 以 MIT 发布（见各自 `package.json` 的 `license` 字段）。
- **插件仓库**：见 [ZTools Extensions LICENSE](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/LICENSE)。
- **第三方依赖**：以其自身许可为准。

提交 Pull Request 时需要勾选贡献授权，同意以 GPL-3.0-only 和 MIT 双重许可提供贡献，原因见 [贡献指南](CONTRIBUTING.md#贡献授权)。
