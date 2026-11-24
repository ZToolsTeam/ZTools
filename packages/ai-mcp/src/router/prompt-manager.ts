import { PromptTemplate, ChatMessage } from '../types/ai.js';
import { AiMcpLocale, resolveAiMcpLocale, tAiMcp } from '../i18n.js';

export interface PromptTemplateManagerOptions {
  locale?: string;
}

interface BilingualPresetContent {
  description: string;
  systemPrompt: string;
  template: string;
  defaultValues?: Record<string, string>;
}

interface BilingualPresetDefinition {
  name: string;
  variables: string[];
  locales: Record<AiMcpLocale, BilingualPresetContent>;
}

const PRESET_DEFINITIONS: readonly BilingualPresetDefinition[] = [
  {
    name: 'file_search_assistant',
    variables: ['query'],
    locales: {
      'en-US': {
        description: 'Guides the model to analyze file search intent and generate structured search parameters',
        systemPrompt:
          "You are an efficient file search assistant. Analyze the user's natural language request to determine target filename keywords, extensions, or directories.",
        template:
          'Extract search parameters from the following user request:\nRequest: {{query}}\nOptional directory scope: {{directory}}',
        defaultValues: {
          directory: 'All workspaces'
        }
      },
      'zh-CN': {
        description: '引导大模型分析用户文件检索意图并生成结构化检索参数',
        systemPrompt:
          '你是一个高效的文件检索助手。根据用户的自然语言描述，分析出需要检索的文件名关键词、扩展名或目标目录。',
        template: '请根据以下用户需求提取检索参数：\n需求：{{query}}\n可选约束目录：{{directory}}',
        defaultValues: {
          directory: '全部工作区'
        }
      }
    }
  },
  {
    name: 'code_reviewer',
    variables: ['language', 'code'],
    locales: {
      'en-US': {
        description: 'Reviews provided code across architecture, security, performance, and style',
        systemPrompt:
          'You are a senior architect and code review specialist. Provide constructive feedback covering code clarity, security, edge cases, performance, and maintainability.',
        template:
          'Please review the following code:\nLanguage: {{language}}\nFile path: {{filePath}}\nCode:\n```{{language}}\n{{code}}\n```',
        defaultValues: {
          filePath: 'Untitled file'
        }
      },
      'zh-CN': {
        description: '对提供的代码进行架构、安全、性能与代码风格审查',
        systemPrompt:
          '你是一位资深架构师和代码审查专家。请从代码清晰度、安全性、边界条件、性能和可维护性几个维度提供建设性反馈。',
        template:
          '请对以下代码进行 Review：\n语言：{{language}}\n文件路径：{{filePath}}\n代码内容：\n```{{language}}\n{{code}}\n```',
        defaultValues: {
          filePath: '未命名文件'
        }
      }
    }
  },
  {
    name: 'summarizer',
    variables: ['text'],
    locales: {
      'en-US': {
        description: 'Distills long text into concise summaries and key takeaways',
        systemPrompt:
          'You are a professional summarization assistant. Distill core conclusions and action items into concise bullet points.',
        template: 'Summarize the following text into {{maxPoints}} key points:\n{{text}}',
        defaultValues: {
          maxPoints: '3'
        }
      },
      'zh-CN': {
        description: '长文本精炼摘要与要点提炼',
        systemPrompt: '你是一位专业的内容提炼与摘要助手。使用简洁的要点提炼出核心结论与行动项。',
        template: '请将以下文本提炼为 {{maxPoints}} 条核心要点：\n{{text}}',
        defaultValues: {
          maxPoints: '3'
        }
      }
    }
  },
  {
    name: 'tool_dispatch_planner',
    variables: ['tools', 'goal'],
    locales: {
      'en-US': {
        description: 'Plans step-by-step execution using MCP Tools to accomplish the user goal',
        systemPrompt:
          'You are an intelligent system action planner. You can coordinate ZTools system tools (file search, clipboard, window management, etc.) to complete tasks.',
        template:
          'Available tools:\n{{tools}}\n\nUser goal: {{goal}}\nProvide the tool invocation sequence and execution plan.'
      },
      'zh-CN': {
        description: '规划使用 MCP Tools 完成用户目标的步骤',
        systemPrompt:
          '你是一个智能系统操作调度器。你可以使用 ZTools 系统工具（文件搜索、剪贴板、窗口控制等）来协同完成任务。',
        template: '可用工具列表：\n{{tools}}\n\n用户输入目标：{{goal}}\n请给出调度的工具序列与执行计划。'
      }
    }
  },
  {
    name: 'json_extractor',
    variables: ['schema', 'text'],
    locales: {
      'en-US': {
        description: 'Extracts structured, valid JSON data accurately from unstructured text',
        systemPrompt:
          'You are a high-precision JSON data extractor. Output pure JSON only, without any Markdown fences or extra explanations.',
        template: 'Expected JSON Schema / structure requirements:\n{{schema}}\n\nSource text:\n{{text}}'
      },
      'zh-CN': {
        description: '从非结构化文本中精准抽取符合 JSON 语法的结构化数据',
        systemPrompt: '你是一个高精度的 JSON 数据抽取器。只输出纯 JSON，不添加任何 Markdown 标记或多余解释。',
        template: '期望 JSON Schema / 结构要求：\n{{schema}}\n\n待抽取文本：\n{{text}}'
      }
    }
  }
];

const PRESET_MAP: ReadonlyMap<string, BilingualPresetDefinition> = new Map(
  PRESET_DEFINITIONS.map(def => [def.name, def])
);

function cloneTemplate(template: PromptTemplate): PromptTemplate {
  return {
    ...template,
    variables: [...template.variables],
    ...(template.defaultValues ? { defaultValues: { ...template.defaultValues } } : {})
  };
}

