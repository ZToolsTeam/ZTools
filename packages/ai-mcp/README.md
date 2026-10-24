# @ztools/ai-mcp

> ZTools AI Native 基础设施与原生 MCP (Model Context Protocol) 核心网关

`@ztools/ai-mcp` 是 ZTools 平台的高性能、轻量化、纯净 AI 与 MCP 核心架构包，旨在为现代智能桌面端提供 **BYOK (Bring Your Own Key) 大模型路由网关** 以及遵循 Anthropic 协议标准的 **原生 MCP (Model Context Protocol) 全双工协议栈**。

---

## 核心特性

### 1. BYOK 统一大模型路由网关 (`ModelRouter`)
- **主流云端与本地大模型全覆盖**：
  - OpenAI Compatible：原生支持 DeepSeek（含 R1 推理思维链 `reasoning_content`）、OpenAI（GPT-4o、o1/o3-mini）、SiliconFlow（硅基流动）、自建兼容端点等；
  - Anthropic Claude：支持 Messages API、工具调用规范及流式 SSE 协议；
  - 本地离线大模型嗅探：自动检测并直连本地运行的 **Ollama** (`http://127.0.0.1:11434`) 与 **LM Studio** (`http://127.0.0.1:1234`)，零配置发现与免 key 载入。
- **流式输出 (Stream chunks)**：支持标准 `AsyncGenerator` 异步流输出，增量交付内容与思考过程。
- **Prompt 模板管理 (`PromptTemplateManager`)**：支持 `{{variable}}` 与 `{variable}` 插值、默认值兜底、必填参数校验及多种预设模板（文件检索、代码审查、摘要提炼、Agent 调度规划、结构化 JSON 抽取）。
- **Token 统计与精准估算 (`TokenTracker`)**：支持跨中英文和代码的启发式 Token 快速估算器，统计请求数、各模型 Token 分布、首字时延及多维报表。
- **弹性高可用与错误降级 (Fallback Chain)**：配置候选降级优先级链条，当主模型遭遇服务端 5xx、限流 429、网络中断或超时时，自动平滑切换至备选模型。

### 2. 原生 MCP (Model Context Protocol) 协议栈
- **ZTools 充当 MCP Host（客户端）**：
  - 完整遵循 Anthropic MCP 协议规范与标准 JSON-RPC 2.0 序列化；
  - 双向握手生命周期：`initialize` 协商 -> `notifications/initialized` -> `tools/list` 动态探测；
  - 支持多类型底层通信 Transport：
    - `InMemoryTransport`：高速进程内双向通道，无网络开销；
    - `StdioTransport`：基于子进程标准输入输出流的 MCP CLI 调度通道；
    - `HttpSseTransport`：远程 HTTP / Server-Sent Events MCP 通道。
- **反向暴露 ZTools 系统能力为 MCP Tools**：
  - `search_files`：高速检索工作区或指定目录下的本地文件，支持按名称、扩展名及内容检索，内置安全边界与深搜防护；
  - `read_clipboard` / `write_clipboard`：统一剪贴板读写调度，支持纯文本与富文本 HTML，支持桌面适配器无缝注入；
  - `manage_window`：ZTools 桌面窗口调度，支持置顶、最小化、最大化、还原、屏幕边缘贴靠（左/右/上/下分屏）与状态探测；
  - `createZToolsSystemToolsServer` / `registerSystemToolsToHost`：一键打包为标准 MCP Server 并挂载到 MCP Host。

---

## 安装与引入

```bash
# 作为 monorepo 内部包引用
import {
  ModelRouter,
  McpHost,
  registerSystemToolsToHost,
  createZToolsSystemToolsServer
} from '@ztools/ai-mcp';
```

---

## 使用指南

### 1. BYOK 大模型路由与流式交互

```typescript
import { ModelRouter } from '@ztools/ai-mcp';

const router = new ModelRouter();

// 注册云端 DeepSeek (BYOK)
router.registerProvider({
  id: 'my-deepseek',
  name: 'DeepSeek BYOK',
  type: 'deepseek',
  apiKey: 'sk-your-deepseek-key',
  defaultModel: 'deepseek-chat'
});

// 自动探测本地运行的 Ollama 或 LM Studio
const sniffResult = await router.autoDetectLocalProviders();
console.log('Detected local models:', sniffResult.allOnline);

// 配置错误降级链：若云端失败，自动降级至本地 Ollama
if (router.getProvider('local-ollama')) {
  router.setFallbackChain(['local-ollama']);
}

// 流式问答
for await (const chunk of router.chatStream({
  messages: [{ role: 'user', content: '写一个快速排序算法' }]
})) {
  if (chunk.delta.reasoningContent) {
    process.stdout.write(`[思考] ${chunk.delta.reasoningContent}`);
  }
  if (chunk.delta.content) {
    process.stdout.write(chunk.delta.content);
  }
}
```

### 2. 挂载 ZTools 系统能力并充当 MCP Host 调度工具

```typescript
import { McpHost, registerSystemToolsToHost } from '@ztools/ai-mcp';

const host = new McpHost({ name: 'ztools-desktop-client' });

// 将 search_files, read_clipboard, write_clipboard, manage_window 挂载到 Host
await registerSystemToolsToHost(host, 'ztools-system');

// 发现已接入工具
const tools = host.listTools();
console.log('Available MCP Tools:', tools.map(t => t.name));

// 1. 检索本地文件
const searchResult = await host.callTool('search_files', {
  query: 'package.json',
  fileTypes: ['.json']
});

// 2. 调度系统剪贴板
await host.callTool('write_clipboard', {
  text: 'Hello from MCP!'
});

// 3. 调度窗口分屏贴靠
await host.callTool('manage_window', {
  action: 'snap',
  options: { snapTo: 'left' }
});
```

### 3. 端到端 Autonomous Agent 自循环

```typescript
// 将 MCP Tools 转为大模型 Function Calling 描述
const mcpTools = host.listTools();
const modelTools = mcpTools.map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema
  }
}));

// 模型自主推理并触发 MCP 工具执行
const res = await router.chat({
  messages: [{ role: 'user', content: '查找 config.json 并将路径复制到剪贴板' }],
  tools: modelTools
});

if (res.message.toolCalls) {
  for (const call of res.message.toolCalls) {
    const output = await host.callTool(call.function.name, JSON.parse(call.function.arguments));
    console.log('Tool Result:', output);
  }
}
```

---

## 自动化测试与质量门禁

所有单测与端到端测试均采用 Node.js 原生测试套件执行：

```bash
# 执行类型构建与全量测试套件
npm test
```

测试套件涵盖：
1. `tests/token-tracker.test.mjs`：启发式多语种分词估算与指标聚合；
2. `tests/prompt-manager.test.mjs`：模板变量插值、默认值与预设模板；
3. `tests/local-sniffer.test.mjs`：本地 Ollama 与 LM Studio HTTP 探测；
4. `tests/model-router.test.mjs`：BYOK 多 Provider、DeepSeek R1 推理流、Claude 协议与 Fallback 降级；
5. `tests/mcp-protocol.test.mjs`：JSON-RPC 2.0、握手、Schema 校验与动态工具变更通知；
6. `tests/system-tools.test.mjs`：4 项 ZTools 核心能力（搜索、读剪贴板、写剪贴板、窗口控制）执行；
7. `tests/e2e-agent-loop.test.mjs`：AI 路由 -> 决策调用 MCP Tools -> 宿主执行 -> 结果反馈闭环。
