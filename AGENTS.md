# AGENTS.md

## 适用范围与战略定位
- **项目战略定调**：ZTools 彻底卸下历史兼容包袱，不再投入精力维护同步转异步 Shim、黑盒环境模拟与非标兼容层。全面转向**“纯粹开源、免费极客、轻量宿主、极致性能”**的现代化架构体系，采用现代极客工程实践，打造对标国际一流的 Windows & macOS 双端效率中枢平台。
- **本文件地位**：本文件是 ZTools 父仓库及其所有子模块的**唯一且最高权威规则文档**。
- **沟通基准**：全面且强制使用中文进行沟通、思考、Git 提交备注（Commit Message）以及技术文档输出。
- **开发原则**：坚持 KISS 原则，拒绝过度设计与重复造轮子。先找根因再改，事实导向，发现高风险问题必须暂停实现并等待确认，严禁“先写再说”。删除文件或覆盖核心配置前必须先确认。
- **核心架构参考依据**：针对声明式 UI、Native 侧车（UIAccess 穿透 / MFT 硬件级索引）、React Reconciler 虚拟视图描述符与现代扩展兼容层，严格遵循本文件与 `@ztools/declarative-ui` 标准架构规范进行研发与测试。
- **疑难困境工程设计准则**：当遇到复杂系统设计、技术瓶颈或方案选型时，**严禁闭门造车或凭空盲猜**。必须坚持以事实和成熟工业级工程实践为导向，全面评估并发模型、状态机契约与异常边界，确保方案经过严密自审与全异常测试后再行编码。

---

## 现代极客工程标杆法则：商业模式与开发方案核心规范 (Core Engineering Rules)

为了确保 ZTools 保持世界一流的极客水准与长久健康的生态活力，**项目在商业模式、产品哲学与技术开发方案上全面吸纳经过市场与时间验证的核心优点**，同时规避历史包袱（坚决拒绝臃肿的多语言跨端缝合架构）。本规则作为全局最高准则，贯穿所有规划、研发与运营阶段：

### 一、 商业模式对齐规则 (Business Model Principles)
1. **个人端极致纯净与完全免费（Freemium 极客底座）**：
   - **核心能力永久免费、零广告、不作恶**：快捷启动、超级面板、剪贴板历史、窗口管理、文件秒搜、无限制安装社区扩展全部向个人用户永久免费开放。
   - **杜绝骚扰与功能限制**：严禁在基础功能中插入弹窗广告、诱导付费、刻意降低免费体验以逼迫充值的行为。
2. **开发者即一等公民与开源生态飞轮 (Developer-First Ecology)**：
   - **把 DX（开发者体验）作为第一优先级**：统一且优雅的声明式 SDK、热重载开发体验、完善的 TypeScript 类型定义；
   - **开放投稿、官方审核上架**：插件生态完全开源（GitHub 协作），任何人都可以提交插件，但是否上架由官方人工审核决定，保证市场质量；通过 GitOps 静态分发，零抽成、零中间剥削。
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

### 2. 交互与生态：声明式组件规范（严禁插件写 CSS/HTML）
- **彻底封杀原生 CSS/DOM**：所有扩展应用必须基于统一的声明式组件库（`@ztools/declarative-ui`），仅生成结构化 JSON 视图描述符（View Descriptors），严禁插件自定义原生 HTML 标签与 CSS 样式。
- **核心组件抽象**：`<List>`（含 Item, Section, Dropdown）、`<Detail>`（含 Markdown 与 Metadata 侧边栏）、`<Form>`（含 TextField, TextArea, Checkbox, Dropdown）、`<ActionPanel>`、`<Action>`。
- **统一极客键盘流**：上下键自动滚屏聚焦、`Enter` 激活首要动作、`Ctrl+Enter` 激活次要动作、`Ctrl+K` 弹出 ActionPanel 操作面板、`Esc` 导航栈后退；界面统一呈现沉浸式 Fluent / Mica 亚克力毛玻璃视觉。

### 2.1 效率工具箱插件 UI 与交互设计五大黄金法则及三大标准布局范式
ZTools 的核心定位是**“呼出即用、用完即走”的闪电效率工具箱**（对标 Raycast / Linear / Spotlight），**绝不是传统 Web 后台管理系统（Admin Dashboard）**。所有内置与社区声明式插件（以 `kill-process`、`disk-analyzer`、`batch-video` 为全仓三大标准模板）必须严格遵循以下 5 条黄金交互原则与 3 大标准布局范式：

1. **原则 1：列表/主工作区主权原则（75%+ 屏幕面积必须留给核心交互内容）**
   - 用户唤起插件的第一诉求是快速定位并操作目标条目，而非浏览统计报表。
   - **硬性约束**：顶部区域（搜索栏 + 极简状态条）占用的垂直高度**严禁超过窗口总高度的 20%（约 72px~96px）**，必须将 **75%~80% 的垂直空间** 留给下方的主工作区（首屏列表区域至少完整展示 7~10 行数据），严禁在列表上方堆叠大尺寸统计卡片（`MetricGrid`）或多行筛选标签。
2. **原则 2：单一信源与零重复原则（同一功能在屏幕上绝不出现第二次）**
   - **筛选入口唯一**：若搜索框右侧已提供 `<List.Dropdown>` 下拉筛选或排序，顶栏下方**严禁**再重复渲染相同维度的筛选胶囊行（`filterBar.groups`）；若左侧已有分类树或参数面板，顶栏严禁再重复渲染五颜六色的分类比例条（`distributionBar`）。
   - **动作锚点唯一**：同一项操作严禁在顶栏、列表行内、详情页顶部与底部状态栏同时重复出现，彻底杜绝视觉打架与认知过载。
