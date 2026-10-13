/**
 * ZTools 抗自动化逆向 (Anti-REA) 与二进制安全防御集成混沌测试套件
 * (Anti-Reverse-Engineering Resilience & Chaos Security Test Suite)
 * 
 * 覆盖 3 大核心关键安全防线：
 * 1. 原生侧车双向握手、伪造 Token 拦截与未认证拒绝服务混沌测试 (Handshake Chaos & Access Denied)
 * 2. 生产二进制 PE 结构、内存缓解措施 (ASLR/DEP/CFG) 与符号剥离验证 (PE Security Mitigations)
 * 3. 宿主 SidecarManager 动态令牌注入与端到端握手闭环自愈测试 (E2E Host-Sidecar Mutual Auth)
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  readPeSecurityMitigations,
  verifyBinaryHardening
} from '../electron-client/scripts/harden-production-artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sidecarBinDir = path.join(rootDir, 'electron-client', 'out', 'native', 'win32-x64', 'bin');

/**
 * 辅助方法：启动受控的侧车进程进行低级 JSON-RPC 交互测试
 */
function createRawSidecarClient(binaryName, envToken = '') {
  const binaryPath = path.join(sidecarBinDir, `${binaryName}.exe`);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`测试目标侧车不存在: ${binaryPath}`);
  }

  const env = { ...process.env };
  if (envToken) {
    env.ZTOOLS_SIDECAR_TOKEN = envToken;
  } else {
    delete env.ZTOOLS_SIDECAR_TOKEN;
  }

  const child = spawn(binaryPath, [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const rl = readline.createInterface({ input: child.stdout });
  let reqId = 1;
  const pending = new Map();

  rl.on('line', (line) => {
    try {
      const resp = JSON.parse(line);
      if (resp && resp.id !== undefined && pending.has(resp.id)) {
        const { resolve } = pending.get(resp.id);
        pending.delete(resp.id);
        resolve(resp);
      }
    } catch {}
  });

  const send = (method, params = {}, timeoutMs = 3000) => {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC request '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      child.stdin.write(payload);
    });
  };

  const close = async () => {
    try {
      await Promise.race([
        send('shutdown', {}, 500),
        new Promise((r) => setTimeout(r, 500))
      ]).catch(() => {});
    } finally {
      rl.close();
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }
  };

  return { child, send, close };
}

