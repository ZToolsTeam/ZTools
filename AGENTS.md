# AGENTS.md

## 适用范围与战略定位
- **项目战略定调**：ZTools 彻底卸下历史兼容包袱，不再投入精力维护同步转异步 Shim、黑盒环境模拟与非标兼容层。全面转向**“纯粹开源、免费极客、轻量宿主、极致性能”**的现代化架构体系，吸纳 Raycast 验证过的顶尖工程实践，打造对标国际一流的 Windows & macOS 双端效率中枢平台。
- **本文件地位**：本文件是 ZTools 父仓库及其所有子模块的**唯一且最高权威规则文档**。
- **沟通基准**：默认使用中文沟通、思考、提交说明和技术文档输出。
- **开发原则**：坚持 KISS 原则，拒绝过度设计与重复造轮子。先找根因再改，事实导向，发现高风险问题必须暂停实现并等待确认，严禁“先写再说”。删除文件或覆盖核心配置前必须先确认。
- **权威逆向资产依据（优先查阅）**：后续针对声明式 UI、Native 侧车（UIAccess 穿透 / MFT 索引）、React Reconciler 视图描述符或插件兼容层的研发与调试，**优先直接查阅 `docs/raycast-windows-deep-reverse-analysis.md`**；若文档中未覆盖特定未知细节，才允许使用 REA 工具或子代理进行定向针对性逆向，避免重复从零分析。

---

## 对齐 Raycast 标杆法则：商业模式与开发方案核心规范 (Raycast Alignment Rules)

为了确保 ZTools 保持世界一流的极客水准与长久健康的生态活力，**项目在商业模式、产品哲学与技术开发方案上全面对标并吸纳 Raycast 经过市场与时间验证的核心优点**，同时规避其历史包袱（坚决拒绝臃肿的多语言跨端缝合架构）。本规则作为全局最高准则，贯穿所有规划、研发与运营阶段：

### 一、 商业模式对齐规则 (Business Model Principles)
1. **个人端极致纯净与完全免费（Freemium 极客底座）**：
   - **核心能力永久免费、零广告、不作恶**：快捷启动、超级面板、剪贴板历史、窗口管理、文件秒搜、无限制安装社区扩展全部向个人用户永久免费开放。
   - **杜绝骚扰与功能限制**：严禁在基础功能中插入弹窗广告、诱导付费、刻意降低免费体验以逼迫充值的行为。
2. **开发者即一等公民与开源生态飞轮 (Developer-First Ecology)**：
   - **把 DX（开发者体验）作为第一优先级**：统一且优雅的声明式 SDK、热重载开发体验、完善的 TypeScript 类型定义；
   - **开放投稿、官方审核上架**：插件生态完全开源（GitHub 协作），任何人都可以提交插件，但是否上架由官方人工审核决定（对齐 Raycast Store 模式），保证市场质量；通过 GitOps 静态分发，零抽成、零中间剥削。
3. **商业化聚焦组织协同与高级 AI 增值 (Teams & AI Monetization)**：
   - **团队协同变现 (ZTools for Teams)**：商业价值锚定在企业/团队协同场景——企业统一配置管理、团队私有扩展分发、共享 Snippets/指令、组织级合规审计与权限管控；
   - **高级 AI 增值服务 (ZTools Pro / AI)**：提供官方集成的高性能算力通道与多端云同步增值服务；
   - **极客友好与 BYOK 自由原则**：充分尊重极客，全面支持自带 Key（BYOK: DeepSeek, OpenAI, Claude）与本地离线大模型（Ollama / LM Studio），绝不绑架用户消费官方 Token。
4. **Local-First 与极致隐私优先 (Privacy by Design)**：
   - **核心数据本地化与零隐私搜集**：剪贴板、个人笔记、快捷指令、索引数据 100% 留存在本地 SQLite，绝不上报用户隐私，不进行任何用户监控数据的商业化；
   - **去中心化端到端加密（E2EE）**：同步链路基于 Argon2id 派生密钥与 AES-256-GCM 本地加密，服务端与云存储仅能见到不可逆密文。

