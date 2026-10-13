# ZTools Electron Client

ZTools Electron 客户端固定使用 Electron 43.4.1。Windows 正式构建目标为 `win32-x64`；另有一个必须在 macOS 主机上运行的 Darwin Universal `.app` staging 入口，覆盖 `arm64` 与 Intel `x64`。Staging 尚不等于完整 Mac 发布支持。

## 当前实现与入口

跨平台适配层正在分阶段建设。当前源码已把屏幕/剪贴板、系统信息、native runtime 与窗口生命周期分到 `src/main/platform/`；macOS 使用纯 JavaScript 主流程，不会启动 Windows NativeHost32、Service 或系统托盘。此状态仅表示开发中的适配入口，不代表 Mac 已发布支持；Mac 签名包、系统权限、插件目标安装和真实设备验收仍未完成。

当前主程序的开发、构建和运行入口均位于本仓库。旧 `framework/` 保留为只读行为、资源与 DLL ABI 参考。
父仓库规则见 `AGENTS.md` 和 `.kiro/steering/electron-dev.md`。迁移阶段文档保留当时的任务状态和证据，
当前能力以源码、契约测试与真实运行验证为准，不从旧阶段状态推断发布验收结论。

构建会先执行父仓库 `frontend/` 的真实生产构建，再复制到 `out/assets/web`。preload 仅暴露逐方法 transport，
main 再次校验方法白名单、调用方身份、参数与超时。开发启动命令为 `npm start`，
CDP 调试为 `npm start -- --remote-debugging-port=9222`；正式数据和插件位于
`%APPDATA%\ZTools\Data` 及其 `Plugins` 子目录，`bin/Data/Plugins` 是现有打包输入。

当前已接通配置、窗口、事件、网络、文件、进程、屏幕、剪贴板、LevelDB、插件安装、插件窗口、DLL 插件 Router、触发器和基础系统查询。`plugin_open` 会校验已安装插件清单，以 `ztools://plugins` 加载沙箱化窗口，按 `window` 配置处理尺寸和单实例复用，绑定可信插件身份，并在创建或复用时投递启动参数；更新和卸载前会先关闭目标插件窗口。超级面板读取现有 `super_panel`、`plugin_state.json` 和 `local_apps.json`，使用沙箱化独立窗口并直接启动插件；键盘触发由 `globalShortcut` 管理，鼠标触发由 NativeHost32 的专用 `WH_MOUSE_LL` 线程管理，退出时对称注销和卸钩。普通 DLL 只通过 NativeHost32 调用，随包清单锚定允许的插件、函数和 DLL SHA-256；管理员 DLL 只通过已认证的 ZToolsService 同步调用，不会降级到普通 Host。NativeHost32 支持 Init/GetInfo/同步 Call/异步 Call/结果回调/查询/取消/清理/Destroy；管理员 DLL 异步任务当前明确返回 `NOT_SUPPORTED`。Host 退出会拒绝新调用、取消活动任务、等待调用、按剩余预算调用 `DllPlugin_StopManagedProcesses` 并卸载会话；deadline 耗尽时终止整个隔离 Host，不在线程仍运行时卸载 DLL。Ready Host 意外退出时，待处理请求统一失败为 `NATIVE_HOST_CRASHED`，main 在 60 秒窗口内最多按 250/500/1000ms 重启 3 次，第四次熔断；应用 stopping 会取消待执行重启。Service 从活动用户身份快照取得数据根，通过 Windows 管道身份校验建立连接，不依赖安装密钥文件。Service 命令只接受固定版本二进制封包和受控 ID，具体插件、DLL 和函数仍由特权清单逐项授权，不接受任意路径或通用命令。Service 未安装或未运行时，管理员 DLL 调用会返回 `SERVICE_UNAVAILABLE`。其余高权限命令、Windows 深度能力及更新安装仍按 M3-M6 分阶段启用。

主进程运行日志按天写入 `%APPDATA%\ZTools\Logs\electron-main-YYYY-MM-DD.log`。日志包含启动与退出阶段、各阶段耗时、打包路径、数据与插件目录、NativeHost/Service 状态、插件清单摘要、失败 IPC 方法，以及 renderer 的 warning/error、页面加载失败、preload 错误和进程崩溃信息；不记录 IPC 参数正文。

## 构建

```powershell
npm ci
npm run test:quick
npm run test:plugins
npm run test:full
npm run test:release
npm run package:app:win32:x64
npm run package:win32:x64
```

Mac staging 需要在 macOS 主机上运行，并提供产品已确认的 Bundle ID：

```sh
npm run package:app:darwin:universal -- --app-bundle-id "<已确认的 macOS Bundle ID>" --minimum-os "<已批准最低OS>" --short-version "<已批准三段展示版本>" --build-version "<已批准构建版本>"
```

该命令会先执行 Electron/Frontend 构建，再用 Electron Packager 的 Universal 目标生成 x64、arm64 候选并合并；输出位于 `artifacts/<version>/darwin-universal/ZTools-darwin-universal/ZTools.app`。脚本会保留并检查 LevelDB Universal 原生模块，并对 bundle 中全部 Mach-O 文件运行架构核验。Mac NativeHost/Worker 当前明确关闭：纯 JavaScript staging 写入 `nativeHostMode: disabled`，请求 native catalog/身份或 `--include-native-host` 会在构建前拒绝；verify/sign 也会拒绝出现的 Host/Worker/policy 组。它只生成本地 staging `.app`，不生成 DMG/安装器，也不执行 Developer ID 正式签名或公证；当前仓库还没有 Mac `.icns` 图标。最低 macOS 版本、正式 Bundle ID 和分发渠道仍待确认，因此 staging 不能作为可分发版本。

`package:app:win32:x64` 只生成 `ZTools-win32-x64` 应用目录；`package:win32:x64` 在此基础上构建 Electron 版 `ZToolsService.exe`，再复用原 Delphi 引导器生成离线安装包。
最终输出为 `artifacts/<version>/win32-x64/ZTools-<version>-win32-x64.exe` 及同名 `.sha256` 文件，不使用 Electron Packager 自带安装器。
应用进程、Electron DLL 与 classic-level binding 均为 x64。NativeHost32 与 ZToolsService、原 Setup/Uninstall 引导器，以及由原 Setup stub 生成的最终离线安装包仍是 x86 PE；引导器负责安装 x64 应用 payload。x64 Electron 主进程不在 Win10 x86 上运行；x64 Windows 上的 x86 Host/Service 在 WoW64 中运行，`wow64OnX64` 描述主进程，值为 `false`。

