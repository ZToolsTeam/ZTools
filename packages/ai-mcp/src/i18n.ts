export type AiMcpLocale = 'en-US' | 'zh-CN';

export type AiMcpMessageKey =
  | 'prompt.emptyName'
  | 'prompt.notFound'
  | 'prompt.missingVariable'
  | 'tools.searchFiles.emptyQuery'
  | 'tools.searchFiles.directoryNotFound'
  | 'tools.clipboard.invalidText'
  | 'tools.window.unsupportedAction'
  // mcp/host.ts
  | 'mcp.host.serverDisconnected'
  | 'mcp.host.serverAlreadyConnected'
  | 'mcp.host.serverNotConnected'
  | 'mcp.host.serverIsNotConnected'
  | 'mcp.host.toolNotFoundOnServer'
  | 'mcp.host.toolNotFoundAnyServer'
  | 'mcp.host.requestTimedOut'
  | 'mcp.host.rpcError'
  // mcp/registry.ts
  | 'mcp.registry.emptyToolName'
  | 'mcp.registry.argsMustBeObject'
  | 'mcp.registry.missingRequiredParam'
  | 'mcp.registry.unexpectedParam'
  | 'mcp.registry.paramMustBeString'
  | 'mcp.registry.paramMustBeNumber'
  | 'mcp.registry.paramMustBeInteger'
  | 'mcp.registry.paramMustBeBoolean'
  | 'mcp.registry.paramMustBeArray'
  | 'mcp.registry.paramMustBeObject'
  | 'mcp.registry.paramMustBeEnum'
  | 'mcp.registry.toolNotFound'
  | 'mcp.registry.toolExecutionFailed'
  // mcp/server.ts
  | 'mcp.server.toolNameRequired'
  | 'mcp.server.toolNotFound'
  | 'mcp.server.methodNotSupported'
  // router/model-router.ts
  | 'router.providerIdRequired'
  | 'router.providerNotRegistered'
  | 'router.noProviderSelected'
  | 'router.primaryProviderNotFound'
  | 'router.allProvidersFailed'
  | 'router.allStreamProvidersFailed'
  // tools/extension-tools.ts
  | 'extTools.serializeBigInt'
  | 'extTools.serializeCircular'
  | 'extTools.serializeFailed'
  | 'extTools.argsMustBeJsonObject'
  | 'extTools.invalidJsonArgs'
  | 'extTools.argsNotArray'
  | 'extTools.argsMustBeObjectOrJson'
  | 'extTools.toolFileNotFound'
  | 'extTools.loadModuleFailed'
  | 'extTools.exportNotFunction'
  | 'extTools.executionTimedOut'
  | 'extTools.executionFailed'
  | 'extTools.managerAlreadyAttached'
  | 'extTools.manifestIdRequired'
  | 'extTools.emptyExtensionId'
  | 'extTools.extensionDisabled'
  | 'extTools.extensionRevoked'
  | 'extTools.defaultRevokedReason'
  | 'extTools.confirmationDenied'
  | 'extTools.confirmationError'
  | 'extTools.confirmationHandlerMissing'
  | 'extTools.cannotEnableRevoked'
  | 'extTools.defaultRevokedPolicy'
  | 'extTools.defaultRevokedSecurityPolicy';

export type AiMcpErrorCode = AiMcpMessageKey;

export type AiMcpMessageParams = Record<string, string | number>;

interface GlobalLocaleHolder {
  __ztoolsLocale?: unknown;
}

/**
 * AI/MCP 模块中英双语消息字典
 */
