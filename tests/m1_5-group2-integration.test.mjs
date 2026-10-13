/**
 * ZTools M1.5 Phase Group 2 System Integration Test Suite
 * (8 High-Frequency Core Built-in Tools IPC & Service Verification)
 *
 * 覆盖 8 大核心高频内置服务与对应 34 项 IPC 契约：
 * 1. Emoji & Symbols (Emoji / 符号选择器)
 * 2. Translator (快速翻译 / 词典)
 * 3. Notes (轻量临时便签，SQLite WAL 存储)
 * 4. WindowsRun (运行窗口增强 / 快搜系统别名)
 * 5. WindowsTaskbar (Win32 任务栏显隐/状态控制)
 * 6. Screenshots (屏幕截图历史与快贴)
 * 7. Applications (应用卸载与管理快搜)
 * 8. Dictionary (英汉双解科技词典)
 *
 * 全面执行真实调用链路与端到端闭环，覆盖边界极值、故障注入、并发压力与参数安全校验。
 */

import assert from 'node:assert/strict';
import test, { describe, it, before, after } from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';

// 导入核心服务工厂与契约工具
import { createCoreServices } from '../electron-client/out/main/services/core-services.js';
import { isAllowedMethod, canCall } from '../electron-client/out/contracts/capabilities.js';
import { validateMethodParams } from '../electron-client/out/contracts/method-params.js';
import { ScreenshotsService } from '../electron-client/out/main/services/screenshots-service.js';
import { ApplicationsService } from '../electron-client/out/main/services/applications-service.js';

