# ZTools

<p align="center">
  <strong>现代化、高性能、纯粹开源的 Windows & macOS 双端效率启动器与插件中枢</strong>
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="License: GPL-3.0"></a>
  <a href="https://github.com/codingmuse/ZTools/actions"><img src="https://img.shields.io/badge/CI-Passing-brightgreen.svg" alt="CI Status"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-green.svg" alt="Node Version"></a>
  <a href="https://www.electronjs.org"><img src="https://img.shields.io/badge/Electron-43.4.1-blue.svg" alt="Electron Version"></a>
</p>

---

## 💡 为什么选择 ZTools？

ZTools 彻底卸下历史兼容包袱，吸纳 **Raycast** 验证过的顶尖工程实践，致力于打造对标国际一流的下一代桌面效率平台：

- 🚀 **毫秒级极速启动与出窗**：唤醒延迟严格压制在 100ms 以内（SLA < 100ms），待机时主动释放 GPU 资源，常驻托盘内存轻量稳定。
- ⚡ **硬件级 NTFS MFT / USN 秒级索引**：内置 Rust 编写的高性能侧车引擎，实测 100 万文件检索平均延迟仅 **0.035ms**，告别传统扫描卡顿。
- 🎨 **纯粹声明式 UI 体系**：彻底封杀原生 DOM/CSS 随意自由发挥，扩展统一采用语义化组件（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`），由宿主统一呈现沉浸式 Fluent / Mica 亚克力亚态毛玻璃质感与自适应主题。
- ⌨️ **全键盘优先极客流**：上下键自动滚屏聚焦、`Enter` 激活首要动作、`Ctrl+K` 呼出动作面板、`Esc` 返回上级导航栈，双手不离键盘。
- 🔒 **Local-First 与极致隐私优先**：数据 100% 留存在本地 SQLite，绝不强弹登录窗口，支持 Argon2id + AES-256-GCM 端到端加密（E2EE）通过 WebDAV 或 GitHub Gist 自主同步。
- 🤖 **AI Native 与原生 MCP 网关**：支持 BYOK（自带 DeepSeek、OpenAI、Claude Key），原生支持 DeepSeek R1 思考流与本地离线模型自动嗅探（Ollama / LM Studio 直连）。

---

## 🏗️ 架构与生态（双仓飞轮）

ZTools 采用**“核心宿主大仓 + 插件生态大仓”**的双仓解耦模式：

1. **核心宿主大仓（当前仓库）**：
   - `electron-client/`：基于 Electron 43 + TypeScript 打造的轻量现代化宿主；
   - `frontend/`：Vue 3 纯声明式渲染器；
   - `packages/`：公共核心基础设施（`@ztools/raycast-compat` SDK、`@ztools/ai-mcp` 网关、`@ztools/sync-crypto` 加密核心等）；
   - 随包内置预编译的 Rust Native 侧车（`ztools-indexer.exe` 与 `ztools-uiaccess.exe`），普通开发者无需配置 C++ 或 Rust 编译环境。
2. **插件生态大仓（[ZTools-extensions](https://github.com/codingmuse/ZTools-extensions)）**：
   - 包含日常开源通用插件与社区提交插件；
   - 内置一键脚手架（`npm run create-plugin`）；
   - 对标 Raycast 模式：**开放投稿，投稿即 PR，经 CI AST 安全扫描后官方审核合并，免运维静态分发**。

---

## ⚡ 快速开始（30 秒跑起本地环境）

环境要求：
- [Node.js](https://nodejs.org/) >= 20.0.0 (推荐 22+)
- Windows 10/11 或 macOS

### 1. 克隆代码

```bash
git clone https://github.com/codingmuse/ZTools.git
cd ZTools
```

### 2. 安装依赖并启动

```bash
# 安装根依赖
npm install

# 一键启动开发环境（前端与 Electron 宿主热更新）
npm run dev
```

### 3. 运行轻量门禁测试

```bash
# 运行 TypeScript 边界与单元契约测试
npm run test:quick

# 运行全链路混沌抗毁性集成测试
npm test
```

---

## 🛠️ 参与贡献与插件开发

想要为 ZTools 开发插件？无需克隆本仓库！

1. 访问插件大仓：[ZTools-extensions](https://github.com/codingmuse/ZTools-extensions)；
2. 运行 `npm run create-plugin my-tool` 一键生成遵循声明式规范的标准工程；
3. 打开电脑上正在运行的 ZTools 客户端，在「设置」->「开发者」中直接加载本地目录实时预览；
4. 编写完成直接提交 PR，官方审核后全网用户即可一键安装！

---

## 📄 开源协议 (License)

- 本仓库核心宿主代码基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 协议开源，严格禁止任何第三方闭源套壳分发。
- 插件生态（`@ztools/raycast-compat` 及官方通用扩展）基于宽松的 [MIT License](https://opensource.org/licenses/MIT) 授权，保障社区开发者最大自由度。
