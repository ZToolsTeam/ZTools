# Electron Client 测试流程

## 稳定入口

| 命令 | 用途 | 是否构建原生组件 |
| --- | --- | --- |
| `npm run test:quick` | TypeScript、源码边界、单元与多平台数据契约测试 | 否 |
| `npm run test:plugin-matrix` | 检查运行目录三类插件及其入口、资源、权限声明和 x86 DLL | 否 |
| `npm run test:plugins` | 三类代表插件的业务、生产构建、Electron Renderer、Host/Service 流程 | 是 |
| `npm run test:full` | 静态、单元、多平台数据契约加 `test:plugins`，日常完整门禁 | 是 |
| `npm run test:release` | 完整门禁、Windows x64 候选安装包、产物内容/架构/签名检查 | 是 |

各流程会把阶段状态、耗时、退出码和跳过原因写入
`out-test/test-reports/<profile>-latest.json`。任一必需阶段失败时命令返回非零；依赖失败的阶段标记为
`skipped`，不会被当作通过。

`npm run test:portable-contract` 验证 win32/linux/darwin 的路径、大小写冲突、能力状态、外部路径、凭据和逻辑数据导出/回迁规则。
它只使用内存数据和 fake contract，不读取当前用户的 Data、注册表、凭据或外部进程。

`npm run test:legacy-upgrade` 需要显式提供旧 fixture 和候选安装包：

```powershell
npm run test:legacy-upgrade -- --fixture-root="<fixture-root>" --artifact="<installer.exe>" --run-root="<new-evidence-root>" --legacy-client="<legacy-client.exe>"
```

该 runner 会在隔离目录中验证旧 `/S /D`、ZIP `--zip/--target` 和卸载入口，并为全部 fixture 插件保存数据摘要及脱敏日志。未提供真实旧客户端时，安装器/ZIP 结果仍会记录，但总状态保持 `blocked`。

## 三类代表插件

测试矩阵固定在 `tests/plugin-test-matrix.json`，不通过运行时猜测任意插件作为代表。

| 类型 | 代表插件 | 页面与业务验证 | 原生验证 |
| --- | --- | --- | --- |
| 纯 JS | `todo` | 单元测试、独立生产构建、`ztools://plugins` 页面加载、SDK/LevelDB 读写 | 不应存在 `dllloader` |
| 普通权限 DLL | `clipboard-manager` | 业务测试、独立生产构建、普通插件 Renderer 身份与 SDK 使用 | `ZToolsNativeHost32.exe` 加载 x86 DLL 并调用无副作用 `GetStatus` |
| 管理员权限 DLL | `context-menu` | 业务测试、独立生产构建、普通插件 Renderer 身份与 SDK 使用 | `ZToolsService.exe` 受信测试清单下调用 `CheckAdmin`；生产无信任锚时必须拒绝 |

矩阵预检同时比较以下三份事实来源：

- JS 插件源码 `plugin.json`；
- DLL 插件源码 `plugin.json`；
- 本次构建生成的 `out/runtime/Data/Plugins` 运行清单和文件。

`requireAdmin`、`dllloader`、DLL 文件名或架构不一致会直接失败，避免把管理员插件送入普通 Host，或把普通插件误送入 Service。

## Renderer 进程测试

`tests/e2e/plugin-runtime-app` 是专用 Electron 测试应用，不使用普通浏览器或 `file://`。它复用生产代码中的：

- `ztools://plugins` 与 `ztools://web` 协议处理；
- `secureWebPreferences()` 和主 preload；
- `WindowRegistry` 插件身份；
- `IpcRouter`、能力表和真实 LevelDB 服务。

每个代表插件都必须满足：入口和相对资源实际加载、`#app` 完成渲染、SDK 识别为 Electron、Node/`require` 不可见、自身数据库可读写、伪造其他插件数据库身份被拒绝。窗口在每个用例后销毁，Router 和数据库在测试退出前对称停止。

该测试直接创建测试窗口，不替代 M4 的 `plugin_open`、单/多实例、payload、更新、卸载和崩溃恢复验收。生产插件窗口管理器接入后，这些场景必须继续加入本流程，不能仅以本测试应用通过作为发布依据。

## 原生边界

普通 DLL 流程构建真实 `ClipboardManagerPlugin.dll`、`BatchRenamePlugin.dll` 和
`ScreenCapturePlugin.dll`，通过测试信任锚验证清单、x86 PE、函数白名单、同步/异步/回调、取消、卸载、受管进程清理、Host 崩溃和有界退出。

