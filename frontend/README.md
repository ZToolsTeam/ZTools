# frontend

The UI layer for ZTools (Vue 3 + Vite), including the workspace dashboard, floating launcher bar, settings, and the declarative plugin renderer. Build artifacts are packaged into the client by `electron-client`.

ZTools 的界面层（Vue 3 + Vite），包含工作台、悬浮搜索条、设置页，以及声明式插件的渲染器。构建产物由 `electron-client` 打包进客户端。

## Directory Layout / 目录结构

| Directory / 目录 | Description / 内容 |
| --- | --- |
| `src/pages/`, `src/components/`, `src/layouts/` | Pages, components, and layouts / 页面、组件与布局 |
| `src/stores/` | Pinia stores / Pinia 状态 |
| `src/declarative/` | Declarative view renderer (`List`, `Detail`, `Form`, `ActionPanel`, etc.) / 声明式视图渲染器 |
| `src/api/` | Host IPC wrappers and plugin marketplace catalog (CDN) client / 宿主调用与插件市场目录（CDN）的封装 |
| `src/config/` | Runtime configuration such as build-time translation endpoint / 运行配置，如构建时注入的翻译服务地址 |
| `src/edition-oss/` | Open-source edition implementation imported via `@edition` (`vite.config.js`, `vitest.config.js`) ([Edition Interface](../docs/en/architecture.md#edition-interface) / [版本接口](../docs/architecture.md#版本接口)) |
| `public/js/cef-ipc/` | `window.ztools` host API source, built into `public/sdk/` / `window.ztools` 宿主 API 源码，构建到 `public/sdk/` |
| `public/bundled-plugins/` | Built artifacts of plugins bundled with the client / 随客户端内置的插件构建产物 |

Stack / 技术栈：Vue 3 (`<script setup>`), Pinia, Vue Router, Ant Design Vue, Tailwind CSS, Vitest.

## Common Commands / 常用命令

Run from the repository root / 在仓库根目录执行：

```bash
npm --prefix frontend test              # Run Vitest suite / 运行 Vitest 测试
npm --prefix frontend run test:watch    # Watch mode / 监听模式
npm --prefix frontend run build:sdk     # Rebuild window.ztools host API / 重新生成 window.ztools 宿主 API
npm --prefix electron-client run build  # Production build into electron-client / 生产构建界面层并装入客户端
```

`npm --prefix frontend run dev` starts a Vite dev server in the browser, suitable for layout tweaks only. Features that depend on host capabilities must run inside the Electron client (`npm run dev` from the repository root).

This repository is the open-source edition and does not include closed-source account or cloud service modules (sign-in, in-app feedback, plugin reviews, cloud sync, telemetry). See [Open-Source vs. Official Edition](../docs/en/building.md#open-source-vs-official-edition) ([开源版与官方版](../docs/building.md#开源版与官方版)), [Building from Source](../docs/en/building.md) ([从源码构建](../docs/building.md)), and [Testing](../docs/en/testing.md) ([测试](../docs/testing.md)).
