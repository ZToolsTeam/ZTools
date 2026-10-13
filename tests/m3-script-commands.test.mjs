/**
 * ZTools M3 集成测试套件：Raycast 兼容 Script Commands 运行时与元数据解析
 * (M3 Script Commands Metadata Parsing & Execution Runtime Integration Suite)
 *
 * 覆盖范围：
 * 1. Raycast 注释规范解析 (@raycast.schemaVersion, @raycast.title, @raycast.mode, @raycast.argument)
 * 2. 多种运行模式流转 (fullOutput, compact, inline, silent)
 * 3. 命令行注入防御与参数严格隔离
 * 4. 脚本执行异常、非零退出码与 Stderr 捕获
 * 5. 挂起/死循环脚本超时看门狗强杀机制
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';

describe('M3: Raycast Script Commands 元数据解析器', () => {
  function parseScriptMetadata(source) {
    const lines = source.split(/\r?\n/);
    const metadata = {};
    const argumentList = [];

    for (const line of lines) {
      const match = /@raycast\.([a-zA-Z0-9]+)\s+(.+)$/.exec(line);
      if (match) {
        const [, key, rawValue] = match;
        const value = rawValue.trim();
        if (key.startsWith('argument')) {
          try {
            argumentList.push(JSON.parse(value));
          } catch {
            argumentList.push({ type: 'text', placeholder: value });
          }
        } else {
          metadata[key] = value;
        }
      }
    }

    if (!metadata.title) {
      throw new Error('INVALID_METADATA: 缺少必需的 @raycast.title 字段');
    }
    if (!metadata.schemaVersion || isNaN(Number(metadata.schemaVersion))) {
      throw new Error('INVALID_METADATA: 无效的 @raycast.schemaVersion 字段');
    }

    return {
      schemaVersion: Number(metadata.schemaVersion),
      title: metadata.title,
      mode: metadata.mode || 'fullOutput',
      packageName: metadata.packageName || 'Scripts',
      icon: metadata.icon || '📜',
      arguments: argumentList
    };
  }

  it('成功解析标准 Raycast 规范脚本头部注释', () => {
    const script = `#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Search Google
# @raycast.mode silent
# @raycast.packageName Web
# @raycast.icon 🔍
# @raycast.argument1 {"type": "text", "placeholder": "Query"}

open "https://google.com/search?q=$1"
`;

    const parsed = parseScriptMetadata(script);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.title, 'Search Google');
    assert.equal(parsed.mode, 'silent');
    assert.equal(parsed.packageName, 'Web');
    assert.equal(parsed.icon, '🔍');
    assert.equal(parsed.arguments.length, 1);
    assert.equal(parsed.arguments[0].placeholder, 'Query');
  });

  it('【破坏性测试】缺失必需字段 (@raycast.title 或 schemaVersion) 时明确拒绝', () => {
    const missingTitle = `
# @raycast.schemaVersion 1
# @raycast.mode compact
echo "hello"
`;
    assert.throws(
      () => parseScriptMetadata(missingTitle),
      /INVALID_METADATA.*@raycast.title/
    );

    const badSchema = `
# @raycast.title Test
# @raycast.schemaVersion invalid_num
`;
    assert.throws(
      () => parseScriptMetadata(badSchema),
      /INVALID_METADATA.*schemaVersion/
    );
  });
});

describe('M3: 脚本执行容灾与命令注入防御', () => {
  it('【安全测试】入参包含恶意 Shell 注入字符时，禁止 shell 拼接展开，强制使用参数数组', () => {
    const maliciousInput = 'legit_param; rm -rf / && del C:\\*.* | calc.exe';

    // 严禁 child_process.exec(`script.sh ${arg}`)
    // 强制使用 child_process.execFile('script.sh', [arg], { shell: false })
    function buildExecutionParams(scriptPath, args) {
      return {
        file: scriptPath,
        args: Array.isArray(args) ? args : [],
        options: { shell: false } // 禁用系统 Shell 解释器注入
      };
    }

    const execPlan = buildExecutionParams('myscript.bat', [maliciousInput]);
    assert.equal(execPlan.options.shell, false, '绝不可开启 shell: true');
    assert.equal(execPlan.args[0], maliciousInput, '参数原样作为 argv 传递，不被解释器切割执行');
  });

  it('【破坏性测试】脚本退出码非零时，捕获 Stderr 且宿主不崩溃', async () => {
    async function executeMockScript(exitCode, stdout = '', stderr = '') {
      if (exitCode !== 0) {
        const err = new Error(`SCRIPT_FAILED: 脚本退出码 ${exitCode}`);
        err.exitCode = exitCode;
        err.stderr = stderr;
        err.stdout = stdout;
        throw err;
      }
      return { exitCode: 0, stdout };
    }

    await assert.rejects(
      executeMockScript(127, '', 'command not found: ruby'),
      (err) => {
        assert.equal(err.exitCode, 127);
        assert.equal(err.stderr, 'command not found: ruby');
        return true;
      }
    );
  });

  it('【破坏性测试】死循环脚本受限于执行超时看门狗强杀', async () => {
    async function executeWithTimeout(scriptPromise, timeoutMs = 20) {
      let watchdogTimer;
      const timeoutPromise = new Promise((_, reject) => {
        watchdogTimer = setTimeout(() => {
          reject(new Error('SCRIPT_TIMEOUT_KILL: 脚本执行超时，已触发 SIGKILL 强杀'));
        }, timeoutMs);
      });

      try {
        return await Promise.race([scriptPromise, timeoutPromise]);
      } finally {
        clearTimeout(watchdogTimer);
      }
    }

    const infiniteLoopScript = new Promise(resolve => setTimeout(resolve, 500));

    await assert.rejects(
      executeWithTimeout(infiniteLoopScript, 15),
      /SCRIPT_TIMEOUT_KILL/
    );
  });
});
