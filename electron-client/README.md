# electron-client

ZTools 的 Electron 主程序（Electron 43，TypeScript）：主进程、预加载脚本、IPC 契约，以及平台原生组件源码。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/main/` | 主进程：启动流程、窗口、IPC 路由、系统服务、平台适配 |
| `src/main/edition.ts`、`src/main/edition-types.ts` | 主进程版本接口：账号、统计、更新来源与公共库元数据 |
| `src/main/edition-oss/` | 版本接口的开源版实现：始终未登录、不上报统计、不检查更新、不发网络请求，见 [版本接口](../docs/architecture.md#版本接口) |
| `src/preload/` | 预加载脚本，向页面暴露逐个方法的调用桥 |
| `src/contracts/` | IPC 请求格式、方法能力表、错误码等契约 |
| `native/` | Windows 与 macOS 原生组件（C++ / Objective-C++，CMake 构建） |
| `resources/` | 应用图标与随包资源 |
| `scripts/` | 构建、打包与测试脚本 |
| `tests/` | 单元与契约测试（`tests/unit/`） |

各部分如何配合见 [架构概览](../docs/architecture.md)。

## 常用命令

在仓库根目录执行：

```bash
npm --prefix electron-client run build        # 构建界面层与主进程，输出到 out/
npm --prefix electron-client run test:quick   # 类型检查、单元与契约测试
npm --prefix electron-client run start:mac    # macOS：构建并启动
npm --prefix electron-client run package:app:darwin:universal -- --help   # macOS 打包参数说明
```

开发时一般直接在根目录运行 `npm run dev`。环境要求和打包步骤见 [从源码构建](../docs/building.md)，测试说明见 [测试](../docs/testing.md)。
