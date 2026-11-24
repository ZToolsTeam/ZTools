import { McpTool } from '../types/mcp.js';
import { McpServer } from '../mcp/server.js';
import { McpHost, ConnectedServerInfo } from '../mcp/host.js';
import { InMemoryTransport } from '../mcp/transport/in-memory.js';
import { AiMcpLocale, resolveAiMcpLocale } from '../i18n.js';
import { searchFiles, SearchFilesArgs } from './search-files.js';
import { readClipboard, writeClipboard, ReadClipboardArgs, WriteClipboardArgs } from './clipboard.js';
import { manageWindow, ManageWindowArgs } from './window.js';

interface SystemToolCopy {
  searchFiles: {
    description: string;
    query: string;
    directory: string;
    maxResults: string;
    fileTypes: string;
    caseSensitive: string;
    contentMatch: string;
  };
  readClipboard: {
    description: string;
    format: string;
  };
  writeClipboard: {
    description: string;
    text: string;
    format: string;
  };
  manageWindow: {
    description: string;
    action: string;
    options: string;
    alwaysOnTop: string;
    snapTo: string;
  };
}

const SYSTEM_TOOL_MESSAGES: Record<AiMcpLocale, SystemToolCopy> = {
  'en-US': {
    searchFiles: {
      description:
        'Quickly search files or directories in the local filesystem with filtering by filename keyword, extension, file content, or search depth',
      query: 'Search keyword or pattern',
      directory: 'Optional root directory path to search; defaults to the workspace root',
      maxResults: 'Maximum number of results to return (1-100, default 20)',
      fileTypes: 'Array of allowed file extensions, e.g. [".ts", ".json", ".md"]',
      caseSensitive: 'Whether matching is case-sensitive, default false',
      contentMatch: 'Whether to also search inside text file contents, default false'
    },
    readClipboard: {
      description: 'Read the current content stored in the system clipboard (text or HTML format)',
      format: 'Read format, defaults to text'
    },
    writeClipboard: {
      description: 'Write specified content to the system clipboard in plain text or rich HTML format',
      text: 'String content to write to the clipboard',
      format: 'Write format, defaults to text'
    },
    manageWindow: {
      description:
        'Control the current ZTools desktop client window state, including always-on-top, minimize, maximize, restore, or screen edge snapping',
      action: 'Window operation action',
      options: 'Additional options',
      alwaysOnTop: 'Target always-on-top state when action is always_on_top',
      snapTo: 'Target snap edge direction when action is snap'
    }
  },
  'zh-CN': {
    searchFiles: {
      description: '快速检索本地文件系统中的文件或目录，支持按文件名关键词、后缀类型、文件内容或指定搜索深度过滤',
      query: '检索关键词或模式',
      directory: '可选的检索根目录路径，默认为工作区根目录',
      maxResults: '最大返回结果数量（1-100，默认 20）',
      fileTypes: '限定文件后缀数组，例如 [".ts", ".json", ".md"]',
      caseSensitive: '是否区分大小写，默认 false',
      contentMatch: '是否同时搜索文本文件内容，默认 false'
    },
    readClipboard: {
      description: '读取系统剪贴板当前存储的内容（文本或 HTML 格式）',
      format: '读取格式，默认为 text'
    },
    writeClipboard: {
      description: '将指定内容写入系统剪贴板，支持普通文本或富文本 HTML',
      text: '需要写入剪贴板的字符串内容',
      format: '写入格式，默认为 text'
    },
    manageWindow: {
      description: '调度管理当前 ZTools 桌面客户端窗口形态，支持置顶、最小化、最大化、恢复或屏幕边缘贴靠',
      action: '窗口操作动作',
      options: '附加配置项',
      alwaysOnTop: '当 action 为 always_on_top 时指定置顶状态',
      snapTo: '当 action 为 snap 时指定贴靠方向'
    }
  }
};

/**
 * 按指定或当前运行语言生成 search_files 工具定义
 */
export function createSearchFilesTool(locale?: string): McpTool {
  const copy = SYSTEM_TOOL_MESSAGES[resolveAiMcpLocale(locale)].searchFiles;
  return {
    name: 'search_files',
    description: copy.description,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: copy.query
        },
        directory: {
          type: 'string',
          description: copy.directory
        },
        maxResults: {
          type: 'integer',
          description: copy.maxResults
        },
        fileTypes: {
          type: 'array',
          description: copy.fileTypes
        },
        caseSensitive: {
          type: 'boolean',
          description: copy.caseSensitive
        },
        contentMatch: {
          type: 'boolean',
          description: copy.contentMatch
        }
      },
      required: ['query']
    }
  };
}