3. **原则 3：区分「全局动作」与「单条动作」（职责物理隔离）**
   - **顶部状态栏（`filterBar`）仅放全局上下文与 1~2 个全局动作**：左侧展示精炼的单行实时状态摘要（`summaryText`，可直接融合关键统计指标），右侧最多只允许放置 **1~2 个全局级轻量按钮**（如 `[新建]`、`[重新扫描]`），**严禁在顶栏放置针对单条选中项的“删除/结束进程/复制/定位”等单条动作按钮**。
   - **底部黄金三键栏统一承载主操作动作**：针对当前选中项或任务队列的操作，100% 收敛在底部状态栏的 **黄金三键**（`[主动作 ↵]` + `[次动作 ⌘↵]` + `[动作面板 (N) ⌘K]`）；列表行右侧仅干净展示 `accessories` 指标标签（Badge / 进度条），不在行内或右侧详情面板顶部重复堆砌操作按钮群。
4. **原则 4：渐进式披露（高频直达，低频收纳）**
   - 首屏底部栏永远只外露最高频的 **第 1 主动作（Enter）** 与 **第 2 次动作（Ctrl+Enter）**；
   - 第 3~N 个低频/进阶动作全部收纳进底部的 `[动作面板 (N) Ctrl+K]` 弹出层，同时支持通过全局快捷键（`matchActionShortcut`）免开菜单一键触发。
5. **原则 5：极简克制配色与零 Emoji 污染原则（90% 灰阶单色 + 10% 语义点缀）**
   - **彻底清零彩色 Emoji 污染**：严禁在标题、状态栏、下拉框、按钮文案中使用 `🔄`、`🌐`、`💽`、`🎬`、`📊`、`🚀`、`📂`、`🗑️` 等系统彩色 Emoji（在 Windows 下会被渲染成高饱和度卡通色块），界面图标 100% 统一使用单色线性 SVG 图标。
   - **去彩虹化（No Rainbow Noise）**：严禁给同类列表项循环赋予紫、蓝、绿、黄、粉、青等无业务含义的彩虹色；列表图标统一使用克制的中性次级灰（`var(--rc-text-muted)`），行内体积/进度占比条（`acc.progress`）统一使用单色半透明中性灰白（`rgba(255,255,255,0.25)`），仅靠长度体现差异。
   - **复选框与胶囊标签去刺眼化**：多选复选框（`[✓]`）采用低调高对比的单色灰白选中态（严禁整列刷成刺眼的亮橙色方块）；右侧标签（`acc.tag`）取消刺眼的彩色描边，统一采用无彩色边框的极简暗灰底胶囊（仅在磁盘空间 > 90% 等真正高危告警处允许使用低饱和红色点缀）。
   - **唯一主色调克制使用**：全屏仅在底部第 1 主动作按钮（Primary Action）与当前聚焦指示处保留唯一主强调色。