export const AI_MCP_MESSAGES: Record<AiMcpLocale, Record<AiMcpMessageKey, string>> = {
  'en-US': {
    'prompt.emptyName': 'Template name cannot be empty',
    'prompt.notFound': 'Prompt template "{name}" not found',
    'prompt.missingVariable': 'Missing required variable "{variable}" for template "{name}"',
    'tools.searchFiles.emptyQuery': 'Search query cannot be empty',
    'tools.searchFiles.directoryNotFound': 'Directory does not exist: "{directory}"',
    'tools.clipboard.invalidText': 'Clipboard text content must be a string',
    'tools.window.unsupportedAction': 'Unsupported window action: "{action}"',

    'mcp.host.serverDisconnected': 'MCP Server "{serverName}" disconnected',
    'mcp.host.serverAlreadyConnected': 'Server with name "{serverName}" is already connected',
    'mcp.host.serverNotConnected': 'Server "{serverName}" not connected',
    'mcp.host.serverIsNotConnected': 'Server "{serverName}" is not connected',
    'mcp.host.toolNotFoundOnServer': 'Tool "{toolName}" not found on server "{serverName}"',
    'mcp.host.toolNotFoundAnyServer': 'Tool "{toolName}" was not found on any connected MCP server',
    'mcp.host.requestTimedOut': 'MCP Request {method} (id={id}) timed out after {timeoutMs}ms',
    'mcp.host.rpcError': 'MCP error {code}: {message}',

    'mcp.registry.emptyToolName': 'Tool name cannot be empty',
    'mcp.registry.argsMustBeObject': 'Arguments must be an object',
    'mcp.registry.missingRequiredParam': 'Missing required parameter: "{param}"',
    'mcp.registry.unexpectedParam': 'Unexpected parameter: "{param}"',
    'mcp.registry.paramMustBeString': 'Parameter "{param}" must be a string',
    'mcp.registry.paramMustBeNumber': 'Parameter "{param}" must be a number',
    'mcp.registry.paramMustBeInteger': 'Parameter "{param}" must be an integer',
    'mcp.registry.paramMustBeBoolean': 'Parameter "{param}" must be a boolean',
    'mcp.registry.paramMustBeArray': 'Parameter "{param}" must be an array',
    'mcp.registry.paramMustBeObject': 'Parameter "{param}" must be an object',
    'mcp.registry.paramMustBeEnum': 'Parameter "{param}" must be one of: [{allowed}], got: "{actual}"',
    'mcp.registry.toolNotFound': 'Tool "{name}" not found',
    'mcp.registry.toolExecutionFailed': 'Tool execution failed: {reason}',

    'mcp.server.toolNameRequired': 'Tool name is required in params',
    'mcp.server.toolNotFound': 'Tool "{name}" not found on server',
    'mcp.server.methodNotSupported': 'Method "{method}" is not supported',

    'router.providerIdRequired': 'Provider config must have an id',
    'router.providerNotRegistered': 'Provider "{id}" is not registered',
    'router.noProviderSelected': 'No AI provider registered or selected',
    'router.primaryProviderNotFound': 'Primary provider "{id}" not found',
    'router.allProvidersFailed': 'All providers in chain failed: {attempts}',
    'router.allStreamProvidersFailed': 'All stream providers failed: {attempts}',

    'extTools.serializeBigInt': 'Tool output serialization failed: BigInt cannot be serialized to JSON',
    'extTools.serializeCircular': 'Tool output serialization failed: Circular reference detected in tool output',
    'extTools.serializeFailed': 'Tool output serialization failed: {reason}',
    'extTools.argsMustBeJsonObject': 'Tool arguments must be a JSON object, got {actualType}',
    'extTools.invalidJsonArgs': 'Invalid JSON input arguments: {reason}',
    'extTools.argsNotArray': 'Tool arguments must be an object, not an array',
    'extTools.argsMustBeObjectOrJson': 'Tool arguments must be an object or JSON string, got {actualType}',
    'extTools.toolFileNotFound': 'Tool file not found: "{path}"',
    'extTools.loadModuleFailed': 'Failed to load tool module "{path}": {reason}',
    'extTools.exportNotFunction': 'Tool export "{exportName}" in "{path}" is not a function (got {actualType})',
    'extTools.executionTimedOut': 'Tool execution timed out after {timeoutMs}ms',
    'extTools.executionFailed': 'Tool execution failed: {reason}',
    'extTools.managerAlreadyAttached': 'ExtensionToolManager is already attached to host',
    'extTools.manifestIdRequired': 'Invalid extension manifest: id is required',
    'extTools.emptyExtensionId': 'Extension id cannot be empty',
    'extTools.extensionDisabled': 'Extension "{id}" is currently disabled',
    'extTools.extensionRevoked': 'Extension "{id}" has been revoked: {reason}',
    'extTools.defaultRevokedReason': 'security policy',
    'extTools.confirmationDenied': 'Tool execution cancelled by user: User denied confirmation for "{toolName}"',
    'extTools.confirmationError': 'Tool execution cancelled: Confirmation error ({reason})',
    'extTools.confirmationHandlerMissing': 'Tool "{toolName}" requires confirmation, but no confirmation handler is available',
    'extTools.cannotEnableRevoked': 'Cannot enable revoked extension "{id}": {reason}',
    'extTools.defaultRevokedPolicy': 'revoked by policy',
    'extTools.defaultRevokedSecurityPolicy': 'Revoked by security policy'
  },
  'zh-CN': {
    'prompt.emptyName': '模板名称不能为空',
    'prompt.notFound': '未找到 Prompt 模板 "{name}"',
    'prompt.missingVariable': '模板 "{name}" 缺少必填变量 "{variable}"',
    'tools.searchFiles.emptyQuery': '搜索关键词不能为空',
    'tools.searchFiles.directoryNotFound': '目录不存在: "{directory}"',
    'tools.clipboard.invalidText': '剪贴板文本内容必须为字符串',
    'tools.window.unsupportedAction': '不支持的窗口操作: "{action}"',

    'mcp.host.serverDisconnected': 'MCP 服务 "{serverName}" 已断开连接',
    'mcp.host.serverAlreadyConnected': '名为 "{serverName}" 的 MCP 服务已处于连接状态',
    'mcp.host.serverNotConnected': 'MCP 服务 "{serverName}" 未连接',
    'mcp.host.serverIsNotConnected': 'MCP 服务 "{serverName}" 尚未连接',
    'mcp.host.toolNotFoundOnServer': '服务 "{serverName}" 上未找到工具 "{toolName}"',
    'mcp.host.toolNotFoundAnyServer': '所有已连接的 MCP 服务中均未找到工具 "{toolName}"',
    'mcp.host.requestTimedOut': 'MCP 请求 {method} (id={id}) 在 {timeoutMs}ms 后超时',
    'mcp.host.rpcError': 'MCP 错误 {code}: {message}',

    'mcp.registry.emptyToolName': '工具名称不能为空',
    'mcp.registry.argsMustBeObject': '工具参数必须为对象',
    'mcp.registry.missingRequiredParam': '缺少必填参数: "{param}"',
    'mcp.registry.unexpectedParam': '存在未声明的参数: "{param}"',
    'mcp.registry.paramMustBeString': '参数 "{param}" 必须为字符串',
    'mcp.registry.paramMustBeNumber': '参数 "{param}" 必须为数字',
    'mcp.registry.paramMustBeInteger': '参数 "{param}" 必须为整数',
    'mcp.registry.paramMustBeBoolean': '参数 "{param}" 必须为布尔值',
    'mcp.registry.paramMustBeArray': '参数 "{param}" 必须为数组',
    'mcp.registry.paramMustBeObject': '参数 "{param}" 必须为对象',
    'mcp.registry.paramMustBeEnum': '参数 "{param}" 必须为 [{allowed}] 之一，当前值: "{actual}"',
    'mcp.registry.toolNotFound': '未找到工具 "{name}"',
    'mcp.registry.toolExecutionFailed': '工具执行失败: {reason}',

    'mcp.server.toolNameRequired': '请求参数中缺少必填的工具名称',
    'mcp.server.toolNotFound': '服务端未找到工具 "{name}"',
    'mcp.server.methodNotSupported': '不支持的 MCP 方法 "{method}"',

    'router.providerIdRequired': '模型服务商配置必须包含 id',
    'router.providerNotRegistered': '模型服务商 "{id}" 尚未注册',
    'router.noProviderSelected': '尚未注册或选择任何 AI 模型服务商',
    'router.primaryProviderNotFound': '未找到主模型服务商 "{id}"',
    'router.allProvidersFailed': '降级链中所有模型服务商均调用失败: {attempts}',
    'router.allStreamProvidersFailed': '所有流式模型服务商均调用失败: {attempts}',

    'extTools.serializeBigInt': '工具输出序列化失败：BigInt 无法序列化为 JSON',
    'extTools.serializeCircular': '工具输出序列化失败：检测到循环引用',
    'extTools.serializeFailed': '工具输出序列化失败: {reason}',
    'extTools.argsMustBeJsonObject': '工具参数必须为 JSON 对象，实际类型为 {actualType}',
    'extTools.invalidJsonArgs': '无效的 JSON 输入参数: {reason}',
    'extTools.argsNotArray': '工具参数必须为对象，不能为数组',
    'extTools.argsMustBeObjectOrJson': '工具参数必须为对象或 JSON 字符串，实际类型为 {actualType}',
    'extTools.toolFileNotFound': '未找到工具入口文件: "{path}"',
    'extTools.loadModuleFailed': '加载工具模块 "{path}" 失败: {reason}',
    'extTools.exportNotFunction': '模块 "{path}" 中的导出 "{exportName}" 不是函数（实际类型: {actualType}）',
    'extTools.executionTimedOut': '工具执行在 {timeoutMs}ms 后超时',
    'extTools.executionFailed': '工具执行失败: {reason}',
    'extTools.managerAlreadyAttached': 'ExtensionToolManager 已挂载到宿主网关',
    'extTools.manifestIdRequired': '无效的扩展清单：缺少必填字段 id',
    'extTools.emptyExtensionId': '扩展 id 不能为空',
    'extTools.extensionDisabled': '扩展 "{id}" 当前已被禁用',
    'extTools.extensionRevoked': '扩展 "{id}" 已被下架封禁: {reason}',
    'extTools.defaultRevokedReason': '安全策略',
    'extTools.confirmationDenied': '工具执行已被用户取消：用户拒绝确认执行 "{toolName}"',
    'extTools.confirmationError': '工具执行已取消：确认流程异常 ({reason})',
    'extTools.confirmationHandlerMissing': '工具 "{toolName}" 需要二次确认，但当前未提供确认处理器',
    'extTools.cannotEnableRevoked': '无法启用已下架封禁的扩展 "{id}": {reason}',
    'extTools.defaultRevokedPolicy': '已被策略下架',
    'extTools.defaultRevokedSecurityPolicy': '因安全策略已被下架封禁'
  }
};