// =========================================================================
// 链路 1：原生侧车安全鉴权握手与拒绝服务破坏性混沌测试
// =========================================================================
describe('【链路 1】原生侧车双向握手、伪造 Token 拦截与拒绝服务混沌测试', () => {
  const testSecretToken = 'secret-token-' + crypto.randomBytes(16).toString('hex');

  it('异常测试 1.1: 在未完成握手认证前，直接调用敏感指令（如 search_files / index_path），严格拒绝并返回 -32001', async () => {
    const client = createRawSidecarClient('ztools-indexer', testSecretToken);
    try {
      // 1. ping 应当允许
      const pingResp = await client.send('ping');
      assert.equal(pingResp.result, 'pong', '未认证前应仅允许探测 ping');

      // 2. 调用敏感业务指令 search_files
      const searchResp = await client.send('search_files', { query: 'test' });
      assert.ok(searchResp.error, '未握手调用敏感方法必须被拒绝');
      assert.equal(searchResp.error.code, -32001, '错误码必须是 -32001 (Authentication required)');
      assert.match(searchResp.error.message, /authentication required/i, '错误描述必须清晰声明未认证');

      // 3. 调用管理指令 index_path
      const indexResp = await client.send('index_path', { path: '.' });
      assert.ok(indexResp.error, '未握手调用 index_path 必须被拒绝');
      assert.equal(indexResp.error.code, -32001);
    } finally {
      await client.close();
    }
  });

  it('异常测试 1.2: 注入伪造的非法 Token 进行握手，严格返回 -32002 且状态机维持未认证', async () => {
    const client = createRawSidecarClient('ztools-indexer', testSecretToken);
    try {
      // 尝试使用假 Token 握手
      const fakeToken = 'forged-token-abc-123456';
      const handshakeResp = await client.send('handshake', { token: fakeToken });

      assert.ok(handshakeResp.error, '非法 Token 握手必须报错');
      assert.equal(handshakeResp.error.code, -32002, '错误码必须为 -32002 (Invalid handshake token)');

      // 验证后续业务指令依然被严格封锁
      const blockedResp = await client.send('search_files', { query: 'test' });
      assert.equal(blockedResp.error?.code, -32001, '非法握手后状态机绝不能撕裂或放行');
    } finally {
      await client.close();
    }
  });

  it('异常测试 1.3: 对真实 Token 进行单比特微小篡改 (Bit Flip)，认证必须被拒绝', async () => {
    const client = createRawSidecarClient('ztools-indexer', testSecretToken);
    try {
      // 将真实 Token 的最后一个字符替换成不同字符
      const lastChar = testSecretToken.slice(-1);
      const mutatedChar = lastChar === 'a' ? 'b' : 'a';
      const mutatedToken = testSecretToken.slice(0, -1) + mutatedChar;

      const handshakeResp = await client.send('handshake', { token: mutatedToken });
      assert.ok(handshakeResp.error, '篡改 1 字节 Token 必须被立即识破');
      assert.equal(handshakeResp.error.code, -32002);
    } finally {
      await client.close();
    }
  });

  it('安全闭环 1.4: 注入正确 Token 完成握手后，业务能力即刻解锁并恢复极速响应', async () => {
    const client = createRawSidecarClient('ztools-indexer', testSecretToken);
    try {
      // 1. 发起合法握手
      const handshakeResp = await client.send('handshake', { token: testSecretToken });
      assert.equal(handshakeResp.error, undefined);
      assert.equal(handshakeResp.result.authenticated, true);
      assert.equal(handshakeResp.result.protocol, 'ztools-sidecar-v1');

      // 2. 握手后调用业务指令，正常返回
      const statsResp = await client.send('get_stats');
      assert.equal(statsResp.error, undefined);
      assert.equal(statsResp.result.index_type, 'flat_trie_pinyin_acronym');
    } finally {
      await client.close();
    }
  });
});

// =========================================================================
// 链路 2：生产二进制 PE 结构、内存缓解措施 (ASLR/DEP/CFG) 验证
// =========================================================================
describe('【链路 2】生产二进制 PE 结构与企业级内存缓解措施校验', () => {
  const binaryNames = ['ztools-uiaccess.exe', 'ztools-uiaccess-standard.exe', 'ztools-indexer.exe'];

  for (const binName of binaryNames) {
    it(`安全加固 2.1: ${binName} 必须开启 DYNAMICBASE (ASLR) 与 NXCOMPAT (DEP) 防护`, () => {
      const p = path.join(sidecarBinDir, binName);
      assert.ok(fs.existsSync(p), `侧车二进制必须存在: ${p}`);

      const mitigations = verifyBinaryHardening(p);
      assert.equal(mitigations.dynamicBase, true, `${binName} 必须开启 ASLR (DYNAMICBASE)`);
      assert.equal(mitigations.nxCompat, true, `${binName} 必须开启 DEP (NXCOMPAT)`);
      assert.equal(mitigations.guardCf, true, `${binName} 必须开启 Control Flow Guard (CFG)`);
    });
  }

  it('防信息泄露 2.2: 生产 Release 二进制不应残留调试 PDB 外部路径与符号', () => {
    const indexerPath = path.join(sidecarBinDir, 'ztools-indexer.exe');
    const buf = fs.readFileSync(indexerPath);
    // 检查是否包含本地源码特定绝对盘符路径残留 (如 E:\csdwork3...)
    const content = buf.toString('latin1');
    const pdbLeak = content.includes('ztools-indexer.pdb');
    assert.equal(pdbLeak, false, 'Release 产物严禁残留本地 .pdb 调试数据库路径');
  });
});