6. **全仓 35+ 插件的「三大标准布局范式」（100% 场景覆盖，严禁生造第四种怪异布局）**：
   - **【布局一：单栏宽列表 / 左列表 + 右真实内容预览（Search & Preview List）】**
     * **标杆模板**：`kill-process`、`clipboard-history`
     * **适用范围（11 款检索与系统状态插件）**：`process-monitor`/`kill-process`、`flow-guard`、`clipboard-manager`、`hardware-info`、`network-adapter`、`network-rescue`、`context-menu`、`window-manager`、`wechat-multi`、`system-tools`、`lan-share`。
     * **设计铁律**：若条目信息在单行（标题+副标题+右侧状态标签）即可表达完整，使用 **100% 全宽单列表**；仅当右侧确实是**真实内容本体**（如剪贴板长文本、代码片段、词典释义、二维码图片、硬件参数表）时才开启右侧预览栏，**严禁为了凑双栏而在右侧放静态重复的说明文字**。
     ```text
     +-----------------------------------------------------------------------------------+
     | 搜索框 (占主视觉)                                [分类/排序下拉框 Dropdown ▾]     | <-- 第 1 层：搜索与唯一筛选 (44px)
     +-----------------------------------------------------------------------------------+
     | 实时状态一句话摘要 (融合核心指标统计)                      [新建 / 刷新] (仅全局) | <-- 第 2 层：单行极简状态条 (28px)
     +-----------------------------------------------------------------------------------+
     | 选中项标题  副标题 (完整路径/PID/端口)               [指标Badge] [状态Badge]       |
     | 普通项标题  副标题                                   [指标Badge] [状态Badge]       | <-- 第 3 层：100% 宽列表 (或 48% 列表
     | 普通项标题  副标题                                   [指标Badge] [状态Badge]       |     + 52% 真实内容预览，可看 8~10 行)
     +-----------------------------------------------------------------------------------+
     | Esc 返回                                  | [主动作 ↵]  [次动作 ⌘↵]  [动作面板 ⌘K]  | <-- 第 4 层：底部黄金三键动作栏 (40px)
     +-----------------------------------------------------------------------------------+
     ```
   - **【布局二：左 32% 导航分类树 + 右 68% 可勾选交互列表（Master-SubList Cleaner）】**
     * **标杆模板**：`disk-analyzer`
     * **适用范围（14 款复杂多维管理与清理插件）**：`disk-analyzer`、`cleaner`、`wechat-cleaner`、`qq-cleaner`、`software-manager`/`applications`、`boost`、`mover`、`data-recovery`、`shredder`、`system-backup`、`multi-download`/`downloads-manager`、`video-downloader`、`sqlite-plugin`、`batch-rename`。
     * **设计铁律**：通过 `<List subList={...}>` 实现。**左栏（32% 宽度）** 作为多维空间/分类/账号/数据表导航树，点击左栏实时过滤右栏；**右栏（68% 宽度）** 直接渲染带全选表头、单色复选框 `[✓]`、单色体积占比条（`acc.progress`）与中性分类标签的可交互明细列表；底部黄金三键直接作用于右侧选中项或已勾选集合。
     ```text
     +-----------------------------------------------------------------------------------+
     | 搜索大文件/后缀或路径...                          [全盘汇总 / 账号切换 ▾]         | <-- 第 1 层：搜索与顶层源切换 (44px)
     +-----------------------------------------------------------------------------------+
     | 全盘总容量 1.7 TB / 已用 1.3 TB (78%) · 右侧共 678 项                [重新扫描]   | <-- 第 2 层：单行极简状态条 (28px)
     +--------------------------+--------------------------------------------------------+
     | 物理挂载分区 / 10大分类   | [☐] 全盘可清理大文件明细 (按体积降序，直接勾选或按 ↵)  |
     | ▸ 全盘所有大文件   678项 | [✓] Windows11_x64.iso        █████░░ [镜像]    8.0 GB  |
     | ▸ 系统主分区 (C:)   98%  | [☐] Ubuntu-Snapshot.vmem     ████░░░ [其他]    8.0 GB  | <-- 第 3 层：左 32% 导航树 +
     | ▸ 数据库与资源包  67.7GB | [锁] pagefile.sys            ███░░░░ [系统保护] 4.0 GB  |     右 68% 单色可勾选列表 (8~10 行)
     +--------------------------+--------------------------------------------------------+
     | Esc 返回                 | [移入回收站清理 ↵]    [在资源管理器定位 ⌘↵]    [⌘K]    | <-- 第 4 层：底部黄金三键动作栏 (40px)
     +--------------------------+--------------------------------------------------------+
     ```
   - **【布局三：左 34% 参数配置/视觉画布 + 右 66% 任务队列/结果工作台（Parameter & Queue Workbench）】**
     * **标杆模板**：`batch-video`
     * **适用范围（10 款批量媒体加工、AI 视觉与录屏/OCR 插件）**：`batch-video`、`batch-audio`、`pdf`、`ai-image`、`ai-video`、`ocr`、`record`、`screenshot`、`screen-color-picker`、`file-compare`。
     * **设计铁律**：通过 `<List workbenchPanel={...} subList={...}>` 实现。**左栏（34% 宽度）** 承载加工参数选择器（如输出格式、编码器、分辨率、CRF 画质、AI 超分倍率、输出目录）与极简预估摘要卡；**右栏（66% 宽度）** 承载待处理文件勾选队列、单色体积占比条与预计输出大小对比；底部黄金三键绑定 `[开始批量处理 ↵]` + `[打开输出目录 ⌘↵]` + `[动作面板 ⌘K]`。
     ```text
     +-----------------------------------------------------------------------------------+
     | 搜索队列文件或输入参数...                         [预设方案: 画质压缩 ▾]          | <-- 第 1 层：搜索与预设方案切换 (44px)
     +-----------------------------------------------------------------------------------+
     | 队列已选 36 个视频 (1.4 GB) · 预计转码后 ~476 MB (节省 66%)          [重新扫描]   | <-- 第 2 层：任务预估状态条 (28px)
     +----------------------------+------------------------------------------------------+
     | 视频转码参数工作台 (34%)    | [✓] 待处理视频文件队列 (66%)                         |
     | 输出容器  [ MP4 (通用)  ▾] | [✓] 演示录屏_01.mov        █████░░ [→ ~30MB] 89.5 MB |
     | 视频编码  [ H.265/HEVC  ▾] | [✓] 会议录像_1018.mp4      ████░░░ [→ ~29MB] 85.2 MB | <-- 第 3 层：左 34% 单色参数工作台
     | 目标画质  [ CRF 23 均衡 ▾] | [✓] 产品宣传_4K.mp4        ███░░░░ [→ ~26MB] 78.9 MB |     + 右 66% 单色队列与输出对比
     | 预计总节省空间: ~924 MB     |                                                      |
     +----------------------------+------------------------------------------------------+
     | Esc 返回                   | [开始批量转码 ↵]      [在资源管理器定位 ⌘↵]      [⌘K] | <-- 第 4 层：底部黄金三键动作栏 (40px)
     +----------------------------+------------------------------------------------------+
     ```
