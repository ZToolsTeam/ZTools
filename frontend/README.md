# ZTools Frontend

> 当前主程序位于 `electron-client/`。SDK 源码保留 `cef-ipc` 目录名，已支持 Electron transport；桌面运行验证须构建 Electron 并使用真实 `ztools://` 页面。API 能力以 main Router/能力表为准，不能把旧 CEF API 清单视为全部已迁移。

ZTools 前端应用，基于 Vue 3 + Vite 构建。

## 技术栈

- **框架**: Vue 3 (Composition API + script setup)
- **构建工具**: Vite 5
- **UI 组件库**: Ant Design Vue 4
- **样式方案**: Tailwind CSS 3
- **状态管理**: Pinia
- **路由**: Vue Router 4
- **HTTP 客户端**: Axios
- **图标**: Font Awesome 4

## 项目结构

```
Frontend/
├── public/                 # 静态资源
│   ├── js/
│   │   ├── cef-ipc/       # CEF IPC 通信模块
│   │   ├── dll-plugin-sdk.js  # DLL 插件 SDK
│   ├── sdk/plugin-sdk.js   # 插件SDK发布副本，由构建生成
│   └── plugin-theme.css   # 插件主题样式
├── src/
│   ├── sdk/plugin-sdk.js   # 插件SDK唯一维护源码
│   ├── api/               # API 接口
│   │   ├── http.js        # HTTP 客户端封装
│   │   ├── plugins.js     # 插件市场 API
│   │   ├── update.js      # 更新检查 API
│   │   ├── statistics.js  # 统计分析 API
│   │   └── apiserver.js   # 统一 API 出口
│   ├── components/        # 组件
│   ├── composables/       # 组合式函数
│   ├── layouts/           # 布局组件
│   ├── pages/             # 页面
│   ├── router/            # 路由配置
│   ├── stores/            # 状态管理
│   ├── App.vue            # 根组件
│   ├── main.js            # 入口文件
│   └── style.css          # 全局样式
├── .env.development       # 开发环境配置（需创建）
├── .env.production        # 生产环境配置（需创建）
├── package.json
├── vite.config.js         # Vite 配置
├── tailwind.config.js     # Tailwind CSS 配置
└── postcss.config.js      # PostCSS 配置
```

## 环境配置

### 1. 开发环境

创建 `.env.development` 文件：

```env
VITE_API_BASE_URL = /api
```

### 2. 生产环境

创建 `.env.production` 文件：

```env
VITE_API_BASE_URL = https://api.ztools.cn
```

## 开发指南

### 安装依赖

```bash
npm install
```

### 启动开发服务器

```bash
npm run dev
```

访问：http://localhost:5173

### 构建生产版本

```bash
npm run build
```

### 单独构建 SDK / CEF-IPC 层

```bash
npm run build:sdk
```

说明：

- `npm run dev` 和 `npm run build` 会通过 `predev` / `prebuild` 自动构建 SDK
- `public/js/cef-ipc/src/` 是 `window.ztools` IPC SDK 源码；`src/sdk/plugin-sdk.js` 是 `ztoolsPlugin` 插件SDK唯一源码
- `npm run build:sdk` 会构建并同步两类 SDK 发布副本；修改上述任一源码并要立即同步时可手动运行

### 预览生产构建

```bash
npm run preview
```

## API 架构

Frontend 使用三层 API 架构：

### 1. Backend API（HTTP）

用于获取服务端数据：

- 插件市场（列表、详情、下载）
- 更新检查（主程序、插件）
- 统计分析
- 用户认证（未来）
- 需求墙（未来）

**示例**：

```javascript
import { getMarketPlugins } from '@/api/apiserver'

const { list, total } = await getMarketPlugins({
  keyword: 'json',
  category: '系统工具',
  page: 1,
  pageSize: 20
})
```

### 2. Native API（Electron preload / main）

用于调用系统功能：

- 本地插件管理
- 窗口控制
- 系统通知
- 文件操作
- 设置管理

**示例**：

```javascript
import { getLocalPlugins, openPlugin } from '@/api/apiserver'

// 获取本地插件
const plugins = await getLocalPlugins()

// 打开插件
await openPlugin('plugin-id')
```

### 3. Mock API（测试数据）

开发时的降级方案：

- Backend API 失败时自动降级
- 纯浏览器环境使用

**配置**：

```env
# 禁用 Backend API，使用 Mock 数据
VITE_USE_BACKEND_API=false
```