### 二、 开发方案对齐规则 (Development & Engineering Principles)
1. **严格声明式 UI 体系（彻底解耦逻辑与视觉呈现）**：
   - **彻底封杀原生 DOM/CSS 自由发挥**：严禁扩展直接操作原生 HTML DOM 或书写自定义 CSS，从根源杜绝界面混乱、样式污染与卡顿；
   - **统一标准化语义描述符**：扩展只能使用语义化组件（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`, `<Action>`），由宿主统一呈现沉浸式 Fluent / Mica 亚克力亚态毛玻璃、自适应主题与无障碍交互。
2. **纯粹的键盘优先交互流 (Keyboard-First Philosophy)**：
   - **全键盘极客闭环**：一切高频操作无需离开键盘——方向键聚焦、`Enter` 激活首要动作、`Ctrl+K` 唤起 ActionPanel 动作面板、`Esc` 返回上级栈、全局热键即时映射；
   - **极简扁平交互路径**：消除冗余弹窗与确认层级，所见即所操作。
3. **系统特权穿透与硬件级底层性能下沉 (Native Performance & Sidecar Decoupling)**：
   - **特权与极速下沉 Native**：UIAccess 穿透跨权限抓词与活动浏览器 Tab URL 获取、NTFS MFT 裸盘硬件级索引与 USN Journal 毫秒追踪全部下沉；
   - **独立 Sidecar 进程解耦**：采用独立 Rust 预编译进程承载密集计算，通过标准管道/IO 与主进程通信，坚决避免把五种不同语言硬性缝合进主进程，杜绝崩溃连锁反应并压低安装包体积。
4. **闪电级唤醒与严苛的资源纪律 (Sub-100ms & Strict Resource Discipline)**：
   - **毫秒级出窗**：唤醒延迟严格控制在 100ms 以内（SLA < 100ms）；
   - **待机资源零浪费**：窗口隐藏后释放 GPU 渲染资源，待机常驻内存控制在 200MB 以内；唤醒时双层缓冲防闪烁；扩展网络请求内置 SQLite WAL 强缓存，离线秒开。
5. **官方审核 + 必要安全门禁 (Official Review & Essential Security)**：
   - 拒绝黑盒非标生态，所有扩展源码公开，经 CI 自动 AST 扫描后由官方人工审核合并才可上架；
   - **安全只做必要的**：项目未上线前只落地"人工审核、AST 扫描、源码构建 + hash 校验、下架开关"四项，其余加固上线后按需追加（详见"分发体系"）。

---

## 核心架构原则与技术基线

### 1. 架构解耦：轻量 TypeScript 宿主 + 预编译 Native Sidecar
- **主应用层（90% 开源开发者工作区）**：
  - 基于轻量化纯 TypeScript（Electron 43.4.1 + Vue 3 + TailwindCSS 3）；
  - 开发者克隆代码后只需 `npm install && npm start`，30 秒跑起本地开发环境；
  - 零 C++、零 Rust 编译门槛要求，全量享受现代前端 HMR（热重载）与 Chrome DevTools / CDP 调试能力。
- **底层高性能引擎（10% 硬核极客与预编译分发）**：
  - `ztools-indexer.exe`：Rust 编写的 NTFS MFT / USN Journal 硬件级极速文件索引引擎（实测 100 万文件检索平均延迟仅 0.035ms，SLA < 10ms）；
  - `ztools-uiaccess.exe`：Rust/Win32 编写的 UIAccess 特权穿透 Worker 进程（穿透 UIPI，读取高权限窗口选中文本与活跃浏览器 Tab URL）；
  - **Prebuilt 二进制随包分发**：CI 预编译全平台二进制，普通开发者直接运行现成二进制，无需本地编译底层 Native。

### 2. 交互与生态：Raycast 声明式组件规范（严禁插件写 CSS/HTML）
- **彻底封杀原生 CSS/DOM**：所有扩展应用必须基于统一的声明式组件库（`@ztools/raycast-compat`），仅生成结构化 JSON 视图描述符（View Descriptors），严禁插件自定义原生 HTML 标签与 CSS 样式。
- **核心组件抽象**：`<List>`（含 Item, Section, Dropdown）、`<Detail>`（含 Markdown 与 Metadata 侧边栏）、`<Form>`（含 TextField, TextArea, Checkbox, Dropdown）、`<ActionPanel>`、`<Action>`。
- **统一极客键盘流**：上下键自动滚屏聚焦、`Enter` 激活首要动作、`Ctrl+K` 弹出 ActionPanel 操作面板、`Esc` 导航栈后退；界面统一呈现沉浸式 Fluent / Mica 亚克力毛玻璃视觉。

### 3. 分发体系：开放投稿 + 官方审核上架（对齐 Raycast Store）
- **投稿即 PR**：任何人都可按 `plugins/{author}/{plugin-id}` 向官方公开插件仓库提交 PR；**官方合并 = 批准上架**，拒绝合并即不上架。插件**每次更新同样走 PR 审核**（审 diff 即可）。
- **上线前必做的 4 项安全门禁（只做必要的）**：
  1. **官方人工审核**：审功能质量、交互体验、命名是否重复/仿冒、权限申请是否合理；
  2. **CI 自动预检**：强校验 `plugin.schema.json` 清单结构（严防路径穿透）+ AST 静态扫描（严禁动态 `eval()`、`new Function()`、`_0x...` 混淆、未声明的 Node 原生模块）；
  3. **CI 从源码构建 + hash 校验**：不接受作者自行上传的产物；构建产物 SHA-256 写入 `plugins.json`，客户端下载后强制校验；
  4. **下架开关**：`plugins.json` 中的 `revoked` 字段，客户端刷新索引时自动禁用已下架插件。
- **上线后按需追加（当前不做）**：`plugins.json` 签名、运行时权限拦截/沙箱、高危权限 Two-Man Rule 双人复核、作者 2FA、举报后台、团队私有扩展签名。
- **免运维静态分发**：GitHub Releases 自动产出 `{plugin-id}-{version}.zip` 与静态全局索引 `plugins.json`，直连腾讯云 COS / Cloudflare R2 对象存储，接入国内 EdgeOne CDN。**带版本号的 zip 可 30 天强缓存；`plugins.json` 必须短缓存（≤ 5 分钟）**，否则下架开关无法及时生效。

### 3.1 双仓开源飞轮与商业资产物理隔离规范（Dual-Repo & Commercial Shield）
- **战略双仓体系（对齐 Raycast 标杆实践）**：
  1. **核心宿主开源仓库（`codingmuse/ZTools`）**：采用 **GNU GPL-3.0** 开源许可证。完全开源客户端壳层与声明式组件引擎，但依托 GPL-3.0 强传染性条款强制任何二次分发或商业衍生版本必须以同等 GPL-3.0 协议公开全部源码，从法律底层彻底封死竞品“套壳闭源”的商业侵占路径；官方依法独占双重许可（Dual-Licensing）变现权利。
  2. **插件生态大仓（`codingmuse/ZTools-extensions`）**：采用 **MIT** 宽松许可证。对标 `raycast/extensions`，官方插件与社区开发者贡献统一汇聚于此；根目录内置一键脚手架（`npm run create-plugin`）与本地 AST 安全扫描；开发者向社区提交 PR 零版权顾虑，最大化驱动生态飞轮。
- **商业资产物理隔离红线（绝对禁止进入开源仓库）**：
  * **核心私有商业资产黑名单**：
    - `DLLPlugins/`：包含 35 款核心自营 Windows 原生动态库插件（极客独占底层工具、硬件专有驱动与深度系统适配，属企业核心商业资产），严禁开源；
    - `backend/`：商业后台服务、企业协同与鉴权计费模块，严禁开源；
    - `installer/`：传统 Delphi 专有安装包工程（架构老旧不友好，客户端统一采用现代 Electron 官方打包流水线），严禁开源；
    - `bin/`：历史旧版 CEF 运行时与本地临时大文件，严禁开源；
    - 敏感环境变量与凭据（`.env.local` 等凭据文件）。
  * **发布隔离防线**：严禁直接将包含敏感提交历史的内部私有主仓推向公开 GitHub。所有开源发布强制通过 `scripts/prepare-opensource-release.mjs` 镜像抽取白名单纯净工作树，确保开源仓库仅含合规公开源码。
- **客户端 4 大开发者引导触点规范**：
  * 宿主必须在主界面提供零门槛触达插件生态的入口：主搜索框内置快捷指令（`developer-create-extension`、`developer-github-repo`）、插件市场无搜索结果时的高转化空状态号召（“🚀 想要该功能？5分钟写一个插件”）、市场底部常驻生态大仓直达条、设置中心「开发者与扩展生态」一键加载本地开发插件与直通大仓。

### 4. 智能化与去中心化同步
- **AI Native 与原生 MCP 网关**：
  - BYOK (Bring Your Own Key) 统一大模型路由（`ModelRouter`）：适配 DeepSeek（原生支持 R1 思考流）、OpenAI、Claude、SiliconFlow；
  - 本地离线模型自动嗅探（`local-sniffer.ts`）：一键探测 `11434` (Ollama) 与 `1234` (LM Studio) 在线状态与本地已拉取模型，零配置直连；
  - 原生 Model Context Protocol 协议栈（`McpHost`）：支持 InMemory/Stdio/HttpSse Transports，系统能力反向暴露为 MCP Tools（`search_files`, `read/write_clipboard`, `manage_window`）。
- **帧同步与去中心化 E2EE 同步**：
  - 窗口隐藏 15 秒主动挂起后台渲染管线并释放 GPU 显存，托盘待机内存压制在 200MB 以内；唤醒时通过 Web 侧 `requestAnimationFrame` 首帧重绘双层确认再映射原生窗口，彻底消灭白屏/黑屏闪烁；
  - 去中心化端到端加密同步（`@ztools/sync-crypto`）：基于 Argon2id 派生密钥与 AES-256-GCM 认证加密；WebDAV 适配器基于 ETag 乐观锁并发控制防覆盖；GitHub Gist 适配器实现多端无冲突云同步。

### 5. 权威逆向分析资产与第一方内置复刻准则
- **首选权威参考**：后续针对声明式 UI、React Reconciler 虚拟视图树转译、Native 侧车（UIAccess UIPI 特权穿透 / MFT USN 极速索引）、插件兼容层（`@ztools/raycast-compat`）或 IPC 协议的研发与适配，**优先直接查阅 `docs/raycast-windows-deep-reverse-analysis.md`**；
- **内置应用严禁凭空重写，一律通过 REA 定向提取后进行本地化改造**：复刻 Raycast 38 款核心内置套件时，**严禁凭空盲写**。必须使用 REA 工具直接从其本地二进制（`backend/index.mjs` 等）逆向提取原版元数据、命令注册树、参数模型、视图切片与底层宏展开算法；提取后对其进行本地化工程改造（替换专有 Host IPC 为 `window.ztools`、加入中文拼音模糊索引、消除官方云端商业锁定、对接本地 SQLite 与 Rust 侧车）。

---

## 测试用例编写强制规则（拒绝纯 Happy Case，默认集成与全异常覆盖）

编写或维护测试用例时，必须严格遵守以下原则：

### 1. 默认包含集成测试 (Integration Tests by Default)
- **拒绝孤立纯 Mock**：编写测试用例时，不得仅编写局限在单一方法或孤立打桩（Mock）的孤岛单元测试；
- **必须覆盖跨模块真实闭环**：测试套件必须默认包含端到端集成测试，打通“用户指令/输入 -> 协议解析与状态机流转 -> 下层服务/Worker/硬件/网络交互 -> 结果回填与数据持久化/UI反馈”的完整协同链路。

### 2. 严禁仅写 Happy Path，全面覆盖破坏性测试 (Fault Injection & Chaos Testing)
- **严禁仅测正常业务流或理想路径**：测试用例必须主动注入故障，全面覆盖各类破坏性异常场景：
  1. **进程与生命周期异常**：子进程查询中途暴毙（Crash / Kill -9）、僵尸进程处理、IPC 管道截断与半包/乱码报文注入、渲染进程挂起/死循环卡死；
  2. **时序与高并发异常**：极端高频连续并发交替触发（如 20ms 内连续 10 次交替触发 show/hide）、竞态乱序响应、状态机死锁防御（看门狗超时强制解除死锁）；
  3. **网络与远端服务异常**：远端并发冲突（如 WebDAV 412 ETag 乐观锁失效、版本更新时间冲突）、速率限制（HTTP 429 Too Many Requests 故障降级）、服务端 5xx 熔断与平滑回退；
  4. **数据与密码学异常**：密文单比特微小篡改（翻转 1 比特）认证解密失败拒绝、错误主密码解密拦截、畸形/损坏的 JSON 与 Payload 安全回退；
  5. **对抗与代码安全异常**：恶意代码字符串间接拼接（`window["ev"+"al"]`）、全局动态变量反射调用（`window[dynamicVar]()`）、原型链逃逸（`({}).constructor.constructor(...)`）、动态计算 require 模块注入（`require(Buffer.from(...))`）。
- **严格断言异常状态与自愈兜底**：每一个异常用例必须明确断言错误类型、状态码、降级逻辑或兜底行为，确保核心宿主在极限破坏下依然稳如磐石、不崩死、不假死、状态机不撕裂。

---

## 7 项核心代码质量原则与 AI 设计自审机制

### 7 项核心原则
1. **完整性**：处理枚举/集合时考虑所有可能分支，保留 `else` / `default` 兜底；
2. **对称性**：成对操作必须严格对称配对（Open/Close, Begin/End, Subscribe/Unsubscribe, Register/Unregister）；
3. **互斥性**：互斥逻辑必须有明确标记或原子互斥锁，避免并发重复触发；
4. **状态机**：涉及状态迁移时先画状态转换图，避免 TOCTOU（检查时与使用时状态不一致），状态变量必须有初始值；
5. **边界条件**：必查空值（null/undefined）、零值、最大极值、溢出、并发、超时与中断；
6. **防御性**：所有外部输入（IPC、网络、文件、命令行参数）默认不可信，必须严格校验并做好异常隔离；
7. **全覆盖测试**：测试用例默认必须包含端到端集成测试，且必须构造崩溃自愈、高频并发竞态、超时死锁、冲突与数据篡改等破坏性异常。

### AI 工作流程（强制执行）
```
需求分析 → 设计方案 → 【设计自审】→ 发现高风险？
                               ↓              ├─ 是 → 停止等待确认
                          输出状态图           └─ 否 → 继续实现
                          边界条件                      ↓
                          互斥识别                   编码实现
                                                       ↓
                                                    集成与异常测试