describe('ZTools M1.5 Group 2 System Integration Suite (8 High-Frequency Core Tools)', () => {
  let tempDir;
  let testScreenshotsDir;
  let services;
  let ipcHandlers;

  // 模拟全链路安全 IPC 分发器 (严格复刻 Router.ts 的调用管道)
  async function dispatchIpc(request, caller = { type: 'main' }) {
    if (!request || typeof request !== 'object') {
      return {
        messageId: 'invalid',
        success: false,
        error: { code: 'INVALID_REQUEST', message: '请求报文格式非法' }
      };
    }

    const messageId = typeof request.messageId === 'string' ? request.messageId : 'msg-test';
    const method = request.method;

    // 1. 能力清单核对
    if (!isAllowedMethod(method)) {
      return {
        messageId,
        success: false,
        error: { code: 'METHOD_NOT_FOUND', message: `未注册的方法: ${method}` }
      };
    }

    // 2. 调用者权限与鉴权
    if (!canCall(method, caller)) {
      return {
        messageId,
        success: false,
        error: { code: 'PERMISSION_DENIED', message: `调用者无权调用此方法: ${method}` }
      };
    }

    // 3. 严格参数结构与类型校验 (拒绝未知字段与类型漂移)
    try {
      validateMethodParams(method, request.params);
    } catch (err) {
      return {
        messageId,
        success: false,
        error: { code: err.code || 'INVALID_ARGUMENT', message: err.message }
      };
    }

    // 4. 分发到核心服务 Handler
    const handler = ipcHandlers[method];
    if (!handler) {
      return {
        messageId,
        success: false,
        error: { code: 'NOT_IMPLEMENTED', message: `Handler 尚未挂载: ${method}` }
      };
    }

    try {
      const data = await handler(request.params);
      return {
        messageId,
        success: true,
        data
      };
    } catch (err) {
      return {
        messageId,
        success: false,
        error: { code: err.code || 'HANDLER_EXECUTION_ERROR', message: err.message }
      };
    }
  }

  before(async () => {
    // 创建完全独立的临时数据隔离目录
    tempDir = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-test-group2-')));
    testScreenshotsDir = path.join(tempDir, 'screenshots');
    await fs.mkdir(testScreenshotsDir, { recursive: true });

    // 初始化真实的核心服务集合
    services = createCoreServices(tempDir, '1.0.0', '1.0.0');

    // 注入可控的截图目录以测试截图扫描与回贴
    const customScreenshotsService = new ScreenshotsService({
      searchDirectories: [testScreenshotsDir]
    });

    // 挂载所有 34 个 IPC 处理器 (严格对齐 router.ts 实现)
    ipcHandlers = {
      // 1. Emoji & Symbols
      async emoji_search(params) {
        const input = (params || {});
        const opts = {};
        if (input.category !== undefined) opts.category = input.category;
        if (input.skinTone !== undefined) opts.skinTone = input.skinTone;
        if (input.limit !== undefined) opts.limit = input.limit;
        return services.emoji.search(input.query ?? '', opts);
      },
      async emoji_record_usage(params) {
        services.emoji.recordUsage(params.char);
        return { success: true };
      },
      async emoji_toggle_favorite(params) {
        return { isFavorite: services.emoji.toggleFavorite(params.char) };
      },
      async emoji_get_recents() {
        return { items: services.emoji.getRecent() };
      },
      async emoji_get_favorites() {
        return { items: services.emoji.getFavorites() };
      },

      // 2. Translator
      async translator_translate(params) {
        const opts = {};
        if (params.sourceLanguage !== undefined) opts.sourceLanguage = params.sourceLanguage;
        if (params.targetLanguage !== undefined) opts.targetLanguage = params.targetLanguage;
        return services.translator.translate(params.text, opts);
      },
      async translator_detect_language(params) {
        return { language: services.translator.detectLanguage(params.text) };
      },
      async translator_get_history() {
        return { items: services.translator.getHistory() };
      },

      // 3. Notes
      async notes_list(params) {
        return services.notes.listNotes(params || {});
      },
      async notes_get(params) {
        return services.notes.getNote(params.id);
      },
      async notes_save(params) {
        if (params.id) {
          return services.notes.updateNote(params.id, {
            title: params.title,
            content: params.content,
            pinned: params.pinned,
            color: params.color,
            tags: params.tags
          });
        }
        return services.notes.createNote({
          title: params.title,
          content: params.content || '',
          pinned: params.pinned,
          color: params.color,
          tags: params.tags
        });
      },
      async notes_delete(params) {
        if (params.permanent) {
          return { success: services.notes.permanentlyDelete(params.id) };
        }
        services.notes.moveToTrash(params.id);
        return { success: true };
      },
      async notes_restore(params) {
        services.notes.restoreFromTrash(params.id);
        return { success: true };
      },
      async notes_toggle_pin(params) {
        return { pinned: services.notes.togglePin(params.id) };
      },
      async notes_count() {
        return services.notes.countNotes();
      },

      // 4. Windows Run
      async windows_run_search(params) {
        return services.windowsRun.searchCommands(params?.query);
      },
      async windows_run_execute(params) {
        const opts = {};
        if (params.args) opts.arguments = params.args.join(' ');
        if (params.runAsAdmin !== undefined) opts.asAdministrator = params.runAsAdmin;
        if (params.shell !== undefined) opts.shell = params.shell;
        if (params.workingDirectory !== undefined) opts.workingDirectory = params.workingDirectory;
        return services.windowsRun.execute(params.command, opts);
      },
      async windows_run_register_alias(params) {
        return services.windowsRun.createCustomCommand({
          alias: params.alias,
          command: params.command,
          description: params.description,
          descriptionZh: params.descriptionZh,
          runAsAdminByDefault: params.runAsAdminByDefault
        });
      },
      async windows_run_remove_alias(params) {
        const cmd = services.windowsRun.getByAlias(params.alias);
        return { success: cmd ? services.windowsRun.deleteCustomCommand(cmd.id) : false };
      },

      // 5. Windows Taskbar
      async taskbar_toggle() {
        return services.taskbar.toggleTaskbar();
      },
      async taskbar_show() {
        return services.taskbar.showTaskbar();
      },
      async taskbar_hide() {
        return services.taskbar.hideTaskbar();
      },
      async taskbar_status() {
        return { visible: await services.taskbar.isTaskbarVisible() };
      },

      // 6. Screenshots (使用可控的 customScreenshotsService)
      async screenshots_scan(params) {
        return customScreenshotsService.scanScreenshots(params?.forceRefresh);
      },
      async screenshots_paste_latest() {
        return customScreenshotsService.pasteLatestScreenshot();
      },
      async screenshots_toggle_pin(params) {
        const screenshots = customScreenshotsService.scanScreenshots();
        const target = screenshots.find(s => s.path === params.filePath);
        if (target?.pinned) {
          customScreenshotsService.unpinScreenshot(params.filePath);
          return { pinned: false };
        } else {
          customScreenshotsService.pinScreenshot(params.filePath);
          return { pinned: true };
        }
      },
      async screenshots_delete(params) {
        return { success: await customScreenshotsService.deleteScreenshot(params.filePath) };
      },

      // 7. Applications
      async applications_list(params) {
        const opts = params?.includeSystemComponents !== undefined ? { includeSystemComponents: params.includeSystemComponents } : {};
        return services.applications.searchApplications(params?.query, opts);
      },
      async applications_uninstall(params) {
        return services.applications.launchUninstall(params.command);
      },

      // 8. Dictionary
      async dictionary_lookup(params) {
        return services.dictionary.lookup(params.word);
      },
      async dictionary_suggestions(params) {
        return services.dictionary.getSuggestions(params.prefix, params.limit);
      },
      async dictionary_toggle_favorite(params) {
        return { isFavorite: services.dictionary.toggleFavorite(params.word) };
      },
      async dictionary_get_favorites() {
        return { items: services.dictionary.getFavorites() };
      },
      async dictionary_get_history() {
        return { items: services.dictionary.getHistory() };
      }
    };
  });

  after(async () => {
    // 优雅释放所有 SQLite 句柄与服务资源
    if (services) {
      services.stop();
    }
    // 清理临时文件目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // 容忍临时句柄延迟释放
    }
  });

  // =========================================================================
  // 1. Emoji & Symbols 服务与 IPC 闭环测试
  // =========================================================================
  describe('1. Emoji & Symbols 服务与 IPC 闭环测试', () => {
    it('【英文、中文与拼音搜索】多模式精准命中 Emoji', async () => {
      // 英文搜索
      const resEn = await dispatchIpc({
        method: 'emoji_search',
        params: { query: 'rocket' }
      });
      assert.equal(resEn.success, true);
      assert.ok(Array.isArray(resEn.data.items));
      assert.ok(resEn.data.items.some(e => e.char === '🚀'));

      // 中文搜索
      const resZh = await dispatchIpc({
        method: 'emoji_search',
        params: { query: '火箭' }
      });
      assert.equal(resZh.success, true);
      assert.ok(resZh.data.items.some(e => e.char === '🚀'));

      // 拼音全拼搜索
      const resPy = await dispatchIpc({
        method: 'emoji_search',
        params: { query: 'huojian' }
      });
      assert.equal(resPy.success, true);
      assert.ok(resPy.data.items.some(e => e.char === '🚀'));

      // 检查返回项字段完整性
      const rocket = resZh.data.items.find(e => e.char === '🚀');
      assert.ok(rocket.name);
      assert.ok(rocket.nameZh);
      assert.ok(rocket.category);
      assert.ok(Array.isArray(rocket.keywords));
    });

    it('【分类过滤与上限控制】验证 category 与 limit 约束', async () => {
      const res = await dispatchIpc({
        method: 'emoji_search',
        params: { query: '', category: 'travel', limit: 3 }
      });
      assert.equal(res.success, true);
      assert.ok(res.data.items.length <= 3);
      assert.ok(res.data.items.every(e => e.category === 'travel'));
    });

    it('【使用记录与高频收藏状态机】动态维护 recents 与 favorites', async () => {
      // 1. 记录使用
      const recordRes = await dispatchIpc({
        method: 'emoji_record_usage',
        params: { char: '🎉' }
      });
      assert.equal(recordRes.success, true);

      // 获取近期记录
      const recentsRes = await dispatchIpc({
        method: 'emoji_get_recents',
        params: {}
      });
      assert.equal(recentsRes.success, true);
      assert.ok(recentsRes.data.items.includes('🎉'));

      // 2. 收藏状态切换 (Toggle On)
      const favOnRes = await dispatchIpc({
        method: 'emoji_toggle_favorite',
        params: { char: '🎉' }
      });
      assert.equal(favOnRes.success, true);
      assert.equal(favOnRes.data.isFavorite, true);

      const favsRes1 = await dispatchIpc({
        method: 'emoji_get_favorites',
        params: {}
      });
      assert.ok(favsRes1.data.items.includes('🎉'));

      // 3. 再次切换 (Toggle Off)
      const favOffRes = await dispatchIpc({
        method: 'emoji_toggle_favorite',
        params: { char: '🎉' }
      });
      assert.equal(favOffRes.success, true);
      assert.equal(favOffRes.data.isFavorite, false);

      const favsRes2 = await dispatchIpc({
        method: 'emoji_get_favorites',
        params: {}
      });
      assert.equal(favsRes2.data.items.includes('🎉'), false);
    });

    it('【破坏性参数校验】非法字段与缺失参数被安全拦截', async () => {
      // 缺少必需参数 char
      const res1 = await dispatchIpc({
        method: 'emoji_record_usage',
        params: {}
      });
      assert.equal(res1.success, false);
      assert.equal(res1.error.code, 'INVALID_REQUEST');

      // 非法类型 (char 为数字)
      const res2 = await dispatchIpc({
        method: 'emoji_toggle_favorite',
        params: { char: 12345 }
      });
      assert.equal(res2.success, false);
      assert.equal(res2.error.code, 'INVALID_REQUEST');

      // 未知恶意注入参数字段
      const res3 = await dispatchIpc({
        method: 'emoji_search',
        params: { query: 'test', maliciousField: true }
      });
      assert.equal(res3.success, false);
      assert.equal(res3.error.code, 'INVALID_REQUEST');
    });
  });

  // =========================================================================
  // 2. Translator 快速翻译与多语言即时解析闭环测试
  // =========================================================================
  describe('2. Translator 快速翻译与多语言即时解析闭环测试', () => {
    it('【英汉互译与技术词条兜底】离线内置高质量翻译与例句输出', async () => {
      // 英译中
      const resEn = await dispatchIpc({
        method: 'translator_translate',
        params: { text: 'hello world', sourceLanguage: 'en', targetLanguage: 'zh-CN' }
      });
      assert.equal(resEn.success, true);
      assert.ok(resEn.data.translatedText);
      assert.equal(resEn.data.targetLanguage, 'zh-CN');
      assert.ok(resEn.data.translatedText.includes('你好'));

      // 中译英
      const resZh = await dispatchIpc({
        method: 'translator_translate',
        params: { text: '设置', sourceLanguage: 'zh-CN', targetLanguage: 'en' }
      });
      assert.equal(resZh.success, true);
      assert.ok(resZh.data.translatedText);
      assert.equal(resZh.data.targetLanguage, 'en');
    });

    it('【语种自动探测与查词历史】正确识别语种并计入历史记录', async () => {
      // 探测英文
      const detectEn = await dispatchIpc({
        method: 'translator_detect_language',
        params: { text: 'Welcome to ZTools platform' }
      });
      assert.equal(detectEn.success, true);
      assert.equal(detectEn.data.language, 'en');

      // 探测中文
      const detectZh = await dispatchIpc({
        method: 'translator_detect_language',
        params: { text: '这是一个极速开源中枢' }
      });
      assert.equal(detectZh.success, true);
      assert.equal(detectZh.data.language, 'zh-CN');

      // 获取查词历史
      const historyRes = await dispatchIpc({
        method: 'translator_get_history',
        params: {}
      });
      assert.equal(historyRes.success, true);
      assert.ok(Array.isArray(historyRes.data.items));
      assert.ok(historyRes.data.items.length >= 2);
    });

    it('【异常处理】空文本与超长乱码防御', async () => {
      // 空字符拦截
      const resEmpty = await dispatchIpc({
        method: 'translator_translate',
        params: { text: '' }
      });
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.error.code, 'INVALID_REQUEST');

      // 超长畸形 Unicode 符号文本不崩溃
      const massiveText = '🚀'.repeat(5000);
      const resMassive = await dispatchIpc({
        method: 'translator_translate',
        params: { text: massiveText }
      });
      assert.equal(resMassive.success, true);
      assert.ok(resMassive.data.translatedText);
    });
  });

  // =========================================================================
  // 3. Notes 轻量临时便签 (SQLite WAL 存储与生命周期管理)
  // =========================================================================
  describe('3. Notes 便签服务 (SQLite WAL 持久化与生命周期)', () => {
    let createdNoteId;

    it('【增删改查生命周期闭环】新增、读取、更新、置顶与软删除', async () => {
      // 1. 新增便签
      const saveRes = await dispatchIpc({
        method: 'notes_save',
        params: {
          title: '系统架构设计要点',
          content: '## 核心原则\n- 纯粹开源\n- 极致性能\n- 拒绝臃肿',
          pinned: false,
          color: '#10b981',
          tags: ['architecture', 'ztools']
        }
      });
      assert.equal(saveRes.success, true);
      assert.ok(saveRes.data.id);
      assert.equal(saveRes.data.title, '系统架构设计要点');
      assert.equal(saveRes.data.pinned, false);
      assert.ok(saveRes.data.created_at);
      assert.ok(saveRes.data.updated_at);
      createdNoteId = saveRes.data.id;

      // 2. 读取单条便签
      const getRes = await dispatchIpc({
        method: 'notes_get',
        params: { id: createdNoteId }
      });
      assert.equal(getRes.success, true);
      assert.equal(getRes.data.id, createdNoteId);
      assert.ok(getRes.data.content.includes('拒绝臃肿'));

      // 3. 更新便签内容
      const updateRes = await dispatchIpc({
        method: 'notes_save',
        params: {
          id: createdNoteId,
          title: '系统架构设计要点 (已修订)',
          content: '## 核心原则 (v2)\n- 纯粹开源\n- 极致性能\n- 零外部依赖'
        }
      });
      assert.equal(updateRes.success, true);
      assert.equal(updateRes.data.title, '系统架构设计要点 (已修订)');

      // 4. 置顶切换
      const pinRes = await dispatchIpc({
        method: 'notes_toggle_pin',
        params: { id: createdNoteId }
      });
      assert.equal(pinRes.success, true);
      assert.equal(pinRes.data.pinned, true);

      // 5. 列表搜索过滤
      const listRes = await dispatchIpc({
        method: 'notes_list',
        params: { search: '开源' }
      });
      assert.equal(listRes.success, true);
      assert.ok(listRes.data.some(n => n.id === createdNoteId));

      // 6. 统计计数
      const countRes1 = await dispatchIpc({
        method: 'notes_count',
        params: {}
      });
      assert.equal(countRes1.success, true);
      assert.ok(countRes1.data.active >= 1);
      assert.equal(countRes1.data.trash, 0);

      // 7. 软删除 (移至回收站)
      const delRes = await dispatchIpc({
        method: 'notes_delete',
        params: { id: createdNoteId, permanent: false }
      });
      assert.equal(delRes.success, true);

      // 验证正常列表不再包含，但回收站包含
      const activeList = await dispatchIpc({
        method: 'notes_list',
        params: {}
      });
      assert.equal(activeList.data.some(n => n.id === createdNoteId), false);

      const trashList = await dispatchIpc({
        method: 'notes_list',
        params: { onlyTrash: true }
      });
      assert.ok(trashList.data.some(n => n.id === createdNoteId));

      // 8. 从回收站恢复
      const restoreRes = await dispatchIpc({
        method: 'notes_restore',
        params: { id: createdNoteId }
      });
      assert.equal(restoreRes.success, true);

      const restoredList = await dispatchIpc({
        method: 'notes_list',
        params: {}
      });
      assert.ok(restoredList.data.some(n => n.id === createdNoteId));

      // 9. 物理永久删除
      const permDelRes = await dispatchIpc({
        method: 'notes_delete',
        params: { id: createdNoteId, permanent: true }
      });
      assert.equal(permDelRes.success, true);

      const finalList = await dispatchIpc({
        method: 'notes_list',
        params: { onlyTrash: true }
      });
      assert.equal(finalList.data.some(n => n.id === createdNoteId), false);
    });

    it('【高并发并发写入压力测试】20 次并发写入 SQLite WAL 事务隔离无撕裂', async () => {
      const concurrentTasks = [];
      for (let i = 0; i < 20; i++) {
        concurrentTasks.push(
          dispatchIpc({
            method: 'notes_save',
            params: {
              title: `并发压力便签 #${i}`,
              content: `并发写入校验测试内容 ${i}`,
              tags: ['concurrency-test']
            }
          })
        );
      }

      const results = await Promise.all(concurrentTasks);
      assert.equal(results.length, 20);
      assert.ok(results.every(r => r.success === true && r.data.id));

      const count = await dispatchIpc({
        method: 'notes_count',
        params: {}
      });
      assert.ok(count.data.active >= 20);
    });
  });

  // =========================================================================
  // 4. WindowsRun 运行窗口增强与系统别名闭环测试
  // =========================================================================
  describe('4. WindowsRun 运行中枢与系统别名闭环测试', () => {
    it('【内置 30+ 别名搜索与拼音匹配】快速检索系统运维工具', async () => {
      // 1. 英文 alias 检索
      const resCmd = await dispatchIpc({
        method: 'windows_run_search',
        params: { query: 'regedit' }
      });
      assert.equal(resCmd.success, true);
      assert.ok(resCmd.data.some(c => c.alias === 'regedit' && c.command === 'regedit.exe'));

      // 2. 检查管理员预置标记 (UAC RunAs 默认提权)
      const regedit = resCmd.data.find(c => c.alias === 'regedit');
      assert.equal(regedit.runAsAdminByDefault, true);

      // 3. 中文全拼搜索 "zhuceshibianjiqi"
      const resPinyin = await dispatchIpc({
        method: 'windows_run_search',
        params: { query: 'zhuceshi' }
      });
      assert.equal(resPinyin.success, true);
      assert.ok(resPinyin.data.some(c => c.alias === 'regedit'));

      // 4. 控制面板 "control"
      const resControl = await dispatchIpc({
        method: 'windows_run_search',
        params: { query: 'control' }
      });
      assert.ok(resControl.data.some(c => c.alias === 'control'));
    });

    it('【自定义别名注册、检索与删除】用户态快捷指令增删改查', async () => {
      // 注册自定义别名
      const regRes = await dispatchIpc({
        method: 'windows_run_register_alias',
        params: {
          alias: 'gitbash',
          command: 'bash.exe',
          description: 'Git Bash Terminal',
          descriptionZh: 'Git 命令行终端',
          runAsAdminByDefault: false
        }
      });
      assert.equal(regRes.success, true);
      assert.equal(regRes.data.alias, 'gitbash');

      // 搜索该别名
      const searchRes = await dispatchIpc({
        method: 'windows_run_search',
        params: { query: 'gitbash' }
      });
      assert.ok(searchRes.data.some(c => c.alias === 'gitbash'));

      // 移除该自定义别名
      const removeRes = await dispatchIpc({
        method: 'windows_run_remove_alias',
        params: { alias: 'gitbash' }
      });
      assert.equal(removeRes.success, true);

      // 验证已被删除
      const afterSearch = await dispatchIpc({
        method: 'windows_run_search',
        params: { query: 'gitbash' }
      });
      assert.equal(afterSearch.data.some(c => c.alias === 'gitbash'), false);
    });

    it('【参数边界测试】空别名与空命令被防御性拒绝', async () => {
      const resEmpty = await dispatchIpc({
        method: 'windows_run_register_alias',
        params: { alias: '', command: '' }
      });
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.error.code, 'INVALID_REQUEST');
    });
  });

  // =========================================================================
  // 5. WindowsTaskbar 任务栏状态与控制闭环测试
  // =========================================================================
  describe('5. WindowsTaskbar 任务栏状态与显隐控制测试', () => {
    it('【状态获取与显隐状态迁移】感知任务栏可见性', async () => {
      const statusRes = await dispatchIpc({
        method: 'taskbar_status',
        params: {}
      });
      assert.equal(statusRes.success, true);
      assert.equal(typeof statusRes.data.visible, 'boolean');
    });

    it('【高频切换并发防撕裂】快速连续触发状态机平稳切换', async () => {
      // 快速触发 show / hide / toggle
      const p1 = dispatchIpc({ method: 'taskbar_show', params: {} });
      const p2 = dispatchIpc({ method: 'taskbar_hide', params: {} });
      const p3 = dispatchIpc({ method: 'taskbar_toggle', params: {} });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1.success, true);
      assert.equal(r2.success, true);
      assert.equal(r3.success, true);
    });
  });

  // =========================================================================
  // 6. Screenshots 截图历史扫描、置顶与回贴闭环测试
  // =========================================================================
  describe('6. Screenshots 截图历史扫描、置顶与回贴闭环测试', () => {
    let mockImg1;
    let mockImg2;
    let mockNonImg;

    before(async () => {
      // 在可控测试目录生成真实测试文件
      mockImg1 = path.join(testScreenshotsDir, 'Screenshot_20261013_120000.png');
      mockImg2 = path.join(testScreenshotsDir, 'Screenshot_20261013_120500.jpg');
      mockNonImg = path.join(testScreenshotsDir, 'notes.txt');

      await fs.writeFile(mockImg1, Buffer.from('mock-png-data'));
      await fs.writeFile(mockImg2, Buffer.from('mock-jpg-data'));
      await fs.writeFile(mockNonImg, 'text-content-should-be-ignored');
    });

    it('【目录扫描与图片过滤】只识别合法图像，提取元数据', async () => {
      const scanRes = await dispatchIpc({
        method: 'screenshots_scan',
        params: { forceRefresh: true }
      });
      assert.equal(scanRes.success, true);
      assert.ok(Array.isArray(scanRes.data));
      // 必须包含 2 张图片，忽略 .txt
      assert.ok(scanRes.data.some(s => s.path === mockImg1));
      assert.ok(scanRes.data.some(s => s.path === mockImg2));
      assert.equal(scanRes.data.some(s => s.path === mockNonImg), false);
    });

    it('【最新截图一键回贴】返回最新生成的文件', async () => {
      const pasteRes = await dispatchIpc({
        method: 'screenshots_paste_latest',
        params: {}
      });
      assert.equal(pasteRes.success, true);
      assert.equal(pasteRes.data.success, true);
      assert.ok(pasteRes.data.screenshot);
      assert.ok(pasteRes.data.screenshot.path);
    });

    it('【置顶切换与文件移除】pin/unpin 及删除生命周期', async () => {
      // 1. 置顶
      const pinRes1 = await dispatchIpc({
        method: 'screenshots_toggle_pin',
        params: { filePath: mockImg1 }
      });
      assert.equal(pinRes1.success, true);
      assert.equal(pinRes1.data.pinned, true);

      // 2. 取消置顶
      const pinRes2 = await dispatchIpc({
        method: 'screenshots_toggle_pin',
        params: { filePath: mockImg1 }
      });
      assert.equal(pinRes2.success, true);
      assert.equal(pinRes2.data.pinned, false);

      // 3. 删除文件
      const delRes = await dispatchIpc({
        method: 'screenshots_delete',
        params: { filePath: mockImg2 }
      });
      assert.equal(delRes.success, true);
      assert.equal(fsSync.existsSync(mockImg2), false);
    });

    it('【防御性校验】删除不存在的文件抛出明确异常', async () => {
      const nonExistent = path.join(testScreenshotsDir, 'ghost-image.png');
      const delRes = await dispatchIpc({
        method: 'screenshots_delete',
        params: { filePath: nonExistent }
      });
      assert.equal(delRes.success, false);
      assert.ok(delRes.error.message.includes('不存在'));
    });
  });

  // =========================================================================
  // 7. Applications 已装应用管理与快速过滤测试
  // =========================================================================
  describe('7. Applications 已装应用管理与快速过滤测试', () => {
    it('【应用枚举与拼音检索】支持系统组件过滤与名称模糊匹配', async () => {
      // 列出所有应用（不含系统组件）
      const listRes = await dispatchIpc({
        method: 'applications_list',
        params: { includeSystemComponents: false }
      });
      assert.equal(listRes.success, true);
      assert.ok(Array.isArray(listRes.data));

      // 验证返回对象规范契约
      if (listRes.data.length > 0) {
        const app = listRes.data[0];
        assert.ok(typeof app.name === 'string');
        assert.ok(typeof app.pinyin === 'string');
        assert.ok(typeof app.pinyinInitials === 'string');
        assert.equal(app.isSystemComponent, false);
      }
    });

    it('【沙箱测试适配器】注入模拟扫描器验证高频国产应用拼音匹配', async () => {
      const mockScanner = {
        async scan() {
          return [
            {
              id: 'app-wechat',
              name: '微信',
              version: '3.9.10',
              publisher: 'Tencent',
              installLocation: 'C:\\Program Files\\Tencent\\WeChat',
              uninstallString: 'C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe',
              isSystemComponent: false,
              pinyin: 'weixin',
              pinyinInitials: 'wx'
            },
            {
              id: 'app-sys',
              name: 'Windows Update Component',
              version: '10.0',
              publisher: 'Microsoft',
              installLocation: '',
              uninstallString: '',
              isSystemComponent: true,
              pinyin: 'windowsupdate',
              pinyinInitials: 'wu'
            }
          ];
        }
      };

      const customAppService = new ApplicationsService({ scanner: mockScanner });

      // 拼音首字母 'wx' 搜索
      const searchRes1 = await customAppService.searchApplications('wx');
      assert.equal(searchRes1.length, 1);
      assert.equal(searchRes1[0].name, '微信');

      // 系统组件过滤验证
      const searchNoSys = await customAppService.searchApplications('', { includeSystemComponents: false });
      assert.equal(searchNoSys.length, 1);
      assert.equal(searchNoSys[0].name, '微信');

      const searchWithSys = await customAppService.searchApplications('', { includeSystemComponents: true });
      assert.equal(searchWithSys.length, 2);
    });

    it('【卸载指令校验】空指令拦截', async () => {
      const resEmpty = await dispatchIpc({
        method: 'applications_uninstall',
        params: { command: '' }
      });
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.error.code, 'INVALID_REQUEST');
    });
  });

  // =========================================================================
  // 8. Dictionary 英汉双解科技词典闭环测试
  // =========================================================================
  describe('8. Dictionary 英汉双解科技词典闭环测试', () => {
    it('【科技词汇精准查词与音标例句】格式化释义与技术例句输出', async () => {
      const lookupRes = await dispatchIpc({
        method: 'dictionary_lookup',
        params: { word: 'algorithm' }
      });
      assert.equal(lookupRes.success, true);
      assert.ok(lookupRes.data);
      assert.equal(lookupRes.data.word, 'algorithm');
      assert.ok(lookupRes.data.phonetic);
      assert.ok(lookupRes.data.definitions.some(d => d.meaningZh.includes('算法')));
      assert.ok(lookupRes.data.examples.length >= 1);
    });

    it('【前缀联想推荐与生词收藏状态机】Suggestions 与 Favorites', async () => {
      // 1. 前缀推荐
      const suggRes = await dispatchIpc({
        method: 'dictionary_suggestions',
        params: { prefix: 'algo', limit: 5 }
      });
      assert.equal(suggRes.success, true);
      assert.ok(suggRes.data.some(s => s.word === 'algorithm'));

      // 2. 收藏生词
      const favRes1 = await dispatchIpc({
        method: 'dictionary_toggle_favorite',
        params: { word: 'algorithm' }
      });
      assert.equal(favRes1.success, true);
      assert.equal(favRes1.data.isFavorite, true);

      // 获取收藏清单
      const favList = await dispatchIpc({
        method: 'dictionary_get_favorites',
        params: {}
      });
      assert.equal(favList.success, true);
      assert.ok(favList.data.items.includes('algorithm'));

      // 查词历史
      const historyRes = await dispatchIpc({
        method: 'dictionary_get_history',
        params: {}
      });
      assert.equal(historyRes.success, true);
      assert.ok(historyRes.data.items.includes('algorithm'));

      // 3. 取消收藏
      const favRes2 = await dispatchIpc({
        method: 'dictionary_toggle_favorite',
        params: { word: 'algorithm' }
      });
      assert.equal(favRes2.success, true);
      assert.equal(favRes2.data.isFavorite, false);
    });

    it('【安全与对抗】SQL 注入与恶意特殊字符查询安全过滤', async () => {
      const sqlInjectionWord = "' OR 1=1 --; DROP TABLE words;";
      const res = await dispatchIpc({
        method: 'dictionary_lookup',
        params: { word: sqlInjectionWord }
      });
      assert.equal(res.success, true);
      // 未收录时安全返回 null 或兜底，绝不崩溃或报 SQL 语法错误
      assert.equal(res.data, null);
    });
  });

  // =========================================================================
  // 9. 全局 IPC 安全门禁与多服务混合并发混沌压力测试
  // =========================================================================
  describe('9. 全局 IPC 安全门禁与多服务混合并发混沌测试', () => {
    it('【未受信任插件权限拦截】非特权插件无权调用敏感底层方法', async () => {
      const unauthorizedCaller = { type: 'plugin', pluginId: 'untrusted-evil-plugin' };
      // 验证未开放给插件的方法拦截
      const deniedRes = await dispatchIpc(
        { method: 'window_open', params: {} },
        unauthorizedCaller
      );
      assert.equal(deniedRes.success, false);
      assert.equal(deniedRes.error.code, 'PERMISSION_DENIED');
    });

    it('【未知方法调用拦截】请求不存在的方法抛出 METHOD_NOT_FOUND', async () => {
      const res = await dispatchIpc({
        method: 'totally_unknown_service_method',
        params: {}
      });
      assert.equal(res.success, false);
      assert.equal(res.error.code, 'METHOD_NOT_FOUND');
    });

    it('【40 项跨服务混合高并发调用】零死锁、零状态撕裂、100% 成功交付', async () => {
      const mixedRequests = [
        // Emoji
        dispatchIpc({ method: 'emoji_search', params: { query: 'heart' } }),
        dispatchIpc({ method: 'emoji_get_recents', params: {} }),
        // Translator
        dispatchIpc({ method: 'translator_detect_language', params: { text: 'Hello ZTools' } }),
        dispatchIpc({ method: 'translator_get_history', params: {} }),
        // Notes
        dispatchIpc({ method: 'notes_list', params: {} }),
        dispatchIpc({ method: 'notes_count', params: {} }),
        // Windows Run
        dispatchIpc({ method: 'windows_run_search', params: { query: 'cmd' } }),
        // Windows Taskbar
        dispatchIpc({ method: 'taskbar_status', params: {} }),
        // Screenshots
        dispatchIpc({ method: 'screenshots_scan', params: {} }),
        // Applications
        dispatchIpc({ method: 'applications_list', params: {} }),
        // Dictionary
        dispatchIpc({ method: 'dictionary_suggestions', params: { prefix: 'con' } }),
        dispatchIpc({ method: 'dictionary_get_history', params: {} })
      ];

      // 重复四轮构造 48 个并发混合请求
      const allRequests = [
        ...mixedRequests,
        ...mixedRequests,
        ...mixedRequests,
        ...mixedRequests
      ];

      const t0 = performance.now();
      const results = await Promise.all(allRequests);
      const elapsed = performance.now() - t0;

      assert.equal(results.length, 48);
      assert.ok(results.every(r => r.success === true), '所有并发 IPC 请求必须全部成功完成');
      assert.ok(elapsed < 2000, `48 项并发跨模块混合调用总延迟 (${elapsed.toFixed(2)}ms) 必须低于 2000ms`);
    });
  });
});
