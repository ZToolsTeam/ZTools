# ZTools 跨平台运行时契约

本目录是 Windows/macOS 与 Electron 及历史 Delphi 产物共用的平台目标、运行时身份和能力状态契约来源。Schema 使用 JSON Schema Draft 2020-12。Electron、历史 Windows Delphi 产物及其他消费者应按相同字段语义读取这些 schema 和 fixtures；内部平台适配器接口不属于此公开契约。

## 文件

| 文件 | 用途 |
|---|---|
| `platform-target.schema.json` | 描述一个平台、runtime、CPU 架构与可选 ABI/最低契约版本要求 |
| `application-version.schema.json` | App 发行版本数字格式与三/四段历史版本归一化规则 |
| `runtime-identity.schema.json` | 运行时握手；把目标、OS、主进程和单独 Native Host 的观测值分开 |
| `capability-record.schema.json` | 单项能力快照；实现状态、当前调用者授权与 OS 权限互相独立 |
| `public-error.schema.json` | 公共 IPC 错误对象：稳定机器错误码与仅供展示的消息 |
| `fixtures/` | 两个宿主、Windows WOW64、Apple Silicon/Rosetta、未知值、能力状态、最低契约版本及无效平台目标样例 |
| `fixtures/current-api-semantics.json` | 当前屏幕、快捷键、请求超时、DLL 任务和错误码来源事实快照；包含尚未解决的阻塞项 |
| `validate-contracts.mjs` | 使用 Node.js 内置模块检查 schema 与全部 fixtures，无第三方依赖 |

## 公共 IPC 错误

失败响应的 `error` 字段由 `public-error.schema.json` 定义。`code` 是供程序分支处理的大写标识符；`message` 只用于展示，不应被调用方解析或用作权限判断。Electron Main IPC 中无法识别的异常映射为 `INTERNAL_ERROR` 和固定消息。ScreenService、ClipboardService、FileSystemService 与 NetworkService 的未知底层异常映射为固定领域错误码和展示消息；`CLIPBOARD_ERROR` 不再透传适配器文本。ShellService 不再把操作系统打开路径时返回的错误文本放进 `SHELL_ERROR.message`。Windows GDI 截图与 PowerShell 文件剪贴板适配器也使用固定消息。Electron 单测覆盖这些边界；其余显式领域错误、诊断对象和NativeHost事件仍需逐项审查，不能据此推断所有公开错误已完成审计。

超时错误码依调用路径而异：`REQUEST_TIMEOUT` 来自 Electron Main IPC 请求超时；`CALL_TIMEOUT` 来自旧 JS transport 的本地调用超时；`TIMEOUT` 是旧事件请求 API 解析出的 `{ ok: false, code: 'TIMEOUT' }` 结果。这些来源和返回形状尚未统一，调用方应按实际 API 处理；本契约不承诺它们等价。

当前错误来源事实、修复状态及校验断言见 `fixtures/current-api-semantics.json`。契约校验器锁定该快照中的明确事实；实际运行测试仍是行为变更的验证依据。

## 屏幕坐标与显示器

当前 Screen API 的 cursor、`Display.bounds`、`Display.workArea` 和 point/rect 参数均使用 Electron DIP（device-independent pixels）坐标；虚拟桌面允许负坐标。当前截图实现按 DIP 区域生成 PNG，每 DIP 输出一个像素（不按 Retina `scaleFactor` 放大 PNG 尺寸）。消费者在与原生像素缓冲区交互时不能把 DIP 和物理像素混用。

返回的显示器 `id` 是运行期 Electron 标识，不是跨会话或硬件持久标识；`index` 只代表本次显示器列表顺序。插件不得持久化或把两者当作显示器稳定身份。`scaleFactor` 单独表示像素缩放比例。

