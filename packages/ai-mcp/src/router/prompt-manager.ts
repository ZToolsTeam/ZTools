import { PromptTemplate, ChatMessage } from '../types/ai.js';

export class PromptTemplateManager {
  private templates: Map<string, PromptTemplate> = new Map();

  constructor() {
    this.registerPresets();
  }

  private registerPresets(): void {
    this.registerTemplate({
      name: 'file_search_assistant',
      description: '引导大模型分析用户文件检索意图并生成结构化检索参数',
      systemPrompt: '你是一个高效的文件检索助手。根据用户的自然语言描述，分析出需要检索的文件名关键词、扩展名或目标目录。',
      template: '请根据以下用户需求提取检索参数：\n需求：{{query}}\n可选约束目录：{{directory}}',
      variables: ['query'],
      defaultValues: {
        directory: '全部工作区'
      }
    });

    this.registerTemplate({
      name: 'code_reviewer',
      description: '对提供的代码进行架构、安全、性能与代码风格审查',
      systemPrompt: '你是一位资深架构师和代码审查专家。请从代码清晰度、安全性、边界条件、性能和可维护性几个维度提供建设性反馈。',
      template: '请对以下代码进行 Review：\n语言：{{language}}\n文件路径：{{filePath}}\n代码内容：\n```{{language}}\n{{code}}\n```',
      variables: ['language', 'code'],
      defaultValues: {
        filePath: '未命名文件'
      }
    });

    this.registerTemplate({
      name: 'summarizer',
      description: '长文本精炼摘要与要点提炼',
      systemPrompt: '你是一位专业的内容提炼与摘要助手。使用简洁的要点提炼出核心结论与行动项。',
      template: '请将以下文本提炼为 {{maxPoints}} 条核心要点：\n{{text}}',
      variables: ['text'],
      defaultValues: {
        maxPoints: '3'
      }
    });

    this.registerTemplate({
      name: 'tool_dispatch_planner',
      description: '规划使用 MCP Tools 完成用户目标的步骤',
      systemPrompt: '你是一个智能系统操作调度器。你可以使用 ZTools 系统工具（文件搜索、剪贴板、窗口控制等）来协同完成任务。',
      template: '可用工具列表：\n{{tools}}\n\n用户输入目标：{{goal}}\n请给出调度的工具序列与执行计划。',
      variables: ['tools', 'goal']
    });

    this.registerTemplate({
      name: 'json_extractor',
      description: '从非结构化文本中精准抽取符合 JSON 语法的结构化数据',
      systemPrompt: '你是一个高精度的 JSON 数据抽取器。只输出纯 JSON，不添加任何 Markdown 标记或多余解释。',
      template: '期望 JSON Schema / 结构要求：\n{{schema}}\n\n待抽取文本：\n{{text}}',
      variables: ['schema', 'text']
    });
  }

  /**
   * 注册模板
   */
  public registerTemplate(template: PromptTemplate): void {
    if (!template.name || template.name.trim().length === 0) {
      throw new Error('Template name cannot be empty');
    }
    this.templates.set(template.name, { ...template });
  }

  /**
   * 移除模板
   */
  public unregisterTemplate(name: string): boolean {
    return this.templates.delete(name);
  }

  /**
   * 获取模板
   */
  public getTemplate(name: string): PromptTemplate | undefined {
    const template = this.templates.get(name);
    return template ? { ...template } : undefined;
  }

  /**
   * 列出所有模板
   */
  public listTemplates(): PromptTemplate[] {
    return Array.from(this.templates.values()).map(t => ({ ...t }));
  }

  /**
   * 渲染模板为文本字符串
   */
  public render(name: string, variables: Record<string, string | number | boolean>): string {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(`Prompt template "${name}" not found`);
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
        throw new Error(`Missing required variable "${requiredVar}" for template "${name}"`);
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
  public renderMessages(name: string, variables: Record<string, string | number | boolean>): ChatMessage[] {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(`Prompt template "${name}" not found`);
    }

    const userContent = this.render(name, variables);
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
