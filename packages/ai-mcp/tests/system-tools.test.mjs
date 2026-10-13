import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  searchFiles,
  readClipboard,
  writeClipboard,
  manageWindow,
  createZToolsSystemToolsServer,
  registerSystemToolsToHost,
  McpHost
} from '../dist/index.js';

describe('ZTools System Capabilities as MCP Tools', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-system-tools-test-'));
    fs.writeFileSync(path.join(tempDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Welcome to ZTools native MCP core gateway', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'app.ts'), 'export const app = "ztools";', 'utf-8');

    const subDir = path.join(tempDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'utils.ts'), 'export function helper() {}', 'utf-8');
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('search_files performs accurate file matching, type filtering, and content search', async () => {
    // 1. 文件名检索
    const res1 = await searchFiles({
      query: 'settings',
      directory: tempDir
    });
    assert.equal(res1.totalFound, 1);
    assert.equal(res1.files[0].name, 'settings.json');

    // 2. 后缀限定检索
    const res2 = await searchFiles({
      query: '', // 将由 searchFiles 校验非空
      directory: tempDir,
      fileTypes: ['.ts']
    }).catch(err => ({ error: err.message }));
    assert.ok(res2.error);

    const resTs = await searchFiles({
      query: 'ts',
      directory: tempDir,
      fileTypes: ['.ts']
    });
    assert.equal(resTs.totalFound, 2); // app.ts, utils.ts

    // 3. 文件内容搜索 (contentMatch)
    const resContent = await searchFiles({
      query: 'gateway',
      directory: tempDir,
      contentMatch: true
    });
    assert.equal(resContent.totalFound, 1);
    assert.equal(resContent.files[0].name, 'README.md');
    assert.ok(resContent.files[0].snippet?.includes('gateway'));
  });

  test('read_clipboard and write_clipboard roundtrip works seamlessly', async () => {
    const writeRes = await writeClipboard({
      text: 'ZTools Clipboard Native MCP Data 2026'
    });
    assert.equal(writeRes.success, true);
    assert.equal(writeRes.format, 'text');

    const readRes = await readClipboard();
    assert.equal(readRes.content, 'ZTools Clipboard Native MCP Data 2026');
    assert.equal(readRes.format, 'text');
    assert.equal(readRes.length, 'ZTools Clipboard Native MCP Data 2026'.length);

    // HTML 格式
    await writeClipboard({
      text: '<b>Rich Text</b>',
      format: 'html'
    });
    const readHtml = await readClipboard({ format: 'html' });
    assert.equal(readHtml.content, '<b>Rich Text</b>');
    assert.equal(readHtml.format, 'html');
  });

  test('manage_window supports minimize, maximize, restore, always_on_top and snap', async () => {
    // 获取初始状态
    const initRes = await manageWindow({ action: 'get_state' });
    assert.equal(initRes.success, true);
    assert.equal(initRes.state.isMinimized, false);

    // 最小化
    const minRes = await manageWindow({ action: 'minimize' });
    assert.equal(minRes.state.isMinimized, true);

    // 最大化
    const maxRes = await manageWindow({ action: 'maximize' });
    assert.equal(maxRes.state.isMaximized, true);
    assert.equal(maxRes.state.width, 1920);

    // 贴靠屏幕左侧
    const snapRes = await manageWindow({
      action: 'snap',
      options: { snapTo: 'left' }
    });
    assert.equal(snapRes.state.x, 0);
    assert.equal(snapRes.state.width, 960);

    // 置顶
    const topRes = await manageWindow({
      action: 'always_on_top',
      options: { alwaysOnTop: true }
    });
    assert.equal(topRes.state.isAlwaysOnTop, true);
  });

  test('registerSystemToolsToHost exposes all 4 capabilities to McpHost and executes', async () => {
    const host = new McpHost({ name: 'ztools-test-client' });
    const connInfo = await registerSystemToolsToHost(host, 'ztools-system');

    assert.equal(connInfo.name, 'ztools-system');

    const tools = host.listTools();
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('search_files'));
    assert.ok(toolNames.includes('read_clipboard'));
    assert.ok(toolNames.includes('write_clipboard'));
    assert.ok(toolNames.includes('manage_window'));

    // 通过 McpHost 调度 search_files
    const searchCallRes = await host.callTool('search_files', {
      query: 'settings.json',
      directory: tempDir
    });
    assert.equal(searchCallRes.isError, false);
    const parsedSearch = JSON.parse(searchCallRes.content[0].text);
    assert.equal(parsedSearch.totalFound, 1);
    assert.equal(parsedSearch.files[0].name, 'settings.json');

    // 通过 McpHost 调度 write_clipboard
    const clipCallRes = await host.callTool('write_clipboard', {
      text: 'Dispatched via MCP Host'
    });
    assert.equal(clipCallRes.isError, false);

    // 通过 McpHost 调度 manage_window
    const winCallRes = await host.callTool('manage_window', {
      action: 'snap',
      options: { snapTo: 'right' }
    });
    assert.equal(winCallRes.isError, false);
    const parsedWin = JSON.parse(winCallRes.content[0].text);
    assert.equal(parsedWin.state.x, 960);

    await host.disconnectAll();
  });
});
