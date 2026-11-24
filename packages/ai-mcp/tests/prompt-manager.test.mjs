import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PromptTemplateManager } from '../dist/index.js';

describe('PromptTemplateManager', () => {
  test('preset templates are initialized and queryable', () => {
    const manager = new PromptTemplateManager();
    const presets = manager.listTemplates();

    assert.ok(presets.length >= 5);
    const names = presets.map(p => p.name);
    assert.ok(names.includes('file_search_assistant'));
    assert.ok(names.includes('code_reviewer'));
    assert.ok(names.includes('summarizer'));
    assert.ok(names.includes('tool_dispatch_planner'));
    assert.ok(names.includes('json_extractor'));
  });

  test('render performs variable interpolation and applies defaults', () => {
    const manager = new PromptTemplateManager();

    // 默认 en-US 下 file_search_assistant 的默认 directory 为 All workspaces
    const renderedWithDefaultEn = manager.render('file_search_assistant', {
      query: 'electron always on top'
    });
    assert.ok(renderedWithDefaultEn.includes('Request: electron always on top'));
    assert.ok(renderedWithDefaultEn.includes('Optional directory scope: All workspaces'));

    // 显式指定 zh-CN 时保留原有中文默认变量与模板
    const renderedWithDefaultZh = manager.render('file_search_assistant', {
      query: 'electron 窗口置顶'
    }, 'zh-CN');

    assert.ok(renderedWithDefaultZh.includes('需求：electron 窗口置顶'));
    assert.ok(renderedWithDefaultZh.includes('可选约束目录：全部工作区'));

    // 覆盖默认值
    const renderedCustom = manager.render('file_search_assistant', {
      query: 'config.json',
      directory: 'D:\\Projects\\ZTools'
    }, 'zh-CN');
    assert.ok(renderedCustom.includes('可选约束目录：D:\\Projects\\ZTools'));
  });

  test('render throws when required variables are missing', () => {
    const manager = new PromptTemplateManager();

    assert.throws(() => {
      // Missing required variable 'query'
      manager.render('file_search_assistant', {});
    }, /Missing required variable "query"/);
  });

  test('custom template registration, unregistration and rendering', () => {
    const manager = new PromptTemplateManager();

    manager.registerTemplate({
      name: 'translate_en_to_cn',
      description: '英文翻译为中文',
      systemPrompt: '你是一名专业中英翻译官。',
      template: '请将以下文本翻译为地道中文：\n{{sourceText}}\n风格：{{style}}',
      variables: ['sourceText'],
      defaultValues: {
        style: '专业优雅'
      }
    });

    const output = manager.render('translate_en_to_cn', {
      sourceText: 'Bring Your Own Key architecture enables high sovereignty.'
    });

    assert.ok(output.includes('Bring Your Own Key architecture enables high sovereignty.'));
    assert.ok(output.includes('风格：专业优雅'));

    // renderMessages
    const messages = manager.renderMessages('translate_en_to_cn', {
      sourceText: 'Hello world'
    });

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, '你是一名专业中英翻译官。');
    assert.equal(messages[1].role, 'user');
    assert.ok(messages[1].content.includes('Hello world'));

    // Unregister
    const deleted = manager.unregisterTemplate('translate_en_to_cn');
    assert.equal(deleted, true);
    assert.equal(manager.getTemplate('translate_en_to_cn'), undefined);
  });
});
