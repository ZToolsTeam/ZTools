# 从源码构建

本文说明如何在 Windows 或 macOS 上从源码运行和打包 ZTools。模块分工见 [架构概览](architecture.md)，测试命令见 [测试](testing.md)。

## 环境要求

| 用途 | 需要 |
| --- | --- |
| 开发运行（两个平台） | Node.js 24（最低 22.12）、npm、Git |
| Windows 原生组件（可选） | CMake，Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载 |
| macOS 打包 | Xcode 命令行工具（`clang`、`lipo`、`codesign`、`hdiutil`） |

不装 C++ 工具链也能运行，只是依赖原生组件的功能（如 Windows 的 32 位 DLL 插件宿主、macOS 的设备音频控制与字体预览）不可用。

## 安装依赖

在仓库根目录执行：

```bash
npm install
```

安装完成后会自动补齐 `electron-client/` 和 `frontend/` 的依赖，并编译 `packages/declarative-ui`。期间需要下载 Electron，网络受限时见文末「常见问题」。

## 开发运行

```bash
npm run dev            # 构建并启动客户端（与 npm start 相同）
npm run start:rebuild  # 忽略已有产物，强制重新构建后启动
```

`npm run dev` 会按平台选择启动方式：

- **macOS**：执行 `electron-client` 的 `start:mac`，构建后启动 Electron。
- **Windows**：如果 32 位原生宿主 NativeHost32 还没编译，先尝试用 CMake 编译；失败则跳过，继续构建并启动。

它不提供热更新：改完代码退出客户端，再运行一次。macOS 每次都会重新构建；Windows 在源码没变时跳过构建。

## 只构建不启动

```bash
npm --prefix electron-client run build
```

这一步编译主进程、界面层与预加载脚本。macOS 已安装 Xcode 命令行工具时，还会自动构建音频、图像文字识别与字体绘制、受控文件访问辅助进程；源码未变时复用已有产物。产物在 `electron-client/out/`，界面资源在 `electron-client/out/assets/web/`。

Windows 原生组件需要单独编译：

```bash
npm --prefix electron-client run build:native-host32     # 32 位 DLL 插件宿主
npm --prefix electron-client run build:native:sidecars   # 文件索引等辅助进程
```

## macOS 打包

只能在 macOS 上执行。先生成同时包含 Apple Silicon 与 Intel 架构的 `.app`：

```bash
npm --prefix electron-client run package:app:darwin:universal -- \
  --app-bundle-id com.example.ztools \
  --minimum-os 13.0 \
  --short-version 1.1.8 \
  --build-version 1.1.8
```

- 四个参数都必须提供：`--short-version` 是三段数字，`--build-version` 是一到三段数字。本地测试时 Bundle ID 用自己的反向域名即可。
- 输出在 `electron-client/artifacts/<版本号>/darwin-universal/ZTools-darwin-universal/ZTools.app`。输出目录已存在时脚本会停止，重新打包前先移走旧目录。

本地测试可以先做临时签名，再生成 DMG：

```bash
APP="$PWD/electron-client/artifacts/<版本号>/darwin-universal/ZTools-darwin-universal/ZTools.app"
codesign --force --deep --sign - "$APP"
npm --prefix electron-client run package:dmg:darwin -- \
  --app "$APP" \
  --output "$PWD/ZTools-local-darwin-universal.dmg" \
  --allow-unsigned
```

`--app` 和 `--output` 必须是绝对路径。生成 DMG 时会同时写一个 `.sha256` 校验文件。

**正式分发**需要 Apple Developer ID 证书签名并经过苹果公证，否则其他电脑打开时会被系统拦截。流程是：用 `sign:mac:prototype`（[`electron-client/scripts/sign-macos.mjs`](../electron-client/scripts/sign-macos.mjs)）给 `.app` 签名并公证，再把 `--sign-identity` 和 `--notary-profile` 传给 `package:dmg:darwin`。两个脚本加 `--help` 可以查看完整参数，权限声明文件在 [`electron-client/scripts/macos-entitlements/`](../electron-client/scripts/macos-entitlements/)。

