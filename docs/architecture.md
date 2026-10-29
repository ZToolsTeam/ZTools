# 架构概览

这是一张给贡献者看的模块地图：每块负责什么、代码在哪。细节以源码和测试为准。构建方法见 [从源码构建](building.md)。

## 整体结构

```text
界面层（Vue，frontend/）  ── window.ztools ──>  预加载脚本（preload）
                                                     │  ztools:call 单一通道
                                                     ▼
                                     主进程（electron-client/src/main）
                                     校验方法、调用方、权限、参数、超时
                                                     │
                     ┌───────────────────────────────┼───────────────────────────┐
                     ▼                               ▼                           ▼
             系统服务（services/）         插件窗口 / 声明式插件         原生组件（native/）
```

## 各部分职责

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 主进程 | [`electron-client/src/main/`](../electron-client/src/main/) | 应用生命周期、窗口、快捷键、托盘、插件安装与运行、系统能力 |
| 预加载脚本 | [`electron-client/src/preload/`](../electron-client/src/preload/) | 通过 `contextBridge` 暴露逐个方法的调用桥，不暴露 Node 模块 |
| IPC 契约 | [`electron-client/src/contracts/`](../electron-client/src/contracts/) | 请求格式、方法白名单、调用方能力表、错误码、大小与超时上限 |
| 界面层 | [`frontend/src/`](../frontend/src/) | 工作台、悬浮搜索条、设置页，以及声明式视图渲染器 |
| 宿主 API | [`frontend/public/js/cef-ipc/`](../frontend/public/js/cef-ipc/) | 生成 `window.ztools`，把调用转给预加载桥 |
| 声明式 UI | [`packages/declarative-ui/`](../packages/declarative-ui/) | 插件使用的组件、运行时（协调器与 Hooks）和示例 |
| 插件规范 | [`packages/ztools-plugins-spec/`](../packages/ztools-plugins-spec/)、[`packages/api/`](../packages/api/) | `plugin.json` Schema、校验器、TypeScript 类型 |
| 模型与 MCP | [`packages/ai-mcp/`](../packages/ai-mcp/) | 大模型调用路由（含本机模型探测）与 MCP 协议实现 |
| 加密与同步 | [`packages/sync-crypto/`](../packages/sync-crypto/) | 端到端加密（Argon2id 派生密钥、AES-256-GCM）与 WebDAV、GitHub Gist 同步适配器 |
| 原生组件 | [`electron-client/native/`](../electron-client/native/) | 平台相关的 C++ / Objective-C++ 程序，作为独立进程运行 |

主进程里常看的目录：

- `bootstrap.ts`、`application-lifecycle.ts`：启动与退出流程。
- `windows/`：主窗口、悬浮搜索条（`launcher-controller.ts`）、插件窗口、托盘。
- `ipc/router.ts`：所有 `ztools:call` 请求的入口。
- `services/`：配置、剪贴板、文件搜索、插件安装、更新等服务，一个能力一个文件。
- `edition.ts`、`edition-types.ts`、`edition-oss/`：主进程的版本接口与开源版实现，见下文「版本接口」。
- `platform/`：Windows 与 macOS 的差异封装在 `windows/`、`macos/` 子目录。
- `protocol/ztools-protocol.ts`：`ztools://` 协议，界面和插件资源都从这里加载。

## 版本接口