7. **AI 开发新插件 / 重构插件时的「布局选型决策树与代码契约」（强制执行）**：
   - **第一步：1 秒判定该用无界面命令（`no-view`）还是三大视图布局（`view`）？（AI 选型决策树）**
     0. **问：用户触发该指令后，是否根本不需要看列表或点按钮，只需立即执行一个动作并给出结果反馈（如一键锁屏、切换深浅色、清空回收站、生成 UUID 写入剪贴板、窗口左半屏）？**
        - **是** ➔ **必须选用【零界面瞬时命令（`mode: "no-view"`）】**（对标 Raycast No-View Command）：
          * **清单声明**：在 `plugin.json` 的 `mode`（或 `features[].mode`）中声明 `"mode": "no-view"`；
          * **代码实现**：**严禁渲染任何 `<List>` / `<Detail>` / `<Form>` 界面**！直接导出一个异步执行函数 `export default async function Command() { ... await showHUD("已执行动作"); }`，用户在主搜索框敲回车或按全局快捷键后，主窗口直接收起、后台毫秒级执行并弹出 1.5s 自动消失的毛玻璃 `HUD` 胶囊提示。
     1. **问（有界面 `mode: "view"`）：用户是否需要在左侧设定一串加工参数（如转码格式、画质、AI 倍率、OCR 语言、重命名规则），同时在右侧查看待处理文件队列与预计产出？**
        - **是** ➔ **必须选用【布局三：参数与队列工作台】**，直接以 `packages/declarative-ui/src/examples/batch-video/index.ts` 为代码模板（`<List isShowingDetail={false} workbenchPanel={...} subList={...}>`）。
     2. **问（有界面 `mode: "view"`）：数据是否存在“左侧分类树/盘符/微信账号/数据表 ➔ 右侧成百上千条可勾选明细并批量清理/卸载/搬移”的 1 对多层级关系？**
        - **是** ➔ **必须选用【布局二：左 32% 导航树 + 右 68% 可勾选明细表】**，直接以 `packages/declarative-ui/src/examples/disk-analyzer/index.ts` 为代码模板（`<List isShowingDetail={false} subList={...}>`，左栏渲染 `<List.Item>` 导航节点，右栏通过 `subList` 渲染带复选框的明细行）。
     3. **问（有界面 `mode: "view"`）：是否是二级新建/编辑配置页，或纯单篇结果阅读页？**
        - **是** ➔ 使用共享同一套极简顶底外壳的 `<Form>`（表单输入页）或 `<Detail>`（纯 Markdown 阅读页）。
     4. **其余所有有界面场景（含 100% 的轻量级列表插件、检索开关、系统控制集、剪贴板、词典）**：
        - **一律选用【布局一：单栏宽列表 / 左列表 + 右真实内容预览】**，直接以 `packages/declarative-ui/src/examples/kill-process/index.tsx` 为代码模板：
          * **极轻量插件（如 5~15 个系统开关集合、快捷动作列表）**：不传 `filterBar`，设置 `isShowingDetail={false}`，界面自动退化为最轻盈的「搜索框 + 100% 全宽单色列表 + 底部黄金三键栏」；
          * **标准检索/监控插件（如进程强杀、网络端口、窗口切换）**：传入单行 `filterBar={{ summaryText, actions }}` + `isShowingDetail={false}`；
          * **内容预览插件（如剪贴板历史长文本、词典释义、二维码图片）**：设置 `isShowingDetail={true}`，右侧仅展示真实内容本体。
   - **第二步：三大布局的 Props 填空契约（AI 直接按此结构编写代码）**
     * **顶栏筛选**：统一通过 `searchBarAccessory={<List.Dropdown value={...} onChange={...}>...</List.Dropdown>}` 挂载在搜索框右侧；
     * **第 2 层单行状态条**：统一通过 `filterBar={{ summaryText: "单行统计摘要", actions: [{ title: "重新扫描", onAction }] }}` 传入（极轻插件可省略 `filterBar`）；
     * **行内右侧指标**：统一通过 `accessories: [{ progress: 0.65 }, { tag: { value: "标签" } }, { text: "8.0 GB" }]` 传入，不传彩色 `color`（仅 `>90%` 高危告警可传 `color: "red"`）；
     * **底部黄金三键**：统一通过选中项或子列表项的 `<ActionPanel>` 定义，第 1 个 `<Action>` 自动映射为 `Enter` 主动作，第 2 个自动映射为 `Ctrl+Enter` 次动作，其余自动收纳进 `Ctrl+K` 动作面板。
   - **第三步：AI 编写插件的 6 条红线自检清单（提交代码前必查）**
     1. `[ ]` 是否生造了第 4 种布局或写了原生 HTML/CSS？（严禁）
     2. `[ ]` 是否在列表上方传了大尺寸统计卡片 `MetricGrid` 或彩色比例条 `distributionBar`？（严禁）
     3. `[ ]` 在已有右上角 `<List.Dropdown>` 或左栏导航树的情况下，是否又重复传了 `filterBar.groups` 胶囊行？（严禁）
     4. `[ ]` 文案中是否混入了任何彩色 Emoji（如 `🔄`、`🌐`、`💽`、`🎬`、`📊`、`🚀`、`🔒`）？（严禁，必须清零）
     5. `[ ]` 是否给普通列表图标或标签循环赋予了紫/蓝/绿/黄/青等彩虹色？（严禁，必须保持 90% 灰阶单色）
     6. `[ ]` 若开启了 `isShowingDetail={true}`，右侧是否只是把左侧列表行已有的标题/路径重复写了一遍？（若是，必须改为 `isShowingDetail={false}` 全宽列表）

### 3. 分发体系：开放投稿 + 官方审核上架
- **投稿即 PR**：任何人都可按 `plugins/{author}/{plugin-id}` 向官方公开插件仓库提交 PR；**官方合并 = 批准上架**，拒绝合并即不上架。插件**每次更新同样走 PR 审核**（审 diff 即可）。
- **上线前必做的 4 项安全门禁（只做必要的）**：
  1. **官方人工审核**：审功能质量、交互体验、命名是否重复/仿冒、权限申请是否合理；
  2. **CI 自动预检**：强校验 `plugin.schema.json` 清单结构（严防路径穿透）+ AST 静态扫描（严禁动态 `eval()`、`new Function()`、`_0x...` 混淆、未声明的 Node 原生模块）；
  3. **CI 从源码构建 + hash 校验**：不接受作者自行上传的产物；构建产物 SHA-256 写入 `plugins.json`，客户端下载后强制校验；
  4. **下架开关**：`plugins.json` 中的 `revoked` 字段，客户端刷新索引时自动禁用已下架插件。
- **上线后按需追加（当前不做）**：`plugins.json` 签名、运行时权限拦截/沙箱、高危权限 Two-Man Rule 双人复核、作者 2FA、举报后台、团队私有扩展签名。
- **免运维静态分发**：GitHub Releases 自动产出 `{plugin-id}-{version}.zip` 与静态全局索引 `plugins.json`，直连腾讯云 COS / Cloudflare R2 对象存储，接入国内 EdgeOne CDN。**带版本号的 zip 可 30 天强缓存；`plugins.json` 必须短缓存（≤ 5 分钟）**，否则下架开关无法及时生效。

