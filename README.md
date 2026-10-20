<p align="center">
  <img src="assets/ztools-logo.png" width="96" alt="ZTools Logo">
</p>

<h1 align="center">ZTools</h1>

<p align="center">面向 Windows 与 macOS 的桌面启动器与插件工具箱</p>

<p align="center">
  <a href="https://www.ztools.cn">官网</a> ·
  <a href="https://www.ztools.cn/download.html">下载</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools/releases">版本发布</a> ·
  <a href="https://github.com/ZToolsTeam/ZTools/issues">问题反馈</a>
</p>

ZTools 将应用搜索、快捷启动和插件工具放在同一个桌面入口中，提供工作台与悬浮搜索条两种界面，支持键盘操作和明暗主题。

本仓库包含 Electron 客户端、Vue 界面层及共享包的源码。独立插件源码和插件开发指南位于 [ZTools Extensions](https://github.com/ZToolsTeam/ZTools-extensions)。各插件支持的平台、权限和依赖以其清单与说明为准。

## 下载与使用

从[官网下载页](https://www.ztools.cn/download.html)或 [GitHub Releases](https://github.com/ZToolsTeam/ZTools/releases) 获取适合自己系统的安装包。版本说明、可用文件和校验文件以对应发布页为准。

## 从源码运行

准备 Node.js 24（含 npm）与 Git，在 Windows 或 macOS 上执行：

```bash
git clone https://github.com/ZToolsTeam/ZTools.git
cd ZTools
npm install
npm run dev
```

根目录的安装脚本会安装 `electron-client/`、`frontend/` 的依赖并构建声明式 UI 包。`npm run dev` 会先构建界面和客户端，再启动 Electron；它不是持续监听源码的开发服务器，修改后需重新构建或重启。

Windows 启动脚本会尝试构建 NativeHost32；该组件需要 CMake 和 Visual Studio C++ 工具链。依赖该组件的系统功能需要相应组件可用。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| [`electron-client/`](electron-client/) | Electron 主进程、预加载桥接、系统服务与原生组件 |
| [`frontend/`](frontend/) | Vue 界面、搜索入口与声明式视图渲染器 |
| [`packages/declarative-ui/`](packages/declarative-ui/) | 声明式组件、运行时、宿主 API 与示例 |
| [`packages/api/`](packages/api/) | 插件 API 类型与契约 |
| [`packages/ztools-plugins-spec/`](packages/ztools-plugins-spec/) | 插件清单 Schema 与校验器 |
| [`packages/ai-mcp/`](packages/ai-mcp/) | 模型调用与 MCP 相关模块 |
| [`packages/sync-crypto/`](packages/sync-crypto/) | 加密与同步相关模块 |
| [`tests/`](tests/) | 跨模块测试 |

## 构建与检查

安装依赖后，在仓库根目录执行：

```bash
# 构建客户端与界面，不启动窗口
npm --prefix electron-client run build

# 客户端类型、单元测试与便携数据契约检查
npm run test:quick
```

这些检查不能代替实际系统上的交互验证。修改快捷键、窗口、剪贴板或插件桥接时，还需要在对应平台的 ZTools 客户端中验证。

## 参与贡献

- 客户端问题与建议：提交 [Issue](https://github.com/ZToolsTeam/ZTools/issues)，附上系统、客户端版本和复现步骤。
- 客户端代码修改：提交 Pull Request，说明改动与验证结果。
- 插件开发与投稿：参阅 [ZTools Extensions 贡献指南](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/CONTRIBUTING.md)。

## 许可证

本仓库的许可证见 [GNU GPL v3.0](LICENSE)。独立包的许可声明请查看对应目录；插件仓库的许可证见 [ZTools Extensions LICENSE](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/LICENSE)。