参考 Electron 官方文档：[Screen API](https://www.electronjs.org/docs/latest/api/screen)、[Display 结构](https://www.electronjs.org/docs/latest/api/structures/display)。

## 快捷键词汇与适配边界

当前录制器把跨平台主修饰键存为 `Ctrl`：Windows 对应物理 Control，macOS 对应 Command；`Control` 表示物理 Control，`Alt` 在 macOS 显示为 Option，Shift 保持不变。主进程 adapter 当前只将 `Ctrl` token 转换为 Electron `CommandOrControl`，其他 token 原样传递。录制器显示转换已有单测，但真实 macOS 全局快捷键注册、键盘布局及系统保留组合仍需 Mac 实机验收；未验收前不得据此宣称全局快捷键已跨平台兼容。

参考 Electron 官方文档：[Keyboard Shortcuts（含 Accelerators）](https://www.electronjs.org/docs/latest/tutorial/keyboard-shortcuts#accelerators)、[globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)。

## 请求超时与异步任务

IPC 请求超时不是长任务超时：当前 Main IPC 默认 10 秒、单次上限 120 秒；只有文件打开/保存/选择目录对话框与 `process_wait` 可配置无限等待。超时时 Router 会触发 AbortSignal 并结束请求等待，但 handler 必须主动响应 signal；该机制不保证底层 handler 或操作已经停止。

当前 DLL task status (`invoking`、`running`、`completed`、`cancelled`、`error`) 属于 Windows NativeHost legacy API。macOS 没有 NativeHost，DLL task API 不支持；项目没有通用异步任务 API。取消成功后的状态可能被后续事件改回其他 terminal status，任务保留与清理也未定义为稳定公共语义。这两项留给 T12 阻塞处理；本契约不新增通用 task API，也不把请求超时等同于任务取消。

## 版本域

App 发行版本不是 SemVer：`application-version.schema.json` 接受三段历史值和四段发行值，每段为 1–15 位十进制数字；比较时三段补 `.0`，前导零按数值归一化，空白、后缀、缺段、超出 15 位的段均拒绝。runtime identity 的 `contractVersion` 单独标记该身份 schema 的版本，目前只接受已知的 `1`。manifest 的 `minSdkContractVersion` 与宿主 `SDK_CONTRACT_VERSION` 比较，不使用 runtime identity 版本代替。NativeHost wire `protocolVersion` 是 1–65535 的整数；没有适用/可观测 Host 时为 `null`。SDK、NativeHost、Service 协议版本分别维护，即使当前数值相同也不能互相推导。前后端 App 比较器和契约校验器直接消费 `fixtures/app-version/comparison-cases.json`；插件包/Web 版本不使用这套规则。

## 平台目标

`platform-target.schema.json` 的 `platform` 是产品平台（`windows` 或 `macos`）；`runtime` 是宿主技术（`electron` 或 `legacy-delphi`）；`arch` 描述这个包或目标范围（`any`、`ia32`、`x64`、`arm64`、`universal`）。可选 `id` 是稳定的小写目标标识。插件 manifest 在声明 `targets` 时必须给每项目标提供唯一 `id`，以便原生组件通过 `targetId` 关联；单个运行时身份或能力快照可以省略它。`legacy-delphi` 只标记仍需识别的 Windows 历史产物，schema 拒绝 Mac Delphi 目标；它不代表 Delphi 会继续作为新主程序实现或发布。Windows Electron 的 `ia32` 是当前已有目标。除上述遗留边界外，目标字段不声明任何平台/架构组合已经实现、发布或可运行。

`any` 表示目标不限定 CPU 架构；`universal` 表示产物声明包含多个架构切片。当前 Mac Universal 产物必须同时含 arm64 与 x64；macOS 不接受 ia32 目标，Universal 仍映射到运行中的 arm64 或 x64 Electron 进程架构。构建、包索引和启动器仍须检查实际二进制切片、依赖和宿主能力。不得仅因 manifest 与运行时目标匹配就宣称兼容。

插件 manifest 的 `nativeComponents[].arch` 描述组件实际二进制架构，默认必须与它绑定的 `target.arch` 相同。唯一跨架构例外是 Windows Electron x64 target 上由 x86 `NativeHost32` 承载的组件：主 DLL 必须声明 `kind: "dll"`、真实 `arch: "ia32"`、`abi: "ztools-native-host/v1"` 和 `protocolVersion: 1`。此 ABI 仅适用于 Windows Electron DLL；不得让 x64 同进程 DLL、worker 或 shared-library 冒用它。

该 DLL 在 NativeHost32 内加载的 ia32 PE 依赖另列为 `kind: "shared-library"`、`arch: "ia32"`、`abi: "windows-pe/v1"`。当它绑定到 x64 target 时，必须通过 `hostComponentId` 指向同一 target 的 NativeHost32 主 DLL；该引用必须是已声明的 DLL 组件，不能形成依赖链。字段可在同架构组件上省略；跨架构依赖必须填写并通过宿主校验。其他 shared-library、worker、未知 ABI、缺失或不匹配的协议版本，以及非 Windows Electron 目标继续要求组件与 target 架构精确相等。

这些字段只表达兼容性与宿主边界，不核验 PE 文件本身，也不授予 DLL 调用权限或信任。构建/安装仍须核对每个实际 DLL/PE 的 Machine 架构和既有信任清单；不能用 manifest 元数据替代二进制或授权验证。

可选 `abi` 必须带版本，例如 `ztools-native-host/v1` 或 `ztools-native-host@1.2.0`。ABI 不兼容时必须使用新版本标识。可选 `minSdkContractVersion` 是消费方最低所需的 SDK 契约整数版本，不能当作最低 macOS 版本。此 schema 不定义发行渠道、最低 OS 或首发架构。

## 运行时身份

握手的 `contractVersion` 是本目录公开契约的整数版本，本契约当前从 `1` 开始；`appVersion` 是应用版本；`nativeHost.protocolVersion` 是单独 Native Host 通讯协议版本。三者不可互相代替。消费者必须检查目标的 `minSdkContractVersion`，并确认实际 `contractVersion` 在自身明确支持的版本范围内。只满足最低版本不代表兼容；未知的未来版本或未知 Native Host 协议不能自动降级为“功能可用”。

`target.arch` 是包或目标声明，`os.arch` 是宿主操作系统架构，`process.arch` 是当前主进程架构，`nativeHost.arch` 是独立 Native Host 架构。它们可能不同；例如 Win32 进程运行于 x64 Windows，或 x64 Electron 在 arm64 Mac 上由 Rosetta 执行。macOS 的 OS、Electron 主进程和 Native Host 架构只能是 x64、arm64 或无法确认的 `unknown`，不能报告 ia32。`process.translationMode` 记录 `native`、`translated`（如 Rosetta）、`compatibility`（如 WOW64）、`not-applicable` 或 `unknown`。无法可靠读取的值用 `unknown`，不要从 User-Agent、包名或平台推断授权/架构事实。

`os.productVersion` 和可选 `os.kernelVersion` 分开记录，以免把 macOS 产品版本误当 Darwin 内核版本。若不存在单独 Native Host，`nativeHost.state` 使用 `not-applicable`，其架构与协议版本使用 `unknown`。

## 能力与授权

每个能力记录必须分别填写三个维度：

- `implementation`：`supported` 表示该能力有实现路径，`unsupported` 表示当前目标不支持，`unavailable` 表示实现或依赖暂不可用。
- `authorization`：当前真实调用者对本次能力的授权：`granted`、`denied` 或 `unknown`。宿主必须从已验证的 WebContents/插件实例身份和策略计算，不能信任 renderer、manifest 或调用参数自报的 plugin/caller id。
- `osPermission`：操作系统权限状态，独立于调用者授权；`not-required` 表示本能力不依赖该权限，`not-determined`、`granted`、`denied`、`restricted`、`unknown` 按系统实况填写。

读取能力快照必须是只读操作：探测或声明能力不会触发 TCC/系统授权提示，也不会授予插件调用权。OS 权限已授予不代表 caller 已获授权；caller 已获授权也不代表平台实现或依赖可用。`revision` 是该 runtime 实例中此 capability 快照的递增修订号，只用于识别较旧的显示数据，不能充当许可。UI 可以展示快照，但每次实际操作仍由宿主重新校验 caller、实现、OS 权限、资源及有效期，避免把缓存状态当成执行许可。

当前 Electron 稳定能力目录由 `electron-client/src/contracts/runtime-capability.ts` 显式维护，只登记以下既有契约 ID：

| 稳定 ID | 用途 |
|---|---|
| `screen.capture` | 查询屏幕采集能力状态 |
| `clipboard.files.read` | 查询读取剪贴板文件能力状态 |
| `system.hibernate` | 查询系统休眠能力状态 |

目录仅允许查询这些明确登记的 ID；共享记录 schema 的 `capability` 字符串格式校验不等于目录白名单。未知 ID 必须失败关闭。生产 Router 按当前目标报告实现状态：`screen.capture` 在 Windows/macOS 为 `supported`；`clipboard.files.read` 在 Windows 为 `supported`、macOS 为 `unsupported`；`system.hibernate` 在两平台均为 `unsupported`，因为当前 handler 仍延迟到 M5。只有已存在的实现路径因运行依赖缺失时才报告 `unavailable`。当前 Electron 生产环境尚无插件授权 provider，因此 `authorization` 为 `unknown`；读取快照不会授予权限，每次实际 IPC 调用仍单独校验。`screen.capture` 仅在 macOS 复用 Electron 的只读屏幕 TCC 状态查询；provider 缺失、报告 `unavailable` 或异常时 `osPermission` 为 `unknown`。Windows 和其它能力没有 OS 权限 provider，`osPermission` 为 `unknown`。测试注入的授权状态不得代替生产状态。

## 校验

在仓库根目录运行：

```sh
node ztools-open/sdk/contracts/validate-contracts.mjs
```

该脚本检查 schema 引用、字段/枚举、fixtures、架构独立性、未知状态、版本门槛和负例。它是此目录中最小的无依赖一致性校验器；接入使用完整 JSON Schema 校验库的工程时，仍应直接加载本目录 schema。

Electron 的 `plugin-runtime-target-resolver` 是平台目标契约的第二个实现。它复用 `src/contracts/protocol-versions.ts` 中的 `SDK_CONTRACT_VERSION`，在安装与打开插件时拒绝当前宿主版本低于目标 `minSdkContractVersion` 的插件。`electron-client/tests/unit/platform-runtime.test.ts` 直接读取 `fixtures/targets/` 和 `fixtures/invalid/platform-target/`，验证有效目标选择、最低版本门禁和无效目标拒绝；不要在测试里复制这些 fixture 内容。版本门禁单测可注入宿主版本，但生产调用使用权威常量。运行时身份记录仍由本目录 validator 单独消费；能力记录现由 Electron `runtime_capability_get` IPC 作为只读生产查询消费者，并由插件 Renderer E2E 验证。没有授权/TCC provider 时仍必须返回 `unknown`，不能据此推断 Mac 权限链已完成。