```
- **核心要求**：复杂改动在设计阶段必须列出状态、边界、互斥关系、异常路径；发现高风险问题必须暂停实现并等待确认，严禁“先写再说”。

---

## Code Exploration / 代码检索与分析规范

在涉及代码探索、流程梳理、符号查找或改动前调研时，必须严格遵守以下原则：
- **优先使用 codegraph**：涉及类/函数定义、调用链追踪、架构理解或排查 Bug 时，**必须优先通过 `call_mcp_tool` 调用 `codegraph` MCP 的 `codegraph_explore` 工具**，严禁未尝使用图谱就直接进行大范围文件泛查或盲目递归搜索。
- **获取上下文后再读文件**：利用 codegraph 梳理出精确的符号关系和核心文件后，再按需针对性查看具体代码。

---

## 目录边界与模块职责

- `electron-client/`：Electron 43 主程序（TypeScript main/preload、C++ NativeHost32、ZToolsService 与 `native/` 原生侧车源码目录）。
- `frontend/`：Vue 3 Renderer 壳层与统一声明式渲染器源码（`src/declarative/`）。
- `packages/`：现代架构解耦核心包目录：
  - `packages/raycast-compat/`：Raycast 声明式 API 兼容包（`@ztools/raycast-compat`）与首批 10 款经典开源应用；
  - `packages/ai-mcp/`：AI Native 基础设施与原生 MCP 协议栈网关（`@ztools/ai-mcp`）；
  - `packages/sync-crypto/`：去中心化 E2EE 加密核心与 WebDAV/Gist 同步适配器（`@ztools/sync-crypto`）；
  - `packages/ztools-plugins-spec/`：GitOps 插件规范、JSON Schema 与元数据校验器；
  - `packages/api/`：官方现代开放平台 SDK 类型定义（`types/index.d.ts`）与运行时契约。
- `scripts/`：GitOps AST 安全扫描器（`scan-plugin-security.mjs`）、自动化打包（`build-plugins-release.mjs`）与对象存储/CDN 推送脚本。
- `tests/`：跨模块端到端集成测试与混沌抗毁性自动化套件（`e2e-cross-module-resilience.test.mjs`）。
- `backend/`：Bun + Hono API 后端服务；`backend/admin/` 是后台管理前端工程。
- `DLLPlugins/`：Windows x86 传统 C++ / Delphi DLL 插件与测试工具。
- `installer/`：安装/卸载程序子模块（独立仓库维护）。
- `bin/`：运行目录与构建打包输出目录。
- `docs/`：项目全套架构、API 文档与实施路线图（包含权威逆向技术报告 `docs/raycast-windows-deep-reverse-analysis.md`）。

---

## 分端编码与安全规范

### 1. Electron 主程序规范
- 主进程负责生命周期、窗口控制、原生协议、Native 侧车进程调度与安全分发；preload 通过 `contextBridge` 只暴露逐方法安全 transport，Renderer 统一使用 `window.ztools`。
- 严格维持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；严禁向 Renderer 暴露 Node 原生模块、任意 IPC 通道、本地文件路径或原生加载能力。
- IPC 通道与请求契约严格维护在 `src/contracts/ipc.ts`，主进程必须基于真实 WebContents 身份独立校验方法权限、调用方身份、参数有效性与超时时限，绝不信任前端自报标识。
- 长任务必须支持取消、窗口销毁保护、应用退出协同与资源释放；监听器、定时器、快捷键、系统钩子必须成对清理，关闭退出路径必须有界且可重入。

### 2. 现代扩展（JS 插件）规范
- 插件资源必须使用 `ztools://` 协议访问，严禁使用相对路径或绕过入口的 `file://` 协议。
- 扩展严格遵循 Raycast 声明式组件规范（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`），**严禁直接操作 DOM 或编写 CSS**。
- 所有样式由统一宿主渲染器（`frontend/src/declarative/`）沉浸式呈现，自动适配深浅主题。

### 3. Frontend 规范
- 优先使用 Vue 3 Composition API 与 `<script setup>`，避免 Options API。
- 组件名使用多词命名；状态管理统一使用 Pinia；从 Store 解构响应式字段时必须使用 `storeToRefs`。
- 样式优先级：Ant Design Vue 组件 > 组件库配合 TailwindCSS > 原生 HTML + TailwindCSS；组件卸载时必须在 `onUnmounted` 中清理定时器与事件监听器。

### 4. Backend 规范
- 路由层只做解析参数、校验输入、调用 Service、返回统一响应；严禁在 Route 中编写复杂 SQL 或第三方 API 编排。
- Service 层负责业务逻辑、事务处理、聚合查询与稳定结构输出；统一通过 `backend/src/db/` 访问数据库。
- 外部输入必须全面校验；需要登录的接口使用认证中间件；数据库迁移统一使用 `bun run db:push`。

### 5. Native 与 DLL 规范
- 普通 x86 DLL 仅通过 NativeHost32，管理员 DLL 仅通过认证 Service；严格核对清单与权限，拒绝不受信调用。
- DLL 必须导出 `DllPlugin_Init`、`DllPlugin_GetInfo`、`DllPlugin_Call`、`DllPlugin_Destroy` 并使用 `cdecl`；DLL 返回宿主的字符串必须使用 `CoTaskMemAlloc` 分配，禁止使用 `new[]`。

---

## 通用工作流与构建测试指南

### 通用开发流程
- 按“需求分析 → 设计方案 → 编码实现 → 测试验证 → 提交交付”推进。
- 变更后至少验证直接受影响链路；测试用例编写默认必须包含跨模块端到端集成测试，且必须覆盖超时、并发竞态、崩溃自愈、数据篡改等破坏性异常，严禁仅测 Happy Path。
- **文件换行符规范**：
  * 编辑现有文件时必须严格保持原有行结束符（CRLF/LF），严禁因编辑器格式化改写换行符；
  * 新增文件时，非 `.bat` 文件统一使用 LF 换行符；`.bat` 文件统一使用 CRLF 换行符；
  * 默认禁止执行全局批量格式化命令。

### 常用构建与验证命令
```bash
# 全仓端到端集成与混沌抗毁性自动化测试（6 大关键链路，19 项破坏性用例）
node --test tests/e2e-cross-module-resilience.test.mjs