/**
 * 清理语言标签：去首尾空白、剥离 POSIX `.UTF-8` / `@...` 后缀并将 `_` 转为 `-`。
 * 与 `packages/ztools-plugins-spec/src/locale.js` 保持 100% 行为等价。
 */
export function stripAiMcpLocaleSuffix(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withoutPosix = trimmed.split(/[.@]/)[0] || '';
  return withoutPosix.trim().replace(/_/g, '-');
}

/**
 * 严格匹配受支持语言标签（zh-CN / en-US）。
 * 遇到空值、`'system'`/`'auto'`/`'default'` 或第三语种（如 `ja-JP`/`fr-FR`）返回 `null`。
 */
export function matchAiMcpSupportedLocale(raw?: unknown): AiMcpLocale | null {
  const cleaned = stripAiMcpLocaleSuffix(raw);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === 'system' || lower === 'auto' || lower === 'default') {
    return null;
  }
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh-CN';
  }
  if (lower === 'en' || lower.startsWith('en-')) {
    return 'en-US';
  }
  return null;
}

/**
 * 解析 AI/MCP 模块运行语言：
 * 支持单值或候选数组；自动剥离 `.UTF-8`/`@...` 并跳过 `'system'`、空值与第三语种；
 * 优先级：显式参数 > `globalThis.__ztoolsLocale` > `process.env.ZTOOLS_LOCALE` > 默认 `'en-US'`。
 */