### 3.1 双仓开源飞轮与商业资产物理隔离规范（Dual-Repo & Commercial Shield）
- **战略双仓体系**：
  1. **核心宿主开源仓库（`codingmuse/ZTools`）**：采用 **GNU GPL-3.0** 开源许可证。完全开源客户端壳层与声明式组件引擎，但依托 GPL-3.0 强传染性条款强制任何二次分发或商业衍生版本必须以同等 GPL-3.0 协议公开全部源码，从法律底层彻底封死竞品“套壳闭源”的商业侵占路径；官方依法独占双重许可（Dual-Licensing）变现权利。
  2. **插件生态大仓（`codingmuse/ZTools-extensions`）**：采用 **MIT** 宽松许可证。官方插件与社区开发者贡献统一汇聚于此；根目录内置一键脚手架（`npm run create-plugin`）与本地 AST 安全扫描；开发者向社区提交 PR 零版权顾虑，最大化驱动生态飞轮。
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

### 3.2 商业版用户反馈与 GitHub Issues 智能中继规范（Feedback Bridge & Issue Sync）
- **开源版 vs 商业版清晰定调与边界**：
  * **开源版纯粹极客**：能自行 clone 源码并打包构建的 100% 为开发者，开源版严禁内置耦合私有 MySQL/微信评论树的“心愿墙/反馈建议”页面；反馈一律直连指向官方 GitHub Issues；
  * **商业版贴合国内普通用户**：国内大众小白用户无法访问 GitHub，商业发行版客户端内保留轻量免登录/微信反馈与点赞功能（`WishWall.vue`），承载收集池功能。
- **三层漏斗与自动化闭环中继机制**：
  1. **端内收集池与隐私脱敏防线**：商业端反馈进入内部数据库（`feedbacks` 表）；中继服务（`github-sync.service.ts`）强制执行正则脱敏（严防普通用户手机号、邮箱等个人隐私直接暴露到公开仓库）；同时异步调用企业微信 Webhook 机器人（`notification.service.ts`）向研发群实时推送脱敏卡片通知，附带一键流转链接，彻底消除漏看延误；
  2. **管理后台一键转接（漏斗过滤，拒绝无脑全量灌水）**：管理员在后台（`FeatureRequests.vue`）审核确认后一键【转为 GitHub Issue】；调用 GitHub REST API 创建规范化 Issue，自动回写关联 `github_issue_number` 与 `github_issue_url`，并向用户追加系统承接回复；
  3. **研发结案自动闭环回传**：核心研发在 GitHub 关联 PR 关闭 Issue 后，触发 Webhook（`POST /api/webhooks/github`，HMAC SHA-256 强制验签）；系统自动将商业端反馈状态置为 `completed`（已完成），并生成报喜通知回复（若 reopen 则自动恢复为 `developing`）。
- **GitHub 官方 CLI (`gh`) 自动化运维代理规范**：
  * 环境已全局就绪配置 GitHub 官方 CLI（`gh`，位于 `%LOCALAPPDATA%\Programs\GitHub CLI\bin`，已绑定 `codingmuse` 官方账号与 `repo`/`workflow` 权限）；
  * AI 助手在后续会话中遇到用户需要“查询 Issues/PR”、“新建/关闭 Issue”、“配置 Webhooks”或“发版 Release”时，**必须优先利用 `gh` 命令或已封装的 API 为用户代劳执行，严禁让用户进行繁琐的人工重复搬运**。

### 3.3 微软官方 Windows Package Manager (Winget) 自动化分发规范（WinGet Distribution Pipeline）
- **会话触发与操作基准**：
  * 当用户在会话中提出**“要提交到 winget”**、**“发布到 winget”**或需要同步新版本安装包至微软官方源时，**AI 助手必须优先直接代劳执行 `npm run release:winget`**（或调用 `node scripts/publish-winget.mjs`），严禁让用户进行繁琐的人工清单编写或手动提 PR；
  * 若仅需本地生成清单并验证，使用 `npm run release:winget:dry-run`；运行全量测试使用 `npm run test:winget`。
- **自动化流水线 5 步严密闭环**：
  1. **工具链自动诊断**：自动定位系统 `winget` 与 `wingetcreate`（若缺失则通过 winget 自动安装 `Microsoft.WingetCreate`），并通过 `gh auth token` 动态获取鉴权凭据；
  2. **产物与直链校验**：自动校验 GitHub Release `v<version>` 上的离线安装包（`ZTools-<version>-win32-x64.exe`）与本地 SHA-256，若远端未就绪可搭配 `--package` 自动触发双包构建并上传；
  3. **标准 Manifest 自动化生成**：生成 4 份符合微软 1.6.0+ 标准架构规范的 YAML 清单（版本清单、安装器清单、中文 defaultLocale、英文 locale），严格遵循 `Scope: user`、`InstallerType: exe`、`Silent: /S` 与 `Moniker: ztools` 约束；
  4. **严格本地模式校验**：调用 `winget validate` 执行语法与语义实体验证，确保 100% 达成 0 错误 0 警告；
  5. **自动化提交 PR**：通过 `wingetcreate submit` 自动 Fork 微软官方仓库 `microsoft/winget-pkgs`、创建分支并提交 Pull Request，向用户汇报 PR 链接。

