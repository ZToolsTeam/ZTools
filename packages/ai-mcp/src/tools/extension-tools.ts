import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  McpTool,
  McpToolInputSchema,
  McpToolResult
} from '../types/mcp.js';
import { McpHost } from '../mcp/host.js';
import { McpServer } from '../mcp/server.js';
import { InMemoryTransport } from '../mcp/transport/in-memory.js';

export interface ToolEntryPointOptions {
  /** 插件工具文件路径（绝对路径或相对路径） */
  toolPath: string;
  /** 导出的函数名，默认为 'default' */
  exportName?: string;
  /** 调用工具传入的参数（对象、JSON 字符串或异常类型） */
  args?: unknown;
  /** 超时保护时限（毫秒），默认为 30000ms */
  timeoutMs?: number;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

export interface ExtensionToolDefinition {
  name: string;
  description: string;
  inputSchema?: McpToolInputSchema;
  toolPath: string;
  exportName?: string;
  /** 是否需要人工二次确认（Human-in-the-Loop） */
  confirmation?: boolean;
  /** 人工确认时展示的提示文案 */
  confirmationPrompt?: string;
}

export interface ToolConfirmationRequest {
  pluginId: string;
  toolName: string;
  args: Record<string, unknown>;
  confirmationPrompt?: string;
}

export type ToolConfirmationHandler = (
  request: ToolConfirmationRequest
) => Promise<boolean> | boolean;

export interface ExtensionManifestForTools {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  dir?: string;
  enabled?: boolean;
  revoked?: boolean;
  revokedReason?: string;
  tools?: ExtensionToolDefinition[];
  commands?: Array<{
    name: string;
    title?: string;
    description?: string;
    mode?: string;
    entry?: string;
    confirmation?: boolean;
    confirmationPrompt?: string;
    inputSchema?: McpToolInputSchema;
  }>;
}

export interface ExtensionToolManagerOptions {
  host?: McpHost;
  serverName?: string;
  serverVersion?: string;
  confirmHandler?: ToolConfirmationHandler;
  defaultTimeoutMs?: number;
  allowUnconfirmedIfNoHandler?: boolean;
}

export interface RegisteredExtensionTool {
  pluginId: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema?: McpToolInputSchema;
  toolPath: string;
  exportName: string;
  confirmation: boolean;
  confirmationPrompt?: string;
}

interface ExtensionInternalRecord {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  revoked: boolean;
  revokedReason?: string;
  tools: Map<string, RegisteredExtensionTool>;
  registeredToolNames: Set<string>;
}

/**
 * 序列化工具输出结果，具备循环引用与 BigInt 熔断防护
 */
export function serializeToolOutput(rawResult: unknown): McpToolResult {
  if (rawResult === undefined || rawResult === null) {
    return {
      isError: false,
      content: [{ type: 'text', text: 'null' }]
    };
  }

  if (typeof rawResult === 'string') {
    return {
      isError: false,
      content: [{ type: 'text', text: rawResult }]
    };
  }

  if (typeof rawResult === 'number' || typeof rawResult === 'boolean') {
    return {
      isError: false,
      content: [{ type: 'text', text: String(rawResult) }]
    };
  }

  if (typeof rawResult === 'bigint') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Tool output serialization failed: BigInt cannot be serialized to JSON' }]
    };
  }

  if (typeof rawResult === 'object') {
    const objResult = rawResult as Record<string, unknown>;
    if ('content' in objResult && Array.isArray(objResult.content)) {
      return rawResult as McpToolResult;
    }

    try {
      const text = JSON.stringify(rawResult, (_key, value) => {
        if (typeof value === 'bigint') {
          throw new TypeError('Do not know how to serialize a BigInt');
        }
        return value;
      }, 2);

      return {
        isError: false,
        content: [{ type: 'text', text }]
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('circular') || msg.includes('cyclic')) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Tool output serialization failed: Circular reference detected in tool output' }]
        };
      }
      if (msg.includes('BigInt')) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Tool output serialization failed: BigInt cannot be serialized to JSON' }]
        };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool output serialization failed: ${msg}` }]
      };
    }
  }

  return {
    isError: false,
    content: [{ type: 'text', text: String(rawResult) }]
  };
}

/**
 * M4-1: Worker / Runtime 执行 tool 入口点函数
 * 严密校验 JSON 参数、动态加载模块、捕获运行时异常与非可序列化结果
 */
export async function executeToolEntryPoint(options: ToolEntryPointOptions): Promise<McpToolResult> {
  // 1. 校验与解析 arguments
  let parsedArgs: Record<string, unknown>;
  const rawArgs = options.args;

  if (rawArgs === undefined || rawArgs === null) {
    parsedArgs = {};
  } else if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (trimmed.length === 0) {
      parsedArgs = {};
    } else {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Tool arguments must be a JSON object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`
            }]
          };
        }
        parsedArgs = parsed as Record<string, unknown>;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Invalid JSON input arguments: ${errMsg}` }]
        };
      }
    }
  } else if (typeof rawArgs === 'object') {
    if (Array.isArray(rawArgs)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Tool arguments must be an object, not an array' }]
      };
    }
    parsedArgs = rawArgs as Record<string, unknown>;
  } else {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool arguments must be an object or JSON string, got ${typeof rawArgs}` }]
    };
  }

  // 2. 检查与解析模块路径
  const resolvedPath = path.isAbsolute(options.toolPath)
    ? options.toolPath
    : path.resolve(options.cwd || process.cwd(), options.toolPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool file not found: "${resolvedPath}"` }]
    };
  }

  // 3. 动态加载模块
  let mod: Record<string, unknown>;
  try {
    const stat = fs.statSync(resolvedPath);
    const fileUrl = pathToFileURL(resolvedPath);
    fileUrl.searchParams.set('v', String(Math.trunc(stat.mtimeMs)));
    mod = (await import(fileUrl.href)) as Record<string, unknown>;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to load tool module "${resolvedPath}": ${errMsg}` }]
    };
  }

  // 4. 定位目标导出函数
  const exportName = options.exportName || 'default';
  let targetFn: ((args: Record<string, unknown>) => unknown) | undefined;
  const modDefault = mod?.default as Record<string, unknown> | ((args: Record<string, unknown>) => unknown) | undefined;

  if (mod && typeof mod[exportName] === 'function') {
    targetFn = mod[exportName] as (args: Record<string, unknown>) => unknown;
  } else if (exportName === 'default' && typeof modDefault === 'function') {
    targetFn = modDefault;
  } else if (exportName === 'default' && typeof mod === 'function') {
    targetFn = mod as unknown as (args: Record<string, unknown>) => unknown;
  } else if (modDefault && typeof modDefault === 'object' && typeof modDefault[exportName] === 'function') {
    targetFn = modDefault[exportName] as (args: Record<string, unknown>) => unknown;
  } else {
    const actualType = mod && mod[exportName] !== undefined
      ? typeof mod[exportName]
      : (exportName === 'default' && modDefault !== undefined ? typeof modDefault : typeof mod);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `Tool export "${exportName}" in "${resolvedPath}" is not a function (got ${actualType})`
      }]
    };
  }

  // 5. 执行函数并配置看门狗超时机制
  const timeoutMs = options.timeoutMs ?? 30000;
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const fnToCall = targetFn!;
    const execPromise = Promise.resolve().then(() => fnToCall(parsedArgs));
    const rawResult = await Promise.race([execPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    return serializeToolOutput(rawResult);
  } catch (err: unknown) {
    if (timer) clearTimeout(timer);
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Tool execution failed: ${errMsg}` }]
    };
  }
}

/**
 * M4-2 & M4-3: 扩展工具管理器
 * 动态挂载到 McpHost、生命周期自动解绑与 Human-in-the-Loop 二次确认机制
 */
export class ExtensionToolManager {
  public readonly serverName: string;
  public readonly server: McpServer;
  private host?: McpHost;
  private confirmHandler?: ToolConfirmationHandler;
  private defaultTimeoutMs: number;
  private allowUnconfirmedIfNoHandler: boolean;
  private extensions: Map<string, ExtensionInternalRecord> = new Map();

  constructor(options: ExtensionToolManagerOptions = {}) {
    this.serverName = options.serverName || 'ztools-extensions';
    this.server = new McpServer({
      name: this.serverName,
      version: options.serverVersion || '1.0.0'
    });
    this.confirmHandler = options.confirmHandler;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 30000;
    this.allowUnconfirmedIfNoHandler = options.allowUnconfirmedIfNoHandler ?? false;
  }

  /**
   * 挂载连接至 McpHost 网关
   */
  public async attachHost(host: McpHost): Promise<void> {
    if (this.host) {
      throw new Error(`ExtensionToolManager is already attached to host`);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createPair();
    await this.server.connect(serverTransport);
    await host.connectServer(this.serverName, clientTransport);
    this.host = host;
  }

  /**
   * 设置人工交互二次确认回调
   */
  public setConfirmHandler(handler?: ToolConfirmationHandler): void {
    this.confirmHandler = handler;
  }

  /**
   * 注册单个扩展插件清单中的所有 Tools
   */
  public async registerExtension(manifest: ExtensionManifestForTools): Promise<RegisteredExtensionTool[]> {
    if (!manifest || !manifest.id || typeof manifest.id !== 'string') {
      throw new Error('Invalid extension manifest: id is required');
    }

    const pluginId = manifest.id.trim();
    if (!pluginId) {
      throw new Error('Extension id cannot be empty');
    }

    const toolsToRegister: RegisteredExtensionTool[] = [];
    const baseDir = manifest.dir || process.cwd();

    // 1. 提取 manifest.tools 声明
    if (Array.isArray(manifest.tools)) {
      for (const t of manifest.tools) {
        if (!t.name || !t.toolPath) continue;
        const resolvedPath = path.isAbsolute(t.toolPath) ? t.toolPath : path.resolve(baseDir, t.toolPath);
        toolsToRegister.push({
          pluginId,
          name: t.name,
          qualifiedName: `${pluginId}__${t.name}`,
          description: t.description || `Tool ${t.name} from ${pluginId}`,
          inputSchema: t.inputSchema,
          toolPath: resolvedPath,
          exportName: t.exportName || 'default',
          confirmation: t.confirmation === true,
          confirmationPrompt: t.confirmationPrompt
        });
      }
    }

    // 2. 提取 manifest.commands 中声明 mode 为 tool 的指令
    if (Array.isArray(manifest.commands)) {
      for (const cmd of manifest.commands) {
        if (cmd.mode === 'tool' && cmd.entry) {
          const resolvedPath = path.isAbsolute(cmd.entry) ? cmd.entry : path.resolve(baseDir, cmd.entry);
          toolsToRegister.push({
            pluginId,
            name: cmd.name,
            qualifiedName: `${pluginId}__${cmd.name}`,
            description: cmd.description || cmd.title || `Tool command ${cmd.name} from ${pluginId}`,
            inputSchema: cmd.inputSchema,
            toolPath: resolvedPath,
            exportName: 'default',
            confirmation: cmd.confirmation === true,
            confirmationPrompt: cmd.confirmationPrompt
          });
        }
      }
    }

    // 3. 构建/更新记录（若已存在同一 pluginId，先卸载清理旧工具避免残留）
    const existingRecord = this.extensions.get(pluginId);
    if (existingRecord) {
      this.unmountExtensionTools(existingRecord);
      existingRecord.tools.clear();
    }

    const record: ExtensionInternalRecord = existingRecord ?? {
      id: pluginId,
      name: manifest.name || pluginId,
      version: manifest.version || '1.0.0',
      enabled: manifest.enabled !== false,
      revoked: manifest.revoked === true,
      revokedReason: manifest.revokedReason,
      tools: new Map(),
      registeredToolNames: new Set()
    };

    if (existingRecord) {
      record.name = manifest.name || record.name;
      record.version = manifest.version || record.version;
      record.enabled = manifest.enabled !== false;
      record.revoked = manifest.revoked === true;
      record.revokedReason = manifest.revokedReason;
    } else {
      this.extensions.set(pluginId, record);
    }

    for (const tool of toolsToRegister) {
      record.tools.set(tool.name, tool);
    }

    // 4. 若插件处于有效启用状态，挂载工具至 MCP 注册表
    if (record.enabled && !record.revoked) {
      this.mountExtensionTools(record);
    }

    await this.syncHostTools();
    return toolsToRegister;
  }

  /**
   * 挂载指定插件的工具到 McpServer 注册表
   */
  private mountExtensionTools(record: ExtensionInternalRecord): void {
    for (const tool of record.tools.values()) {
      const toolHandler = async (args: Record<string, unknown>) => {
        // 门禁 1: 检查插件是否被禁用
        if (!record.enabled) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Extension "${record.id}" is currently disabled` }]
          };
        }

        // 门禁 2: 检查插件是否被官方下架封禁 (revoked)
        if (record.revoked) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Extension "${record.id}" has been revoked: ${record.revokedReason || 'security policy'}` }]
          };
        }

        // 门禁 3: M4-3 Human-in-the-Loop 二次确认检查
        if (tool.confirmation) {
          if (this.confirmHandler) {
            try {
              const confirmed = await this.confirmHandler({
                pluginId: record.id,
                toolName: tool.name,
                args,
                confirmationPrompt: tool.confirmationPrompt
              });

              if (!confirmed) {
                return {
                  isError: true,
                  content: [{ type: 'text', text: `Tool execution cancelled by user: User denied confirmation for "${tool.name}"` }]
                };
              }
            } catch (confirmErr: unknown) {
              const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr);
              return {
                isError: true,
                content: [{ type: 'text', text: `Tool execution cancelled: Confirmation error (${errMsg})` }]
              };
            }
          } else if (!this.allowUnconfirmedIfNoHandler) {
            return {
              isError: true,
              content: [{ type: 'text', text: `Tool "${tool.name}" requires confirmation, but no confirmation handler is available` }]
            };
          }
        }

        // 门禁 4: 调用执行入口
        return await executeToolEntryPoint({
          toolPath: tool.toolPath,
          exportName: tool.exportName,
          args,
          timeoutMs: this.defaultTimeoutMs
        });
      };

      const mcpDef: McpTool = {
        name: tool.qualifiedName,
        description: tool.description,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} }
      };

      // 注册全名 (pluginId__toolName)
      this.server.registerTool(mcpDef, toolHandler);
      record.registeredToolNames.add(tool.qualifiedName);

      // 若未冲突，同时注册短别名 (toolName) 便于平滑调用
      const existingShort = this.server.registry.getTool(tool.name);
      if (!existingShort) {
        this.server.registerTool(
          {
            ...mcpDef,
            name: tool.name
          },
          toolHandler
        );
        record.registeredToolNames.add(tool.name);
      }
    }
  }

  /**
   * 卸载指定插件在 McpServer 注册表中的工具
   */
  private unmountExtensionTools(record: ExtensionInternalRecord): void {
    for (const toolName of record.registeredToolNames) {
      this.server.registry.unregisterTool(toolName);
    }
    record.registeredToolNames.clear();
  }

  /**
   * M4-2 禁用扩展插件：从 MCP Server 移除工具，彻底杜绝悬空调用
   */
  public async disableExtension(pluginId: string): Promise<boolean> {
    const record = this.extensions.get(pluginId);
    if (!record) return false;

    record.enabled = false;
    this.unmountExtensionTools(record);
    await this.syncHostTools();
    return true;
  }

  /**
   * M4-2 重新启用扩展插件：重新挂载工具到 MCP Server
   */
  public async enableExtension(pluginId: string): Promise<boolean> {
    const record = this.extensions.get(pluginId);
    if (!record) return false;

    if (record.revoked) {
      throw new Error(`Cannot enable revoked extension "${pluginId}": ${record.revokedReason || 'revoked by policy'}`);
    }

    record.enabled = true;
    this.mountExtensionTools(record);
    await this.syncHostTools();
    return true;
  }

  /**
   * M4-2 封禁/下架扩展插件 (Revoke)
   */
  public async revokeExtension(pluginId: string, reason?: string): Promise<boolean> {
    const record = this.extensions.get(pluginId);
    if (!record) return false;

    record.revoked = true;
    record.enabled = false;
    record.revokedReason = reason || 'Revoked by security policy';
    this.unmountExtensionTools(record);
    await this.syncHostTools();
    return true;
  }

  /**
   * M4-2 卸载扩展插件 (Uninstall)
   */
  public async uninstallExtension(pluginId: string): Promise<boolean> {
    const record = this.extensions.get(pluginId);
    if (!record) return false;

    this.unmountExtensionTools(record);
    this.extensions.delete(pluginId);
    await this.syncHostTools();
    return true;
  }

  /**
   * 检查指定扩展是否已注册
   */
  public getExtension(pluginId: string): ExtensionInternalRecord | undefined {
    return this.extensions.get(pluginId);
  }

  /**
   * 列出当前所有已注册的扩展信息
   */
  public listExtensions(): Array<{
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    revoked: boolean;
    toolsCount: number;
  }> {
    return Array.from(this.extensions.values()).map(r => ({
      id: r.id,
      name: r.name,
      version: r.version,
      enabled: r.enabled,
      revoked: r.revoked,
      toolsCount: r.tools.size
    }));
  }

  /**
   * 同步通知 McpHost 工具列表变更
   */
  public async syncHostTools(): Promise<void> {
    try {
      await this.server.notifyToolsChanged();
      if (this.host) {
        await this.host.refreshServerTools(this.serverName);
      }
    } catch {
      // Host 尚未挂载或连接已断开时静默降级，不阻断本地注册表变更
    }
  }
}