开发运行时组装会为仍依赖旧 ABI 的插件复制 `Data\Libraries` 公共库；打包跳过这些插件库，
仅将仍由 SDK 调用的旧版
`ImagePlugin`、`ScreenCapturePlugin`、`SQLitePlugin` 和 `ZipPlugin` 放入
`resources\CommonPlugins`；新版客户端已实现的 `SystemToolsPlugin` 不再随包引入。
这些公共 DLL 及其依赖仍从 `bin\CommonPlugins` 的已有构建产物复制，缺失时会报错。

应用目录只保留 Electron 的 `en-US.pak` 和 `zh-CN.pak` 语言包，并排除测试说明、依赖开发文档、
源码映射和编译中间文件。`out\runtime` 仅作为构建时的运行树和测试输入，`Data` 目录不会复制到
应用目录或最终安装包；发布版业务数据仍由 `%APPDATA%\ZTools\Data` 管理。Chromium/Electron
运行库、GPU 回退文件和许可证文件继续保留。

`npm run start` 会生成根仓库 `out\dev-runtime`，并使用其 `Data` 目录启动本地测试客户端；它不会读取、
删除或覆盖旧版 `bin\Data`。

`test:plugins` 固定区分纯 JS `todo`、普通权限 DLL `clipboard-manager` 和管理员权限 DLL
`context-menu`。流程会执行代表插件业务测试与独立生产构建，在真实 Electron 进程中通过
`ztools://plugins` 加载三类页面并验证 SDK/LevelDB 和插件身份隔离，再分别通过
NativeHost32 调用普通 x86 DLL、通过 Service 测试链调用管理员 DLL。完整阶段、失败语义和
系统发布矩阵见 [TESTING.md](TESTING.md)。

`build:native-host32` 固定使用 Visual Studio 2022 的 Win32 工具链，输出 `out/native/win32-ia32/ZToolsNativeHost32.exe`。`test:native-host32` 会从相邻 `DLLPlugins` 源码构建生产插件样本和公共 ABI 测试，再额外构建不参与打包的 x86 ABI fixture；测试执行真实子进程握手、负向认证/协议/帧长向量、清单摘要、路径逃逸、junction、DLL 篡改、PE 架构、函数越权，并结合真实 `BatchRenamePlugin.dll` 验证同步、Async 直返与 Callback 形态，结合真实 `ScreenCapturePlugin.dll/.exe` 验证延迟 Callback 和受管进程清理，再覆盖取消、CoTaskMem 结果、任务归属、清理后静默、卸载/重载、重复 stop、阻塞调用的有界 shutdown、真实 PID 崩溃、限速重启、熔断和 stopping 互斥。

客户端从程序资源目录 `resources/native/.ztools-native-host.xml` 读取可信清单，不再向用户插件目录复制清单。公共 DLL 固定从 `resources/CommonPlugins` 加载，私有 DLL 仍从用户 `Data/Plugins` 加载；两种根目录由主进程分别传给 NativeHost，公共 DLL 缺失时不回退到用户目录。开发启动使用 `out/dev-runtime/resources`，正式包使用安装目录的 `resources`，均不由 `--data-root` 改写公共 DLL 来源。旧 Data 中遗留的 CommonPlugins 不自动删除、不再加载。公共 DLL 的程序文件随应用安装、更新、卸载；业务输出仍应写到用户数据或明确选择的输出目录。

清单必须是版本 1 的严格 XML，按 `plugin/dll/function` 声明相对 DLL 路径、SHA-256、`x86` 架构和允许函数；未知元素、命名空间、重复标识、绝对路径、reparse 路径和摘要不符均拒绝。清单目录和摘要只能由 Electron main 的受信安装链在创建 Host 时注入，不能来自 renderer 或普通 `plugin.json`。独立 NativeHost 测试未指定清单目录时仍使用其测试插件根；公共 DLL 始终要求显式资源根。

截图公共 DLL 的 CaptureScreen/CaptureWindow/CaptureRegion 未指定 outputDir 时，宿主在同步、异步、回调三条调用链均注入调用方缓存目录，避免默认写到程序资源旁。显式输出目录保持调用方参数。`npm run test:common-dll-resources` 编译并验证双根加载、清单隔离、无用户目录回退和篡改/重解析点拒绝；它也纳入 `test:native-host32`。可向 `node scripts/test-common-dll-resources.mjs <绝对resources目录>` 传入组装或应用包目录，额外验证四个实际公共 DLL 的加载。

`build:ztools-service` 生成 `out/native/service-win32-ia32/ZToolsService.exe`，并拒绝非 x86 PE；`test:ztools-service` 额外验证服务生命周期、重复停止、named pipe 单实例、最小 SID ACL、客户端 PID/SessionId 身份、有界帧、双向 HMAC-SHA256 握手、逐帧 MAC、严格递增 request ID、管理员 DLL 清单的 10 个正负向量、13 个命令/策略向量，以及 System32-only 正反加载向量。Service 不监听旧 TCP 端口，客户端和服务端均不再读取安装密钥文件。生产连接依赖 Windows named pipe 的 SID ACL、PID/SessionId 校验；每次连接使用随机数生成会话帧校验材料，保留逐帧校验和递增 request ID。该握手不再提供基于安装密钥的对端认证。升级时需要同时更新客户端与 ZToolsService.exe。

`npm run prepare:debug-service` 生成并校验 `out/debug-service/`，包含 x86 `ZToolsService.exe`、插件 DLL/辅助进程镜像和 `debug-service.json`。可使用 `ZToolsService.exe --console --data-root <该目录下的Data>` 加载调试插件。

Service 默认使用当前活动控制台用户的 `%APPDATA%\ZTools\Data`（`--console` 使用进程用户）。支持 `--data-root <目录>` 和 `--data-root=<目录>` 覆盖 Data 根目录，控制台模式和 Windows 服务 ImagePath 参数均有效。目录必须存在，重复、空值或无效目录会使启动失败；相对路径按进程工作目录解析，Windows 服务配置建议使用绝对路径。用户身份和命名管道 ACL 仍按原有逻辑确定。服务递归搜索 `<data-root>\Plugins\<pluginId>` 中唯一的 `<dllId>.dll`，校验目录边界、reparse 路径、最终句柄路径及 x86 PE；当前实现不读取旧版清单、哈希或 HKLM 摘要。DLL 通过绝对路径及 `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_SYSTEM32)` 加载，普通同步调用执行 `Init -> GetInfo -> Call -> CoTaskMemFree -> Destroy -> FreeLibrary`。

开发时先在管理员终端停止已安装的 `ZToolsPrivilegedService`，再运行以下命令（工作目录为 `electron-client`），看到 ready 后在另一终端运行 `npm start`：

```powershell
npm run build:ztools-service
.\out\native\service-win32-ia32\ZToolsService.exe --console --data-root ..\out\dev-runtime\Data
```

`out/dev-runtime/Data` 需已通过开发运行时组装生成。服务与客户端各自设置 Data 目录，客户端参数不会自动传给服务。`npm run test:service-data-root` 验证参数错误、SCM 入口、带中文/空格及相对路径、指定目录内的真实 DLL 加载；运行该测试前需停止其他服务实例，测试只结束自己创建的进程。

