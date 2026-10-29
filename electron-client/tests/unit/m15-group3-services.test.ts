import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'

import { DeveloperService } from '../../src/main/services/developer-service.js'
import { McpService } from '../../src/main/services/mcp-service.js'
import { FocusService } from '../../src/main/services/focus-service.js'
import { ScreenAwarenessService } from '../../src/main/services/screen-awareness-service.js'
import { DictationService } from '../../src/main/services/dictation-service.js'
import { CalendarService, detectConference } from '../../src/main/services/calendar-service.js'
import { NavigationService } from '../../src/main/services/navigation-service.js'
import { WebBrowserService, SEARCH_ENGINES } from '../../src/main/services/web-browser-service.js'
import { GeekToolsService } from '../../src/main/services/geek-tools-service.js'
import { ClipboardHistoryService } from '../../src/main/services/clipboard-history-service.js'
import { HudService } from '../../src/main/services/hud-service.js'

test('ZTools M1.5 Group 3 Geek Development & Intelligent Interaction Test Suite', async (t) => {
  const tmpRoot = path.join(os.tmpdir(), `ztools-test-group3-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(tmpRoot, { recursive: true })

  t.after(async () => {
    try {
      await fsPromises.rm(tmpRoot, { recursive: true, force: true })
    } catch {
      // 容错
    }
  })

  // ===========================================================================
  // 1. M1.5-17: Developer Service (扩展开发脚手架与诊断)
  // ===========================================================================
  await t.test('1. DeveloperService: Scaffold, Import, Manage & Diagnostics', async (st) => {
    const devService = new DeveloperService({
      dataRoot: tmpRoot,
      devExtensionsDir: path.join(tmpRoot, 'dev-exts')
    })

    await st.test('1.1 Happy Path: 创建新扩展脚手架 (List, Form, Script 模板)', async () => {
      // 创建 List 模板扩展
      const listExt = await devService.createExtension({
        name: 'my-list-tool',
        title: '我的列表插件',
        description: '极客开发列表测试',
        template: 'list'
      })
      assert.equal(listExt.name, 'my-list-tool')
      assert.equal(listExt.template, 'list')
      assert.ok(fs.existsSync(path.join(listExt.directory, 'package.json')))
      assert.ok(fs.existsSync(path.join(listExt.directory, 'src/index.tsx')))

      // 创建 Form 模板扩展
      const formExt = await devService.createExtension({
        name: 'my-form-tool',
        title: '表单输入插件',
        template: 'form'
      })
      assert.equal(formExt.name, 'my-form-tool')
      assert.ok(fs.existsSync(path.join(formExt.directory, 'src/index.tsx')))

      // 创建 Script/AI-Tool 模板扩展
      const scriptExt = await devService.createExtension({
        name: 'my-script-tool',
        title: '脚本执行命令',
        template: 'script'
      })
      assert.equal(scriptExt.entryFile, 'src/index.ts')
      assert.ok(fs.existsSync(path.join(scriptExt.directory, 'src/index.ts')))
    })

    await st.test('1.2 Beyond Happy Path: 异常名称、路径越界与重复创建防御', async () => {
      // 非法名称防御
      await assert.rejects(async () => {
        await devService.createExtension({ name: 'Invalid Name/Slash!', title: 'Bad' })
      }, /Extension name must be alphanumeric/)

      // 空值防御
      await assert.rejects(async () => {
        await devService.createExtension(null as any)
      }, /Invalid extension creation input/)

      // 重复目录冲突防御
      await assert.rejects(async () => {
        await devService.createExtension({ name: 'my-list-tool', title: 'Duplicate' })
      }, /already exists/)
    })

    await st.test('1.3 Happy Path & Beyond: 扩展导入、中文拼音检索与诊断数据', async () => {
      // 拼音首字母与模糊搜索
      const searchRes = devService.listExtensions('wdlb')
      assert.ok(searchRes.length > 0)
      assert.equal(searchRes[0]?.name, 'my-list-tool')

      // 状态切换与卸载
      const id = searchRes[0]!.id
      assert.equal(devService.toggleExtension(id, false), true)
      assert.equal(devService.listExtensions().find(e => e.id === id)?.enabled, false)

      // 诊断数据采集
      devService.recordWorkerStats({
        extensionId: id,
        extensionName: 'my-list-tool',
        status: 'active',
        workerPid: 1234,
        threadId: 2,
        uptimeSeconds: 120,
        heapUsedBytes: 25 * 1024 * 1024,
        heapTotalBytes: 50 * 1024 * 1024,
        rssBytes: 60 * 1024 * 1024,
        pingLatencyMs: 0.25,
        eventLoopLagMs: 0.1,
        activeHandlersCount: 3,
        errorCount: 0,
        lastError: null
      })

      const diag = devService.extensionDiagnostics()
      assert.ok(diag.length >= 3)
      const targetDiag = diag.find(d => d.extensionId === id)!
      assert.equal(targetDiag.workerPid, 1234)
      assert.equal(targetDiag.pingLatencyMs, 0.25)

      // 导入不存在目录防御
      await assert.rejects(async () => {
        await devService.importExtension(path.join(tmpRoot, 'non-existent-dir'))
      }, /does not exist/)
    })

    await devService.stop()
  })

  // ===========================================================================
  // 2. M1.5-18: MCP Gateway Service (Model Context Protocol 网关拓扑)
  // ===========================================================================
  await t.test('2. McpService: Topology, Server Install, Status & Pinyin', async (st) => {
    const mcpService = new McpService({
      dataRoot: tmpRoot,
      configFilePath: path.join(tmpRoot, 'mcp_servers.json')
    })

    await st.test('2.1 Happy Path: 安装与配置 MCP 服务器 (stdio 与 sse)', async () => {
      // 注册 Stdio 类型的 GitHub MCP Server
      const stdioServer = await mcpService.installServer({
        name: 'GitHub MCP',
        title: 'GitHub 代码检索网关',
        mentionName: 'github',
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'test_token' }
      })

      assert.equal(stdioServer.id, 'mcp.github')
      assert.equal(stdioServer.transportType, 'stdio')
      assert.equal(stdioServer.enabled, true)

      // 注册 SSE 类型的 Memory Server
      const sseServer = await mcpService.installServer({
        name: 'Memory SSE',
        title: '向量记忆网关',
        mentionName: 'memory',
        transportType: 'sse',
        url: 'http://localhost:8080/sse'
      })
      assert.equal(sseServer.id, 'mcp.memory')
      assert.equal(sseServer.url, 'http://localhost:8080/sse')
    })

    await st.test('2.2 Beyond Happy Path: 缺失必填字段与类型冲突防御', async () => {
      // stdio 缺失 command
      await assert.rejects(async () => {
        await mcpService.installServer({
          name: 'Bad Stdio',
          transportType: 'stdio'
        })
      }, /Command is required for stdio/)

      // sse 缺失 url
      await assert.rejects(async () => {
        await mcpService.installServer({
          name: 'Bad SSE',
          transportType: 'sse'
        })
      }, /URL is required for SSE/)

      // 空对象防御
      await assert.rejects(async () => {
        await mcpService.installServer(null as any)
      }, /Invalid MCP server input/)
    })

    await st.test('2.3 Happy Path: 拓扑状态展示、拼音搜索与启停下架', async () => {
      // 注册工具并验证拓扑查询
      mcpService.registerMockTools('mcp.github', [
        { name: 'search_repositories', description: 'Search GitHub repos' },
        { name: 'create_issue', description: 'Create an issue' }
      ])

      const list = mcpService.manageServers('代码检索')
      assert.equal(list.length, 1)
      assert.equal(list[0]?.toolsCount, 2)
      assert.equal(list[0]?.status, 'connected')

      // 启停切换
      await mcpService.toggleServer('mcp.github', false)
      const disabledList = mcpService.manageServers('github')
      assert.equal(disabledList[0]?.enabled, false)
      assert.equal(disabledList[0]?.status, 'disconnected')

      // 删除服务
      assert.equal(await mcpService.removeServer('mcp.github'), true)
      assert.equal(mcpService.manageServers('github').length, 0)
    })

    await mcpService.stop()
  })

  // ===========================================================================
  // 3. M1.5-19: Focus Service (专注时钟与番茄工作法)
  // ===========================================================================
  await t.test('3. FocusService: Pomodoro Lifecycle, State Machine & HUD', async (st) => {
    let lastHudMsg = ''
    const mockHudService = {
      showHUD: async (msg: unknown) => {
        lastHudMsg = String(msg)
        return { id: 'hud-1', message: lastHudMsg, durationMs: 1500, timestamp: Date.now() }
      }
    } as unknown as HudService

    const focusService = new FocusService({
      dbPath: path.join(tmpRoot, 'focus.sqlite'),
      hudService: mockHudService,
      snoozeDurationMs: 180000
    })

    await st.test('3.1 Happy Path: 专注启动、暂停、继续、提前达成与 HUD 反馈', () => {
      // 启动专注
      const session = focusService.startSession({
        title: '架构重构专注',
        durationMinutes: 25
      })
      assert.equal(session.status, 'running')
      assert.equal(session.totalDurationMs, 25 * 60 * 1000)
      assert.ok(lastHudMsg.includes('开始专注'))

      // 暂停
      const paused = focusService.pauseSession()
      assert.equal(paused.status, 'paused')
      assert.ok(lastHudMsg.includes('已暂停'))

      // 恢复
      const resumed = focusService.resumeSession()
      assert.equal(resumed.status, 'running')
      assert.ok(lastHudMsg.includes('已继续'))

      // 提前完成
      const completed = focusService.completeSession()
      assert.equal(completed.status, 'completed')
      assert.equal(completed.remainingMs, 0)
      assert.equal(completed.progress, 1.0)
      assert.ok(lastHudMsg.includes('专注已达成'))

      // 校验历史统计
      const stats = focusService.getStats()
      assert.ok(stats.totalCompletedSessions >= 1)
      assert.ok(stats.todayFocusMinutes >= 1)
    })

    await st.test('3.2 Beyond Happy Path: 非法状态迁移防范与异常拦截', () => {
      // 空闲状态下暂停应抛出异常
      assert.throws(() => {
        focusService.pauseSession()
      }, /当前没有进行中的计时/)

      // 空闲状态下恢复应抛出异常
      assert.throws(() => {
        focusService.resumeSession()
      }, /当前没有暂停的计时/)

      // 启动一个会话后重复启动应被拒绝
      focusService.startSession({ durationMinutes: 10 })
      assert.throws(() => {
        focusService.startSession({ durationMinutes: 10 })
      }, /已有进行中或暂停的计时/)

      // 取消当前会话
      const cancelled = focusService.cancelSession()
      assert.equal(cancelled.status, 'cancelled')
      assert.ok(lastHudMsg.includes('已取消'))
    })

    await st.test('3.3 分类管理与拼音检索', () => {
      const cats = focusService.listCategories('shendu')
      assert.ok(cats.length > 0)
      assert.equal(cats[0]?.name, '深度工作')

      const createdCat = focusService.createCategory({
        name: '极客设计',
        color: '#E11D48',
        defaultDurationMinutes: 40
      })
      assert.equal(createdCat.name, '极客设计')
      assert.equal(createdCat.defaultDurationMinutes, 40)
    })

    focusService.stop()
  })

  // ===========================================================================
  // 4. M1.5-20: Screen Awareness Service (屏幕感知与视觉交互)
  // ===========================================================================
  await t.test('4. ScreenAwarenessService: Selected Text, Capture & Graceful Fallback', async (st) => {
    // 注入 Mock Sidecar
    const mockSidecar = {
      getSelectedText: async () => ({ text: 'ZTools 选中文本上下文', source: 'uia_text_pattern' }),
      getActiveWindow: async () => ({
        active: true,
        hwnd: 0x12345,
        title: 'VS Code - ZTools Project',
        pid: 8888,
        process_name: 'Code.exe',
        process_path: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'
      })
    } as any

    const screenService = new ScreenAwarenessService({
      sidecarManager: mockSidecar
    })

    await st.test('4.1 Happy Path: 抓取选中文本并附加焦点窗口上下文', async () => {
      const payload = await screenService.captureSelectedText()
      assert.equal(payload.type, 'selected_text')
      assert.equal(payload.text, 'ZTools 选中文本上下文')
      assert.equal(payload.activeWindow.hwnd, 0x12345)
      assert.equal(payload.activeWindow.process_name, 'Code.exe')
      assert.ok(payload.timestamp > 0)
    })

    await st.test('4.2 Beyond Happy Path: 截屏区域合法性防御与 UIA 异常容错', async () => {
      // 畸形区域参数拦截
      await assert.rejects(async () => {
        await screenService.captureScreenArea({ x: 0, y: 0, width: -10, height: 100 })
      }, /Invalid screen region rectangle/)

      // 空 Sidecar 环境下的平滑降级验证
      const isolatedService = new ScreenAwarenessService({ sidecarManager: null })
      const fallbackPayload = await isolatedService.captureSelectedText()
      assert.equal(fallbackPayload.type, 'selected_text')
      assert.equal(fallbackPayload.text, '')
      assert.equal(fallbackPayload.activeWindow.process_name, 'unknown')
    })

    await screenService.stop()
  })

  // ===========================================================================
  // 5. M1.5-21: Dictation Service (语音听写输入与打字回贴)
  // ===========================================================================
  await t.test('5. DictationService: State Machine, History & Hotwords', async (st) => {
    let pastedHwnd = -1
    const mockSidecar = {
      pasteToActive: async (hwnd: number) => {
        pastedHwnd = hwnd
        return { success: true }
      }
    } as any

    const dictationService = new DictationService({
      dbPath: path.join(tmpRoot, 'dictation.sqlite'),
      sidecarManager: mockSidecar
    })

    await st.test('5.1 Happy Path: 录音听写、自动回贴与热词纠错', async () => {
      // 添加自定义专业词汇
      assert.equal(dictationService.addWordToVocabulary('Antigravity'), true)
      assert.ok(dictationService.listVocabulary().includes('Antigravity'))

      // 启动录音
      const startRes = dictationService.startDictation({
        outputAction: 'paste',
        language: 'zh',
        targetHwnd: 0x9999,
        targetAppName: 'Notepad'
      })
      assert.equal(startRes.state, 'recording')

      // 完成听写并回贴
      const record = await dictationService.finishDictation({
        textOverride: '欢迎使用 Antigravity 智能助手',
        durationSeconds: 3.5
      })

      assert.equal(record.text, '欢迎使用 Antigravity 智能助手')
      assert.equal(record.outputAction, 'paste')
      assert.equal(pastedHwnd, 0x9999) // 确认回贴目标窗口

      // 获取最后一次听写
      const last = dictationService.getLastTranscription()
      assert.equal(last?.id, record.id)
      assert.equal(last?.text, record.text)
    })

    await st.test('5.2 Beyond Happy Path: 状态乱序调用与并发冲突拦截', async () => {
      // 未在录音态时调用 finishDictation 应报错
      await assert.rejects(async () => {
        await dictationService.finishDictation()
      }, /Cannot finish dictation when not recording/)

      // 正在录音中重复 startDictation 应被拦截
      dictationService.startDictation()
      assert.throws(() => {
        dictationService.startDictation()
      }, /Dictation is already in progress/)

      // 取消录音
      assert.equal(dictationService.cancelDictation(), true)
      assert.equal(dictationService.getState(), 'idle')
    })

    dictationService.stop()
  })

  // ===========================================================================
  // 6. M1.5-22: Calendar Service (日历日程与会议协同)
  // ===========================================================================
  await t.test('6. CalendarService: Conference Detection, CRUD & ICS', async (st) => {
    const calendarService = new CalendarService({
      dbPath: path.join(tmpRoot, 'calendar.sqlite')
    })

    await st.test('6.1 Happy Path: 智能提取会议链接 (腾讯会议, 飞书, Zoom, Teams)', async () => {
      assert.equal(
        detectConference('请准时加入 https://meeting.tencent.com/dm/abc123456 开会').type,
        'tencent'
      )
      assert.equal(
        detectConference('飞书视频会议：https://vc.feishu.cn/j/888999111').type,
        'feishu'
      )
      assert.equal(
        detectConference('Zoom meeting link: https://us02web.zoom.us/j/123456789').type,
        'zoom'
      )
      assert.equal(
        detectConference('Teams call: https://teams.microsoft.com/l/meetup-join/19%3ameeting').type,
        'teams'
      )
      assert.equal(
        detectConference('Google Meet: https://meet.google.com/abc-defg-hij').type,
        'google'
      )
    })

    await st.test('6.2 Happy Path & Beyond: 日程增删改查、拼音搜索与标准 ICS 导出', async () => {
      const now = Date.now()
      const event = calendarService.createEvent({
        title: 'M1.5 架构评审会',
        description: '会议链接 https://meeting.tencent.com/dm/review123',
        location: '线上会议室',
        startTime: now + 3600 * 1000,
        endTime: now + 7200 * 1000
      })

      assert.equal(event.conferenceType, 'tencent')
      assert.ok(event.conferenceUrl?.includes('meeting.tencent.com'))

      // 拼音检索
      const found = calendarService.listEvents({ search: 'jiagou' })
      assert.equal(found.length, 1)
      assert.equal(found[0]?.title, 'M1.5 架构评审会')

      // 近期日程检索
      const upcoming = calendarService.getUpcomingEvents(24)
      assert.ok(upcoming.some(e => e.id === event.id))

      // 导出标准 ICS 规范文本
      const ics = calendarService.exportToIcs()
      assert.ok(ics.includes('BEGIN:VCALENDAR'))
      assert.ok(ics.includes('SUMMARY:M1.5 架构评审会'))
      assert.ok(ics.includes('END:VCALENDAR'))

      // 非法参数防御
      assert.throws(() => {
        calendarService.createEvent({
          title: '',
          startTime: now,
          endTime: now + 1000
        })
      }, /Event title cannot be empty/)

      assert.throws(() => {
        calendarService.createEvent({
          title: '倒流时间',
          startTime: now + 2000,
          endTime: now + 1000 // 结束时间早于开始时间
        })
      }, /Invalid event start or end time/)

      // 删除日程
      assert.equal(calendarService.deleteEvent(event.id), true)
      assert.equal(calendarService.listEvents({ search: 'jiagou' }).length, 0)
    })

    calendarService.stop()
  })

  // ===========================================================================
  // 7. M1.5-23: Navigation Service (活动窗口枚举与秒切)
  // ===========================================================================
  await t.test('7. NavigationService: Window Switcher, Pinyin Search & Focus', async (st) => {
    let windowActionCalled = ''
    const mockSidecar = {
      manageWindow: async (act: string) => {
        windowActionCalled = act
        return { success: true, action: act }
      }
    } as any

    // 侧车激活只在 Windows 走（见 activateWindow 注释），显式注入 win32 与假执行器，
    // 保证任意宿主上断言一致，且单测不会真的拉起 powershell / osascript
    const execCalls: Array<{ file: string; args: string[] }> = []
    const navService = new NavigationService({
      sidecarManager: mockSidecar,
      platform: 'win32',
      execFile: async (file, args) => {
        execCalls.push({ file, args: [...args] })
        return { stdout: '' }
      }
    })

    // 注入测试窗口数据
    navService.setMockWindows([
      { hwnd: 2001, title: 'Visual Studio Code - ZTools', processName: 'Code', processId: 101, pinyin: 'visualstudiocodeztools', acronym: 'vscz' },
      { hwnd: 2002, title: '微信 (WeChat)', processName: 'WeChat', processId: 102, pinyin: 'weixinwechat', acronym: 'wxwc' },
      { hwnd: 2003, title: '网易云音乐', processName: 'cloudmusic', processId: 103, pinyin: 'wangyiyunyinyue', acronym: 'wyyy' }
    ])

    await st.test('7.1 Happy Path: 窗口列表枚举、拼音首字母检索与激活', async () => {
      // 拼音检索微信
      const wechatResults = await navService.listOpenWindows('weixin')
      assert.equal(wechatResults.length, 1)
      assert.equal(wechatResults[0]?.hwnd, 2002)

      // 缩写检索网易云音乐
      const musicResults = await navService.listOpenWindows('wyyy')
      assert.equal(musicResults.length, 1)
      assert.equal(musicResults[0]?.title, '网易云音乐')

      // 窗口前台激活
      const actRes = await navService.activateWindow(2001)
      assert.equal(actRes.success, true)
      assert.equal(windowActionCalled, 'activate:2001')
      // 侧车成功后不再回退 PowerShell
      assert.deepEqual(execCalls, [])
    })

    await st.test('7.2 Beyond Happy Path: 非法 HWND 边界拦截', async () => {
      await assert.rejects(async () => {
        await navService.activateWindow(0)
      }, /Invalid window handle/)

      await assert.rejects(async () => {
        await navService.closeWindow(-1)
      }, /Invalid window handle/)
    })

    await st.test('7.3 Windows 侧车失败或抛错时回退 PowerShell，PowerShell 也失败则如实报错', async () => {
      for (const sidecarMode of ['fail', 'throw'] as const) {
        const calls: Array<{ file: string; args: string[] }> = []
        let psFail = false
        const svc = new NavigationService({
          platform: 'win32',
          sidecarManager: {
            manageWindow: async () => {
              if (sidecarMode === 'throw') throw new Error('sidecar 未启动')
              return { success: false }
            }
          } as any,
          execFile: async (file, args) => {
            calls.push({ file, args: [...args] })
            if (psFail) throw new Error('powershell 超时')
            return { stdout: '' }
          }
        })

        const ok = await svc.activateWindow(2001)
        assert.equal(ok.success, true, sidecarMode)
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.file, 'powershell.exe')
        assert.deepEqual(calls[0]?.args.slice(-2), ['-TargetHwnd', '2001'])

        psFail = true
        const bad = await svc.activateWindow(2001)
        assert.equal(bad.success, false)
        assert.equal(bad.error, 'powershell 超时')
      }
    })

    await st.test('7.4 macOS 不调用侧车，经 System Events 激活/关闭；应用已退出或脚本失败时返回失败', async () => {
      let sidecarCalled = false
      const calls: Array<{ file: string; args: string[] }> = []
      let nextStdout = 'ok'
      let nextError: Error | null = null
      const svc = new NavigationService({
        platform: 'darwin',
        sidecarManager: {
          manageWindow: async () => {
            sidecarCalled = true
            return { success: true }
          }
        } as any,
        execFile: async (file, args) => {
          calls.push({ file, args: [...args] })
          if (nextError) throw nextError
          return { stdout: nextStdout }
        }
      })

      // hwnd 2001 = pid 20 的第 1 个窗口（序号从 0 开始）
      const ok = await svc.activateWindow(2001)
      assert.equal(ok.success, true)
      assert.equal(sidecarCalled, false, 'macOS 不得把合成 hwnd 交给侧车')
      assert.equal(calls[0]?.file, '/usr/bin/osascript')
      assert.deepEqual(calls[0]?.args.slice(0, 2), ['-l', 'JavaScript'])
      assert.deepEqual(calls[0]?.args.slice(-2), ['20', '0'])

      // 目标进程已不存在
      nextStdout = 'not_found\n'
      const gone = await svc.activateWindow(2001)
      assert.equal(gone.success, false)
      assert.equal(gone.error, '窗口所属的应用已退出')
      const goneClose = await svc.closeWindow(2001)
      assert.equal(goneClose.success, false)
      assert.equal(goneClose.error, '窗口所属的应用已退出')

      // 超时或未授予自动化权限
      nextError = new Error('Not authorized to send Apple events to System Events')
      const denied = await svc.activateWindow(2001)
      assert.equal(denied.success, false)
      assert.match(denied.error ?? '', /Not authorized/)
      const deniedClose = await svc.closeWindow(2001)
      assert.equal(deniedClose.success, false)

      // 正常关闭
      nextError = null
      nextStdout = 'ok'
      const closed = await svc.closeWindow(2001)
      assert.equal(closed.success, true)
      assert.equal(sidecarCalled, false)
      assert.ok(calls.every(c => c.file === '/usr/bin/osascript'))
    })

    await st.test('7.5 closeWindow 只有关闭成功才从列表移除；失败时窗口仍在列表中', async () => {
      for (const platform of ['win32', 'darwin'] as const) {
        let fail: Error | null = new Error('关闭命令超时')
        const svc = new NavigationService({
          platform,
          execFile: async () => {
            if (fail) throw fail
            return { stdout: 'ok' }
          }
        })
        svc.setMockWindows([
          { hwnd: 3001, title: 'Notes', processName: 'Notes', processId: 30, pinyin: 'notes', acronym: 'n' },
          { hwnd: 3002, title: 'Mail', processName: 'Mail', processId: 30, pinyin: 'mail', acronym: 'm' }
        ])

        const failed = await svc.closeWindow(3001)
        assert.equal(failed.success, false, platform)
        assert.equal(failed.error, '关闭命令超时')
        assert.deepEqual((await svc.listOpenWindows()).map(w => w.hwnd), [3001, 3002], `${platform}: 失败时不得移除`)

        // 经 clickMenuItem 的 win-close 入口同样如实返回失败
        const viaMenu = await svc.clickMenuItem({ id: 'win-close:3001' })
        assert.equal(viaMenu.success, false)
        assert.equal((await svc.listOpenWindows()).length, 2)

        fail = null
        const closed = await svc.closeWindow(3001)
        assert.equal(closed.success, true, platform)
        assert.deepEqual((await svc.listOpenWindows()).map(w => w.hwnd), [3002])
        await svc.stop()
      }

      // 不支持的平台不执行命令、不移除窗口
      const linuxCalls: string[] = []
      const linux = new NavigationService({
        platform: 'linux',
        execFile: async (file) => {
          linuxCalls.push(file)
          return { stdout: '' }
        }
      })
      linux.setMockWindows([{ hwnd: 4001, title: 'gedit', processName: 'gedit', processId: 40, pinyin: 'gedit', acronym: 'g' }])
      const linuxClose = await linux.closeWindow(4001)
      assert.equal(linuxClose.success, false)
      assert.match(linuxClose.error ?? '', /unsupported/)
      assert.equal(linuxCalls.length, 0)
      assert.equal((await linux.listOpenWindows()).length, 1)
      await linux.stop()
    })

    await st.test('7.6 clickMenuItem：非 macOS 的普通菜单项返回 unsupported；窗口布局如实反映激活与侧车结果', async () => {
      for (const platform of ['win32', 'linux'] as const) {
        const calls: string[] = []
        const svc = new NavigationService({
          platform,
          execFile: async (file) => {
            calls.push(file)
            return { stdout: '' }
          }
        })
        const res = await svc.clickMenuItem({ path: ['File', 'Save'] })
        assert.equal(res.success, false, platform)
        assert.match(res.error ?? '', /unsupported/)
        assert.equal(calls.length, 0, `${platform}: 不应执行任何命令`)
        await svc.stop()
      }

      // 窗口布局：侧车成功 → 成功；侧车返回失败 / 抛错 / 不存在 → 失败
      const layoutCases: Array<{ name: string; sidecar: any; ok: boolean; error?: RegExp }> = [
        { name: '侧车成功', sidecar: { manageWindow: async (a: string) => ({ success: true, action: a }) }, ok: true },
        { name: '侧车失败', sidecar: { manageWindow: async (a: string) => (a.startsWith('activate:') ? { success: true, action: a } : { success: false, action: a, error: '窗口不支持调整' }) }, ok: false, error: /窗口不支持调整/ },
        { name: '侧车抛错', sidecar: { manageWindow: async (a: string) => { if (a.startsWith('activate:')) return { success: true, action: a }; throw new Error('管道断开') } }, ok: false, error: /管道断开/ },
        { name: '无侧车', sidecar: null, ok: false, error: /原生辅助进程/ }
      ]
      for (const c of layoutCases) {
        const svc = new NavigationService({
          platform: 'win32',
          sidecarManager: c.sidecar,
          execFile: async () => ({ stdout: '' })
        })
        const res = await svc.clickMenuItem({ id: 'win-max:2001' })
        assert.equal(res.success, c.ok, c.name)
        assert.equal(res.clicked, 'Window > maximize')
        if (c.error) assert.match(res.error ?? '', c.error, c.name)
        await svc.stop()
      }

      // 左右半屏的动作名必须是侧车白名单里的连字符写法（left-half / right-half），下划线写法会被侧车拒绝
      for (const [id, expected] of [['win-left:2001', 'left-half'], ['win-right:2001', 'right-half']] as const) {
        const layoutActions: string[] = []
        const svc = new NavigationService({
          platform: 'win32',
          sidecarManager: {
            manageWindow: async (a: string) => {
              layoutActions.push(a)
              const valid = a.startsWith('activate:') || ['maximize', 'left-half', 'right-half'].includes(a)
              return valid ? { success: true, action: a } : { success: false, action: a, error: `Invalid window management action: ${a}` }
            }
          } as any,
          execFile: async () => ({ stdout: '' })
        })
        const res = await svc.clickMenuItem({ id })
        assert.equal(res.success, true, id)
        assert.equal(res.clicked, `Window > ${expected}`)
        assert.deepEqual(layoutActions, ['activate:2001', expected])
        await svc.stop()
      }

      // 激活失败时不再继续调整布局
      let layoutCalled = false
      const actFail = new NavigationService({
        platform: 'win32',
        sidecarManager: {
          manageWindow: async (a: string) => {
            if (!a.startsWith('activate:')) layoutCalled = true
            return { success: false, action: a }
          }
        } as any,
        execFile: async () => {
          throw new Error('powershell 超时')
        }
      })
      const actRes = await actFail.clickMenuItem({ id: 'win-left:2001' })
      assert.equal(actRes.success, false)
      assert.equal(actRes.error, 'powershell 超时')
      assert.equal(layoutCalled, false)
      await actFail.stop()
    })

    await navService.stop()
  })

  // ===========================================================================
  // 8. M1.5-24: Web, URLs, Browser & Contacts Service
  // ===========================================================================
  await t.test('8. WebBrowserService: Search Engines, URL Normalization & Contacts', async (st) => {
    const mockSidecar = {
      getBrowserUrl: async () => ({ found: true, url: 'https://github.com/ztools/repo', browser: 'chrome' })
    } as any

    const webService = new WebBrowserService({
      dbPath: path.join(tmpRoot, 'contacts.sqlite'),
      sidecarManager: mockSidecar
    })

    await st.test('8.1 Happy Path: 搜索引擎 URL 构造与活跃 Tab 窃取', async () => {
      // 百度搜索
      const baiduRes = await webService.searchWeb('baidu', 'TypeScript 教程')
      assert.ok(baiduRes.url.includes('baidu.com/s?wd=TypeScript'))

      // GitHub 代码搜索
      const ghRes = await webService.searchWeb('github', 'electron mica')
      assert.ok(ghRes.url.includes('github.com/search?q=electron'))

      // 活跃浏览器 Tab 提取
      const tab = await webService.getActiveBrowserUrl()
      assert.equal(tab.found, true)
      assert.equal(tab.url, 'https://github.com/ztools/repo')
    })

    await st.test('8.2 Beyond Happy Path: 搜索参数为空与 URL 畸形格式校验', async () => {
      await assert.rejects(async () => {
        await webService.searchWeb('baidu', '   ')
      }, /Search query cannot be empty/)

      // 畸形非法 URL 校验
      await assert.rejects(async () => {
        await webService.quickOpenUrl('http://')
      }, /Invalid URL format/)
    })

    await st.test('8.3 Happy Path: 本地通讯录联系人增删查改与拼音搜索', async () => {
      const contact = webService.createContact({
        name: '张极客',
        organization: 'DeepMind Team',
        phone: '13800138000',
        email: 'geek@example.com'
      })

      assert.equal(contact.name, '张极客')

      // 拼音首字母检索
      const found = webService.listContacts('zhangjike')
      assert.equal(found.length, 1)
      assert.equal(found[0]?.email, 'geek@example.com')

      // 删除
      assert.equal(webService.deleteContact(contact.id), true)
      assert.equal(webService.listContacts('zhangjike').length, 0)
    })

    webService.stop()
  })

  // ===========================================================================
  // 9. M1.5-25: Geek Tools, Games, Typing Practice & Debug Stress Testing
  // ===========================================================================
  await t.test('9. GeekToolsService: Games, Typing Engine, 2048 & Chaos Clipboard Stress', async (st) => {
    const clipboardStorage = new ClipboardHistoryService({
      dbPath: path.join(tmpRoot, 'clip_stress.sqlite')
    })

    const geekTools = new GeekToolsService({
      dbPath: path.join(tmpRoot, 'geek_tools.sqlite'),
      clipboardHistory: clipboardStorage
    })

    await st.test('9.1 Happy Path: 极客打字训练引擎 WPM 测速与准确率计算', async () => {
      const challenges = geekTools.getTypingChallenges()
      assert.ok(challenges.length >= 3)

      const targetSnippet = challenges[0]!.codeSnippet
      // 完美输入：100% 准确率
      const eval100 = geekTools.evaluateTyping(challenges[0]!.id, targetSnippet, 10.0)
      assert.equal(eval100.accuracyPercentage, 100)
      assert.equal(eval100.errorCount, 0)
      assert.ok(eval100.wpm > 0)

      // 有错误输入：准确率折损
      const corrupted = targetSnippet.slice(0, 10) + 'WRONG_CODE'
      const evalCorrupt = geekTools.evaluateTyping(challenges[0]!.id, corrupted, 5.0)
      assert.ok(evalCorrupt.accuracyPercentage < 100)
      assert.ok(evalCorrupt.errorCount > 0)
    })

    await st.test('9.2 Happy Path: 2048 极客数学小游戏状态机', async () => {
      let game = geekTools.createGame2048()
      assert.equal(game.score, 0)
      assert.equal(game.isGameOver, false)

      // 连续移动验证状态演变
      game = geekTools.moveGame2048(game, 'left')
      game = geekTools.moveGame2048(game, 'up')
      game = geekTools.moveGame2048(game, 'right')
      game = geekTools.moveGame2048(game, 'down')

      assert.ok(Array.isArray(game.grid))
      assert.equal(game.grid.length, 4)
    })

    await st.test('9.3 Happy Path & Integration: 游戏扫描与启动', async () => {
      const games = geekTools.listGames('cs2')
      assert.ok(games.length > 0)
      assert.equal(games[0]?.id, 'game-steam-730')

      // 添加自定义游戏
      const custom = geekTools.addCustomGame({
        id: 'game-custom-1',
        name: '星际争霸 2',
        platform: 'custom',
        launchCommand: 'battlenet://SC2'
      })
      assert.equal(custom.acronym, 'xjzb')
      assert.ok(geekTools.listGames('xingji').length > 0)
    })

    await st.test('9.4 Integration & Chaos: 批量合成压测剪贴板数据注入', async () => {
      // 批量生成 150 条包含高熵密钥、代码、URL、颜色的合成条目
      const genRes = await geekTools.createDebugClipboardHistory(150)
      assert.equal(genRes.itemsGenerated, 150)

      // 验证剪贴板数据库真实接收并索引了该 150 条记录
      const items = clipboardStorage.queryItems({ limit: 200 })
      assert.ok(items.length >= 150)

      // 内存采样测试
      const sample = geekTools.sampleMemory()
      assert.ok(sample.heapUsedBytes > 0)
      assert.ok(sample.rssBytes > 0)
      assert.equal(geekTools.getMemoryHistory().length, 1)
    })

    geekTools.stop()
    clipboardStorage.stop()
  })
})