## 运行模式

Frontend 支持三种运行模式：

### 1. Electron 桌面模式

通过 `electron-client/` 的 `npm start` 运行，使用已实现的桌面能力：

- ✅ Backend API - 服务端数据
- ✅ Native API - 系统功能
- ✅ 本地插件管理

### 2. 浏览器开发模式

纯浏览器开发，部分功能：

- ✅ Backend API - 服务端数据
- ❌ Native API - 不可用
- ✅ Mock 数据 - 降级方案

```bash
npm run dev
# 访问 http://localhost:5173
```

### 3. Mock 模式

无需 Backend，使用假数据：

- ❌ Backend API - 不使用
- ❌ Native API - 不可用
- ✅ Mock 数据 - 完全模拟

```env
VITE_USE_BACKEND_API=false
```

## 开发注意事项

### 1. 样式开发规范

优先级：**Ant Design Vue 组件 > Tailwind CSS > style 标签**

```vue
<!-- ✅ 推荐：使用组件库 + Tailwind -->
<template>
  <a-modal v-model:open="visible" title="标题">
    <div class="flex items-center gap-4 p-4 bg-slate-50 dark:bg-slate-800">
      <a-button type="primary">确定</a-button>
    </div>
  </a-modal>
</template>

<!-- ❌ 避免：大量自定义 CSS -->
<style scoped>
.custom-modal { ... }
.custom-button { ... }
</style>
```

**Vue 文件结构顺序**：`<script setup>` → `<template>` → `<style>`

### 2. API 调用

所有 API 调用必须通过 `apiserver.js`：

```javascript
// ✅ 正确
import { getMarketPlugins } from '@/api/apiserver'

// ❌ 错误
import { getMarketPlugins } from '@/api/plugins'
```

### 3. 错误处理

所有 API 调用都应该处理错误：

```javascript
try {
  const plugins = await getMarketPlugins()
} catch (error) {
  console.error('获取插件失败:', error)
  // 显示错误提示
}
```

### 4. 环境判断

使用 `isNative` 判断运行环境：

```javascript
import { isNative } from '@/api/apiserver'

if (isNative) {
  // Electron 桌面环境，可以使用 Native API
} else {
  // 浏览器环境
}
```

### 5. 开发工具

开发时建议安装 Vue DevTools：

- Chrome: [Vue.js devtools](https://chrome.google.com/webstore/detail/vuejs-devtools/)
- Firefox: [Vue.js devtools](https://addons.mozilla.org/firefox/addon/vue-js-devtools/)

## 调试技巧

### 1. 查看 API 请求

开发环境会自动打印所有 HTTP 请求：

```
[HTTP Request] GET /api/plugins?page=1
[HTTP Response] /api/plugins {...}
```

### 2. 测试 Mock 模式

临时禁用 Backend API：

```javascript
// 在 apiserver.js 中临时修改
const useBackendAPI = false
```

### 3. 模拟认证

当前后端使用 JWT Bearer 认证，没有 Laravel `APP_TEST_MODE` 开关。

开发阶段建议使用以下方式之一：

- 在浏览器环境使用 Mock 数据
- 启动本地 Bun 后端并通过真实接口登录
- 在 Electron 桌面环境下通过 `window.ztools.user` 读写登录态

## 常见问题

### Q1: 无法连接 Backend API

**检查项**：

1. Backend 服务是否启动？`bun run dev` 或 `bun run start`
2. API 地址是否正确？检查 `.env.development`
3. 跨域问题？Backend 已配置 CORS

### Q2: Native API 不可用

**原因**：

- 在浏览器环境运行，没有 `window.ztools` 对象
- 需要在 Electron 桌面环境中运行

**解决方案**：

- 使用 Mock 模式开发
- 或在当前 Electron 主程序中测试

### Q3: 插件市场数据为空

**可能原因**：

1. Backend 数据库没有数据
2. Backend API 返回格式不正确
3. 降级到 Mock 数据

**检查**：

```javascript
// 查看控制台日志
[HTTP Response] /api/plugins {data: [], meta: {...}}
```

## 相关文档

- [API使用指南](../docs/API使用指南.md)
- [Frontend架构文档](../docs/Frontend架构文档.md)
- [Frontend与Backend API对比报告](../docs/Frontend与Backend_API对比报告.md)
- [插件开发指南](../docs/Plugin开发指南.md)

**最后更新**: 2025-12-31