# Electron 主程序快速门禁（TypeScript 边界 + 单元测试 + 便携契约）
npm --prefix electron-client run test:quick

# Electron 原生侧车构建与百万级文件压测
node electron-client/scripts/test-sidecars.mjs

# Raycast 声明式兼容包与 10 款应用测试
node --test packages/raycast-compat/tests/all-ten-apps.test.mjs

# AI Native 与原生 MCP 协议栈测试
node --test packages/ai-mcp/tests/e2e-agent-loop.test.mjs packages/ai-mcp/tests/mcp-protocol.test.mjs packages/ai-mcp/tests/model-router.test.mjs packages/ai-mcp/tests/system-tools.test.mjs

# 去中心化 E2EE 加解密与 WebDAV/Gist 同步测试
node --test packages/sync-crypto/tests/crypto.test.mjs packages/sync-crypto/tests/engine.test.mjs packages/sync-crypto/tests/gist-adapter.test.mjs packages/sync-crypto/tests/webdav-adapter.test.mjs

# GitOps AST 插件安全门禁扫描
node scripts/scan-plugin-security.mjs <plugin-dir>

# 前端开发与 SDK 构建
cd frontend && npm run dev
cd frontend && npm run build
cd frontend && npm run build:sdk

# 开源双仓一键增量发布与同步 (支持 all / oss / extensions)
npm run release              # 一键同步核心宿主与插件大仓到 GitHub
npm run release:oss          # 仅同步核心宿主仓库 (codingmuse/ZTools)
npm run release:extensions   # 仅同步插件生态大仓 (codingmuse/ZTools-extensions)
```

### AI 自动化开源发版与零命令交互契约 (Zero-Command AI Release Pipeline)
- **设计宗旨（彻底消除用户心智负担）**：
  * 用户**无需记忆任何脚本名称、参数选项、Git 命令行语法或本地文件系统的物理镜像路径**；
  * 用户在日常对话中只要使用任意模糊自然语言表达发版或开源同步意图，AI **必须主动领会、安全校验并自动闭环完成发布全流程**，严禁反问用户或要求用户输入强命令。
- **自然语言意图识别矩阵（模糊识别，全自动承接）**：
  * **全量发版意图**：“把最新代码发到开源仓库”、“把今天改的代码推到开源 GitHub”、“发布开源版”、“全量同步开源双仓”、“提交开源”、“把这两个项目推上去”；
  * **仅宿主发版意图**：“把核心宿主同步到开源”、“推一下开源宿主”、“更新开源客户端源码”；
  * **仅插件发版意图**：“同步一下开源插件大仓”、“把插件库推上去”、“发布插件生态”。
- **AI 接收意图后的标准全自动执行 SOP（五步流水线）**：
  1. **状态自审与门禁检测**：快速检查当前工作区，确认无高风险破坏或未完成代码，关键测试或构建处于稳定状态；
  2. **物理隔离安全复核**：严格审查待发布文件范围，确保 `DLLPlugins/`、`backend/`、`installer/`、`bin/` 等商业资产与 `.env.local` 等敏感配置绝对未越界；
  3. **调用统一同步执行器**：
     - 执行 `node scripts/sync-release.mjs [all|oss|extensions]`；
     - 脚本自动执行纯净源码白名单抽取、智能保留 `.git` 进行极速增量 diff 比对、自动 commit 并推送到 GitHub `main` 分支；
  4. **提交状态与 SHA 核对**：确认 git push 返回成功，获取最新 commit 短哈希；
  5. **闭环反馈汇报**：向用户汇报同步完成概况，附带对应的 GitHub 仓库地址（[ZTools](https://github.com/codingmuse/ZTools) / [ZTools-extensions](https://github.com/codingmuse/ZTools-extensions)），让用户彻底省心。

### 客户端启动与 Windows 桌面穿透规范（强制执行）
- **启动前互斥守则**：Electron 单例锁机制下，启动新实例前必须先清理旧实例（`Stop-Process -Name electron -Force -ErrorAction SilentlyContinue`），否则新实例因抢不到 `requestSingleInstanceLock` 会立即静默退出。
- **Windows 交互桌面穿透规范**：
  * **背景与根因**：在 Windows 平台上，自动化 Agent / 子进程经常运行在虚拟或沙盒桌面（如 `exebox-...`）中，若直接通过后台普通子进程启动 GUI，窗口会被系统隔离在不可见的虚拟桌面中，用户的物理主屏幕（`WinSta0\Default`）无法看到窗口。
  * **标准唤起方式（首选）**：使用 Windows Task Scheduler 的 `/IT`（交互式任务）模式将进程直接投递到当前登录用户的物理桌面：
    ```powershell
    schtasks /create /tn 'LaunchZTools' /tr 'E:\csdwork3\git\ZTools\start-client.bat' /sc once /st 00:00 /f /it
    schtasks /run /tn 'LaunchZTools'
    Start-Sleep -Seconds 1
    schtasks /delete /tn 'LaunchZTools' /f
    ```
  * **一键脚本**：根目录下的 `start-client.bat` 包含绝对路径与 `--remote-debugging-port=9222`，支持直接执行或双击。
- **主进程前台激活保障**：
  * `bootstrap.ts` 在冷启动完成时，若无特殊 `initialLaunchIntent`，默认分支必须显式调用 `showMainWindow()`；
  * `showMainWindow()` 必须包含 `mainWindow.setAlwaysOnTop(true)` 穿透 Windows Foreground Lock Timeout，随后短时恢复，确保窗口直接弹至前台焦点。

### 运行时验证与 CDP 联调规范
- 涉及主界面、插件渲染、设置页或 IPC 桥接时，最终验证必须在当前真实 Electron 实例中完成（通过开启 `--remote-debugging-port=9222` 启动客户端）。
- 优先通过 CDP 连接当前真实 Electron 实例（`http://127.0.0.1:9222/json`）进行 DOM 检查、事件触发、页面截图与日志采集；系统原生对话框（打开/保存文件）无法通过 CDP 操作时，可使用受控测试替身或 Computer Use，严禁仅在前端伪造成功返回。
- **视觉留证与截图展示铁律（严禁输出纯文本图片名，必须可直接点开查看）**：
  * **严禁纯文本文件名**：向用户汇报或呈现截图留证时，**严禁仅输出无链接、不可点击的纯文本图片文件名**（如写成 `foo.png` 或普通行内代码 `` `foo.png` ``）。
  * **必须提供可点击的绝对路径超链接**：所有截图必须使用 GitHub 风格标准的 `file:///` 协议超链接（Windows 路径统一使用正斜杠 `/`），例如：
    `[截图名称与操作描述](file:///e:/csdwork3/git/ZTools/current_live_xxx.png)`，确保用户在聊天视窗中单次点击即可立刻唤起图片查看器查看原图。
  * **关键交付必须同步生成内嵌大图的视觉报告 Artifact**：
    涉及核心页面、新功能交付或重大 UI 变更留证时，必须将截图复制到会话 Artifact 目录（`.../screenshots/`），并产出用户可见的视觉图集 Artifact（如 `live_screenshots_gallery.md`），使用 `![说明](路径)` 直接内嵌展示，使用户在 IDE 侧边栏即可免切出连续浏览高清界面大图。
  * **每张截图必须附带要素与结论说明**：链接旁必须明确标注该截图验证了哪项具体功能、关键视觉交互（如动作面板、特定类型过滤、状态指示灯）以及判定结果。

