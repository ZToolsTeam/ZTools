# 测试

本文列出各模块的测试命令，以及新用例需要覆盖的情况。先按 [从源码构建](building.md) 执行过 `npm install`。

## 提交前至少运行

```bash
npm run test:quick
```

等同于 `npm --prefix electron-client run test:quick`，依次做三项检查：

1. TypeScript 类型检查与源码边界检查（`lint`）；
2. 主进程单元与契约测试（`electron-client/tests/unit/`）；
3. 跨平台路径、能力与数据契约测试（`test:portable-contract`）。

每一项的完整日志写在 `electron-client/out-test/test-reports/` 下，失败时先看对应日志。

目前有少数只适用于 Windows 的用例还没有按平台跳过，在 macOS 上会失败（例如任务栏、粉碎文件相关的用例，以及 `packages/declarative-ui` 里期望 `taskkill` 命令的结束进程用例）。提交 PR 时，只要你的改动没有让结果比改动前更差即可。

## 按模块运行

| 改动范围 | 命令 |
| --- | --- |
| 界面层 `frontend/` | `npm --prefix frontend test` |
| 声明式 UI `packages/declarative-ui/` | `npm --prefix packages/declarative-ui test` |
| 插件规范 `packages/ztools-plugins-spec/` | `npm --prefix packages/ztools-plugins-spec test` |
| 插件 API 契约 `packages/api/` | `npm --prefix packages/api test` |
| 模型与 MCP `packages/ai-mcp/` | `npm --prefix packages/ai-mcp test` |
| 加密与同步 `packages/sync-crypto/` | `npm --prefix packages/sync-crypto run build && npm --prefix packages/sync-crypto test` |
| 根目录 `tests/` 的跨模块用例 | `npm test`（跨模块主套件），或 `node --test tests/<文件名>.test.mjs` 运行单个文件（先看下方说明） |
| Windows 原生辅助进程 `electron-client/native/` | `npm --prefix electron-client run test:sidecars`（仅 Windows，会先用 CMake 编译） |

根目录 `tests/` 的用例直接加载各模块的编译产物，新克隆的仓库要先编译一次：

```bash
npm test                                   # pretest 会编译 packages/declarative-ui、ai-mcp、sync-crypto 的 dist/ 与 electron-client/out/，再运行跨模块主套件
npm --prefix electron-client run build:test   # 引用 electron-client/out-test/ 的用例需要再执行这一步
```

改了 `electron-client/src/` 或 `packages/*/src/` 后，重新执行对应的编译再运行用例，否则测到的是旧产物。

界面层测试用 Vitest：`npm --prefix frontend run test:watch` 进入监听模式，`npm --prefix frontend run test:coverage` 生成覆盖率报告。

## 测试放在哪里

| 模块 | 位置与命名 |
| --- | --- |
| 主进程 | `electron-client/tests/unit/*.test.ts`，编译到 `out-test/` 后运行 |
| 界面层 | 被测文件旁的 `__tests__/*.spec.js` |
| `packages/*` | 各包的 `tests/*.test.mjs` |
| 跨模块 | 根目录 `tests/*.test.mjs` |

## 用例要求

这里是客户端仓库所有测试共同遵守的规则。

### 默认写集成用例

- 改动跨越多个模块时（例如界面 → IPC → 主进程服务 → 子进程或网络），至少有一条用例走通完整链路：「调用 → 主进程校验 → 服务 → 返回结果或界面反馈」。
- 集成用例尽量使用真实模块，只在系统边界换成测试替身：网络、子进程、系统 API、时钟。不要把被测代码自己的依赖全部打桩成「永远成功」。
- 纯函数、解析器这类独立逻辑可以只写单元测试，但同样要覆盖下面的异常情况。
- 测试不依赖真实网络和本机已有的数据：文件放临时目录，远端服务用本地测试服务或替身代替。

### 必须覆盖失败路径

只测正常流程不够。按改动内容，从下面挑出相关的类别补上用例，不要求每个 Pull Request 覆盖全部：

| 类别 | 需要模拟的情况 |
| --- | --- |
| 边界输入 | 空值、零、超长、非法格式、路径越界（如 `../`）、超大载荷 |
| 进程与 IPC | 子进程中途崩溃或被强制结束、管道数据被截断、半包或乱码报文、渲染进程无响应 |
| 时序与并发 | 短时间内反复触发（如连续快速显示、隐藏窗口）、请求乱序返回、操作中途取消、等待超时 |
| 网络与远端 | 断网、超时、HTTP 412（版本冲突）、429（限流）、5xx，验证重试、降级或报错 |
| 数据损坏 | 损坏或截断的 JSON 与文件；加密数据被改动一个比特、密码错误时必须拒绝解密 |
| 安全输入 | 路径穿越、未声明的权限；改插件扫描相关代码时，还要覆盖拼接出的 `eval`（如 `window["ev"+"al"]`）、`({}).constructor.constructor(...)`、动态计算模块名的 `require` 等绕过写法 |
| 成对操作 | 注册与注销、打开与关闭、订阅与取消订阅之后，不留下监听器、定时器或子进程 |

### 断言要具体

- 断言具体的错误码、错误类型或降级结果，不能只断言「没有抛错」或「有返回值」。
- 断言失败之后状态仍然正确：没有卡在中间状态，锁已经释放，下一次调用能正常执行，进程没有崩溃或挂起。

快捷键、窗口、剪贴板、插件桥接这类改动，除了自动化测试，还要在对应平台的真实客户端里手动验证，并在 Pull Request 里写明验证过的系统。

## 手动验证

用 `npm run dev` 启动客户端。注意：开发运行默认和正式安装版共用同一个数据目录（设置、已安装插件、数据库等，位于系统应用数据目录下的 `ZTools/DataV2`）。不想影响日常数据时，先构建一次，再用 `--data-root` 指定一个单独的空目录启动：

```bash
npm --prefix electron-client run build
cd electron-client
npx electron . --data-root=/path/to/ztools-dev/Data
```

数据写在 `--data-root` 指定的目录，日志、缓存等写在它的上一级目录。同一时间只能运行一个实例：启动后立即退出，多半是已经有 ZTools 在运行（macOS 上正式安装版也算），先退出它再启动。macOS 上 Electron 自身的少量配置仍写在系统默认位置。

需要用开发者工具调试界面时，带上 Chromium 调试端口启动：

```bash
# macOS：构建并启动
npm --prefix electron-client run start:mac -- --remote-debugging-port=9222
# Windows：先用 npm run dev 构建一次，再直接启动已构建的客户端
cd electron-client
npx electron . --remote-debugging-port=9222
```

然后在 Chrome 打开 `chrome://inspect` 连接。两个参数可以一起使用：`npx electron . --data-root=<目录> --remote-debugging-port=9222`。`start:mac` 只接受调试端口这一个参数，要指定数据目录时改用 `npx electron .`。