`verify:artifacts` 检查应用 manifest 目标、语言包、ASAR 内容、classic-level 的 win32-x64 addon、安装器来源哈希、最终安装包校验和及现有 Authenticode 签名门禁。
应用目录中除 `resources/native/ZToolsNativeHost32.exe` 与 `ZToolsService.exe` 外，所有 `.exe`、`.dll`、`.node` 都必须是 x64 PE；这两个隔离进程必须为 x86。最终离线安装包及原 Setup/Uninstall 引导器按原 Delphi 引导职责核验为 x86。未登记的产物路径、架构错配、脏工作区或无效签名都会使验证失败。

本地需要保留多次候选包时，可临时设置 `ZTOOLS_BUILD_QUALIFIER`（仅允许小写字母、数字和连字符）。默认不设置，发布目录仍固定为 `artifacts/<version>/win32-x64`。

## 仓库边界

- `framework/` 只作为行为与 DLL ABI 参考，不修改。
- Framework 转换代码放在本仓库的 `native/`；`framework/` 不承载 Electron 迁移提交。
- Renderer 复用父仓库 `frontend/` 的真实生产构建，不复制页面源码。

## macOS 第一期入口

`npm run start:mac -- --help` 显示参数；Mac 上执行 `npm run start:mac` 调用公共构建并启动安装的 Electron，不运行 Windows native 构建。可按需传 `--remote-debugging-port=9222`；只接受 1024–65535 端口，不默认开放调试。Windows 调用返回 NOT_RUN 和非零退出码。该入口使用既有 Mac 开发数据根；测试应使用专用测试账户，未提供改变生产 userData 的旁路。

`npm run test:mac:contracts` 可在 Windows 运行共享单元/契约和 Mac 启动、Universal staging、Mach-O verifier 的依赖注入测试。Mac NativeHost load gate 在同对象身份无法于 initializer 前证明时明确返回 `SAME_OBJECT_LOAD_UNPROVEN`，不会调用 `dlopen`；synthetic ABI 动态装载不代表生产组件支持。这只证明第一期源码与注入合同，真实 Mac 启动、native 构建、权限、签名和安装测试均待第二期。

单元测试默认串行；设置 `ZTOOLS_TEST_CONCURRENCY=2`（允许1–32）控制Node测试文件并发，资源故障时使用1。`test:quick/plugins/full/release` 每次保存 `out-test/test-reports/<runId>/report.json` 和阶段日志，latest文件仅作索引。隔离Renderer可用 `node scripts/test-plugin-renderers.mjs --plugin-root <绝对测试包目录>`，不会部署或安装插件，也不能代替正式App测试。

### Mac 正常App预检与只读集成（部分实现）

在 `electron-client/` 执行：

```text
npm run test:mac:preflight -- --help
npm run test:mac:integration -- --list
npm run test:mac:preflight -- --app /absolute/ZTools.app --output /absolute/reports --bundle-id <approved-id> --minimum-os <approved-version> --expect-process-arch arm64
npm run test:mac:integration -- --app /absolute/ZTools.app --output /absolute/reports --bundle-id <approved-id> --minimum-os <approved-version> --expect-process-arch arm64 --case M01
```

集成入口实现M01/M03只读SDK子集，以及M05能力/revision、M06显示器坐标/缩放只读采集；M05/M06人工部分保留MANUAL_PENDING、非零退出。M02启动/退出/重启与M08本runner进程只读基线已接线；M13筛选13个已准备插件的正常安装页面基线已接线，完整业务/攻击矩阵尚未完成。预检成功不代表实际Electron启动；集成从真实App启动并通过正常ztools页面查询SDK。请使用专用测试账户，关闭该账户已有App实例以避免单实例转发；runner不修改生产数据根、不关闭安全设置、不重置TCC，退出只处理自己启动的PID。Windows真实模式返回NOT_RUN/退出1，所有报告有独立runId。

### Mac 签名原型（第二期执行）

`npm run sign:mac:prototype -- --help` 列出全部输入，包含已批准Bundle ID/最低OS、Developer ID Application身份、已保存的keychain-profile、App外的main/helper entitlements与新的App外输出目录。原型先审计Universal及每个Mach-O切片的部署下限，拒绝更高部署下限；随后嵌套签名→App签名→严格验证→公证→staple→Gatekeeper→重建最终ZIP。不给内置凭据；原型拒绝disable-library-validation、get-task-allow和未决App Sandbox，并要求allow-jit。源App会被签名及staple，保留独立未签名staging用于重试；步骤失败即停止，修复后用新输出目录重跑。