macOS 27 的局域网设备 MAC 地址读取还需要 **Network Topology Observation** 能力。网络辅助进程独立放在 `Contents/Helpers/ZToolsMacNetwork.app`，标识为主应用 Bundle ID 加 `.network-topology`（例如 `com.example.ztools.network-topology`）。在 Apple 开发者账号中为该标识启用此能力，创建含当前 Developer ID Application 证书的 **Developer ID** 描述文件，签名时通过 `--network-profile <描述文件绝对路径>` 提供。签名器会检查应用标识、团队、证书、期限及权限，将描述文件嵌入辅助进程，并只给它授予网络拓扑权限；未提供描述文件时助手使用普通签名，自动读取 MAC 地址不可用，其余签名与打包流程仍可继续；显式提供但校验不通过时会停止签名。能力要求见 [Apple 开发者说明](https://developer.apple.com/forums/thread/841958)，辅助进程包装方式见 [Apple 签名文档](https://developer.apple.com/documentation/xcode/signing-a-daemon-with-a-restricted-entitlement)。

普通开发运行和临时签名包不具备这项受限权限。在 macOS 27 上仍能扫描响应设备与端口，但不能自动读取其 MAC 地址，界面会明确提示；手动输入 MAC 的唤醒功能不依赖此权限。不要把在终端里单独运行命令能读取地址当作应用已获授权的证明。

[Releases](https://github.com/ZToolsTeam/ZTools/releases) 上的官方 macOS 安装包由维护者在 Mac 上用这套脚本构建、签名和公证后发布，本仓库不提供它的发布流程。

## 开源版与官方版

本仓库是 ZTools 的开源版。[Releases](https://github.com/ZToolsTeam/ZTools/releases) 上的官方安装包用同一份源码构建，另外加入了不开源的账号与云服务组件，提供账号登录（含微信登录）、个人资料、反馈建议、插件评论 / 评分 / 版本记录、云同步、使用统计和更新服务。这些组件不在本仓库里。

从源码构建得到的是**离线版**：

- 没有账号登录、端内反馈、插件评论与评分、云同步和检查更新，新版本请到 Releases 下载；
- 不连接官方后台，也不上报任何使用统计；
- 侧栏的「反馈建议」在浏览器里打开 [GitHub Issues](https://github.com/ZToolsTeam/ZTools/issues)；
- 插件市场照常从 CDN 读取插件目录，浏览、安装和更新插件不受影响；
- 在线翻译需要在构建时配置（见下表），没有配置时翻译命令只查内置词典，其余内容提示「未配置翻译服务」。

与版本有关的能力都通过一层版本接口接入，开源版的实现在 `frontend/src/edition-oss/` 和 `electron-client/src/main/edition-oss/`，见 [架构概览](architecture.md#版本接口)。

构建时可以配置的环境变量：

| 变量 | 作用 |
| --- | --- |
| `VITE_TRANSLATION_ENDPOINT` | 翻译命令使用的在线翻译服务地址（`http://` 或 `https://`），构建客户端或界面层时以环境变量传入，也可写在 `frontend/.env.local`；不配置或地址无效时只用内置词典 |

```bash
VITE_TRANSLATION_ENDPOINT=https://translate.example.com/api npm --prefix electron-client run build
```

## Windows 安装包

Windows 安装包和免安装包由维护者构建并发布到 [Releases](https://github.com/ZToolsTeam/ZTools/releases)，本仓库不提供它们的打包流程。参与开发时从源码运行（`npm run dev`）验证即可。

## 常见问题

- **Electron 下载失败或很慢**：`npm install` 前设置 `ELECTRON_MIRROR` 环境变量，指向可访问的 Electron 镜像。
- **Windows 上改了代码，启动后没变化**：执行 `npm run start:rebuild` 强制重新构建。
- **自己构建的版本没有登录、反馈等功能**：这些功能来自官方安装包里的闭源组件，开源版不包含，见上文「开源版与官方版」。插件市场不受影响。
