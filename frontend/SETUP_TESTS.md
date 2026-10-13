# 测试说明

## 快速开始

```bash
npm run test          # 单元测试（197 个）
npm run test:e2e      # E2E 测试（需要 ZTools 运行）
npm run test:all      # 全部
```

---

## 单元测试

基于 Vitest + jsdom，无需启动 ZTools。

```bash
npm run test:watch    # 监视模式
npm run test:coverage # 覆盖率报告
```

覆盖模块：Pages（MyPage、List）、Components（PluginCard3D）、Stores（plugins、update、nav、ui、theme、user）、Composables（useVersionCompat）、Directives（switchKeyboard）

### 编写规范

```js
beforeEach(() => {
  setActivePinia(createPinia())
  global.window.ztools = {
    config: { get: vi.fn(), set: vi.fn() },
    user: { isLoggedIn: vi.fn().mockResolvedValue(false) }
  }
})
```

---

## E2E 测试

通过 CDP 在真实 ZTools 进程里执行 JS，覆盖 Delphi + CEF + Vue 完整链路。

### 前置条件

```bash
# 1. 安装 devtools 依赖
cd frontend/devtools && npm install

# 2. 启动 ZTools（通过 MCP 或手动）
bin/ZTools_Debug.exe --remote-debugging-port=9222
```

### 运行

```bash
npm run test:e2e                   # 全量
npm run test:e2e -- --test=系统    # 单模块（按套件名过滤）
npm run test:e2e -- --verbose      # 详细输出
```

### 模块顺序

| 模块 | 说明 |
|------|------|
| 01-system | 系统基础 + 版本兼容性 |
| 02-database | 数据库读写 |
| 03-config-theme | 配置管理 + 主题切换 |
| 04-events | 事件系统 + 触发器 |
| 05-auth-and-plugin-unauthed | 用户认证 + **未登录边界**（必须在登录前跑） |
| 06-plugins | 插件市场 + 更新 + 卸载 |
| 07-my-page | 我的页面 |
| 08-settings | 高级设置 |
| 09-notify | 通知系统 |
| 10-sync | 云端同步 |
| 11-integration | 集成工作流 |
| 12-performance | 性能测试 + 错误处理 |

### CEF 109 限制

```js
// ❌ 顶层 await 不支持
'JSON.stringify(await ztools.sys.getCurrentVersion())'

// ✅ 包在 async IIFE 里
'(async function(){ return JSON.stringify(await ztools.sys.getCurrentVersion()) })()'

// ❌ const 在全局作用域会重复声明
'const h = function(){}; ztools.events.on("x", h)'

// ✅ 用 var 或 IIFE
'(function(){ var h = function(){}; ztools.events.on("x", h); ztools.events.off("x", h) })()'
```

### 调试单个命令

```bash
cd frontend/devtools
node exec.js -t ZTools "ztools.getVersion()"
node exec.js -t ZTools "(async function(){ return await ztools.user.isLoggedIn() })()"
```