只分发最终 `ZTools-notarized.zip`；`notary-submission.zip`是staple前提交材料。脚本成功仅表示签名原型工具链通过，仍需两个CPU切片、下载quarantine、权限、安装升级等验收。命令依据：[Apple公证工作流](https://developer.apple.com/documentation/Security/customizing-the-notarization-workflow)、[Apple发行包说明](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)。

独立最低OS审计：`node scripts/verify-macos-universal.mjs /absolute/ZTools.app --minimum-os <approved-version>`。省略参数时仅执行既有Universal/安全链接审计，不证明最低OS门禁通过。

Windows生产DLL测试需要QtMsBuild：`build-native-test-plugins.ps1` 默认从当前 `%LOCALAPPDATA%/QtMsBuild`读取，可显式传 `-QtMsBuildPath`。缺`qt.targets`会在构建前失败，不会跳过截图DLL测试；NativeHost32单独编译成功不代表完整native测试通过。


### Mac 文件剪贴板原生 helper（第一期源码已接线）

`native/ZToolsMacClipboard/main.mm` 使用 AppKit `NSPasteboard` 读写本地文件 URL，协议 version=1；不读取文件内容、不授予文件权限、不启动其他进程。现有 ClipboardService 继续先校验调用者和路径权限。helper 缺失报告 `NATIVE_HOST_UNAVAILABLE`；Mac `clipboard.files.read` 的 implementation 为 `unavailable`，存在可执行 helper 时为 `supported`，与调用者授权独立。

Mac 开发构建使用已批准的最低 OS（下面的占位参数必须替换）：

```powershell
npm run build:native:mac:clipboard -- --output <electron-client绝对路径>/out/mac-clipboard-native --minimum-os <已批准最低OS> --short-version <已批准三段展示版本> --build-version <已批准构建版本>
npm run test:native:mac:clipboard -- --executable <上述输出>/native/ZToolsMacClipboard --arch arm64
npm run test:native:mac:clipboard -- --executable <上述输出>/native/ZToolsMacClipboard --arch x64
```

构建目录必须不存在；保留或归档上次构建，入口不覆盖已有文件。Intel 没有 arm64 执行环境时，arm64 自测移到 Apple Silicon；x64 在 Apple Silicon 需要 Rosetta，结果不能代替 Intel 真机验收。原生自测只验证输入边界，不访问或改写系统剪贴板；Finder 粘贴、多项/Unicode/空格、空剪贴板、取消和实际 ClipboardService 链路在 M07 第二期执行。

Universal staging 现在必须同时传入最低 OS：

```powershell
npm run package:app:darwin:universal -- --app-bundle-id <已批准Bundle-ID> --minimum-os <已批准最低OS> --short-version <已批准三段展示版本> --build-version <已批准构建版本>
```

staging 编译两个 helper 切片、lipo 合并并逐切片核部署下限，将文件以 0755 放在 `Contents/Resources/native/ZToolsMacClipboard`；App 的 `LSMinimumSystemVersion` 同步显式策略，最终 Universal 审计包括 helper。NativeHost/Worker/policy 不会进入 staging，除非未来先补成可证明的加载前对象绑定；当前没有签名或启动 NativeGroup 的成功路径。已有由内到外签名原型会纳入实际出现的 Mach-O。Mac 实际编译/自测/签名未在 Windows 执行。接口依据 [Apple NSPasteboard 文档](https://developer.apple.com/documentation/appkit/nspasteboard/)。


### 合成 Mac 测试夹具

`npm run test:mac:fixtures -- --output <全新绝对目录>` 在 Windows/Mac 创建16份合成文件，包括空/Unicode/空格路径、范围外哨兵、Chrome Bookmarks/History、Firefox places.sqlite、损坏SQLite、聊天测试目录与测试hosts；从不发现或读取真实用户profile/vault/聊天数据。创建入口拒绝已存在目录；`--verify <目录>` 校验runId、真实根路径、每个文件SHA-256和越界。所有创建文件保留供用例使用，脚本不递归删除目录。`data/migration-expectations.json`只是期望数据，不能当作旧加密vault/LevelDB验收。SQLite通过Node内置模块创建，Node22.12入口带`--experimental-sqlite`；参见[Node22.12 SQLite文档](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html)。

`macos-loopback-fixtures.mjs`导出`startLoopbackFixtures()`，仅绑定127.0.0.1/::1的随机TCP/UDP端口，返回本run端点/ownedPid与`stop()`；测试需在finally关闭。IPv6不可用明确NOT_RUN，不伪装空列表成功。停止销毁本run客户端并关闭本run socket，不枚举或终止其它进程。

Mac可执行`npm run test:mac:fixtures:apfs -- --output <全新绝对run目录>`：创建两份256MiB稀疏映像（APFS与Case-sensitive APFS），在本run挂载点挂载并验证hdiutil image映射、diskutil VolumeUUID/DeviceNode/MountPoint/APFS类型；实际文件创建验证大小写行为，准备上面夹具后卸载。`withMacApfsFixtures()`支持在两卷仍挂载时执行case，回调必须返回`{status:'PASS'}`才通过；finally按映像路径/UUID/挂载点再次验身份后卸载，并核挂载点已消失。没有sudo/物理磁盘格式化/强制卸载/全局TCC操作；遇到身份变化拒绝卸载，附加结果不确定会在`apfs-run.json`记录ATTACH_OUTCOME_UNKNOWN，留待人工核对。映像与报告始终保留，不删除用户文件。APFS原生执行只在第二期；Windows注入测试不验证hdiutil实际行为。格式依据[Apple磁盘映像说明](https://support.apple.com/en-gb/guide/disk-utility/dskutl11888/mac)。


`test:mac:integration -- --case M05`只调用三种实际`sys.getCapability()`，间隔采样并检查target/架构、独立授权轴与revision单调性；不会调用capture、申请权限或执行hibernate。`--case M06`通过实际screen SDK采集all/primary/cursor/nearest/matching，检查负坐标、缩放、显示器唯一性、主屏一致性等。正常App身份验证仍为前置。两组基线通过时保存`checks: PASS`和`status: MANUAL_PENDING`，进程正常清理后CLI也返回MANUAL_PENDING/退出1，直到完整人工步骤实现和执行；不会按完整M05/M06计入发行通过。`--list`现列M01/M02/M03/M05/M06/M08/M13，默认不带case仍只跑M01/M03。

`test:mac:contracts`已复用统一workflow runner：lint、单元、Mac脚本三个阶段都有独立日志与runId不可覆盖报告，报告标记`phase:1`和`scope:source-and-injected-contracts`。索引是`out-test/test-reports/mac-contracts-latest.json`；真实历史报告在其runId目录，不能把phase1报告当成Mac原生/真机/发行报告。APFS入口支持SIGINT/SIGTERM转换为AbortSignal；执行回调应遵守传入signal，取消后核owned卷身份再卸载，挂载结果不确定仍保留journal供人工核对。

Mac源码门禁同时运行`plugins/create-plugin/scripts/`中的已准备插件runner直接合同（计算器、日历、中文数字、颜色、加解密、汇率、文本格式、时间戳、待办与翻译），不启动正常App或进行真实网络/系统剪贴板操作。插件Vitest业务与真实Electron/CDP仍按各任务卡独立执行；通过这些合同不代表业务全表或Mac设备通过。固定`.build-runs`产物校验保留为独立入口，在`plugins/create-plugin`运行`node --test scripts/test-chinese-number-converter-build-evidence.mjs scripts/test-crypto-tool-build-evidence.mjs scripts/test-text-formatter-build-evidence.mjs`，要求对应已记录包存在并核原哈希；干净源码门禁不依赖这些本机ignored产物。


Mac原生版本需明确提供`--short-version`（三段整数）和`--build-version`（一至三段整数），不会自动截断现有四段版本。`ztools-bundle-versions.json`记录SDK/更新逻辑版本、两种native版本及`nativeHostMode: disabled`，preflight从app.asar读取实际package.json核对，runtime target marker契约保持不变。参见[Apple展示版本](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)和[构建版本](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)。`package:app:darwin:universal -- --help`可在Windows查看入口而不执行native构建。

`test:mac:integration -- --case M02`进行两轮正常启动/SDK快照/有界退出，不自动重放任务；完整生命周期步骤仍MANUAL_PENDING。集成启动明确使用`/usr/bin/arch -arm64|-x86_64`选择期望slice，Rosetta未安装不伪报x64通过。`--case M08`采集本runner进程的list/info/exists/find与fieldAvailability，并创建/关闭私有TCP/UDP IPv4/IPv6回环夹具；不会终止任意进程或变更网络规则。

`test:mac:integration -- --case M13 --plugin todo`通过当前主界面真实SDK打开正常安装的插件，核实际ztools页面、SDK/进程slice/隔离/DOM及错误合同，最后关闭窗口。`--list`列13个可选G01插件，必须先在专用测试账户经正常安装链装入对应Mac测试包；脚本不部署源码旁副本。基线成功仍返回MANUAL_PENDING/退出1，因为业务成功、错误、取消、重启持久化和最终两架构验收尚未补齐。其它插件拒绝为PLUGIN_BASELINE_NOT_PREPARED。


`test:mac:fixtures:data -- --output <全新绝对目录>`编译维护的legacy secure实现，生成真实LevelDB和旧AES-GCM格式合成字段；`--verify <owned目录>`先核owner/哈希，复制本run新副本再打开/解密，源夹具与副本保留。不会读或迁移现有vault。样本采用classic-level无压缩legacy布局，Delphi压缩SST、新安全格式/Keychain和最终App数据迁移仍待完成。password维护源码的向量测试入口是`cd plugins/create-plugin && npm run test:unit:plugin -- password`。

`test:native:portable:clipboard -- --cmake <已安装CMake绝对路径>`在Windows VS2022 x64或Mac默认C++工具链编译实际共享路径/数量/累积字节校验核心并执行18项边界测试，保留独占runId目录和阶段日志。Windows通过只证明C++核心；`main.mm`的AppKit bridge与Universal两slice仍须Mac编译。NSPasteboard无匹配项返回空数组，读取错误才返回nil，源码保持这一区分，见[Apple readObjects](https://developer.apple.com/documentation/appkit/nspasteboard/readobjects(forclasses:options:))。

`test:mac:release -- --help`列出真实发行审计参数。`--template <新绝对index.json>`生成57项pending策略和完整报告合同，返回MANUAL_PENDING/退出1；模板不是执行证据。真正审计命令需要`--app --output --bundle-id --minimum-os --team-id --expect-process-arch`，并用`--evidence <绝对index.json>`提供同目录报告文件清单。实际Darwin才运行Universal/最低OS、批准Team/Developer ID/hardened runtime/签名entitlements、两slice CDHash、stapler和Gatekeeper。完整case报告必须phase2、scope=complete-case、绑定相同bundle/逻辑版本/CDHash且使用相应物理OS与native进程架构；每个case必需check ID列在模板中。插件supported/partial必须明确features并逐feature提供成功/错误/取消/重启两架构证据；Windows-only/unsupported须两架构确定拒绝。phase1、baseline、Rosetta替代Intel、FAIL、缺项或未清理不会通过。审计只汇总已有观察，不能证明尚未执行的系统/设备/业务步骤，也不会自动发布。

### T07原生路径访问开发验证

`npm run test:native:path-access -- --cmake <绝对CMake路径>`构建ZToolsPathAccess核心/broker并运行独占合成夹具和真实Node→grant→broker读取契约，报告在out-test/path-access/<UUID>，保留夹具和阶段日志。Darwin须另传已批准`--minimum-os`和`--expect-process-arch arm64|x64`；只在Mac编译Universal及运行实际slice，Windows结果不能代替Mac验收。

目录有write权时可deriveSave相对已有子目录中的输出槽，原生复制目录HANDLE/FD并逐段核身份，不经绝对路径重开；只读/list授权不得派生写权，子授权继承owner/有效期，父撤销或关闭同时撤销全部派生授权。入口每次在独占run目录编译bridge JS并记SHA256，避免全局out-test重编译改变历史证据。

目录有read权时可deriveRead得到精确文件引用，describe经保留句柄返回size/lastModifiedMs，不返回路径。可信owner生命周期端口可连接WindowRegistry关闭事件（生产bootstrap已挂接reference runtime，正式SDK2及全部消费者仍待迁移）；排队等待、启动及RPC总等待有界，取消排队请求也会使本broker代际失效。Windows测试可显式加`--expect-native-arch ia32`编译及运行测试用x86核心/broker并审计PE；这不增加x86应用发行目标，也不替代Win10物理系统矩阵。

`npm run build:native:mac:path-access -- --output <全新绝对目录> --minimum-os <已批准版本>`只在Darwin经xcrun构建两slice后lipo并审计部署下限；Mac开发解析器只读取`out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker`，因此可用该精确目录作为`--output`。Mac Universal staging使用独占的`path-access-native-build`，复制broker到`Contents/Resources/native/ZToolsPathAccessBroker`，并要求它与剪贴板、Vision helper一起通过最终Mach-O双架构审计后才生成target marker。Windows注入测试不能代替Mac编译/签名。

维护源码在native/ZToolsPathAccess、platform/path-access.ts、platform/native-path-access.ts及services/path-grant-service.ts。当前实现pin/read/list/readRange/save/release：目录只返回相对名称与有界元数据，list与read权独立；readRange支持安全整数offset及最多16MiB单片段，大文件不用整体读取；Mac保留合法POSIX文件名字节，不按Windows规则禁止冒号、反斜杠和换行。save固定已有父目录与basename输出槽，默认不覆盖，明确replace才原子替换；单次16MiB，先独占临时文件写入/刷盘再提交，Windows相对NtSetInformationFile、Mac renameatx_np源码；连接中断/提交未确认返回FILE_WRITE_OUTCOME_UNKNOWN，不能保证回滚。失败暂存内容经自身句柄清空，空名称保留；流式写入与加密恢复journal已实现，生产bootstrap已通过受控helper resolver及有界safeStorage初始化挂接reference runtime；恢复UI与名称处置仍待完成。正常宿主合约仍为1，全部SDK/协议/消费者迁移完成前，正式引用授权链仍未完成验收。broker是有界私有协议及崩溃/取消隔离，不代表OS权限沙箱。

copy以64KiB分块将精确FileRef复制到SaveRef，最多2GiB，源不删除，提交前检测身份/大小/修改时间变化。remove只允许write目录内文件或空目录；move将该目录内文件原子移入SaveRef，只允许同卷、默认不覆盖，跨卷返回FILE_CROSS_DEVICE，无复制再删除降级。两者授权当前子名称槽，拒绝FileRef直接删除/移动、穿越、链接/硬链接和非空目录；断线或迟到提交仍返回结果未确认。测试流程为每个run创建独占临时目录和npm缓存，避免占用系统盘；保留证据，未运行Mac原生验收。

Windows独立helper构建入口：`npm run build:native:win:path-access -- --cmake <绝对CMake路径> --output <全新绝对目录>`。只生成应用基线x64 broker，检查PE machine并记录SHA256；开发运行使用精确输出根`out/native/win32-x64`，helper位于`bin/ZToolsPathAccessBroker.exe`。普通`npm run build`不隐式依赖CMake；Windows打包只从该受控输出位置复核普通文件、链接与x64 PE后复制到`resources/native/ZToolsPathAccessBroker.exe`，没有构建结果时保持文件broker unavailable。Mac解析仅查Mac Universal helper，绝不回退到该Windows文件。测试用ia32不作为生产输出。生产使用的OwnedPathAccessProvider为每个可信WebContents保留独立broker代际，取消/关闭一个owner不会使其他owner的句柄失效；最多32并发owner、service全局256 grant，失败退出必须向上报告。生产bootstrap/SDK消费状态以其对应F03证据为准。

streamSave支持已知完整长度或显式未知长度，native按64KiB追加、最多2GiB并在Commit才提交；native/adapter/service分别限制8并发写入。等待producer有界可取消，短流/超量/取消中止，Commit之后ACK丢失不宣称回滚。下载持久化helper限制1GiB并处理chunked/压缩Fetch长度；NetworkService新增内部downloadRef/uploadRef，复用现有session/URL/redirect政策，上传使用FileRef读权与读取前后身份/大小/修改时间检查，无raw path返回。这些内部入口尚未注册SDK/IPC，旧生产消费者迁移仍待完成。

createDirectory在write目录grant的已有父目录下原生open-if/mkdirat创建一个目录，返回created/existing，拒绝链接、越界与无写权；递归编排尚待实现。失败staging通过保留的精确句柄清空内容，保留空名称供journal审计；committed/unknown状态不截断输出，失败释放返回FILE_STAGING_RETAINED。RecoveryProof与加密journal已实现，生产bootstrap已挂接，正式SDK2消费/恢复UI/名称处置仍待完成，不以basename检查后删除冒充原子inode删除。

恢复日志源码位于platform/path-write-journal*.ts：独立main原生store，以AES-256-GCM认证完整日志、每快照随机密钥经Electron43.4.1异步safeStorage封装，初始化只在app.ready后；无明文或同步Keychain降级。可注入adapter保存/复制先持久化intent、原生proof、提交字节数/SHA256，成功删本条、未知保留；256条/4MiB限额，损坏/密钥不可用/日志提交未确认均阻止继续写入。observeWrite只读核验祖先和staging/目标对象ID，不自动删除、截断或重放；committed-object仅为对象观察，未确认业务内容时不提升成成功。Windows合成密钥测试不代替真实DPAPI/Keychain验收。

Windows真实OS密钥封装开发验证：npm run test:win:path-journal:sealing，使用固定Electron43.4.1/x64与独占合成user-data，运行异步safeStorage封装随机日志密钥、AES-GCM读回和篡改拒绝；报告在out-test/path-journal-sealing/<UUID>，保留源码/EXE/编译模块哈希。只证明隔离Electron API，不代表生产ZTools调用链、Mac Keychain或发布通过。

文件引用v2维护源码为contracts/path-reference.ts及services/anchored-file-system-service.ts：只接grant ID与相对路径，默认禁止覆盖，严格拒绝legacy路径及caller自报身份/权利；保存、复制等最终仍经PathGrantService与原生对象执行。该门面已做Windows真实native验证，生产Router/SDK与全部消费者仍须一次完整迁移；当前SDK_CONTRACT仍1，新常量不代表SDK2已启用。

.ztools-save-为内部暂存保留名称前缀（包括大小写变体）：公开pin/相对派生/读取/变更拒绝，目录列表隐藏；不会自动删除已有同前缀文件。DirectoryChild/deriveDirectory复制已有父对象链并绑定实际子目录，继承parent rights/owner/TTL/撤销；可以作为受控当前目录引用，不返回原生路径，递归编排与生产SDK接线仍待完成。

引用对话框维护源码为contracts/path-dialog.ts、services/path-reference-dialogs.ts及platform/electron-reference-dialog.ts；WindowService有可注入showReferenceDialog入口，但bootstrap/Router/SDK尚未启用。仅可信原生选择可以创建引用，folder默认只读/列目录，显式read-write请求才写；标题显示授权范围，取消/窗口销毁不授权，多选部分失败释放既有引用，返回无raw path。现有单元验证为native UI注入，不替代实际系统选择器/正常App验收。
日志另外限制未解决暂存预留总4GiB（未知长度按2GiB/条预留），成功确认后释放预算；实际对象名保护与本机8.3别名拒绝已验证；本卷所测Unicode别名不存在，Mac卷实际验证、恢复UI与生产接线仍待完成。

platform/path-access-runtime.ts组装日志专用原生根/独立broker、恢复检查和各owner的journal-enabled访问进程；日志损坏先拒绝初始化，退出按取消writer→有界排空journal→停止store顺序，队列最多256。services/path-write-recovery-service.ts仅为主窗口提供脱敏只读恢复信息，committed-object仍标businessResult=unconfirmed，不重放或删除；上述模块尚未启用生产bootstrap/Router/恢复UI。Mac FlushFile采用F_FULLFSYNC并检查失败，设备与APFS实际表现留待第二期。

services/reference-file-drop-service.ts为引用契约的私有拖放接收源码：重复核真实注册窗口/插件实例，以原生pin和metadata授予只读引用，限100项/512MiB单项/2GiB总量及8全局/2每窗口请求；异常/交付失败清理未交付引用。尚未替换生产legacy FileDropService/preload事件与插件SDK消费者。grant/引用文件门面/对话框可接可信请求AbortSignal，取消拒绝迟到结果并清理未交付授权，实际正常IPC与OS chooser行为仍待生产验证。

原生路径 broker 的 opcode21 在同一次HANDLE/FD打开中分类文件或目录。`ReferenceClipboardFilesService`提供只读引用和按owner独立授权的事件；`EventService.publishHostToOwner`只投当前订阅窗口实例，ClipboardService可注入该服务。相关测试由`test:mac:contracts`和`test:native:path-access`运行；Windows原生测试的剪贴板选择与事件registry是合成注入，生产bootstrap/SDK和复制到剪贴板消费者仍未迁移。

`ReferenceDirectoryLocations`将SDK当前目录保存为owner目录引用；`ReferenceCacheService`只接可信main目录provider，在原生grant内读写缓存并为生成文件返回FileRef。`ScreenService.captureReference`复用现有采集逻辑后经该缓存保存，生产Router/SDK尚未启用新合同。缓存单次16MiB、写缓冲总64MiB、全局8/每owner2并发；提交后的交付失败不宣称回滚。目录位置不是原生进程cwd实现。

ClipboardService的`copyTextReference`/`readImageReference`源码只消费FileRef或有界直接数据，大图片经引用缓存返回FileRef；严格拒绝旧临时路径。测试入口不变，生产Router/SDK尚未切换。Windows集成夹具的OS采集明确为注入，原生保存/读取及owner拒绝是真实执行。

contracts/reference-transport.ts、preload/reference-transport.ts与main/ipc/reference-endpoint.ts是SDK2逐方法调用/取消和可信身份检查维护源码；reference-file-handlers.ts接引用门面/缓存/目录位置。维护SDK的ReferenceTransport取消后等待Main实际结果，不能以本地超时宣称写入回滚。test:native:path-access运行合成VM SDK→固定preload→Main handler→真实Windows native链，报告包含SDK源码哈希；这不是正常Electron页面或Mac真机测试，生产SDK1/Router仍待所有消费者完整迁移后切换。

platform/reference-cache-roots.ts提供Main私有缓存根factory，配置数据根经原生pin后按可信owner/plugin实例创建缓存链，不向Renderer投基础目录或中间grant；32owner及有界退出。test:native:path-access验证隔离main/plugin命名空间和停止后只撤销引用、不删除缓存内容；正常bootstrap仍未启用。

main/ipc/reference-producer-handlers.ts接引用对话框/剪贴板/截图，SDK维护源码api/file-producers-reference.js提供对应引用返回类型及校验。test:native:path-access的VM producer链只注入OS数据采集，保存/读取经真实native；生产client/preload/Router尚未切换，clipboard文件复制/粘贴等消费者继续实施。

main/ipc/reference-network-handlers.ts与SDK api/network-reference.js接有界SaveRef下载/FileRef上传，参数/headers/超时严格校验，保留原生unknown及retained-staging；test:native:path-access使用owned loopback HTTP验证维护SDK到真实native。正常生产SDK/Router尚未切换。

引用源码组合入口为 `src/main/platform/reference-file-runtime.ts`，统一 owner 生命周期与请求/拖放排空、缓存根和 native/journal 关闭。该源码入口未激活生产 SDK2；Windows 注入与原生文件夹具通过不等于正常 App 或 Mac 真机验收。

`test:native:path-access` 还构建/运行 `ZToolsPathAccessNamesTest`，覆盖同一 retained HANDLE/FD 的大小写和 NFC/NFD 名字节校验；Windows 与 Mac 使用相同维护源码，记录实际卷的大小写/Unicode 别名观察。Windows NT 打开参数不能独自证明精确命名，`OpenUserChild` 对该已打开对象的实际名字节与请求 segment 作精确比较，不再次按路径查询。

第二期 Mac 命名矩阵入口为 `npm run test:mac:path-names:apfs -- --native-test <test:native:path-access报告output/bin/ZToolsPathAccessNamesTest的绝对路径> --minimum-os <已批准版本> --expect-process-arch arm64|x64 --output <全新绝对目录>`。先运行现有 `test:native:path-access` 构建 Universal 测试二进制；新入口核双slice/部署下限/执行位/哈希，复用 owned APFS 两卷夹具，逐卷运行实际 C++ 命名校验并核观测的大小写类型，保留执行日志/映像与报告。该入口在 Windows 提前输出 `NOT_RUN/DARWIN_REQUIRED` 并以非零退出；源码注入测试纳入 `test:mac:contracts`。一次只执行显式选择的 process slice，两个 CPU 的最终执行证据仍分别补齐，不是发行验收。

逐插件源码/用例状态入口为 `npm run test:mac:coverage -- --output <全新绝对JSON路径>`：同时读取普通和React插件目录，记录57项分组/依赖、manifest与测试文件哈希、Mxx必需检查及逐插件成功/错误/取消/重启ID。只验证覆盖盘点，不执行插件业务；13份Mac目标声明不代表完整实现。报告保留 `phase1Complete:false`、`releaseAcceptance:false`，输出拒绝覆盖旧证据。

Windows 图片基础功能验证入口：在 `electron-client/` 执行 `npm run test:win:reference:images -- --broker <test:native:path-access 产出的 ZToolsPathAccessBroker.exe 绝对路径>`，隔离 Electron 实际解码/转换/缩放/裁剪/旋转/翻转/压缩并贯通引用 SDK；报告保留于 `out-test/reference-images/<runId>/`。这不代表生产 SDK 2 启用或 Mac 实际执行。

共享图片/Base64 开发验证：Windows 入口 `test:win:reference:images -- --broker <原生测试产出的 broker 绝对路径>`；Mac 入口 `test:mac:reference:images -- --broker <Universal broker 绝对路径> --minimum-os <已批准版本> --expect-process-arch arm64|x64`。两者复用隔离 Electron 的真实编解码/原生文件引用夹具；Mac 入口在 Windows 返回 NOT_RUN，不执行原生操作。测试覆盖 PNG/JPEG Base64 编码、原始/带前缀/换行输入解码及错误拒绝，不代表生产 SDK 2 或正常插件运行验收。

第一期共享图片缓存预览新增 `image.preview(FileRef, operation, params, { format, quality, signal })`，返回只读缓存引用和受控资源URL，复用PNG/JPEG基础处理；`test:win:reference:images` / `test:mac:reference:images` 的同夹具目前核64项（包含维护源码的实际水印、边框、圆角、三种拼图画布执行、图片分页PDF及公共ZIP SDK的原生授权读取/CRC校验/保存）。图片工具引用模式的基础处理源码支持显式可写目录批量输出与取消，生产SDK2整体启用和实际客户端全交互仍待完成。

第一期PDF源码入口为 `image.imagesToPDF(FileRef[], SaveRef, {signal, replace})`，通过注入 `ElectronReferencePdfRenderer` 的共享文件运行时生成受控独立会话PDF；支持1至64张PNG/JPEG，源图合计32MiB/32Mi像素，PDF输出16MiB。真实打印夹具只代表隔离Electron开发验证，生产SDK2与正常ZTools验收仍待完成。

共享ZIP列表/CRC32完整性/文件压缩开发验证：在`electron-client/`执行 `npm run test:reference:zip`（`-- --help`查看说明）；Windows/Mac共用Node >=22.12入口，报告在全新`out-test/reference-zip/<runId>/`。覆盖实际stored/deflate读取/编码及公共SDK注入，不代表native grant IO、生产SDK2启用或Mac App验收。

第一期 SQLite 授权快照验证：`npm run test:reference:sqlite`（Node >=22.12），实际执行独立 sql.js worker、三组固定浏览器查询及取消/超时退出验证。报告位于 `out-test/reference-sqlite/<runId>/`；输入须为16MiB内不依赖WAL的独立SQLite快照，不代表生产SDK2或Mac App验收。

`test:win:reference:images` / `test:mac:reference:images` 共68项实际功能夹具，现含SQLite授权快照固定查询（真实worker与native FileRef）、WAL主文件拒绝和源文件不改写。屏幕/剪贴板源仍为合成数据，不能视为真实OS设备或生产ZTools验收。

第一期真实 GIF：`npm run test:reference:gif` 执行真实gifenc worker与独立omggif解码/取消/超时/SDK测试。`test:win:reference:images` / `test:mac:reference:images` 更新为73项，包含实际native授权GIF导出、私有缓存动画预览、白底/循环/帧顺序及缩放。生产SDK2/正常ZTools/Mac真机仍单独验收。

共享图片功能入口可追加 `--asar-workers`，在隔离ASAR内实际执行SQLite/GIF worker及依赖加载；当前共享夹具83项，2026-10-06 Windows源码与ASAR两变体均通过，Mac实际执行仍待验。该变体不代表最终应用包或生产ZTools验收，Mac错误平台仍提前NOT_RUN。

共享图片/文件功能夹具现为83项，包含实际OS只读进程/端口列表、硬件摘要、系统采样与预取消：Windows进程通过tasklist，Mac通过/bin/ps。普通源码及--asar-workers模式均保留productionZToolsAcceptance:false，不能代替正常App。Google Auth隔离二维码入口在Darwin还必填已批准--minimum-os与--expect-process-arch，Windows误传Mac参数提前NOT_RUN。


### Mac 本地 Vision OCR 开发入口

- `npm run build:native:mac:vision -- --output <fresh absolute directory> --minimum-os <approved version>`：复用Universal helper构建链生成ZToolsMacVision；staging收纳到Contents/Resources/native并执行既有架构/最低OS检查。
- `npm run test:native:mac:vision -- --executable <absolute helper> --arch <arm64|x64> --minimum-os <approved version>`：在实际slice执行9组本地识别/输入自测，Windows返回NOT_RUN，不运行Apple框架。
- `npm run test:native:mac:host:contracts -- --cmake <absolute CMake path>`：在独占runId目录构建`native/ZToolsMacNative`的独立ABI/worker夹具；ABI fixture 的动态装载不代表生产插件加载。Windows结果仅为portable synthetic ABI和源码合同；Darwin还需批准的`--minimum-os`和`--expect-process-arch arm64|x64`。生产 `zt_mac_native_load_candidate_v1` 在静态 preflight 后因 `SAME_OBJECT_LOAD_UNPROVEN` 拒绝，直到能够证明 dyld 在运行 initializer 前会映射已验证的同一对象，Main readiness 不会构造 NativeHost。签名、加载前同对象证明、依赖闭包及生产Host支持仍未通过。
- Mac native生产加载当前保持 `same-object-load-unproven`：有效policy/slice也不创建Host，load gate在任何`dlopen`前拒绝`SAME_OBJECT_LOAD_UNPROVEN`，不得用加载后的vnode检查替代initializer前证明。F21纯JS staging可继续；native Host/Worker/policy组的stage、verify、sign当前拒绝启用。ABI/worker portable测试不是Mac原生可用证明。
- `npm run test:mac:contracts`包含私有子进程协议、取消/退出、引用service/endpoint/SDK和工具注入验证；Native Vision调用由Main reference runtime.localOcr提供，生产SDK2整体迁移前保持未启用。单张PNG/JPEG字节16MiB/8Mi像素，经本地Vision识别，不调用云服务。

区域截图第一期源码：`src/main/platform/macos/region-selection.ts`、`src/main/services/reference-region-capture-service.ts`，维护页面 `frontend/public/platform/region-selector.*`，可选 reference runtime provider 与 `screen.captureRegionReference`。`test:mac:contracts` 覆盖生命周期/显示器变化/SDK；`test:win:reference:images -- --broker <native broker绝对路径>` 同时加载真实 `ztools://web/platform/region-selector.html`、sandbox preload 和私有 IPC，隐藏自有测试窗口、使用合成屏幕来源，不读取用户桌面；`--asar-workers` 复验归档 preload/worker。运行前执行 `npm run build` 更新页面，过期页面夹具拒绝通过。这不是正常 ZTools 的生产合约 2 激活，也不代表 Mac 窗口/Space/Retina/TCC 验收。


Windows 正常 Electron 插件/文件链验证：执行 `npm run test:win:normal-app:plugin-file-chain -- --zip <新鲜单插件 ZIP 绝对路径>`。Runner 使用隔离 userData 启动 `electron .`，经公开 SDK 安装 ZIP，并通过真实 `ztools://web`/插件 CDP 页面点击触发转换、核对 UTF-8 BOM/换行落盘、关闭重开及 App 重启后的数据；原生打开/选择对话框由严格绑定当前插件窗口的一次性 Main 侧替身验证（原生对话框 UI 为 NOT_RUN）。这是当前客户端正常 `electron .` bootstrap 的隔离 CDP 验证，不是 fixture App；报告仍将 `productionZToolsAcceptance` 置为 false，因为未验证日常数据目录、最终签名应用包、原生对话框 UI 或生产 SDK 2，Mac 真机仍为 NOT_RUN。直接库单测入口为 `npm run test:win:normal-app:plugin-file-chain:lib`；报告保留于 `out-test/normal-app-plugin-file-chain/<runId>/` 和 `docs/mac-compat-evidence/F06/`。

### Sandbox preload 构建与可信 lane

`npm run build` 在 TypeScript 编译后复用 Frontend 已安装的 Vite/esbuild 工具链，把 `src/preload/main.ts` 及本地纯函数依赖打成单个 sandbox preload；仅允许外部 `electron` 模块，拒绝 Node、本地运行时 require 和动态模块加载。独立检查入口为 `npm run test:preload:sandbox`，同时纳入 `test:mac:contracts`。Main 通过固定零载荷 `ztools:sdk-lane` 握手返回已登记窗口的可信 lane，Renderer 不能自行升级。正式 host/默认窗口仍使用合约1；合约2业务运行时与关键消费者迁移继续按任务卡推进。

`npm run test:win:path-journal:recovery -- --broker <out-test/path-access 下的绝对x64 broker路径>` 使用两个独立隔离Electron进程验证真实safeStorage/AES-GCM、原生对象与跨进程恢复检查；保持日志、暂存和结果供审计，不重放或删除业务文件。`npm run test:win:reference:resources -- --broker <绝对x64 broker路径>` 通过实际sandbox页面的CDP验证legacy/native私有来源分派、lane与owner拒绝。两者报告分别位于 `out-test/path-journal-recovery/<UUID>/` 和 `out-test/file-resource-dispatch/<UUID>/`，均为Windows隔离夹具，不代表正常App、Mac真机或生产SDK2验收。

### 2026-10-08 远端整合边界

本次整合保留 Windows x64、SDK 1、下载 SHA-256 与原生信任清单。远端隔离插件会话、文件分块、窗口状态、更新与恢复逻辑按现有权限、owner/lane 和退出清理契约接入；真实拖拽仅经 preload 私有通道授予权限，不接受 Renderer 自报路径授权。旧 lifecycle ACK 不与现有退出握手并存。

远端 ia32 C++ 安装部署替换依赖父仓库 `deployment/` 与 `scripts/build-deployment.ps1`，当前工作树不存在这些入口，因此本次保留既有 x64 安装器链，移植业务数据不得进入应用包的独立检查。CommonPlugins 原生加载缺少已批准资源信任清单摘要时拒绝加载。Mac native 生产加载继续关闭，源码测试不得视作 Mac 真机或发行通过。