### 4. 智能化与去中心化同步
- **AI Native 与原生 MCP 网关**：
  - BYOK (Bring Your Own Key) 统一大模型路由（`ModelRouter`）：适配 DeepSeek（原生支持 R1 思考流）、OpenAI、Claude、SiliconFlow；
  - 本地离线模型自动嗅探（`local-sniffer.ts`）：一键探测 `11434` (Ollama) 与 `1234` (LM Studio) 在线状态与本地已拉取模型，零配置直连；
  - 原生 Model Context Protocol 协议栈（`McpHost`）：支持 InMemory/Stdio/HttpSse Transports，系统能力反向暴露为 MCP Tools（`search_files`, `read/write_clipboard`, `manage_window`）。
- **帧同步与去中心化 E2EE 同步**：
  - 窗口隐藏 15 秒主动挂起后台渲染管线并释放 GPU 显存，托盘待机内存压制在 200MB 以内；唤醒时通过 Web 侧 `requestAnimationFrame` 首帧重绘双层确认再映射原生窗口，彻底消灭白屏/黑屏闪烁；
  - 去中心化端到端加密同步（`@ztools/sync-crypto`）：基于 Argon2id 派生密钥与 AES-256-GCM 认证加密；WebDAV 适配器基于 ETag 乐观锁并发控制防覆盖；GitHub Gist 适配器实现多端无冲突云同步。

### 5. 第一方内置应用套件研发与适配准则
- **统一标准实现**：针对声明式 UI、React Reconciler 虚拟视图树转译、Native 侧车（UIAccess UIPI 特权穿透 / MFT USN 极速索引）、插件规范（`@ztools/declarative-ui`）或 IPC 协议的研发，严格基于 `@ztools/declarative-ui` 与原生契约推进；
- **高质量原生套件工程落地**：构建核心内置套件时，严格遵循标准化命令元数据树、参数模型、声明式视图切片与快捷键交互流；深度对接 `window.ztools`、本地 SQLite WAL 强缓存、中文拼音模糊搜索与预编译 Rust 侧车，实现真正零延迟开箱即用。

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
- **架构方案严密对标**：遇到架构复杂、技术不确定性高或遭遇实现瓶颈时，在方案设计阶段强制加入方案自审：比对业界先进工程规范，确认最佳工程解法后再行落地方案。

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
  - `packages/declarative-ui/`：声明式组件与运行时规范包（`@ztools/declarative-ui`）与内置核心应用；
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
- `docs/`：项目全套架构、API 文档与实施路线图。

---

## 分端编码与安全规范

### 1. Electron 主程序规范
- 主进程负责生命周期、窗口控制、原生协议、Native 侧车进程调度与安全分发；preload 通过 `contextBridge` 只暴露逐方法安全 transport，Renderer 统一使用 `window.ztools`。
- 严格维持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`；严禁向 Renderer 暴露 Node 原生模块、任意 IPC 通道、本地文件路径或原生加载能力。
- IPC 通道与请求契约严格维护在 `src/contracts/ipc.ts`，主进程必须基于真实 WebContents 身份独立校验方法权限、调用方身份、参数有效性与超时时限，绝不信任前端自报标识。
- 长任务必须支持取消、窗口销毁保护、应用退出协同与资源释放；监听器、定时器、快捷键、系统钩子必须成对清理，关闭退出路径必须有界且可重入。

### 2. 现代扩展（JS 插件）规范
- 插件资源必须使用 `ztools://` 协议访问，严禁使用相对路径或绕过入口的 `file://` 协议。
- 扩展严格遵循统一声明式组件规范（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`），**严禁直接操作 DOM 或编写 CSS**。
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

# 声明式组件与应用测试
node --test packages/declarative-ui/tests/all-ten-apps.test.mjs

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

# 开源双仓一键增量发布与同步 (支持 all / oss / extensions，默认同时推送 GitHub + Gitee)
npm run release              # 一键同步核心宿主与插件大仓到 GitHub & Gitee
npm run release:oss          # 仅同步核心宿主仓库 (GitHub: codingmuse/ZTools + Gitee: hoposky/ZTools)
npm run release:extensions   # 仅同步插件生态大仓 (codingmuse/ZTools-extensions)

# 发行版执行文件双端三包构建与上传 GitHub Releases (同时产出 Windows EXE/ZIP + macOS Universal DMG)
npm run package:release      # 一键编译最新 Delphi 安装器并同时打包 Windows EXE 离线安装包 + ZIP 免安装便携包
npm run release:binaries     # 同时打包上传 Windows 双包 (EXE + ZIP) 并自动触发云端编译挂载 macOS Universal DMG 至同一 GitHub Release
npm run release:mac          # 单独遥控 GitHub Actions 云端 Mac 真机编译并发布 ZTools-<version>-darwin-universal.dmg
npm run release:mac:download # 遥控云端编译 Mac DMG 并自动拉回本地 dist/macos/ 目录
```

### AI 自动化开源发版与零命令交互契约 (Zero-Command AI Release Pipeline)
- **核心前提铁律（“发布源码到 GitHub / Gitee = 100% 推开源版，且默认双端同推”）**：
  * **商业私有源码绝对不推公开仓**：内部商业版母仓包含私有核心源码资产（`DLLPlugins/`、`backend/`、`installer/` 源码等），**永远不可能直接将私有源码推送到 GitHub 或 Gitee**；
  * **GitHub 与 Gitee 双平台默认同时推送铁律**：**以后无论用户说“推送到 GitHub”还是说“推送到 Gitee”（或发布/同步/上传到 GitHub / Gitee），一律默认同时推送至 GitHub（`https://github.com/codingmuse/ZTools.git`）和 Gitee（`https://gitee.com/hoposky/ZTools.git`）双远端！**
  * **凭据安全隔离**：GitHub 与 Gitee 访问令牌（`GITHUB_TOKEN`、`GITEE_TOKEN`）统一保存在本地 `.env.local`（已被 `.gitignore` 严格忽略且位于开源抽取白名单之外，严禁写入受跟踪文件），由 `scripts/sync-release.mjs` 自动读取并配置远端完成双推；
  * **默认唯一语义映射**：只要用户提到**“发布到 GitHub”、“推到 GitHub”、“发布到 Gitee”、“推到 Gitee”、“公布到 GitHub/Gitee”、“同步到 GitHub/Gitee”、“上传 GitHub/Gitee”**（无论用户是否显式说出“开源”二字），涉及源码同步时 **100% 唯一指的就是通过开源发布流水线（`scripts/sync-release.mjs`）将脱敏抽取后的开源版本同时推送到 GitHub 与 Gitee 公开仓库**！严禁反问“是推商业版还是开源版”，严禁只推单边平台，也严禁在母仓直接执行裸 `git push`。