### 测试专用账号与免扫码登录规范 (Test Device Auth)
- **背景与痛点**：微信扫码强依赖外部公网回调与物理手机扫码，会导致自动化测试（Vitest / E2E / CDP 联调）和 AI 代理在无人工介入时无法闭环。为此系统内置“设备号免密模拟登录”机制（对齐通用库 `csd-public` 的 `deviceLogin` 能力）。
- **测试专用固定参数（AI 必须记忆并默认使用）**：
  * **测试设备号 (Device Code)**：`ZTOOLS-TEST-DEVICE-0001`
  * **用户唯一标识 (OpenID)**：`device:ZTOOLS-TEST-DEVICE-0001`
  * **测试用户名 / 昵称**：`AI测试专用设备号`
- **AI 自动化与联调操作指南**：
  1. **CDP UI 自动化路径**：遇到登录弹窗（`LoginModal.vue`）时，AI 或自动化脚本直接点击弹窗底部的 `.device-login-link` 按钮（“开发测试：设备号一键模拟登录”），800ms 内自动完成鉴权、持久化并关闭弹窗；
  2. **前端 JS 控制台路径**：在 Renderer 进程控制台直接调用 `await window.ztools.api.deviceLogin('ZTOOLS-TEST-DEVICE-0001')`；
  3. **后端 HTTP API 路径**：直接请求 `POST /api/auth/device-login`（或兼容别名 `/api/auth/login_device`），Payload: `{"device_code": "ZTOOLS-TEST-DEVICE-0001", "nickname": "AI测试专用设备号"}`，获取合法 JWT AccessToken 与 RefreshToken；
  4. **冷启动持久化路径**：在 Electron 启动前，脚本可直接向 `bin/Data/user_account.json` 注入合法的测试会话，客户端冷启动即认定为已登录状态；
  5. **测试行为铁律**：严禁 AI 在执行个人中心、需求墙、插件评论等需要登录态的测试任务时等待人工掏出手机扫码，必须自动触发上述设备登录通道。

### Git 与子模块协作准则
- 本仓库是父仓库，`backend/`、`bin/`、`DLLPlugins/`、`docs/`、`electron-client/`、`frontend/`、`installer/`、`official-website/`、`plugins/` 均为子模块。
- 修改子模块时先进入对应子模块目录提交和推送，父仓库仅记录子模块引用更新；除非用户明确说明，不要随意提交父仓库中的子模块引用变动。
- 提交说明默认使用中文，采用通用标准前缀（`fix: ...`, `feat: ...`, `refactor: ...`, `test: ...`, `chore: ...`）。
