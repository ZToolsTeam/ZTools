import { McpTool, McpToolResult } from '../types/mcp.js';
import { McpServer } from '../mcp/server.js';
import { McpHost, ConnectedServerInfo } from '../mcp/host.js';
import { InMemoryTransport } from '../mcp/transport/in-memory.js';
import { searchFiles, SearchFilesArgs } from './search-files.js';
import { readClipboard, writeClipboard, ReadClipboardArgs, WriteClipboardArgs } from './clipboard.js';
import { manageWindow, ManageWindowArgs } from './window.js';

export const SEARCH_FILES_TOOL: McpTool = {
  name: 'search_files',
  description: '快速检索本地文件系统中的文件或目录，支持按文件名关键词、后缀类型、文件内容或指定搜索深度过滤',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索关键词或模式'
      },
      directory: {
        type: 'string',
        description: '可选的检索根目录路径，默认为工作区根目录'
      },
      maxResults: {
        type: 'integer',
        description: '最大返回结果数量（1-100，默认 20）'
      },
      fileTypes: {
        type: 'array',
        description: '限定文件后缀数组，例如 [".ts", ".json", ".md"]'
      },
      caseSensitive: {
        type: 'boolean',
        description: '是否区分大小写，默认 false'
      },
      contentMatch: {
        type: 'boolean',
        description: '是否同时搜索文本文件内容，默认 false'
      }
    },
    required: ['query']
  }
};

export const READ_CLIPBOARD_TOOL: McpTool = {
  name: 'read_clipboard',
  description: '读取系统剪贴板当前存储的内容（文本或 HTML 格式）',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['text', 'html'],
        description: '读取格式，默认为 text'
      }
    }
  }
};

export const WRITE_CLIPBOARD_TOOL: McpTool = {
  name: 'write_clipboard',
  description: '将指定内容写入系统剪贴板，支持普通文本或富文本 HTML',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '需要写入剪贴板的字符串内容'
      },
      format: {
        type: 'string',
        enum: ['text', 'html'],
        description: '写入格式，默认为 text'
      }
    },
    required: ['text']
  }
};

export const MANAGE_WINDOW_TOOL: McpTool = {
  name: 'manage_window',
  description: '调度管理当前 ZTools 桌面客户端窗口形态，支持置顶、最小化、最大化、恢复或屏幕边缘贴靠',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['minimize', 'maximize', 'restore', 'always_on_top', 'snap', 'focus', 'get_state'],
        description: '窗口操作动作'
      },
      options: {
        type: 'object',
        description: '附加配置项',
        properties: {
          alwaysOnTop: {
            type: 'boolean',
            description: '当 action 为 always_on_top 时指定置顶状态'
          },
          snapTo: {
            type: 'string',
            enum: ['left', 'right', 'top', 'bottom'],
            description: '当 action 为 snap 时指定贴靠方向'
          }
        }
      }
    },
    required: ['action']
  }
};

export const ZTOOLS_SYSTEM_TOOLS: McpTool[] = [
  SEARCH_FILES_TOOL,
  READ_CLIPBOARD_TOOL,
  WRITE_CLIPBOARD_TOOL,
  MANAGE_WINDOW_TOOL
];

/**
 * 创建内置 ZTools 系统能力的 MCP Server
 */
export function createZToolsSystemToolsServer(options?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: options?.name || 'ztools-system-tools',
    version: options?.version || '1.0.0'
  });

  server.registerTool(SEARCH_FILES_TOOL, async (args) => {
    return await searchFiles(args as unknown as SearchFilesArgs);
  });

  server.registerTool(READ_CLIPBOARD_TOOL, async (args) => {
    return await readClipboard(args as unknown as ReadClipboardArgs);
  });

  server.registerTool(WRITE_CLIPBOARD_TOOL, async (args) => {
    return await writeClipboard(args as unknown as WriteClipboardArgs);
  });

  server.registerTool(MANAGE_WINDOW_TOOL, async (args) => {
    return await manageWindow(args as unknown as ManageWindowArgs);
  });

  return server;
}

/**
 * 快速将 ZTools 系统能力直接挂载并注册到指定的 McpHost
 */
export async function registerSystemToolsToHost(
  host: McpHost,
  serverName: string = 'ztools-system'
): Promise<ConnectedServerInfo> {
  const server = createZToolsSystemToolsServer({ name: serverName });
  const [clientTransport, serverTransport] = InMemoryTransport.createPair();

  await server.connect(serverTransport);
  const connectedInfo = await host.connectServer(serverName, clientTransport);

  return connectedInfo;
}