- **执行文件（Release 二进制产物）Windows + macOS 双平台三包齐发强制铁律（EXE 安装包 + ZIP 免安装包 + macOS Universal DMG）**：
  * **双端三格式产物缺一不可**：凡是发包、打包商业版/发行版执行文件，或将构建好的安装包上传至 GitHub Releases（`codingmuse/ZTools`）时，**必须同时发布 Windows 与 macOS 双端全量安装包（及其 `.sha256` 校验文件），严禁只发 Windows 单平台或只打单包**：
    1. **Windows EXE 离线安装包**：`ZTools-<version>-win32-x64.exe`（及 `.sha256`）—— 内置极简 Direct2D GPU 安装向导、支持一键平滑升级与空间不足智能换盘；
    2. **Windows ZIP 免安装便携包**：`ZTools-<version>-win32-x64-portable.zip`（及 `.sha256`）—— 解压即用免安装版；
    3. **macOS Universal DMG 通用安装包**：`ZTools-<version>-darwin-universal.dmg`（及 `.sha256`）—— 同时支持 Apple Silicon (M1/M2/M3/M4) 与 Intel 双架构，内置 Ad-hoc 深度签名与 3 个 macOS 原生辅助进程。
  * **Windows 机器一键联动云端 Mac 编译机制**：
    - 本地打包并一键发布 Windows + macOS 全套安装包：`npm run release:binaries`（即 `node scripts/package-release-binaries.mjs --upload`），脚本在完成本地 Windows `.exe` + `-portable.zip` 构建上传后，**会自动调用 `scripts/build-macos-remote.mjs` 触发 GitHub Actions (`build-macos-dmg.yml`) 云端 `macos-latest` 节点编译 `.dmg` 并自动挂载到同一个 `v<version>` Release 下**；
    - 单独触发云端 Mac DMG 编译并挂载 Release：`npm run release:mac`（若需同时下载回本地 Windows `dist/macos/` 目录则执行 `npm run release:mac:download`）；
    - 底层打包器 `electron-client/scripts/package-installer.mjs`、`package-macos-universal.mjs`、`package-macos-dmg.mjs` 与校验器 `verify-artifacts.mjs` 均已强制绑定产物完整性与 SHA-256 校验契约。
  * **版本号自增与四段式数字版本号强制防呆铁律（严禁漏升版本号或未触发构建包）**：
    - **发版必先核对远端 Release 版本号**：凡是用户要求“发包”、“发布新版本”或在完成重要功能修复后要求“提交代码并发布到 Git 上”时，AI **必须先通过 `gh release list -R codingmuse/ZTools` 检查当前 `electron-client/package.json` 的版本号是否已经在 GitHub Releases 发布过**。若该版本号已存在，**必须先递增升级版本号并触发双端构建发包**，严禁只同步源码而漏掉版本号升级与安装包构建！
    - **强制四段式数字版本号（`X.Y.Z.W`）**：Windows 底层服务 `electron-client/native/ZToolsService/CMakeLists.txt` 强制校验四段式数字版本号（正则 `^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$`）。**所有版本号必须严格写成四段式（例如 `1.1.8.0`、`1.1.8.1`，严禁写成三段式 `1.1.8`）**，`scripts/package-release-binaries.mjs` 在启动时亦强制执行该格式预检。
    - **五处版本号同步更新契约**：每次升级版本号时，必须同步更新以下 5 处：`package.json`、`electron-client/package.json`（含 `package-lock.json`）、`frontend/package.json`（含 `package-lock.json`）、`CHANGELOG.md` 顶部正式版标题、`README.md` 更新日志摘要（或直接加 `--bump` 参数由脚本自动自增）。
    - **严禁先后颠倒（必须“先升版本推 GitHub 源码 → 再触发双端三包构建上传 → 最后验包”）**：由于云端 macOS DMG 构建（GitHub Actions）是从 GitHub `codingmuse/ZTools` 的 `main` 分支拉取源码并读取 `electron-client/package.json` 版本号，因此**必须先把升级好版本号的源码通过 `npm run release:oss` 推送到 GitHub `main` 分支，然后再执行 `npm run release:binaries -- --rebuild-app`**，确保本地 Windows 双包与云端 Mac DMG 挂载到同一个新版本 `v<version>` Release 下。
- **设计宗旨（彻底消除用户心智负担）**：
  * 用户**无需记忆任何脚本名称、参数选项、Git 命令行语法或本地文件系统的物理镜像路径**；
  * 用户在日常对话中只要使用任意模糊自然语言表达发版、发包、打包执行文件或 GitHub / Gitee 同步意图，AI **必须主动领会、安全校验并自动闭环完成全流程（源码默认同时推送 GitHub 与 Gitee；发包默认先升四段式版本号、推源码、再同时发布 Windows EXE/ZIP 与 macOS DMG）**，严禁反问用户或要求用户输入强命令。
