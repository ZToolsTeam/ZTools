# 更新日志 (Changelog)

本仓库的所有重要版本更新、新增特性、体验优化与问题修复均记录在此文件中。

日志格式遵循业界通用的 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本 (Semantic Versioning)](https://semver.org/lang/zh-CN/) 标准，每次代码同步与版本发布均在顶部持续追加最新记录。

<!-- changelog-auto-append-start -->
<!-- last-synced-commit: 682b7b7 -->

## [Unreleased / 2026-10-17] - 核心效率流 (Phase 1~3) 落地、双模态交互打磨与跨平台增强

### ✨ 新增特性 (Features)
- **内联计算器、单位换算与色板顶层直出 (E4)**：在悬浮条 (`LauncherBar`) 与主界面搜索框 (`SearchBar`) 双端支持算式（如 `128 * 35`）、单位/汇率换算与色值（`#FF5733` / `rgb()` / `hsl()`）即输即得置顶展示，支持 `Enter` 一键复制结果与 `Ctrl+K` 动作面板扩展操作。
- **窗口分屏上一位置还原 (`Restore`) 与双界面焦点隔离 (E5)**：新增窗口分屏前后状态记忆与来回切换还原能力；在 `WindowManagementService` 中维护 `lastExternalForegroundHwnd`，自动过滤 ZTools 内部窗口句柄，解决从大主界面点击分屏时的焦点误判问题。
- **中文全拼 / 首字母 / 多音字智能检索与命中汉字高亮 (E6)**：前后端统一内置 3500+ 常用汉字全拼词典与高频多音字映射（如 `重`: `zhong/chong`、`还`: `hai/huan`、`行`: `xing/hang`），并在搜索结果列表中精准高亮拼音命中的中文字符。
- **快捷短语 (`Snippets`) 动态参数填空表单与跨窗回填 (E7)**：支持解析 `{argument name="..." options="..."}` 动态参数占位符，自动唤起 `SnippetArgumentFormView`（左栏动态表单 + 右栏实时 `Preview`），填写完成后精准粘贴回原外部活动窗口。
- **脚本命令 (`Script Commands`) 四模式分流与 ANSI 着色渲染 (E8)**：完整支持 `fullOutput`（含 ANSI 16 色控制码解析着色与输出 URL 自动提取打开）、`compact`（剥离控制码后 HUD 提示末行）、`silent`（静默执行与状态提示）及 `inline`（主搜索列表动态内联副标题与 `refreshTime` 定时刷新）。
- **macOS 打包与双窗口流转增强**：新增 `package:mac:dmg` DMG 镜像构建与应用图标校验；悬浮条展开至大主界面工作台时支持精准携带并跳转至目标插件页面；插件危险操作统一接入站内确认对话框。

### 🐛 问题修复 (Bug Fixes)
- **文件秒搜 (`Quick Look`) 快捷键对齐**：将文件秒搜预览快捷键统一对齐为 `Ctrl+Y`，支持空文件与超大文件安全截断预览。
- **平台能力过滤与数据纯净性**：插件市场自动按当前操作系统过滤展示可用插件，隐藏空分类；移除便签、翻译、快捷直达中的示例占位数据；修复 macOS 下 `/var` 系统软链接导致的文件授权测试卡死问题。

### 📝 文档与工程基建 (Chores & Docs)
- **标准更新日志体系与自动追加流水线**：落地核心效率流 (E4~E8)、新增标准 CHANGELOG.md 与自动追加机制并同步全部子模块（遵循 Keep a Changelog + Conventional Commits 规范，每次发布自动脱敏归档并同步至 GitHub）。

---

## [v1.1.7.1] - 2026-10-16 - 声明式 UI 2.0 升级、积木 Z × 余烬橙品牌重设计与 Winget 自动分发

### ✨ 新增特性 (Features)
- **声明式 UI 2.0 (`@ztools/declarative-ui`) 全面升级**：重构虚拟视图描述符（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`）与内置核心生产力套件，强化插件动态加载器与运行时异常隔离。
- **积木 Z × 余烬橙品牌视觉重设计**：客户端全面升级为「积木 Z × 余烬橙」现代极客视觉语言，统一侧边栏、动作面板、设置中心分段控件与全局快捷键键帽组件，完整支持亮色 / 暗色双主题。
- **微软官方 Winget 自动化分发流水线**：新增 `scripts/publish-winget.mjs`（`npm run release:winget`），支持自动生成符合微软 1.6.0+ 规范的多语言 Manifest 清单、本地 `winget validate` 校验与自动提交 PR。

### 🐛 问题修复 (Bug Fixes)
- **内置 Web 资源按内容指纹刷新**：修复重新构建或安装包覆盖升级后仍命中旧版前端缓存界面的问题。
- **开箱即用构建体验优化**：新克隆仓库可直接构建运行，构建与安装过程不再弄脏父仓库 Git 工作区；IPC 路由将 `NOT_SUPPORTED` 视为正常平台能力边界处理。

---

## [v1.0.0] - 2026-10-14 - 纯粹开源双仓架构首发、Rust 高性能侧车与 AI / E2EE 底座

### ✨ 新增特性 (Features)
- **双仓开源飞轮架构首发**：确立 `codingmuse/ZTools`（GPL-3.0 核心宿主大仓）与 `codingmuse/ZTools-extensions`（MIT 插件生态大仓）双仓解耦体系，内置 4 大开发者生态引导触点与 AST 静态安全扫描门禁 (`scan-plugin-security.mjs`)。
- **轻量 TS 宿主 + 预编译 Rust Native 侧车**：集成 `ztools-indexer.exe`（NTFS MFT / USN Journal 百万文件毫秒级检索）与 `ztools-uiaccess.exe`（Win32 UIAccess 跨权限取词与活动浏览器 Tab URL 获取）。
- **大主界面工作台 (`Dashboard`) + 极客悬浮搜索条 (`Launcher`) 双模态**：支持 `Ctrl/Cmd + M` 一键丝滑切换，窗口隐藏 15 秒自动挂起释放 GPU 显存，双层 `requestAnimationFrame` 防闪烁极速唤醒（SLA < 100ms）。
- **Local-First 免登录底座与去中心化 E2EE 云同步 (`@ztools/sync-crypto`)**：核心数据 100% 本地 SQLite WAL 持久化，支持 Argon2id 密钥派生 + AES-256-GCM 认证加密，提供 WebDAV（ETag 乐观锁）与 GitHub Gist 多端同步适配器。
- **AI Native 与原生 MCP 网关 (`@ztools/ai-mcp`)**：支持 BYOK（DeepSeek R1、OpenAI、Claude、SiliconFlow）及本地离线大模型（Ollama `11434` / LM Studio `1234`）零配置嗅探直连，内置原生 MCP 协议栈。
<!-- changelog-auto-append-end -->