管理员流程构建真实 `ContextMenuPlugin.dll`，Service 自测在隔离数据根和测试摘要下完成
`CheckAdmin` ABI 往返；Node named-pipe 集成同时验证无测试信任锚时 `MANIFEST_UNTRUSTED` 的结构化拒绝，以及独立测试清单下的同步/异步任务与事件往返。后者使用明确的 integration-test-server 入口，不能作为已安装管理员 Service 验收。测试不得写入 HKLM 生产信任锚，也不得用普通进程结果冒充管理员 Service 结果。

## 环境与发布

本地要求 Windows、Node 22、Electron 43.4.1、VS2022 Win32 工具链、CMake、QtMsBuild，以及父仓库的 `frontend`、`plugins`、`DLLPlugins`、`bin` 子模块。路径默认值遵循仓库 `AGENTS.md`。

`test:release` 要求所有 PE 均有有效 Authenticode 签名。无签名开发环境中该阶段应明确失败，不能把 `test:full` 的通过结果当作可发布包。

产物检查同时要求 `locales/` 仅包含 `en-US.pak` 和 `zh-CN.pak`，并拒绝测试说明、依赖开发文档、源码映射及编译中间文件进入应用目录。

系统发布前仍需在 Win10 x64 和 Win11 x64 上运行同一门禁；x64 应用中的 NativeHost32/Service 仍通过真实 x86 ABI 在 WOW64 中运行，并完成 DPI、多屏、标准用户、Service 安装态、插件更新/卸载和长稳矩阵。

### 正常客户端配置保存与重启（CDP）

在完成 `npm run build` 后运行 `npm run test:win:normal-app:config-restart`。入口固定使用当前 Electron ZTools，在启动第一行通过 Main inspector 隔离 appData/userData/sessionData，并先安装空剪贴板测试保护；随后通过 CDP 的真实 `ztools://web` 和公共 `ztools.config` 写入、读取，再检查实际 BOM JSON 字节，正常退出并重启同一测试数据目录。

默认在系统临时目录创建全新 UUID 证据目录；可使用 `-- --output <全新绝对目录>`，已有目录拒绝复用。报告记录 Main/Renderer 身份、bootstrap、preload、SDK 构建快照及测试入口/共享 harness 的 SHA-256、落盘摘要及 owned Main/后代清理；运行前后的构建输入必须相同。不能把该子集作为插件业务、原生对话框、真实剪贴板、Mac 或最终发行包验收。

入口合同为 `npm run test:win:normal-app:config-restart:contracts`；现有输出目录拒绝用例在 Windows 核对当前构建快照，所以先完成构建。

### NativeHost32 独立夹具与完整边界测试

`build-native-host32.ps1 -BuildTestFixture` 另构建无插件导出的 `ZToolsNativeAbiRejectionFixture.dll`，仅用于精确验证 `DLL_EXPORTS_INVALID`；不再为此执行第三方 Node addon 的加载初始化。`ZTOOLS_NATIVE_HOST32_INVALID_ABI_FIXTURE` 可指定绝对夹具路径。完整 runner 可通过 `ZTOOLS_NATIVE_HOST32_SCREEN_CAPTURE_FIXTURE_DIR` 指定真实截图 DLL/helper 的绝对构建目录，默认仍为 `DLLPlugins/screenshot/Release`。动态 Qt 夹具必须携带 x86 runtime 和 `platforms/qwindows.dll`；runner复制并校验隔离目录内依赖，移除源夹具目录的 PATH 项。临时动态 Qt 构建不能代替正式静态发布包验收。

focused C13 使用显式 5 秒 request deadline 验证阻塞队列超时；`callDll` 本身仍无固定 deadline。所有错误断言同时核对公共错误类型和原生 hostCode，取消 ACK 仍不视为任务终态。

原生测试入口（Host32、Service、media lifecycle、common DLL和service data root）在成功的主程序TypeScript编译后，统一重新执行现有sandbox preload打包，再进入测试。裸tsc产物含本地require，不能直接供Electron sandbox启动；test:preload:sandbox现用仅允许electron模块的隔离shim实际执行维护源码打包结果，并证明未打包产物被拒绝。该shim测试不是正常App/CDP验收，也不覆盖编译失败后的运行目录恢复。