- **自然语言意图识别矩阵（模糊识别，全自动承接）**：
  * **默认/全量源码发版意图（同时推 GitHub + Gitee）**：“发布到 GitHub”、“推到 GitHub”、“发布到 Gitee”、“推到 Gitee”、“公布到 GitHub/Gitee”、“把最新代码发到开源仓库”、“发布开源版”、“全量同步开源双仓”、“提交开源”、“把这两个项目推上去”；
  * **仅宿主源码发版意图（同时推 GitHub + Gitee）**：“把核心宿主同步到 GitHub/Gitee/开源”、“推一下开源宿主”、“更新开源客户端源码”；
  * **仅插件源码发版意图**：“同步一下开源插件大仓”、“把插件库推上去”、“发布插件生态”；
  * **发包 / 打包上传执行文件（Windows + macOS 双端三包齐发）意图**：“发包”、“打包商业版执行文件”、“打包安装包和免安装包”、“把最新安装包上传到 GitHub Release”、“发个新版本二进制包” → **先递增四段式版本号并同步源码至 GitHub/Gitee，再自动执行 `node scripts/package-release-binaries.mjs --rebuild-app --upload`**（同时完成 Windows EXE/ZIP 上传并自动触发云端 macOS Universal DMG 构建与挂载）。
- **AI 接收意图后的标准全自动执行 SOP（六步闭环流水线）**：
  1. **状态自审与门禁检测**：快速检查当前工作区，确认无高风险破坏或未完成代码，关键测试或构建处于稳定状态；
  2. **版本号核对与四段式自增（发包必做）**：检查 `electron-client/package.json` 版本号是否已在 GitHub Releases 存在；若已存在则自动递增为新的四段式版本号（`X.Y.Z.W`），同步更新 `package.json`、`electron-client/package.json`、`frontend/package.json`、`CHANGELOG.md` 与 `README.md`；
  3. **物理隔离安全复核**：严格审查待发布文件范围，确保 `DLLPlugins/`、`backend/`、`installer/`、`bin/` 等商业源码资产与 `.env.local` 等敏感配置绝对未越界；
  4. **调用统一同步/打包执行器**：
     - 先执行源码同步（自动双推 GitHub + Gitee）：`node scripts/sync-release.mjs [all|oss|extensions] [--msg "中文提交说明"]`；
     - 再执行双端二进制三包构建与上传（Windows + macOS）：`node scripts/package-release-binaries.mjs --rebuild-app --upload`，同时产出并上传 Windows `.exe` 安装包 + `-portable.zip` 免安装包，并自动联动 `scripts/build-macos-remote.mjs` 触发云端 macOS `.dmg` 安装包构建与上传；
  5. **提交状态、SHA 与远端 Release 六文件真机核对**：确认 GitHub 与 Gitee 双远端 git push 成功；发包时**必须等待云端 Mac 构建完毕并执行 `gh release view v<version> -R codingmuse/ZTools`**，确认 `.exe`、`.exe.sha256`、`-portable.zip`、`-portable.zip.sha256`、`-darwin-universal.dmg`、`-darwin-universal.dmg.sha256` 共 **6 个文件全部在远端 Release 页面挂载就绪**；
  6. **闭环反馈汇报**：向用户汇报新版本号、同步或打包上传完成概况，附带对应的 GitHub 与 Gitee 仓库/Release 地址及 macOS 云端构建链接（GitHub: [codingmuse/ZTools](https://github.com/codingmuse/ZTools) / Gitee: [hoposky/ZTools](https://gitee.com/hoposky/ZTools) / [ZTools-extensions](https://github.com/codingmuse/ZTools-extensions)），让用户彻底省心。

### 客户端启动与 Windows 桌面穿透规范（零容忍最高高压线，违者必究）

> [!CAUTION]
> **严禁直接在后台子进程中运行 `electron .`、`npx electron .` 或 `npm start`！**
> **根本原因**：AI 代理环境下的执行终端（pwsh / bash）属于非交互式沙盒上下文（Session/Desktop 隔离），如果直接在当前子进程启动 GUI，Windows 会将其隔离在不可见的虚拟桌面中，**用户物理主屏幕（`WinSta0\Default`）绝对无法看到任何窗口**！必须且只能使用任务计划程序（`schtasks /IT`）交互式投递到用户前台主桌面！

- **启动前互斥守则**：Electron 单例锁机制下，启动新实例前必须先清理旧实例（`Stop-Process -Name electron -Force -ErrorAction SilentlyContinue`），否则新实例因抢不到 `requestSingleInstanceLock` 会立即静默退出。
- **Windows 交互桌面穿透规范（强制执行唯一合法标准）**：
  * **标准唤起方式（首选且唯一标准）**：使用 Windows Task Scheduler 的 `/IT`（交互式任务）模式将进程直接投递到当前登录用户的物理桌面：
    ```powershell
    Stop-Process -Name electron -Force -ErrorAction SilentlyContinue
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

### Git 与子模块协作准则（强制执行）
- **提交备注强制使用中文**：提交 Git 代码时，提交备注/说明（Commit Message）必须 100% 使用中文编写（严禁纯英文提交），格式采用通用标准类型前缀 + 中文说明（例如：`feat: 新增...`、`fix: 修复...`、`refactor: 重构...`、`docs: 文档...`、`test: 测试...`、`chore: 构建/依赖...`）。
- **子模块协作边界**：本仓库是父仓库，`backend/`、`bin/`、`DLLPlugins/`、`docs/`、`electron-client/`、`frontend/`、`installer/`、`official-website/`、`plugins/` 均为子模块。
- **逐级提交原则**：修改子模块时先进入对应子模块目录提交和推送，父仓库仅记录子模块引用更新；除非用户明确说明，不要随意提交父仓库中的子模块引用变动。