function buildPresetTemplate(def: BilingualPresetDefinition, locale?: string): PromptTemplate {
  const resolved = resolveAiMcpLocale(locale);
  const localized = def.locales[resolved];
  return {
    name: def.name,
    description: localized.description,
    systemPrompt: localized.systemPrompt,
    template: localized.template,
    variables: [...def.variables],
    ...(localized.defaultValues ? { defaultValues: { ...localized.defaultValues } } : {})
  };
}

/**
 * 按指定或当前运行语言生成全部内置预设 Prompt 模板列表
 */
export function getPresetPromptTemplates(locale?: string): PromptTemplate[] {
  return PRESET_DEFINITIONS.map(def => buildPresetTemplate(def, locale));
}

export class PromptTemplateManager {
  private customTemplates: Map<string, PromptTemplate> = new Map();
  private removedPresets: Set<string> = new Set();
  private defaultLocale?: string;

  constructor(options?: PromptTemplateManagerOptions) {
    this.defaultLocale = options?.locale;
  }

  public getLocale(): string | undefined {
    return this.defaultLocale;
  }

  public setLocale(locale?: string): void {
    this.defaultLocale = locale;
  }

  /**
   * 注册模板（若与预设同名则覆盖预设）
   */
  public registerTemplate(template: PromptTemplate, locale?: string): void {
    if (!template.name || template.name.trim().length === 0) {
      throw new Error(tAiMcp('prompt.emptyName', undefined, locale ?? this.defaultLocale));
    }
    this.removedPresets.delete(template.name);
    this.customTemplates.set(template.name, cloneTemplate(template));
  }

  /**
   * 移除模板
   */
  public unregisterTemplate(name: string): boolean {
    const deletedCustom = this.customTemplates.delete(name);
    if (PRESET_MAP.has(name) && !this.removedPresets.has(name)) {
      this.removedPresets.add(name);
      return true;
    }
    return deletedCustom;
  }

  /**
   * 获取模板（预设模板自动按显式 locale、实例 locale 或运行时 globalThis.__ztoolsLocale 输出）
   */
  public getTemplate(name: string, locale?: string): PromptTemplate | undefined {
    const custom = this.customTemplates.get(name);
    if (custom) {
      return cloneTemplate(custom);
    }

    if (this.removedPresets.has(name)) {
      return undefined;
    }

    const preset = PRESET_MAP.get(name);
    if (!preset) {
      return undefined;
    }

    return buildPresetTemplate(preset, locale ?? this.defaultLocale);
  }

  /**
   * 列出所有模板
   */
  public listTemplates(locale?: string): PromptTemplate[] {
    const effectiveLocale = locale ?? this.defaultLocale;
    const result: PromptTemplate[] = [];
    const seen = new Set<string>();

    for (const def of PRESET_DEFINITIONS) {
      if (this.removedPresets.has(def.name)) continue;
      seen.add(def.name);
      const custom = this.customTemplates.get(def.name);
      result.push(custom ? cloneTemplate(custom) : buildPresetTemplate(def, effectiveLocale));
    }

    for (const [name, template] of this.customTemplates.entries()) {
      if (seen.has(name)) continue;
      result.push(cloneTemplate(template));
    }

    return result;
  }

  /**
   * 渲染模板为文本字符串
   */
  public render(
    name: string,
    variables: Record<string, string | number | boolean>,
    locale?: string
  ): string {
    const effectiveLocale = locale ?? this.defaultLocale;
    const template = this.getTemplate(name, effectiveLocale);
    if (!template) {
      throw new Error(tAiMcp('prompt.notFound', { name }, effectiveLocale));
    }

    const mergedVars: Record<string, string> = {};

    // 填充默认值
    if (template.defaultValues) {
      for (const [k, v] of Object.entries(template.defaultValues)) {
        mergedVars[k] = String(v);
      }
    }

    // 覆盖用户提供的变量
    for (const [k, v] of Object.entries(variables)) {
      if (v !== undefined && v !== null) {
        mergedVars[k] = String(v);
      }
    }

    // 校验必填变量
    for (const requiredVar of template.variables) {
      if (!(requiredVar in mergedVars) || mergedVars[requiredVar].trim().length === 0) {
        throw new Error(tAiMcp('prompt.missingVariable', { variable: requiredVar, name }, effectiveLocale));
      }
    }

    // 替换 {{var}} 与 {var} 占位符
    let rendered = template.template;
    for (const [k, v] of Object.entries(mergedVars)) {
      const doubleBraceRegex = new RegExp(`{{\\s*${k}\\s*}}`, 'g');
      const singleBraceRegex = new RegExp(`(?<!{){\\s*${k}\\s*}(?!})`, 'g');
      rendered = rendered.replace(doubleBraceRegex, v).replace(singleBraceRegex, v);
    }

    return rendered;
  }

  /**
   * 将模板直接渲染为标准 ChatMessage 列表
   */
  public renderMessages(
    name: string,
    variables: Record<string, string | number | boolean>,
    locale?: string
  ): ChatMessage[] {
    const effectiveLocale = locale ?? this.defaultLocale;
    const template = this.getTemplate(name, effectiveLocale);
    if (!template) {
      throw new Error(tAiMcp('prompt.notFound', { name }, effectiveLocale));
    }

    const userContent = this.render(name, variables, effectiveLocale);
    const messages: ChatMessage[] = [];

    if (template.systemPrompt) {
      messages.push({
        role: 'system',
        content: template.systemPrompt
      });
    }

    messages.push({
      role: 'user',
      content: userContent
    });

    return messages;
  }
}
