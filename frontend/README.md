# frontend

ZTools 的界面层（Vue 3 + Vite），包含工作台、悬浮搜索条、设置页，以及声明式插件的渲染器。构建产物由 `electron-client` 打包进客户端。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/pages/`、`src/components/`、`src/layouts/` | 页面、组件与布局 |
| `src/stores/` | Pinia 状态 |
| `src/declarative/` | 声明式视图渲染器（List、Detail、Form、ActionPanel 等） |
| `src/api/` | 宿主调用与插件市场目录（CDN）的封装 |
| `src/config/` | 运行配置，如构建时注入的翻译服务地址 |
| `src/edition-oss/` | 版本接口的开源版实现，代码通过 `@edition` 别名引用（`vite.config.js`、`vitest.config.js`），见 [版本接口](../docs/architecture.md#版本接口) |
| `public/js/cef-ipc/` | `window.ztools` 宿主 API 源码，构建到 `public/sdk/` |
| `public/bundled-plugins/` | 随客户端内置的插件构建产物 |

技术栈：Vue 3（`<script setup>`）、Pinia、Vue Router、Ant Design Vue、Tailwind CSS、Vitest。

## 常用命令

在仓库根目录执行：

```bash
npm --prefix frontend test              # 运行 Vitest 测试
npm --prefix frontend run test:watch    # 监听模式
npm --prefix frontend run build:sdk     # 重新生成 window.ztools 宿主 API
npm --prefix electron-client run build  # 生产构建界面层并装入客户端
```

`npm --prefix frontend run dev` 会在浏览器里启动 Vite 开发服务器，只适合调整页面布局；依赖宿主能力的功能要在客户端里运行（根目录 `npm run dev`）。

本仓库是开源版，不包含官方安装包里的账号与云服务组件（登录、反馈、插件评论、云同步、使用统计等），见 [开源版与官方版](../docs/building.md#开源版与官方版)。环境要求见 [从源码构建](../docs/building.md)，测试说明见 [测试](../docs/testing.md)。
