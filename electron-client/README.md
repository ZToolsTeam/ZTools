# electron-client

The Electron desktop host for ZTools (Electron 43, TypeScript): main process, preload bridge, IPC contracts, and platform-native helpers.

ZTools 的 Electron 主程序（Electron 43，TypeScript）：主进程、预加载脚本、IPC 契约，以及平台原生组件源码。

## Directory Layout / 目录结构

| Directory / 目录 | Description / 内容 |
| --- | --- |
| `src/main/` | Main process: bootstrap, windows, IPC router, system services, platform adapters / 主进程：启动流程、窗口、IPC 路由、系统服务、平台适配 |
| `src/main/edition.ts`, `src/main/edition-types.ts` | Main-process edition interface: accounts, analytics, update source, and shared library metadata / 主进程版本接口：账号、统计、更新来源与公共库元数据 |
| `src/main/edition-oss/` | Open-source edition implementation: always signed out, no telemetry, no update checks, zero network calls ([Edition Interface](../docs/en/architecture.md#edition-interface) / [版本接口](../docs/architecture.md#版本接口)) |
| `src/preload/` | Preload scripts exposing method-by-method bridges via `contextBridge` / 预加载脚本，向页面暴露逐个方法的调用桥 |
| `src/contracts/` | IPC request schemas, caller capability tables, and error codes / IPC 请求格式、方法能力表、错误码等契约 |
| `native/` | Windows and macOS native helpers (C++ / Objective-C++, built with CMake) / Windows 与 macOS 原生组件（C++ / Objective-C++，CMake 构建） |
| `resources/` | Application icons and bundled assets / 应用图标与随包资源 |
| `scripts/` | Build, packaging, and signing scripts / 构建、打包与签名脚本 |
| `tests/` | Unit and contract tests (`tests/unit/`) and test scripts (`tests/scripts/`) / 单元与契约测试（`tests/unit/`）及测试脚本（`tests/scripts/`） |

See [Architecture Overview](../docs/en/architecture.md) ([架构概览](../docs/architecture.md)) for how these components fit together.

## Common Commands / 常用命令

Run from the repository root / 在仓库根目录执行：

```bash
npm --prefix electron-client run build        # Build frontend and main process to out/ / 构建界面层与主进程，输出到 out/
npm --prefix electron-client run test:quick   # Type check, unit & contract tests / 类型检查、单元与契约测试
npm --prefix electron-client run start:mac    # macOS: build and launch / macOS：构建并启动
npm --prefix electron-client run package:app:darwin:universal -- --help   # macOS packaging options / macOS 打包参数说明
```

For daily development, run `npm run dev` from the repository root. See [Building from Source](../docs/en/building.md) ([从源码构建](../docs/building.md)) and [Testing](../docs/en/testing.md) ([测试](../docs/testing.md)) for full details.
