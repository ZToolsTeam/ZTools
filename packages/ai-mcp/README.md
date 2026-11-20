# @ztools/ai-mcp

> AI-native BYOK model router and Model Context Protocol (MCP) gateway for ZTools  
> ZTools AI Native 基础设施与原生 MCP (Model Context Protocol) 核心网关

`@ztools/ai-mcp` provides a lightweight **BYOK (Bring Your Own Key) LLM router** (OpenAI-compatible, Anthropic Claude, local Ollama & LM Studio) and a full-duplex **MCP (Model Context Protocol)** host/server stack for ZTools.

`@ztools/ai-mcp` 是 ZTools 平台的轻量化 AI 与 MCP 核心架构包，提供 **BYOK 大模型路由网关**（支持 OpenAI Compatible、Anthropic Claude 与本地 Ollama / LM Studio 自动发现）以及标准 **MCP (Model Context Protocol) 全双工协议栈**。

---

## Core Capabilities / 核心特性

### 1. BYOK Model Router (`ModelRouter`) / BYOK 统一大模型路由网关
- **Cloud & Local Providers / 云端与本地模型**：
  - OpenAI Compatible: DeepSeek (including R1 `reasoning_content`), OpenAI, SiliconFlow, and custom compatible endpoints. / 原生支持 DeepSeek（含 R1 推理思维链）、OpenAI、硅基流动及自建兼容端点。
  - Anthropic Claude: Messages API, tool calling, and streaming SSE. / 支持 Messages API、工具调用规范及流式 SSE。
  - Local Offline Discovery: auto-detects **Ollama** (`http://127.0.0.1:11434`) and **LM Studio** (`http://127.0.0.1:1234`) with zero-config key-free loading. / 自动探测本地 Ollama 与 LM Studio，零配置免 Key 载入。
- **Streaming / 流式输出**：`AsyncGenerator` incremental content and reasoning chunks.
- **Prompt Templates (`PromptTemplateManager`) / Prompt 模板管理**：`{{variable}}` / `{variable}` interpolation, defaults, validation, and built-in presets.
- **Token Tracking (`TokenTracker`) / Token 统计估算**：Heuristic multi-language token estimator, latency tracking, and usage summaries.
- **Fallback Chain / 弹性降级链**：Automatically fails over to backup providers on 5xx, 429, timeout, or network errors.

### 2. Native MCP Stack / 原生 MCP 协议栈
- **MCP Host (`McpHost`)**：JSON-RPC 2.0 handshake (`initialize` -> `notifications/initialized` -> `tools/list`) over `InMemoryTransport`, `StdioTransport`, and `HttpSseTransport`.
- **ZTools System Tools (`createZToolsSystemToolsServer` / `registerSystemToolsToHost`)**：Exposes `search_files`, `read_clipboard`, `write_clipboard`, and `manage_window` as standard MCP tools.

---

## Usage / 使用指南

```typescript
import { ModelRouter, McpHost, registerSystemToolsToHost } from '@ztools/ai-mcp';

// 1. Register BYOK provider & auto-detect local models
const router = new ModelRouter();
router.registerProvider({
  id: 'my-deepseek',
  name: 'DeepSeek BYOK',
  type: 'deepseek',
  apiKey: 'sk-your-deepseek-key',
  defaultModel: 'deepseek-chat'
});
await router.autoDetectLocalProviders();

// 2. Mount ZTools system capabilities as MCP tools
const host = new McpHost({ name: 'ztools-desktop-client' });
await registerSystemToolsToHost(host, 'ztools-system');
const tools = host.listTools();
```

---

## Testing / 自动化测试

```bash
npm test
```

Covers `token-tracker`, `prompt-manager`, `local-sniffer`, `model-router`, `mcp-protocol`, `system-tools`, and `e2e-agent-loop` under `tests/`. / 覆盖 `tests/` 下的分词统计、模板管理、本地探测、模型路由、MCP 协议、系统工具与端到端 Agent 闭环测试。