/**
 * 按指定或当前运行语言生成 read_clipboard 工具定义
 */
export function createReadClipboardTool(locale?: string): McpTool {
  const copy = SYSTEM_TOOL_MESSAGES[resolveAiMcpLocale(locale)].readClipboard;
  return {
    name: 'read_clipboard',
    description: copy.description,
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: copy.format
        }
      }
    }
  };
}

/**
 * 按指定或当前运行语言生成 write_clipboard 工具定义
 */
export function createWriteClipboardTool(locale?: string): McpTool {
  const copy = SYSTEM_TOOL_MESSAGES[resolveAiMcpLocale(locale)].writeClipboard;
  return {
    name: 'write_clipboard',
    description: copy.description,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: copy.text
        },
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: copy.format
        }
      },
      required: ['text']
    }
  };
}

/**
 * 按指定或当前运行语言生成 manage_window 工具定义
 */
export function createManageWindowTool(locale?: string): McpTool {
  const copy = SYSTEM_TOOL_MESSAGES[resolveAiMcpLocale(locale)].manageWindow;
  return {
    name: 'manage_window',
    description: copy.description,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['minimize', 'maximize', 'restore', 'always_on_top', 'snap', 'focus', 'get_state'],
          description: copy.action
        },
        options: {
          type: 'object',
          description: copy.options,
          properties: {
            alwaysOnTop: {
              type: 'boolean',
              description: copy.alwaysOnTop
            },
            snapTo: {
              type: 'string',
              enum: ['left', 'right', 'top', 'bottom'],
              description: copy.snapTo
            }
          }
        }
      },
      required: ['action']
    }
  };
}

/**
 * 按指定或当前运行语言动态生成全部内置 ZTools 系统 MCP 工具定义
 */
export function getZToolsSystemTools(locale?: string): McpTool[] {
  return [
    createSearchFilesTool(locale),
    createReadClipboardTool(locale),
    createWriteClipboardTool(locale),
    createManageWindowTool(locale)
  ];
}

// 兼容原有静态导出（模块加载时遵循当前运行 locale，默认 en-US）
export const SEARCH_FILES_TOOL: McpTool = createSearchFilesTool();
export const READ_CLIPBOARD_TOOL: McpTool = createReadClipboardTool();
export const WRITE_CLIPBOARD_TOOL: McpTool = createWriteClipboardTool();
export const MANAGE_WINDOW_TOOL: McpTool = createManageWindowTool();

export const ZTOOLS_SYSTEM_TOOLS: McpTool[] = [
  SEARCH_FILES_TOOL,
  READ_CLIPBOARD_TOOL,
  WRITE_CLIPBOARD_TOOL,
  MANAGE_WINDOW_TOOL
];

/**
 * 创建内置 ZTools 系统能力的 MCP Server
 */
export function createZToolsSystemToolsServer(options?: {
  name?: string;
  version?: string;
  locale?: string;
}): McpServer {
  const server = new McpServer({
    name: options?.name || 'ztools-system-tools',
    version: options?.version || '1.0.0'
  });

  server.registerTool(createSearchFilesTool(options?.locale), async (args) => {
    return await searchFiles(args as unknown as SearchFilesArgs, options?.locale);
  });

  server.registerTool(createReadClipboardTool(options?.locale), async (args) => {
    return await readClipboard(args as unknown as ReadClipboardArgs);
  });

  server.registerTool(createWriteClipboardTool(options?.locale), async (args) => {
    return await writeClipboard(args as unknown as WriteClipboardArgs, options?.locale);
  });

  server.registerTool(createManageWindowTool(options?.locale), async (args) => {
    return await manageWindow(args as unknown as ManageWindowArgs, options?.locale);
  });

  return server;
}

/**
 * 快速将 ZTools 系统能力直接挂载并注册到指定的 McpHost
 */
export async function registerSystemToolsToHost(
  host: McpHost,
  serverName: string = 'ztools-system',
  options?: { locale?: string }
): Promise<ConnectedServerInfo> {
  const server = createZToolsSystemToolsServer({ name: serverName, locale: options?.locale });
  const [clientTransport, serverTransport] = InMemoryTransport.createPair();

  await server.connect(serverTransport);
  const connectedInfo = await host.connectServer(serverName, clientTransport);

  return connectedInfo;
}