账号、反馈、插件评论与评分、云同步、使用统计和客户端更新服务只在官方安装包里提供（见 [开源版与官方版](building.md#开源版与官方版)）。公共代码不直接依赖这些功能，而是通过一层版本接口使用；本仓库提供接口的开源版实现，全部离线、不发网络请求。

更新检查与安装能力分开：官方版按 Windows 或 macOS 选择完整安装包，Windows 交给安装器，macOS 提供 DMG 下载并提示用户手动替换应用。打开下载页面不表示安装完成；没有更新来源时不发出检查请求。

插件分发是两种版本共用的公开能力：列表、分类、详情、安装信息和插件更新均读取官方 CDN 的 `plugins-v2/catalog.json`。安装或更新前重新读取目录，检查下架状态、平台、最低客户端版本、安装包地址和 SHA-256；目录不可用时明确报错。本地快照只用于离线浏览，不能代替安装前的检查。刷新目录或检查插件更新时，下架记录也会同步到已安装插件的禁用状态。

| 层 | 接口入口 | 开源版实现 |
| --- | --- | --- |
| 界面层 | `@edition` 别名（在 `frontend/vite.config.js`、`vitest.config.js` 里配置） | [`frontend/src/edition-oss/`](../frontend/src/edition-oss/)：没有附加路由、页面与插件详情 Tab，反馈入口打开 GitHub Issues，账号状态始终未登录，统计与同步为空操作 |
| 主进程 | [`edition.ts`](../electron-client/src/main/edition.ts)，接口定义在 [`edition-types.ts`](../electron-client/src/main/edition-types.ts) | [`electron-client/src/main/edition-oss/`](../electron-client/src/main/edition-oss/)：始终未登录、没有凭据，统计丢弃，没有更新来源，公共库只用随版本发布的完整性锚点 |

IPC 契约对两种版本相同：`user_get_info`、`user_set_token`、`user_logout`、`analytics_report` 等方法照常存在，开源版里账号方法始终返回未登录、保存登录结果被拒绝，统计上报直接丢弃；开源版的 `window.ztools` 也不提供账号与统计 API。

改动与版本有关的功能时：

- 公共代码只从 `@edition` 或主进程的版本接口取能力，不直接引用某个版本的实现；
- 接口新增或修改字段时，开源版实现同步补上对应的空实现，并通过 `frontend/src/edition-oss/__tests__/` 与 `electron-client/tests/unit/main-edition.test.ts` 的测试；
- 开源版实现不能发网络请求、不能写账号文件。

## 一次调用怎么走

1. 界面或插件调用 `window.ztools` 上的方法。
2. 预加载脚本把它打包成 `{ messageId, method, params, timeoutMs }`，发到 `ztools:call` 通道。
3. 主进程 [`router.ts`](../electron-client/src/main/ipc/router.ts) 依次检查：
   - 请求格式与大小（[`contracts/ipc.ts`](../electron-client/src/contracts/ipc.ts)，普通请求上限 1 MiB，默认超时 10 秒）；
   - 方法是否在白名单内、当前平台是否支持；
   - 调用方能否调用这个方法（[`contracts/capabilities.ts`](../electron-client/src/contracts/capabilities.ts)，按 `main` / `plugin` 区分）；
   - 需要插件权限的能力，检查 `plugin.json` 是否声明（[`ipc/plugin-principal.ts`](../electron-client/src/main/ipc/plugin-principal.ts)）。
4. 调用方身份来自发出请求的窗口（WebContents），不采用请求里自报的标识。
5. 结果统一以 `{ success, data }` 或 `{ success: false, error: { code, message } }` 返回。

新增宿主方法时，契约、能力表、预加载方法列表和路由要一起改，并补上对应测试。

## 插件模型

每个插件是一个带 `plugin.json` 的目录，必填 `id`、`name`、`version`、`description`、`author`、`entry`、`icon`、`permissions`、`targets`、`nativeComponents`（纯 JS 插件写 `[]`），完整字段见 [`plugin.schema.json`](../packages/ztools-plugins-spec/plugin.schema.json)。插件用 `@ztools/declarative-ui` 的组件描述界面，由 [`frontend/src/declarative/`](../frontend/src/declarative/) 统一渲染，资源通过 `ztools://plugins/<插件 ID>/...` 加载。

清单字段、宿主 API 和发布流程见插件仓库的 [API 参考](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/api.md) 与 [发布插件](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/publishing.md)。

### 默认内置插件

开源版和官方版使用同一份[内置清单](../frontend/src/config/bundledPlugins.json)，默认提供 9 个同时支持 Windows 与 macOS 的基础工具：计算器、二维码生成、JSON 格式化、时间戳转换、文本对比、编码与加密、取色与配色、便签、待办清单。

默认内置的选择标准：

- 首次启动即可使用，核心功能不依赖账号、API Key 或额外下载的模型；
- 服务于常见的即时操作，能减少打开其他软件或网站的步骤；
- 按需加载，闲置时不新增后台进程、持续扫描或联网任务；
- 两个平台的核心功能均已验证，适合随客户端版本一起维护和发布。

官方署名与默认内置分别维护：官方插件不一定内置，其余插件由用户从市场按需安装。不要为了丰富首屏而自动下载安装更多插件。

内置插件的资源随源码仓库和客户端一起提供，不依赖账号、云服务或首次启动下载。运行时优先加载 `frontend/public/bundled-plugins/` 中的副本，不能单独卸载，更新随客户端分发；市场里的同名安装包不能覆盖它。

图片 Base64、2FA 验证码、下载管理、图片压缩、解压与压缩、发票助手、划词翻译改为市场按需安装。旧版本用户升级后，如需继续使用这些工具，请从插件市场安装原插件。插件 ID 和数据命名空间保持不变，收敛内置清单不会删除用户数据；已有市场安装副本继续使用，原先仅使用内置副本的用户安装后可继续读取原有数据。

## 原生组件

| 目录 | 平台 | 作用 |
| --- | --- | --- |
| `ZToolsNativeHost32/` | Windows | 加载 32 位 DLL 插件的隔离进程 |
| `ZToolsService/` | Windows | 执行需要管理员权限的受控命令 |
| `ztools-indexer/` | Windows | 文件索引与快速检索 |
| `ztools-uiaccess/` | Windows | 读取其他程序中选中的文本等跨权限操作 |
| `ZToolsPathAccess/` | Windows、macOS | 插件读写用户选定文件时的受控文件访问 |
| `ZToolsMacClipboard/`、`ZToolsMacVision/`、`ZToolsMacAudio/`、`ZToolsMacInputLock/`、`ZToolsMacDns/` | macOS | 剪贴板读写、图片文字识别与系统字体字形绘制、按设备控制音频输入与输出、限时键盘清洁输入拦截、持有系统配置锁的 DNS 修改 |
| `ZToolsMacNative/` | macOS | macOS 原生插件宿主的接口与策略（尚未启用） |

原生组件都作为独立进程运行，通过管道与主进程通信，崩溃不会拖垮主进程。没有编译原生组件时，相关功能不可用，其余功能照常运行。

NativeHost32 与 ZToolsService 只接受清单中登记过的插件和函数。

## 后台资源

窗口隐藏后会逐步释放资源，再次打开时尽量不闪烁：

- **悬浮搜索条**：隐藏 15 秒后降低后台渲染频率并尝试回收内存。再次显示时，先等界面画完第一帧（最多等 150 毫秒）再显示窗口。见 [`launcher-controller.ts`](../electron-client/src/main/windows/launcher-controller.ts) 与 [`frame-sync-manager.ts`](../electron-client/src/main/services/frame-sync-manager.ts)。
- **插件窗口**：隐藏 30 秒后挂起（静音并降低后台渲染）。后台同时最多保留 4 个未挂起的插件窗口，超出时最早隐藏的先挂起。见 [`plugin-window-manager.ts`](../electron-client/src/main/windows/plugin-window-manager.ts)。

改动这些逻辑时，同时保证隐藏、显示交替很快时状态不会错乱。

## 安全基线

- 所有窗口都开启 `contextIsolation`、`sandbox`、`webSecurity`，关闭 `nodeIntegration`。
- 界面和插件拿不到 Node 模块、任意 IPC 通道或原生加载能力，只能调用白名单里的方法。
- 主进程对每个请求独立校验方法、调用方、权限、参数和超时，外部输入一律视为不可信。
- 插件拿不到登录凭据：账号方法只把凭据返回给客户端自己的界面，按发出请求的窗口身份判断，不看请求里自报的身份（开源版没有账号，这些方法始终返回未登录）。
- 插件窗口使用独立的会话。声明式插件和宿主界面运行在同一个渲染上下文里，这一层的安全靠清单权限检查、上架前的源码审核与静态扫描来保证。