export function resolveAiMcpLocale(locale?: unknown | readonly unknown[]): AiMcpLocale {
  const explicitList = Array.isArray(locale) ? locale : [locale];
  const globalLocale = (globalThis as GlobalLocaleHolder).__ztoolsLocale;
  const envLocale = typeof process !== 'undefined' && process.env ? process.env.ZTOOLS_LOCALE : undefined;

  const candidates: unknown[] = [...explicitList, globalLocale, envLocale];
  for (const candidate of candidates) {
    const matched = matchAiMcpSupportedLocale(candidate);
    if (matched) {
      return matched;
    }
  }
  return 'en-US';
}

/**
 * 按指定或当前运行语言格式化 AI/MCP 模块消息，支持 {param} 占位符插值（安全处理 0 值）
 */
export function tAiMcp(
  key: AiMcpMessageKey,
  params?: AiMcpMessageParams,
  locale?: string
): string {
  const resolved = resolveAiMcpLocale(locale);
  const template = AI_MCP_MESSAGES[resolved][key];
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * AI/MCP 结构化业务错误（携带稳定错误码 `code` 与结构化参数 `params`，100% 兼容 `instanceof Error`）
 */
export class AiMcpError extends Error {
  public readonly code: AiMcpErrorCode;
  public readonly params?: Readonly<AiMcpMessageParams>;

  constructor(code: AiMcpErrorCode, params?: AiMcpMessageParams, locale?: string) {
    super(tAiMcp(code, params, locale));
    this.name = 'AiMcpError';
    this.code = code;
    if (params) {
      this.params = Object.freeze({ ...params });
    }
  }
}
