import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenTracker } from '../dist/index.js';

describe('TokenTracker & Token Estimator', () => {
  test('TokenTracker.estimateTokens accurately estimates token count', () => {
    // 空文本
    assert.equal(TokenTracker.estimateTokens(''), 0);

    // 纯英文
    const enText = 'Hello world, this is a test prompt.';
    const enTokens = TokenTracker.estimateTokens(enText);
    assert.ok(enTokens >= 7 && enTokens <= 12, `Estimated tokens ${enTokens} within expected range`);

    // 纯中文
    const cnText = '这是一个中文大模型测试提示词';
    const cnTokens = TokenTracker.estimateTokens(cnText);
    // 14 个中文字符，大约 18-20 tokens
    assert.ok(cnTokens >= 14 && cnTokens <= 25, `Estimated tokens ${cnTokens} within expected range`);

    // 中英文混合及代码
    const mixedText = 'function calculateSum(a: number, b: number): number { /* 计算和 */ return a + b; }';
    const mixedTokens = TokenTracker.estimateTokens(mixedText);
    assert.ok(mixedTokens >= 15 && mixedTokens <= 35, `Estimated tokens ${mixedTokens} within expected range`);
  });

  test('recordUsage records usage, aggregates totals, and supports multiple providers', () => {
    const tracker = new TokenTracker();

    // 记录 Provider 1 成功调用
    tracker.recordUsage(
      'deepseek-chat',
      { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, totalTokens: 150 },
      250,
      true
    );

    // 记录 Provider 1 第二次调用
    tracker.recordUsage(
      'deepseek-chat',
      { promptTokens: 80, completionTokens: 40, reasoningTokens: 10, totalTokens: 120 },
      150,
      true
    );

    // 记录 Provider 2
    tracker.recordUsage(
      'claude-3-5-sonnet',
      { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      500,
      true
    );

    // 记录一次失败请求
    tracker.recordUsage(
      'openai-gpt4o',
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      50,
      false
    );

    tracker.recordFallback();

    const metrics = tracker.getMetrics();
    assert.equal(metrics.totalRequests, 4);
    assert.equal(metrics.successfulRequests, 3);
    assert.equal(metrics.failedRequests, 1);
    assert.equal(metrics.fallbackCount, 1);
    assert.equal(metrics.totalTokens.promptTokens, 380);
    assert.equal(metrics.totalTokens.completionTokens, 190);
    assert.equal(metrics.totalTokens.reasoningTokens, 30);
    assert.equal(metrics.totalTokens.totalTokens, 570);

    const dsStats = tracker.getProviderStats('deepseek-chat');
    assert.ok(dsStats);
    assert.equal(dsStats.requests, 2);
    assert.equal(dsStats.tokens.totalTokens, 270);
    assert.equal(dsStats.averageLatencyMs, 200);

    const allStats = tracker.getAllStats();
    assert.ok(allStats['deepseek-chat']);
    assert.ok(allStats['claude-3-5-sonnet']);

    // 测试重置
    tracker.reset();
    assert.equal(tracker.getMetrics().totalRequests, 0);
    assert.equal(tracker.getMetrics().totalTokens.totalTokens, 0);
    assert.equal(tracker.getProviderStats('deepseek-chat'), undefined);
  });
});
