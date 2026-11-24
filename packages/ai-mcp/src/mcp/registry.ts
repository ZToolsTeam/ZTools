import {
  McpTool,
  McpToolInputSchema,
  McpToolResult,
  McpToolHandler,
  RegisteredTool,
  McpErrorCode
} from '../types/mcp.js';
import { AiMcpError, type AiMcpErrorCode, type AiMcpMessageParams, tAiMcp } from '../i18n.js';

export class ToolValidationError extends Error {
  public code: McpErrorCode = McpErrorCode.InvalidParams;
  public readonly i18nCode?: AiMcpErrorCode;
  public readonly params?: Readonly<AiMcpMessageParams>;

  constructor(message: string, i18nCode?: AiMcpErrorCode, params?: AiMcpMessageParams) {
    super(message);
    this.name = 'ToolValidationError';
    if (i18nCode) this.i18nCode = i18nCode;
    if (params) this.params = Object.freeze({ ...params });
  }
}

function createValidationError(code: AiMcpErrorCode, params?: AiMcpMessageParams): ToolValidationError {
  return new ToolValidationError(tAiMcp(code, params), code, params);
}

export class McpToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * 注册单个工具
   */
  public registerTool(tool: McpTool, handler: McpToolHandler): void {
    if (!tool.name || tool.name.trim().length === 0) {
      throw new AiMcpError('mcp.registry.emptyToolName');
    }

    const schema: McpToolInputSchema = tool.inputSchema || {
      type: 'object',
      properties: {}
    };

    this.tools.set(tool.name, {
      ...tool,
      inputSchema: schema,
      handler
    });
  }

  /**
   * 移除工具
   */
  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 获取工具元数据
   */
  public getTool(name: string): McpTool | undefined {
    const registered = this.tools.get(name);
    if (!registered) return undefined;
    return {
      name: registered.name,
      description: registered.description,
      inputSchema: registered.inputSchema
    };
  }

  /**
   * 列出所有已注册工具
   */
  public listTools(): McpTool[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }

  /**
   * 轻量 JSON Schema 参数校验器
   */
  public validateArgs(schema: McpToolInputSchema, args: Record<string, unknown>): void {
    if (typeof args !== 'object' || args === null) {
      throw createValidationError('mcp.registry.argsMustBeObject');
    }

    // 检查必填字段
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in args) || args[reqKey] === undefined || args[reqKey] === null) {
          throw createValidationError('mcp.registry.missingRequiredParam', { param: reqKey });
        }
      }
    }

    const properties = schema.properties || {};
    for (const [key, val] of Object.entries(args)) {
      const propDef = properties[key];
      if (!propDef) {
        if (schema.additionalProperties === false) {
          throw createValidationError('mcp.registry.unexpectedParam', { param: key });
        }
        continue;
      }

      // 类型校验
      if (val !== undefined && val !== null) {
        if (propDef.type === 'string' && typeof val !== 'string') {
          throw createValidationError('mcp.registry.paramMustBeString', { param: key });
        }
        if (propDef.type === 'number' && typeof val !== 'number') {
          throw createValidationError('mcp.registry.paramMustBeNumber', { param: key });
        }
        if (propDef.type === 'integer' && (!Number.isInteger(val))) {
          throw createValidationError('mcp.registry.paramMustBeInteger', { param: key });
        }
        if (propDef.type === 'boolean' && typeof val !== 'boolean') {
          throw createValidationError('mcp.registry.paramMustBeBoolean', { param: key });
        }
        if (propDef.type === 'array' && !Array.isArray(val)) {
          throw createValidationError('mcp.registry.paramMustBeArray', { param: key });
        }
        if (propDef.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
          throw createValidationError('mcp.registry.paramMustBeObject', { param: key });
        }

        // enum 校验
        if (Array.isArray(propDef.enum) && !propDef.enum.includes(val)) {
          throw createValidationError('mcp.registry.paramMustBeEnum', {
            param: key,
            allowed: propDef.enum.join(', '),
            actual: String(val)
          });
        }
      }
    }
  }

  /**
   * 执行指定工具
   */
  public async executeTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const registered = this.tools.get(name);
    if (!registered) {
      throw new AiMcpError('mcp.registry.toolNotFound', { name });
    }

    try {
      // 校验输入参数
      this.validateArgs(registered.inputSchema, args);

      const output = await registered.handler(args);

      if (typeof output === 'string') {
        return {
          content: [{ type: 'text', text: output }],
          isError: false
        };
      }

      if (typeof output === 'object' && output !== null) {
        if ('content' in output && Array.isArray((output as { content?: unknown }).content)) {
          return output as McpToolResult;
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          isError: false
        };
      }

      return {
        content: [{ type: 'text', text: String(output) }],
        isError: false
      };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: tAiMcp('mcp.registry.toolExecutionFailed', { reason }) }],
        isError: true
      };
    }
  }
}
