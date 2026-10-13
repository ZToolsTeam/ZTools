import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'

import { EmojiService, EMOJI_DATABASE } from '../../src/main/services/emoji-service.js'
import { TranslatorService, OfflineTranslationProvider, detectLanguage } from '../../src/main/services/translator-service.js'
import { NotesService } from '../../src/main/services/notes-service.js'
import { WindowsRunService, BUILTIN_RUN_COMMANDS } from '../../src/main/services/windows-run-service.js'
import { TaskbarService, toggleTaskbar, type TaskbarWin32Adapter } from '../../src/main/services/taskbar-service.js'
import { ScreenshotsService } from '../../src/main/services/screenshots-service.js'
import { ApplicationsService, type ApplicationRegistryScanner, type ApplicationUninstaller } from '../../src/main/services/applications-service.js'
import { DictionaryService, LOCAL_DICTIONARY_ENTRIES } from '../../src/main/services/dictionary-service.js'

test('ZTools M1.5 Group 2 High-Frequency Core Builtin Services Test Suite', async (t) => {

  // ===========================================================================
  // 1. Emoji & Symbols Service (M1.5-9)
  // ===========================================================================
  await t.test('1. EmojiService: Unicode, Math, Arrows and Pinyin Search', () => {
    const service = new EmojiService()

    // Happy Path: 英文关键词检索
    const smileRes = service.search('smile')
    assert.ok(smileRes.items.length > 0)
    assert.equal(smileRes.query, 'smile')
    assert.ok(smileRes.items.some(i => i.char === '😊' || i.char === '😀'))

    // Happy Path: 中文名称检索
    const weixiaoRes = service.search('微笑')
    assert.ok(weixiaoRes.items.length > 0)
    assert.ok(weixiaoRes.items.some(i => i.char === '😊'))

    // Happy Path: 拼音全拼检索 (xiaolian -> 开怀/眯眼微笑/笑脸)
    const pinyinRes = service.search('weixiao')
    assert.ok(pinyinRes.items.length > 0)
    assert.ok(pinyinRes.items.some(i => i.pinyin.includes('weixiao')))

    // Happy Path: 拼音首字母检索 (wx -> 微笑, bdy -> 不等于)
    const initialsRes = service.search('wx')
    assert.ok(initialsRes.items.length > 0)
    assert.ok(initialsRes.items.some(i => i.pinyinInitials === 'wx'))

    // Happy Path: 数学符号与希腊字母检索 (pi -> π, sum -> ∑, approx -> ≈)
    const piRes = service.search('pi', { category: 'math' })
    assert.ok(piRes.items.some(i => i.char === 'π'))

    const sumRes = service.search('sum', { category: 'math' })
    assert.ok(sumRes.items.some(i => i.char === '∑'))

    // Happy Path: 箭头符号与推导符号 (arrow -> →, ←, ⇒)
    const arrowRes = service.search('arrow', { category: 'arrows' })
    assert.ok(arrowRes.items.length >= 3)
    assert.ok(arrowRes.items.some(i => i.char === '→'))

    // Happy Path: 肤色修饰符 (Skin Tone)
    const thumbsUp = EMOJI_DATABASE.find(i => i.char === '👍')!
    assert.ok(thumbsUp.supportsSkinTone)
    const toned = service.applySkinTone(thumbsUp, 'dark')
    assert.notEqual(toned.char, '👍')
    assert.ok(toned.char.includes('👍'))

    // 历史使用记录与收藏夹
    service.recordUsage('😊')
    service.recordUsage('🚀')
    assert.deepEqual(service.getRecent(), ['🚀', '😊'])

    assert.equal(service.isFavorite('🚀'), false)
    assert.equal(service.toggleFavorite('🚀'), true)
    assert.equal(service.isFavorite('🚀'), true)
    assert.equal(service.toggleFavorite('🚀'), false)
    assert.equal(service.isFavorite('🚀'), false)

    // Beyond Happy Path / 异常与边界覆盖
    // 空查询与空格查询
    const emptyRes = service.search('')
    assert.equal(emptyRes.total, EMOJI_DATABASE.length)
    const spaceRes = service.search('   ')
    assert.equal(spaceRes.total, EMOJI_DATABASE.length)

    // 畸形与极长搜索词 (不应抛出异常)
    const crazyRes = service.search('!@#$%^&*()_+~`|}{[]:;?><,./-=' + 'a'.repeat(500))
    assert.equal(crazyRes.items.length, 0)
    assert.equal(crazyRes.total, 0)

    // 非法类型调用安全防御
    assert.doesNotThrow(() => service.search(null as unknown as string))
    assert.doesNotThrow(() => service.recordUsage(null as unknown as string))
    assert.doesNotThrow(() => service.toggleFavorite(undefined as unknown as string))
  })

  // ===========================================================================
  // 2. Translator Service (M1.5-10)
  // ===========================================================================
  await t.test('2. TranslatorService: Selected Text, Offline Engine & Cloud Lock Removal', async () => {
    const service = new TranslatorService()

    // 语言检测算法验证
    assert.equal(detectLanguage('你好，世界'), 'zh-CN')
    assert.equal(detectLanguage('こんにちは'), 'ja')
    assert.equal(detectLanguage('안녕하세요'), 'ko')
    assert.equal(detectLanguage('Привет мир'), 'ru')
    assert.equal(detectLanguage('Hello, world!'), 'en')

    // Happy Path: 本地离线高频短语极速翻译 (zh -> en)
    const resZhEn = await service.translate('你好', { sourceLanguage: 'zh-CN', targetLanguage: 'en' })
    assert.equal(resZhEn.translatedText, 'Hello')
    assert.equal(resZhEn.engine, 'offline')
    assert.equal(resZhEn.targetLanguage, 'en')

    // Happy Path: 本地离线短语极速翻译 (en -> zh)
    const resEnZh = await service.translate('thank you', { sourceLanguage: 'en', targetLanguage: 'zh-CN' })
    assert.equal(resEnZh.translatedText, '谢谢你')

    // 划词划取自动带入翻译
    const selectedRes = await service.translateSelected('hello world')
    assert.equal(selectedRes.translatedText, '你好，世界')
    assert.equal(selectedRes.sourceLanguage, 'en')

    // LRU 缓存与历史记录验证
    const cachedRes = await service.translate('hello world')
    assert.equal(cachedRes.cached, true)
    assert.ok(service.getHistory().length > 0)

    // Beyond Happy Path / 异常注入与容灾测试
    // 1. 空内容或纯空格报错拦截
    await assert.rejects(service.translate(''), /翻译内容不能为空/)
    await assert.rejects(service.translate('   '), /翻译内容不能为空/)
    await assert.rejects(service.translateSelected(''), /未检测到选中文本/)

    // 2. AbortSignal 取消请求断言
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(service.translate('hello', { signal: controller.signal }), /翻译请求已取消/)

    // 3. Provider 故障注入并自动平滑降级到离线词典
    const faultyProvider = {
      async translate(): Promise<{ translatedText: string }> {
        throw new Error('503 Service Unavailable: Remote API down')
      }
    }
    const robustService = new TranslatorService(faultyProvider)
    const fallbackRes = await robustService.translate('save')
    assert.equal(fallbackRes.translatedText, '保存')
    assert.equal(fallbackRes.engine, 'offline')
  })

  // ===========================================================================
  // 3. Notes Service (M1.5-11)
  // ===========================================================================
  await t.test('3. NotesService: SQLite Storage, FTS5 Search & Markdown Excerpt', () => {
    const service = new NotesService({ dbPath: ':memory:' })

    // Markdown 摘要与字数计算
    const sampleMd = `# 项目开发指南\n\n这是 **ZTools** 核心架构说明。\n\n\`\`\`ts\nconsole.log('hello')\n\`\`\`\n\n欢迎参与贡献！`
    const meta = service.parseMarkdownMeta(sampleMd)
    assert.ok(meta.wordCount > 10)
    assert.ok(meta.excerpt.includes('项目开发指南'))
    assert.ok(!meta.excerpt.includes('```')) // 代码块已正确剥离

    // 自动提取首行标题
    assert.equal(service.extractTitleFromContent('# 深度探索\n\n内容'), '深度探索')
    assert.equal(service.extractTitleFromContent('纯文本第一行\n第二行'), '纯文本第一行')

    // 1. 创建笔记
    const note1 = service.createNote({
      title: '架构重构备忘录',
      content: '采用纯 TypeScript 宿主与预编译 Rust Sidecar 解耦设计。',
      tags: ['arch', 'design'],
      pinned: true
    })
    assert.ok(note1.id)
    assert.equal(note1.title, '架构重构备忘录')
    assert.equal(note1.pinned, true)

    const note2 = service.createNote({
      content: '# 极客键盘流\n上下键移动聚焦，Ctrl+K 唤起操作面板。',
      tags: ['keyboard']
    })
    assert.equal(note2.title, '极客键盘流')
    assert.equal(note2.pinned, false)

    // 2. 列表与置顶排序
    const list = service.listNotes()
    assert.equal(list.length, 2)
    assert.equal(list[0]?.id, note1.id) // 置顶排在最前

    // 3. 全文搜索 (FTS5 / LIKE 降级)
    const searchRes = service.searchNotes('Sidecar')
    assert.ok(searchRes.length > 0)
    assert.equal(searchRes[0]?.note.id, note1.id)

    // 4. 更新笔记与切换置顶
    const updated = service.updateNote(note2.id, { title: '全新标题' })
    assert.equal(updated.title, '全新标题')

    const pinnedStatus = service.togglePin(note2.id)
    assert.equal(pinnedStatus, true)

    // 5. 移入废纸篓与恢复
    service.moveToTrash(note2.id)
    assert.equal(service.listNotes().length, 1) // 默认不包含废纸篓
    assert.equal(service.listNotes({ onlyTrash: true }).length, 1)

    const count = service.countNotes()
    assert.equal(count.active, 1)
    assert.equal(count.trash, 1)
    assert.equal(count.total, 2)

    service.restoreFromTrash(note2.id)
    assert.equal(service.listNotes().length, 2)

    // 6. 彻底删除与清空废纸篓
    service.moveToTrash(note2.id)
    const clearedCount = service.emptyTrash()
    assert.equal(clearedCount, 1)
    assert.equal(service.listNotes().length, 1)

    // Beyond Happy Path / 异常覆盖
    assert.throws(() => service.updateNote('non-existent-id', { title: 'fail' }), /笔记不存在/)
    assert.throws(() => service.togglePin('non-existent-id'), /笔记不存在/)

    // 数据库关闭后调用防护
    service.close()
    assert.throws(() => service.createNote({ content: 'fail' }), /Database is closed/)
  })

  // ===========================================================================
  // 4. Windows Run Service (M1.5-12)
  // ===========================================================================
  await t.test('4. WindowsRunService: Commands, Aliases, Search & Win32 Execution', async () => {
    const launched: Array<{ file: string; args: readonly string[]; cwd?: string | undefined }> = []
    const launchedAdmin: Array<{ file: string; args?: string | undefined }> = []

    const mockLauncher = {
      launch(file: string, args: readonly string[], options?: { cwd?: string | undefined }) {
        launched.push({ file, args, cwd: options?.cwd })
        return { pid: 12345 } as any
      },
      async launchAsAdmin(file: string, args?: string) {
        launchedAdmin.push({ file, args })
        return { success: true }
      }
    }

    const service = new WindowsRunService(mockLauncher)

    // 验证预置 30+ 中国开发者高频系统别名
    assert.ok(BUILTIN_RUN_COMMANDS.length >= 30)
    const cmdEntry = service.getByAlias('cmd')
    assert.ok(cmdEntry)
    assert.equal(cmdEntry.command, 'cmd.exe')

    const regeditEntry = service.getByAlias('regedit')
    assert.ok(regeditEntry)
    assert.equal(regeditEntry.runAsAdminByDefault, true)

    // 搜索别名：支持拼音与中文 (renwuguanliqi -> taskmgr)
    const taskmgrSearch = service.searchCommands('renwuguanliqi')
    assert.ok(taskmgrSearch.some(c => c.alias === 'taskmgr'))

    const calcSearch = service.searchCommands('计算器')
    assert.ok(calcSearch.some(c => c.alias === 'calc'))

    // 自定义别名注册与管理
    const custom = service.createCustomCommand({
      alias: 'mytool',
      command: 'C:\\Tools\\app.exe',
      arguments: '--verbose',
      descriptionZh: '我的自定义调试工具'
    })
    assert.equal(custom.alias, 'mytool')
    assert.equal(service.getByAlias('mytool')?.command, 'C:\\Tools\\app.exe')

    // 执行指令：普通派生
    const execDirect = await service.execute('cmd', { arguments: '/c echo hello' })
    assert.equal(execDirect.success, true)
    assert.equal(execDirect.pid, 12345)
    assert.equal(launched[0]?.file, 'cmd.exe')

    // 执行指令：管理员 UAC 提权派生 (RunAs)
    const execAdmin = await service.execute('regedit')
    assert.equal(execAdmin.success, true)
    assert.equal(execAdmin.message, '已请求管理员权限启动')
    assert.equal(launchedAdmin[0]?.file, 'regedit.exe')

    // 执行指令：在 Shell 中执行并保持终端打开
    await service.execute('notepad', { shell: 'cmd' })
    assert.equal(launched[1]?.file, 'cmd.exe')
    assert.deepEqual(launched[1]?.args.slice(0, 2), ['/k', 'notepad.exe'])

    // Beyond Happy Path / 异常覆盖
    await assert.rejects(service.execute(''), /执行指令不能为空/)
    await assert.rejects(service.execute('   '), /执行指令不能为空/)
    assert.throws(() => service.createCustomCommand({ alias: '', command: 'app' }), /别名不能为空/)
    assert.throws(() => service.createCustomCommand({ alias: 'app', command: '' }), /命令不能为空/)

    // 提权失败异常处理
    const failLauncher = {
      launch: mockLauncher.launch,
      async launchAsAdmin() {
        return { success: false, error: '用户拒绝了 UAC 提升权限' }
      }
    }
    const failService = new WindowsRunService(failLauncher)
    await assert.rejects(failService.execute('regedit', { asAdministrator: true }), /用户拒绝了 UAC 提升权限/)
  })

  // ===========================================================================
  // 5. Windows Taskbar Control Service (M1.5-13)
  // ===========================================================================
  await t.test('5. TaskbarService: Win32 toggleTaskbar and Visibility Switching', async () => {
    let mockVisible = true
    const hudMessages: string[] = []

    const mockAdapter: TaskbarWin32Adapter = {
      async setTaskbarVisible(v: boolean) {
        mockVisible = v
        return true
      },
      async getTaskbarVisible() {
        return mockVisible
      }
    }

    const mockHudService = {
      async showHUD(msg: string) {
        hudMessages.push(msg)
      }
    } as any

    const service = new TaskbarService({ adapter: mockAdapter, hudService: mockHudService })

    // 初始状态应为可见
    assert.equal(await service.isTaskbarVisible(), true)

    // 1. 隐藏任务栏
    const hideRes = await service.hideTaskbar()
    assert.equal(hideRes.success, true)
    assert.equal(hideRes.visible, false)
    assert.equal(hideRes.message, '任务栏已隐藏')
    assert.equal(await service.isTaskbarVisible(), false)

    // 2. 显示任务栏
    const showRes = await service.showTaskbar()
    assert.equal(showRes.success, true)
    assert.equal(showRes.visible, true)
    assert.equal(showRes.message, '任务栏已显示')

    // 3. 往返切换测试 toggleTaskbar
    const toggle1 = await service.toggleTaskbar()
    assert.equal(toggle1.visible, false)
    const toggle2 = await service.toggleTaskbar()
    assert.equal(toggle2.visible, true)

    // 验证 HUD 弹出通知已收到
    assert.ok(hudMessages.includes('任务栏已隐藏'))
    assert.ok(hudMessages.includes('任务栏已显示'))

    // 顶级方法便捷调用验证
    const topRes = await toggleTaskbar({ adapter: mockAdapter })
    assert.equal(topRes.success, true)
  })

  // ===========================================================================
  // 6. Screenshots Service (M1.5-14)
  // ===========================================================================
  await t.test('6. ScreenshotsService: Discovery, History & Paste to Active App', async () => {
    // 创建沙箱临时截图目录
    const tempDir = path.join(os.tmpdir(), `ztools-test-screenshots-${Date.now()}`)
    fs.mkdirSync(tempDir, { recursive: true })

    const file1 = path.join(tempDir, 'screenshot-2026-10-10.png')
    const file2 = path.join(tempDir, 'screenshot-2026-10-11.png')
    fs.writeFileSync(file1, 'fake image 1')
    fs.writeFileSync(file2, 'fake image 2')
    // 明确设置修改时间差以确保严格的时间倒序
    fs.utimesSync(file1, new Date('2026-10-10T10:00:00Z'), new Date('2026-10-10T10:00:00Z'))
    fs.utimesSync(file2, new Date('2026-10-11T10:00:00Z'), new Date('2026-10-11T10:00:00Z'))

    const service = new ScreenshotsService({ searchDirectories: [tempDir] })

    // 扫描结果验证
    const records = service.scanScreenshots(true)
    assert.equal(records.length, 2)
    assert.equal(records[0]?.filename, 'screenshot-2026-10-11.png') // 最新的排在前面

    // 获取最新单张截图
    const latest = service.getLatestScreenshot()
    assert.ok(latest)
    assert.equal(latest.filename, 'screenshot-2026-10-11.png')

    // 置顶操作验证
    assert.equal(service.pinScreenshot(file1), true)
    const pinnedSearch = service.searchScreenshots({ pinnedFirst: true })
    assert.equal(pinnedSearch[0]?.path, file1) // 被置顶的文件排到第一名

    // 一键回贴验证
    let pastedFile = ''
    const pasteRes = await service.pasteLatestScreenshot(async (filePath) => {
      pastedFile = filePath
    })
    assert.equal(pasteRes.success, true)
    assert.equal(pastedFile, latest.path)

    // 删除截图测试
    const deleteRes = await service.deleteScreenshot(file1)
    assert.equal(deleteRes, true)
    assert.equal(service.scanScreenshots(true).length, 1)

    // Beyond Happy Path / 异常测试
    // 删除不存在的文件
    await assert.rejects(service.deleteScreenshot(path.join(tempDir, 'not-exist.png')), /文件不存在/)

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true })

    // 空目录下回贴
    const emptyService = new ScreenshotsService({ searchDirectories: [tempDir] })
    const emptyPaste = await emptyService.pasteLatestScreenshot()
    assert.equal(emptyPaste.success, false)
    assert.equal(emptyPaste.message, '未找到近期截图')
  })

  // ===========================================================================
  // 7. Applications Service (M1.5-15)
  // ===========================================================================
  await t.test('7. ApplicationsService: Registry Scanning, Pinyin Search & Uninstaller', async () => {
    const mockScanner: ApplicationRegistryScanner = {
      async scan() {
        return [
          {
            id: 'app-wechat',
            name: '微信',
            version: '3.9.10',
            publisher: 'Tencent Holdings Limited',
            installLocation: 'C:\\Program Files\\Tencent\\WeChat',
            uninstallString: 'C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe',
            quietUninstallString: 'C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe /S',
            isSystemComponent: false,
            pinyin: 'weixin',
            pinyinInitials: 'wx'
          },
          {
            id: 'app-vscode',
            name: 'Visual Studio Code',
            version: '1.93.0',
            publisher: 'Microsoft Corporation',
            installLocation: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code',
            uninstallString: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\unins000.exe"',
            isSystemComponent: false,
            pinyin: 'visualstudiocode',
            pinyinInitials: 'vsc'
          },
          {
            id: 'app-system-runtime',
            name: 'Microsoft Edge WebView2 Runtime',
            version: '124.0.0.0',
            publisher: 'Microsoft Corporation',
            installLocation: '',
            uninstallString: 'setup.exe --uninstall',
            isSystemComponent: true,
            pinyin: 'edge',
            pinyinInitials: 'edge'
          }
        ]
      }
    }

    let uninstalledCmd = ''
    const mockUninstaller: ApplicationUninstaller = {
      async uninstall(cmd: string) {
        uninstalledCmd = cmd
        return { success: true }
      }
    }

    const service = new ApplicationsService({ scanner: mockScanner, uninstaller: mockUninstaller })

    // 1. 获取全量已安装列表
    const all = await service.getInstalledApplications()
    assert.equal(all.length, 3)

    // 2. 搜索：支持拼音全拼与首字母模糊匹配 (wx -> 微信, weixin -> 微信)
    const wxSearch = await service.searchApplications('wx')
    assert.equal(wxSearch.length, 1)
    assert.equal(wxSearch[0]?.name, '微信')

    const weixinSearch = await service.searchApplications('weixin')
    assert.equal(weixinSearch.length, 1)
    assert.equal(weixinSearch[0]?.name, '微信')

    // 3. 搜索：英文名称与过滤系统组件
    const codeSearch = await service.searchApplications('Code', { includeSystemComponents: false })
    assert.equal(codeSearch.length, 1)
    assert.equal(codeSearch[0]?.name, 'Visual Studio Code')

    // 4. 启动卸载程序 (普通模式)
    const uninstallRes = await service.launchUninstall('app-wechat')
    assert.equal(uninstallRes.success, true)
    assert.equal(uninstalledCmd, 'C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe')

    // 5. 启动卸载程序 (静默模式)
    const quietUninstallRes = await service.launchUninstall('app-wechat', true)
    assert.equal(quietUninstallRes.success, true)
    assert.equal(uninstalledCmd, 'C:\\Program Files\\Tencent\\WeChat\\Uninstall.exe /S')

    // Beyond Happy Path / 异常覆盖
    await assert.rejects(service.launchUninstall('non-existent-app'), /未找到应用程序/)
  })

  // ===========================================================================
  // 8. Dictionary Service (M1.5-16)
  // ===========================================================================
  await t.test('8. DictionaryService: Definitions, Phonetics, Suggestions & Markdown View', () => {
    const service = new DictionaryService()

    // 验证核心词库
    assert.ok(LOCAL_DICTIONARY_ENTRIES.length >= 20)

    // 1. 词条查询与音标释义
    const entry = service.lookup('algorithm')
    assert.ok(entry)
    assert.equal(entry.word, 'algorithm')
    assert.equal(entry.phonetic, '/ˈælɡərɪðəm/')
    assert.ok(entry.definitions.length > 0)
    assert.equal(entry.definitions[0]?.pos, 'n.')
    assert.ok(entry.definitions[0]?.meaningZh.includes('算法'))

    // 2. 大小写无关与空格容错
    const upperEntry = service.lookup('  ALGORITHM  ')
    assert.ok(upperEntry)
    assert.equal(upperEntry.word, 'algorithm')

    // 3. 词形变化模糊后缀去除 (algorithms -> algorithm, buffering -> buffer)
    const pluralEntry = service.lookup('algorithms')
    assert.ok(pluralEntry)
    assert.equal(pluralEntry.word, 'algorithm')

    const ingEntry = service.lookup('buffering')
    assert.ok(ingEntry)
    assert.equal(ingEntry.word, 'buffer')

    // 4. 前缀联想输入推荐 (Suggestions)
    const suggestions = service.getSuggestions('pro', 5)
    assert.ok(suggestions.length > 0)
    assert.ok(suggestions.some(s => s.word === 'protocol'))

    // 5. 格式化为 Markdown 视图
    const md = service.formatMarkdown(entry)
    assert.ok(md.includes('# algorithm'))
    assert.ok(md.includes('/ˈælɡərɪðəm/'))
    assert.ok(md.includes('### 📖 释义'))
    assert.ok(md.includes('### 💡 例句'))

    // 6. 查词历史与生词收藏
    assert.ok(service.getHistory().includes('algorithm'))
    assert.equal(service.toggleFavorite('algorithm'), true)
    assert.ok(service.getFavorites().includes('algorithm'))
    assert.equal(service.toggleFavorite('algorithm'), false)
    assert.equal(service.getFavorites().includes('algorithm'), false)

    // Beyond Happy Path / 边界与异常
    assert.equal(service.lookup(''), null)
    assert.equal(service.lookup('   '), null)
    assert.equal(service.lookup('unrecognizedword1234567'), null)
    assert.deepEqual(service.getSuggestions(''), [])
    assert.equal(service.lookup(null as unknown as string), null)
  })
})
