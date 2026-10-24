import {
  McpTool,
  McpToolInputSchema,
  McpToolResult,
  McpToolHandler,
  RegisteredTool,
  McpErrorCode
} from '../types/mcp.js';

export class ToolValidationError extends Error {
  public code: McpErrorCode = McpErrorCode.InvalidParams;
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export class McpToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * 注册单个工具
   */
  public registerTool(tool: McpTool, handler: McpToolHandler): void {
    if (!tool.name || tool.name.trim().length === 0) {
      throw new Error('Tool name cannot be empty');
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
  public validateArgs(schema: McpToolInputSchema, args: Record<string, any>): void {
    if (typeof args !== 'object' || args === null) {
      throw new ToolValidationError('Arguments must be an object');
    }

    // 检查必填字段
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in args) || args[reqKey] === undefined || args[reqKey] === null) {
          throw new ToolValidationError(`Missing required parameter: "${reqKey}"`);
        }
      }
    }

    const properties = schema.properties || {};
    for (const [key, val] of Object.entries(args)) {
      const propDef = properties[key];
      if (!propDef) {
        if (schema.additionalProperties === false) {
          throw new ToolValidationError(`Unexpected parameter: "${key}"`);
        }
        continue;
      }

      // 类型校验
      if (val !== undefined && val !== null) {
        if (propDef.type === 'string' && typeof val !== 'string') {
          throw new ToolValidationError(`Parameter "${key}" must be a string`);
        }
        if (propDef.type === 'number' && typeof val !== 'number') {
          throw new ToolValidationError(`Parameter "${key}" must be a number`);
        }
        if (propDef.type === 'integer' && (!Number.isInteger(val))) {
          throw new ToolValidationError(`Parameter "${key}" must be an integer`);
        }
        if (propDef.type === 'boolean' && typeof val !== 'boolean') {
          throw new ToolValidationError(`Parameter "${key}" must be a boolean`);
        }
        if (propDef.type === 'array' && !Array.isArray(val)) {
          throw new ToolValidationError(`Parameter "${key}" must be an array`);
        }
        if (propDef.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
          throw new ToolValidationError(`Parameter "${key}" must be an object`);
        }

        // enum 校验
        if (Array.isArray(propDef.enum) && !propDef.enum.includes(val)) {
          throw new ToolValidationError(
            `Parameter "${key}" must be one of: [${propDef.enum.join(', ')}], got: "${val}"`
          );
        }
      }
    }
  }

  /**
   * 执行指定工具
   */
  public async executeTool(name: string, args: Record<string, any> = {}): Promise<McpToolResult> {
    const registered = this.tools.get(name);
    if (!registered) {
      throw new Error(`Tool "${name}" not found`);
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
        if ('content' in output && Array.isArray((output as any).content)) {
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
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Tool execution failed: ${err.message || String(err)}` }],
        isError: true
      };
    }
  }
}
